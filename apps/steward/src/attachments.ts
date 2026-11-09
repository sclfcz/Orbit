// Image attachment storage (ADR-0014 phase 2, issue #13). Metadata lives in
// sh_attachment, bytes in 256 KiB sh_attachment_chunk rows, and every reference in
// sh_attachment_link so a device can only read what a command addressed to it.
//
// The phase only writes lifecycle fields. The 24 h unreferenced / terminal+7 d /
// ambiguous 30 d sweep belongs to phase 5; until then expiresAt already records the
// right upper bound and reads refuse an expired row.
import { ulid } from "@alexlikevibe/protocol";
import type { ImageAttachmentMime, ImageAttachmentRef } from "@alexlikevibe/protocol";
import { WorkspaceError } from "./workspace.ts";

/** 3 MiB raw is exactly 4 MiB base64 — the connector's existing per-image cap. */
export const ATTACHMENT_MAX_BYTES = 3 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT = 4;
export const ATTACHMENT_MAX_TOTAL_BYTES = 6 * 1024 * 1024;
export const ATTACHMENT_CHUNK_BYTES = 256 * 1024;
export const ATTACHMENT_UNREFERENCED_TTL_MS = 24 * 60 * 60_000;
/** The hard cap for an unresolved ambiguous intent (ADR-0014 decision 8). */
export const ATTACHMENT_REFERENCED_HARD_CAP_MS = 30 * 24 * 60 * 60_000;
/**
 * 256 MiB is deliberately a quarter of the Workers Free plan's 1 GB per-Durable-Object
 * limit: the same object also holds the conversation, workers and outbox, and the soft
 * budget must trip long before SQLite's SQLITE_FULL. Tests inject a smaller value.
 */
export const ATTACHMENT_SOFT_BUDGET_BYTES = 256 * 1024 * 1024;

