import { describe, expect, it } from "vitest";
import {
  CmdAckMessageSchema,
  CmdMessageSchema,
  CmdResultMessageSchema,
  ImageAttachmentRefSchema,
  ImageAttachmentRefsSchema,
  UnregisterRepoArgsSchema,
  UnregisterRepoResultSchema,
} from "../src/commands.ts";
import { WorkerCmdMessageSchema } from "../src/direct-worker-cmd.ts";

describe("unregister_repo schemas", () => {
  it("accepts a canonical non-empty repo id and rejects malformed arguments", () => {
    expect(UnregisterRepoArgsSchema.safeParse({ repoId: "/srv/project" }).success).toBe(true);
    expect(UnregisterRepoArgsSchema.safeParse({ repoId: "" }).success).toBe(false);
    expect(UnregisterRepoArgsSchema.safeParse({ repoId: "bad\0id" }).success).toBe(false);
    expect(UnregisterRepoArgsSchema.safeParse({ repoId: "/srv/project", extra: true }).success).toBe(false);
    expect(UnregisterRepoResultSchema.safeParse({ repoId: "/srv/project" }).success).toBe(true);
    expect(UnregisterRepoResultSchema.safeParse({ repoId: "" }).success).toBe(false);
    expect(UnregisterRepoResultSchema.safeParse({ repoId: "bad\0id" }).success).toBe(false);
  });
});

describe("CmdMessageSchema", () => {
  it("accepts a well-formed cmd", () => {
    const cmd = { t: "cmd", id: "cmd_1", cseq: 1, kind: "start_worker", workerId: "w1", notAfter: 1791966296285, args: { prompt: "go" } };
    expect(CmdMessageSchema.safeParse(cmd).success).toBe(true);
  });

  it("accepts a null notAfter (no expiry)", () => {
    const cmd = { t: "cmd", id: "cmd_1", cseq: 1, kind: "interrupt", notAfter: null };
    expect(CmdMessageSchema.safeParse(cmd).success).toBe(true);
  });

  it("rejects the wrong message type", () => {
    expect(CmdMessageSchema.safeParse({ t: "nope", id: "cmd_1", cseq: 1, kind: "interrupt" }).success).toBe(false);
  });
});

describe("CmdAckMessageSchema", () => {
  it.each(["accepted", "duplicate", "rejected", "ambiguous"])("accepts status %s", (status) => {
    expect(CmdAckMessageSchema.safeParse({ t: "cmd_ack", re: "cmd_1", status }).success).toBe(true);
  });

  it("accepts duplicate with the original result attached", () => {
    const ack = { t: "cmd_ack", re: "cmd_1", status: "duplicate", result: { ok: true, data: { workerId: "w1" } } };
    expect(CmdAckMessageSchema.safeParse(ack).success).toBe(true);
  });

  it("rejects an unknown status", () => {
    expect(CmdAckMessageSchema.safeParse({ t: "cmd_ack", re: "cmd_1", status: "bogus" }).success).toBe(false);
  });
});

describe("CmdResultMessageSchema", () => {
  it("accepts an ok result", () => {
    expect(CmdResultMessageSchema.safeParse({ t: "cmd_result", re: "cmd_1", ok: true, data: { workerId: "w1" } }).success).toBe(true);
  });

  it("accepts a failed result with an error payload", () => {
    const msg = { t: "cmd_result", re: "cmd_1", ok: false, error: { code: "lock_held", message: "busy", retriable: false } };
    expect(CmdResultMessageSchema.safeParse(msg).success).toBe(true);
  });
});

describe("ADR-0014 attachment schemas", () => {
  const ref = {
    id: "01J0000000000000000000000",
    mimeType: "image/png",
    bytes: 1024,
    sha256: "a".repeat(64),
  };

  it("accepts a reference and rejects base64/data fields", () => {
    expect(ImageAttachmentRefSchema.safeParse(ref).success).toBe(true);
    expect(ImageAttachmentRefSchema.safeParse({ ...ref, data: "iVBORw0KGgo=" }).success).toBe(false);
    expect(ImageAttachmentRefSchema.safeParse({ ...ref, mimeType: "image/svg+xml" }).success).toBe(false);
    expect(ImageAttachmentRefSchema.safeParse({ ...ref, sha256: "nope" }).success).toBe(false);
  });

  it("caps a message at four references", () => {
    expect(ImageAttachmentRefsSchema.safeParse([ref]).success).toBe(true);
    expect(ImageAttachmentRefsSchema.safeParse([ref, ref, ref, ref]).success).toBe(true);
    expect(ImageAttachmentRefsSchema.safeParse([ref, ref, ref, ref, ref]).success).toBe(false);
    expect(ImageAttachmentRefsSchema.safeParse([]).success).toBe(false);
  });

  it("lets a worker_cmd carry at most four attachment ids", () => {
    const base = { t: "worker_cmd", id: "wc-1", workerId: "w1", kind: "send" };
    expect(WorkerCmdMessageSchema.safeParse({ ...base, args: { text: "x", attachments: ["a"] } }).success).toBe(true);
    expect(WorkerCmdMessageSchema.safeParse({ ...base, args: { text: "x", attachments: ["a", "b", "c", "d"] } }).success).toBe(true);
    expect(WorkerCmdMessageSchema.safeParse({ ...base, args: { text: "x", attachments: ["a", "b", "c", "d", "e"] } }).success).toBe(false);
  });
});
