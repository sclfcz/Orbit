// ADR-0014 phase 4: pull attachment bytes from the Steward's device endpoint, verify them
// against the reference, and keep only a short-lived private file. Never logs tokens, URLs,
// image bytes or base64.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ImageAttachmentRef } from "@alexlikevibe/protocol";

export interface FetchedAttachment {
  ref: ImageAttachmentRef;
  path: string;
}

export class AttachmentFetchError extends Error {
  readonly code = "attachment_unavailable";
  readonly retriable = false;
  constructor(message: string) {
    super(message);
    this.name = "AttachmentFetchError";
  }
}

interface AttachmentFetchOptions {
  stateDir: string;
  /** Read through the store each attempt: welcome rotation replaces the token. */
  credentials: () => { serverUrl: string; token: string } | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  attempts?: number;
  maxTotalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_MAX_TOTAL_MS = 20_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function sniffMime(bytes: Uint8Array): string | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

class TransientAttachmentError extends Error {
  readonly transient = true;
  constructor(message: string) {
    super(message);
    this.name = "TransientAttachmentError";
  }
}

export class AttachmentFetcher {
  readonly directory: string;
  readonly #credentials: AttachmentFetchOptions["credentials"];
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #attempts: number;
  readonly #maxTotalMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #log?: AttachmentFetchOptions["log"];

  constructor(options: AttachmentFetchOptions) {
    this.directory = join(options.stateDir, "attachments");
    this.#credentials = options.credentials;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
    this.#maxTotalMs = options.maxTotalMs ?? DEFAULT_MAX_TOTAL_MS;
    this.#sleep = options.sleep ?? sleep;
    this.#log = options.log;
  }

  /** Connector boot: a crash can leave a partial file; clear it before serving work. */
  cleanupOrphans(): void {
    rmSync(this.directory, { recursive: true, force: true });
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
  }

  async fetchAll(refs: readonly ImageAttachmentRef[]): Promise<FetchedAttachment[]> {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    const files: FetchedAttachment[] = [];
    try {
      for (const ref of refs) files.push(await this.fetchOne(ref));
      return files;
    } catch (error) {
      this.cleanup(files);
      throw error;
    }
  }

  async readForPi(files: readonly FetchedAttachment[]): Promise<{ type: "image"; data: string; mimeType: string }[]> {
    const images: { type: "image"; data: string; mimeType: string }[] = [];
    for (const file of files) {
      images.push({
        type: "image",
        data: (await readFile(file.path)).toString("base64"),
        mimeType: file.ref.mimeType,
      });
    }
    return images;
  }

  cleanup(files: readonly FetchedAttachment[]): void {
    for (const file of files) {
      try { rmSync(file.path, { force: true }); } catch { /* best effort */ }
    }
  }

  private async fetchOne(ref: ImageAttachmentRef): Promise<FetchedAttachment> {
    const startedAt = Date.now();
    const deadline = startedAt + this.#maxTotalMs;
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.#attempts; attempt += 1) {
      if (Date.now() > deadline) break;
      try {
        const path = await this.fetchOnce(ref);
        this.#log?.("attachment_fetched", {
          attachmentId: ref.id, bytes: ref.bytes, mimeType: ref.mimeType,
          elapsedMs: Date.now() - startedAt, attempts: attempt, result: "ok",
        });
        return { ref, path };
      } catch (error) {
        lastError = error;
        const transient = error instanceof TransientAttachmentError;
        this.#log?.("attachment_fetch_failed", {
          attachmentId: ref.id, bytes: ref.bytes, mimeType: ref.mimeType,
          elapsedMs: Date.now() - startedAt, attempts: attempt,
          result: transient ? "transient" : "permanent",
        });
        if (!transient) throw new AttachmentFetchError(`attachment ${ref.id} could not be fetched`);
        if (attempt === this.#attempts || Date.now() >= deadline) break;
        await this.#sleep(Math.min(250 * 2 ** (attempt - 1), 2_000));
      }
    }
    this.#log?.("attachment_fetch_failed", {
      attachmentId: ref.id, bytes: ref.bytes, mimeType: ref.mimeType,
      elapsedMs: Date.now() - startedAt, attempts: this.#attempts, result: "unavailable",
    });
    throw new AttachmentFetchError(`attachment ${ref.id} could not be fetched: ${lastError instanceof Error ? lastError.message : "unknown error"}`);
  }

  private async fetchOnce(ref: ImageAttachmentRef): Promise<string> {
    const credentials = this.#credentials();
    if (!credentials) throw new TransientAttachmentError("no device credentials");
    const url = new URL(`/connector/attachments/${encodeURIComponent(ref.id)}`, credentials.serverUrl).toString();
    const path = join(this.directory, `${Date.now()}-${randomBytes(8).toString("hex")}.bin`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      const response = await this.#fetch(url, {
        headers: { Authorization: `Bearer ${credentials.token}` },
        signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 408 || response.status === 429 || response.status >= 500) {
          throw new TransientAttachmentError(`attachment endpoint returned ${response.status}`);
        }
        throw new AttachmentFetchError(`attachment endpoint rejected ${ref.id} (${response.status})`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new TransientAttachmentError("attachment response has no body");
      handle = await open(path, "wx", 0o600);
      const hash = createHash("sha256");
      let total = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > ref.bytes) {
          await reader.cancel();
          throw new AttachmentFetchError(`attachment ${ref.id} exceeded its declared byte length`);
        }
        hash.update(value);
        await handle.write(value);
      }
      await handle.close();
      handle = null;
      if (total !== ref.bytes) throw new AttachmentFetchError(`attachment ${ref.id} byte length mismatch`);
      if (hash.digest("hex") !== ref.sha256) throw new AttachmentFetchError(`attachment ${ref.id} sha256 mismatch`);
      const bytes = await readFile(path);
      if (sniffMime(bytes) !== ref.mimeType) throw new AttachmentFetchError(`attachment ${ref.id} mime type mismatch`);
      return path;
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
      if (error instanceof AttachmentFetchError || error instanceof TransientAttachmentError) throw error;
      if (error instanceof Error && (error.name === "AbortError" || /ECONN|ETIMEDOUT|network/i.test(error.message))) {
        throw new TransientAttachmentError(error.message);
      }
      throw new TransientAttachmentError(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }
}