export const ATTACHMENT_MIME_TYPES: readonly ImageAttachmentMime[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

export interface StoredAttachment {
  id: string;
  mimeType: ImageAttachmentMime;
  bytes: number;
  sha256: string;
  uploadId: string;
  state: "ready" | "referenced" | "deleted";
  createdAt: number;
  expiresAt: number;
  terminalAt: number | null;
}

export interface AttachmentLink {
  attachmentId: string;
  refType: "msg" | "cmd";
  refId: string;
  targetDeviceId: string;
}

export interface AttachmentDownload {
  mimeType: ImageAttachmentMime;
  bytes: number;
  chunks: Uint8Array[];
}

type Row = {
  id: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  uploadId: string;
  state: string;
  createdAt: number;
  expiresAt: number;
  terminalAt: number | null;
};

function view(row: Row): StoredAttachment {
  return {
    id: row.id,
    mimeType: row.mimeType as ImageAttachmentMime,
    bytes: row.bytes,
    sha256: row.sha256,
    uploadId: row.uploadId,
    state: row.state as StoredAttachment["state"],
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    terminalAt: row.terminalAt ?? null,
  };
}

export function normalizeMimeType(value: string | null): ImageAttachmentMime | null {
  const base = value?.split(";")[0]?.trim().toLowerCase() ?? "";
  return (ATTACHMENT_MIME_TYPES as readonly string[]).includes(base) ? (base as ImageAttachmentMime) : null;
}

/** Magic-byte sniffing, not a decoder. `null` means "not one of the four accepted types". */
export function sniffImageMime(bytes: Uint8Array): ImageAttachmentMime | null {
  const ascii = (start: number, end: number): string => String.fromCharCode(...bytes.slice(start, end));
  if (bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

export function extensionForMime(mime: ImageAttachmentMime): string {
  switch (mime) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/webp": return "webp";
    case "image/gif": return "gif";
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The DO's tagged template also binds BLOBs; the shared SqlExecutor type predates that and
 *  intentionally stays narrow for every other caller. */
export type AttachmentSql = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null | Uint8Array | ArrayBuffer)[]
) => T[];

export interface AttachmentStoreOptions {
  sql: AttachmentSql;
  transaction: <T>(fn: () => T) => T;
  now?: () => number;
  softBudgetBytes?: number;
}

export class AttachmentStore {
  readonly #sql: AttachmentSql;
  readonly #transaction: <T>(fn: () => T) => T;
  readonly #now: () => number;
  #softBudgetBytes: number;

  constructor(options: AttachmentStoreOptions) {
    this.#sql = options.sql;
    this.#transaction = options.transaction;
    this.#now = options.now ?? Date.now;
    this.#softBudgetBytes = options.softBudgetBytes ?? ATTACHMENT_SOFT_BUDGET_BYTES;
  }

  setSoftBudgetForTests(bytes: number): void {
    this.#softBudgetBytes = bytes;
  }

  findByUploadId(uploadId: string): StoredAttachment | null {
    const row = this.#sql<Row>`SELECT * FROM sh_attachment WHERE uploadId = ${uploadId}`[0];
    return row ? view(row) : null;
  }

  readable(id: string): StoredAttachment | null {
    const row = this.#sql<Row>`SELECT * FROM sh_attachment WHERE id = ${id}`[0];
    if (!row) return null;
    const attachment = view(row);
    if (attachment.state !== "ready" && attachment.state !== "referenced") return null;
    if (attachment.expiresAt <= this.#now()) return null;
    return attachment;
  }

  usedBytes(): number {
    return this.#sql<{ n: number }>`SELECT COALESCE(SUM(bytes), 0) AS n FROM sh_attachment WHERE state != 'deleted'`[0]!.n;
  }

  /**
   * Store one upload atomically. Chunks are accumulated only after the caller's streaming
   * size check; a rejected/duplicate/over-budget write leaves neither metadata nor chunks.
   */
  async create(input: { uploadId: string; mimeType: ImageAttachmentMime; bytes: Uint8Array }): Promise<StoredAttachment> {
    if (input.bytes.byteLength === 0) throw new WorkspaceError("bad_request", 400);
    if (input.bytes.byteLength > ATTACHMENT_MAX_BYTES) throw new WorkspaceError("too_large", 413);
    const sha256 = await sha256Hex(input.bytes);
    const existing = this.findByUploadId(input.uploadId);
    if (existing) {
      if (existing.sha256 === sha256 && existing.bytes === input.bytes.byteLength) return existing;
      throw new WorkspaceError("id_conflict", 409);
    }
    const id = ulid();
    const now = this.#now();
    const expiresAt = now + ATTACHMENT_UNREFERENCED_TTL_MS;
    try {
      this.#transaction(() => {
        // Re-check inside the transaction so two interleaved uploads cannot both spend the
        // last bytes of the soft budget.
        if (this.usedBytes() + input.bytes.byteLength > this.#softBudgetBytes) {
          throw new WorkspaceError("storage_low", 507);
        }
        this.#sql`
          INSERT INTO sh_attachment (id, mimeType, bytes, sha256, uploadId, state, createdAt, expiresAt)
          VALUES (${id}, ${input.mimeType}, ${input.bytes.byteLength}, ${sha256}, ${input.uploadId}, 'ready', ${now}, ${expiresAt})
        `;
        for (let offset = 0, position = 0; offset < input.bytes.byteLength; offset += ATTACHMENT_CHUNK_BYTES, position += 1) {
          const chunk = input.bytes.subarray(offset, Math.min(offset + ATTACHMENT_CHUNK_BYTES, input.bytes.byteLength));
          this.#sql`
            INSERT INTO sh_attachment_chunk (attachmentId, position, data)
            VALUES (${id}, ${position}, ${chunk})
          `;
        }
      });
    } catch (error) {
      // A concurrent retry may have won the UNIQUE(uploadId) race. Converge on its row when
      // the bytes agree; anything else is the caller's conflict.
      const raced = this.findByUploadId(input.uploadId);
      if (raced) {
        if (raced.sha256 === sha256 && raced.bytes === input.bytes.byteLength) return raced;
        throw new WorkspaceError("id_conflict", 409);
      }
      throw error;
    }
    return this.findByUploadId(input.uploadId)!;
  }

  /** Validate a message's ids and return the reference metadata the outbox carries. */
  refs(ids: readonly string[]): ImageAttachmentRef[] {
    if (ids.length === 0) return [];
    if (ids.length > ATTACHMENT_MAX_COUNT) throw new WorkspaceError("too_many_attachments", 400);
    if (new Set(ids).size !== ids.length) throw new WorkspaceError("duplicate_attachment", 400);
    const rows = ids.map((id) => this.readable(id));
    if (rows.some((row) => row === null)) throw new WorkspaceError("attachment_not_found", 400);
    const attachments = rows as StoredAttachment[];
    const total = attachments.reduce((sum, attachment) => sum + attachment.bytes, 0);
    if (total > ATTACHMENT_MAX_TOTAL_BYTES) throw new WorkspaceError("too_large", 413);
    return attachments.map((attachment) => ({
      id: attachment.id,
      mimeType: attachment.mimeType,
      bytes: attachment.bytes,
      sha256: attachment.sha256,
    }));
  }

  /** Part of the enqueue transaction: the link and its lifecycle fields move together. */
  link(links: readonly AttachmentLink[]): void {
    const now = this.#now();
    const expiresAt = now + ATTACHMENT_REFERENCED_HARD_CAP_MS;
    for (const item of links) {
      this.#sql`
        INSERT OR IGNORE INTO sh_attachment_link (attachmentId, refType, refId, targetDeviceId, createdAt)
        VALUES (${item.attachmentId}, ${item.refType}, ${item.refId}, ${item.targetDeviceId}, ${now})
      `;
      this.#sql`
        UPDATE sh_attachment
        SET state = 'referenced',
            expiresAt = CASE WHEN expiresAt < ${expiresAt} THEN ${expiresAt} ELSE expiresAt END
        WHERE id = ${item.attachmentId} AND state != 'deleted'
      `;
    }
  }

  /** A device may read only an attachment linked to a command addressed to that device. */
  authorizedForDevice(id: string, deviceId: string): boolean {
    return this.#sql<{ one: number }>`
      SELECT 1 AS one FROM sh_attachment_link
      WHERE attachmentId = ${id} AND refType = 'cmd' AND targetDeviceId = ${deviceId}
      LIMIT 1
    `.length > 0;
  }

  readChunks(id: string): AttachmentDownload | null {
    const attachment = this.readable(id);
    if (!attachment) return null;
    const rows = this.#sql<{ data: ArrayBuffer | Uint8Array }>`
      SELECT data FROM sh_attachment_chunk WHERE attachmentId = ${id} ORDER BY position
    `;
    const chunks = rows.map((row) => row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data));
    return { mimeType: attachment.mimeType, bytes: attachment.bytes, chunks };
  }
}
