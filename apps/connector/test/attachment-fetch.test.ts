import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AttachmentFetchError, AttachmentFetcher } from "../src/attachment-fetch.ts";
import { tmpDir } from "./helpers.ts";

const dirs: string[] = [];

function png(size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

function ref(bytes: Uint8Array, overrides: Partial<{ id: string; mimeType: string; bytes: number; sha256: string }> = {}) {
  return {
    id: overrides.id ?? "att-1",
    mimeType: overrides.mimeType ?? "image/png",
    bytes: overrides.bytes ?? bytes.byteLength,
    sha256: overrides.sha256 ?? createHash("sha256").update(bytes).digest("hex"),
  } as never;
}

function response(body: Uint8Array, status = 200): Response {
  return new Response(body as BodyInit, { status });
}

function fetcher(stateDir: string, fetchImpl: typeof fetch) {
  return new AttachmentFetcher({
    stateDir,
    credentials: () => ({ serverUrl: "http://127.0.0.1:9", token: "abc123" }),
    fetchImpl,
    attempts: 3,
    timeoutMs: 1000,
    maxTotalMs: 5000,
    sleep: async () => {},
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

describe("AttachmentFetcher (ADR-0014)", () => {
  it("writes a 0700 directory / 0600 file, verifies bytes and serves Pi image blocks", async () => {
    const root = tmpDir("attachment-fetch-ok");
    dirs.push(root);
    const stateDir = join(root, "state");
    const bytes = png();
    let seenUrl = "";
    let seenAuth = "";
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = new Headers(init?.headers).get("authorization") ?? "";
      return response(bytes);
    }) as typeof fetch;
    const store = fetcher(stateDir, fetchImpl);
    const [file] = await store.fetchAll([ref(bytes)]);
    expect(seenUrl).toBe("http://127.0.0.1:9/connector/attachments/att-1");
    expect(seenAuth).toBe("Bearer abc123");
    expect(statSync(store.directory).mode & 0o777).toBe(0o700);
    expect(statSync(file!.path).mode & 0o777).toBe(0o600);
    expect((await store.readForPi([file!]))).toEqual([
      { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: "image/png" },
    ]);
    store.cleanup([file!]);
    expect(existsSync(file!.path)).toBe(false);
  });

  it("rejects byte-length, sha256 and magic-byte mismatches without leaving files", async () => {
    const root = tmpDir("attachment-fetch-bad");
    dirs.push(root);
    const bytes = png();
    const cases = [
      ref(bytes, { bytes: bytes.byteLength + 1 }),
      ref(bytes, { sha256: "0".repeat(64) }),
      ref(bytes, { mimeType: "image/jpeg" }),
    ];
    for (const [index, item] of cases.entries()) {
      const stateDir = join(root, `state-${index}`);
      const store = fetcher(stateDir, (async () => response(bytes)) as typeof fetch);
      await expect(store.fetchAll([item])).rejects.toBeInstanceOf(AttachmentFetchError);
      expect(readdirSync(store.directory)).toEqual([]);
    }
  });

  it("retries transient failures and gives up permanently on a 404", async () => {
    const root = tmpDir("attachment-fetch-retry");
    dirs.push(root);
    const bytes = png();
    let calls = 0;
    const retry = fetcher(join(root, "retry"), (async () => {
      calls += 1;
      return calls < 3 ? response(new Uint8Array(), 503) : response(bytes);
    }) as typeof fetch);
    await expect(retry.fetchAll([ref(bytes)])).resolves.toHaveLength(1);
    expect(calls).toBe(3);

    let permanent = 0;
    const missing = fetcher(join(root, "missing"), (async () => {
      permanent += 1;
      return response(new Uint8Array(), 404);
    }) as typeof fetch);
    await expect(missing.fetchAll([ref(bytes)])).rejects.toBeInstanceOf(AttachmentFetchError);
    expect(permanent).toBe(1);
  });

  it("clears leftovers from a crashed run", async () => {
    const root = tmpDir("attachment-fetch-orphan");
    dirs.push(root);
    const stateDir = join(root, "state");
    const store = fetcher(stateDir, (async () => response(png())) as typeof fetch);
    store.cleanupOrphans();
    writeFileSync(join(store.directory, "leftover.bin"), "partial");
    store.cleanupOrphans();
    expect(readdirSync(store.directory)).toEqual([]);
  });
});
