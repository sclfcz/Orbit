// ADR-0014 phase 5: deterministic lifecycle clocks, real DO SQLite and schedules.
import { SELF, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AttachmentStore,
  ATTACHMENT_SWEEP_BATCH,
  ATTACHMENT_TERMINAL_RETENTION_MS as WEEK,
  ATTACHMENT_REFERENCED_HARD_CAP_MS as MONTH,
  ATTACHMENT_UNREFERENCED_TTL_MS as DAY,
  type AttachmentSql,
} from "../src/attachments.ts";
import type { Ledger } from "../src/ledger.ts";
import type { Steward } from "../src/steward.ts";
import { configureAndBind, ownerStub, pairDevice, resetLedgerState, webLogin } from "./helpers.ts";

const BASE = "https://example.com";
function png(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode("private-image-payload")]);
}

type Fixture = {
  store: AttachmentStore;
  sql: AttachmentSql;
  clock: { now: number };
  logs: Array<{ event: string; detail: string }>;
  create: () => ReturnType<AttachmentStore["create"]>;
  cmd: (attachmentId: string, state: string, cmdId?: string) => string;
  chunks: (id: string) => number;
};
async function fixture(test: (f: Fixture) => Promise<void> | void): Promise<void> {
  await runInDurableObject(ownerStub(), async (instance: Steward, state) => {
    const sql = (instance as unknown as { sql: AttachmentSql }).sql.bind(instance);
    const clock = { now: Date.now() };
    const logs: Fixture["logs"] = [];
    const store = new AttachmentStore({
      sql, transaction: (fn) => state.storage.transactionSync(fn), now: () => clock.now,
      audit: (event, detail) => logs.push({ event, detail }),
    });
    const create = () => store.create({ uploadId: crypto.randomUUID(), mimeType: "image/png", bytes: png() });
    const cmd = (attachmentId: string, status: string, cmdId: string = crypto.randomUUID()) => {
      sql`INSERT INTO outbox (cmdId, deviceId, cseq, kind, payload, state, createdAt)
        VALUES (${cmdId}, 'test-device', 1, 'send', '{}', ${status}, ${clock.now})`;
      store.link([{ attachmentId, refType: "cmd", refId: cmdId, targetDeviceId: "test-device" }]);
      return cmdId;
    };
    const chunks = (id: string) => sql<{ n: number }>`SELECT COUNT(*) AS n FROM sh_attachment_chunk WHERE attachmentId = ${id}`[0]!.n;
    await test({ store, sql, clock, logs, create, cmd, chunks });
  });
}

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
  await ownerStub().setAttachmentBudgetForTests(256 * 1024 * 1024);
});

describe("attachment retention", { timeout: 30_000 }, () => {
  it("unreferenced_24h deletes only bytes at the exact boundary and keeps metadata", async () => {
    await fixture(async ({ store, sql, clock, create, chunks, logs }) => {
      const row = await create();
      clock.now += DAY - 1;
      expect(store.sweep().deleted).toBe(0);
      expect(store.readChunks(row.id)).not.toBeNull();
      clock.now += 1;
      expect(store.sweep()).toMatchObject({ checked: 1, deleted: 1, freedBytes: row.bytes, remaining: 0 });
      expect(chunks(row.id)).toBe(0);
      expect(store.findByUploadId(row.uploadId)).toMatchObject({ ...row, state: "deleted" });
      expect(sql`SELECT * FROM sh_attachment_link`).toHaveLength(0);
      expect(store.readChunks(row.id)).toBeNull();
      expect(logs.find((l) => l.event === "attachment_deleted")?.detail).toContain('"reason":"unreferenced_24h"');
      expect(store.sweep().deleted).toBe(0);
    });
  });

  it.each(["done", "failed", "expired"])("%s starts terminal_7d at first observation, never restarts the clock", async (status) => {
    await fixture(async ({ store, sql, clock, create, cmd, chunks, logs }) => {
      const row = await create();
      cmd(row.id, status);
      clock.now += DAY;
      const terminalAt = clock.now;
      expect(store.sweep().terminalWritten).toBe(1);
      expect(store.findByUploadId(row.uploadId)).toMatchObject({ terminalAt, expiresAt: terminalAt + WEEK });
      clock.now += WEEK - 1;
      expect(store.sweep()).toMatchObject({ terminalWritten: 0, deleted: 0 });
      expect(store.readable(row.id)).not.toBeNull();
      clock.now += 1;
      expect(store.sweep().deleted).toBe(1);
      expect(chunks(row.id)).toBe(0);
      expect(sql`SELECT * FROM sh_attachment_link`).toHaveLength(1);
      expect(logs.at(-2)?.detail).toContain('"reason":"terminal_7d"');
    });
  });

  it.each(["queued", "sent", "accepted", "ambiguous"])("%s retains bytes until hard_cap_30d", async (status) => {
    await fixture(async ({ store, clock, create, cmd, logs }) => {
      const row = await create();
      clock.now += 100;
      cmd(row.id, status);
      clock.now += MONTH - 1;
      expect(store.sweep()).toMatchObject({ terminalWritten: 0, deleted: 0 });
      expect(store.findByUploadId(row.uploadId)?.terminalAt).toBeNull();
      expect(store.readable(row.id)).not.toBeNull();
      clock.now += 1;
      expect(store.sweep().deleted).toBe(1);
      expect(logs.at(-2)?.detail).toContain('"reason":"hard_cap_30d"');
    });
  });

  it("waits for every linked command, and treats a missing command as unresolved", async () => {
    await fixture(async ({ store, sql, clock, create, cmd }) => {
      const row = await create();
      cmd(row.id, "done");
      const second = cmd(row.id, "accepted");
      expect(store.sweep().terminalWritten).toBe(0);
      clock.now += DAY;
      sql`UPDATE outbox SET state = 'done' WHERE cmdId = ${second}`;
      expect(store.sweep().terminalWritten).toBe(1);
      expect(store.findByUploadId(row.uploadId)?.terminalAt).toBe(clock.now);
      const unknown = await create();
      store.link([{ attachmentId: unknown.id, refType: "cmd", refId: "missing", targetDeviceId: "test-device" }]);
      expect(store.sweep().terminalWritten).toBe(0);
      expect(store.findByUploadId(unknown.uploadId)?.terminalAt).toBeNull();
    });
  });

  it("new pending references reset terminalAt without extending the first-reference hard cap", async () => {
    await fixture(async ({ store, sql, clock, create, cmd }) => {
      const row = await create();
      cmd(row.id, "done");
      const cap = clock.now + MONTH;
      store.sweep();
      clock.now += WEEK - 1;
      const second = cmd(row.id, "accepted");
      expect(store.findByUploadId(row.uploadId)).toMatchObject({ terminalAt: null, expiresAt: cap });
      store.sweep();
      expect(store.findByUploadId(row.uploadId)?.terminalAt).toBeNull();
      clock.now = cap - DAY;
      sql`UPDATE outbox SET state = 'done' WHERE cmdId = ${second}`;
      store.sweep();
      expect(store.findByUploadId(row.uploadId)).toMatchObject({ terminalAt: clock.now, expiresAt: cap });
      // Duplicate links cannot renew retention or make the clock drift.
      store.link([{ attachmentId: row.id, refType: "cmd", refId: second, targetDeviceId: "test-device" }]);
      expect(store.findByUploadId(row.uploadId)?.expiresAt).toBe(cap);
      clock.now = cap;
      expect(store.sweep().deleted).toBe(1);
    });
  });

  it("msg_only_7d starts at first reference and logs the anomaly once", async () => {
    await fixture(async ({ store, clock, create, logs }) => {
      const row = await create();
      clock.now += 100;
      const firstRef = clock.now;
      store.link([{ attachmentId: row.id, refType: "msg", refId: "owner-msg", targetDeviceId: "test-device" }]);
      clock.now += DAY;
      expect(store.sweep().terminalWritten).toBe(1);
      expect(store.findByUploadId(row.uploadId)).toMatchObject({ terminalAt: firstRef, expiresAt: firstRef + WEEK });
      clock.now = firstRef + WEEK - 1;
      expect(store.sweep().deleted).toBe(0);
      clock.now += 1;
      expect(store.sweep().deleted).toBe(1);
      expect(logs.filter((l) => l.event === "attachment_msg_only")).toHaveLength(1);
      expect(logs.at(-2)?.detail).toContain('"reason":"msg_only_7d"');
    });
  });

  it("usedBytes excludes expired rows; budget pressure reclaims one batch before accepting or refusing", async () => {
    await fixture(async ({ store, clock, create, chunks }) => {
      const expired = await create();
      store.setSoftBudgetForTests(expired.bytes);
      clock.now += DAY;
      expect(store.usedBytes()).toBe(0);
      expect(chunks(expired.id)).toBe(1); // physical garbage until capacity pressure
      const fresh = await create();
      expect(chunks(expired.id)).toBe(0);
      expect(store.usedBytes()).toBe(fresh.bytes);
      await expect(create()).rejects.toMatchObject({ code: "storage_low" });
      expect(store.readable(fresh.id)).not.toBeNull();
    });
  });

  it("budget cleanup is bounded and requests a continuation for expired leftovers", async () => {
    await runInDurableObject(ownerStub(), async (instance: Steward, state) => {
      const sql = (instance as unknown as { sql: AttachmentSql }).sql.bind(instance);
      let now = Date.now();
      const continuations: string[] = [];
      const store = new AttachmentStore({
        sql, transaction: (fn) => state.storage.transactionSync(fn), now: () => now,
        continueSweep: async (afterId) => { continuations.push(afterId); },
      });
      for (let i = 0; i < ATTACHMENT_SWEEP_BATCH + 2; i += 1) {
        await store.create({ uploadId: crypto.randomUUID(), mimeType: "image/png", bytes: png() });
      }
      now += DAY;
      store.setSoftBudgetForTests(png().length);
      const fresh = await store.create({ uploadId: crypto.randomUUID(), mimeType: "image/png", bytes: png() });
      expect(sql<{ n: number }>`SELECT COUNT(*) AS n FROM sh_attachment WHERE state = 'deleted'`[0]!.n).toBe(64);
      expect(continuations).toHaveLength(1);
      const rest = store.sweep(now, { afterId: continuations[0]! });
      expect(rest.deleted).toBe(2);
      expect(store.usedBytes()).toBe(fresh.bytes);
      expect(store.readable(fresh.id)).not.toBeNull();
    });
  });

  it("rolls back chunk deletion and lifecycle changes together if the transaction fails", async () => {
    await runInDurableObject(ownerStub(), async (instance: Steward, state) => {
      const sql = (instance as unknown as { sql: AttachmentSql }).sql.bind(instance);
      const now = Date.now();
      let fail = false;
      const store = new AttachmentStore({
        sql, now: () => now - DAY,
        transaction: (fn) => state.storage.transactionSync(() => {
          const result = fn();
          if (fail) throw new Error("injected transaction failure");
          return result;
        }),
      });
      const row = await store.create({ uploadId: crypto.randomUUID(), mimeType: "image/png", bytes: png() });
      fail = true;
      expect(() => store.sweep(now)).toThrow("injected transaction failure");
      expect(store.findByUploadId(row.uploadId)).toEqual(row);
      expect(sql`SELECT * FROM sh_attachment_chunk WHERE attachmentId = ${row.id}`).toHaveLength(1);
      fail = false;
      expect(store.sweep(now).deleted).toBe(1);
    });
  });

  it("sweep log records only allowed metadata and statistics, never image content", async () => {
    await fixture(async ({ store, clock, create, logs }) => {
      const row = await create();
      clock.now += DAY;
      store.sweep();
      const deletion = JSON.parse(logs.find((l) => l.event === "attachment_deleted")!.detail);
      expect(deletion).toEqual({ attachmentId: row.id, bytes: row.bytes, mimeType: "image/png", reason: "unreferenced_24h" });
      const stats = JSON.parse(logs.at(-1)!.detail);
      expect(stats).toEqual({ checked: 1, terminalWritten: 0, deleted: 1, freedBytes: row.bytes, remaining: 0, durationMs: expect.any(Number), nextCursor: null });
      const text = JSON.stringify(logs);
      expect(text).not.toMatch(/private-image-payload|iVBORw0KGgo|base64|https?:|token|sha256/);
    });
  });

  it("bounds every pass and visits later rows even when earlier attachments are still waiting", async () => {
    await fixture(async ({ store, sql, clock, create, cmd }) => {
      for (let i = 0; i < ATTACHMENT_SWEEP_BATCH; i += 1) cmd((await create()).id, "accepted");
      const expired = await create();
      // Pin sort order explicitly; random ULID suffixes within one millisecond are unordered.
      sql`UPDATE sh_attachment SET id = 'zz-last' WHERE id = ${expired.id}`;
      sql`UPDATE sh_attachment_chunk SET attachmentId = 'zz-last' WHERE attachmentId = ${expired.id}`;
      clock.now += DAY;
      const first = store.sweep();
      expect(first).toMatchObject({ checked: 64, deleted: 0, remaining: 1, nextCursor: expect.any(String) });
      const second = store.sweep(clock.now, { afterId: first.nextCursor! });
      expect(second).toMatchObject({ checked: 1, deleted: 1, remaining: 0, nextCursor: null });
      expect(store.readable("zz-last")).toBeNull();
    });
  });
});

describe("attachment maintenance integration", { timeout: 30_000 }, () => {
  it("arms one hourly cron on repeated startup and schedules each remaining batch three seconds later", async () => {
    await runInDurableObject(ownerStub(), async (instance: Steward, state) => {
      const frozen = vi.spyOn(Date, "now").mockReturnValue(Date.now() + DAY);
      try {
        const api = instance as unknown as {
          armAttachmentMaintenance(): void;
          cancelSchedule(id: string): Promise<unknown>;
          listSchedules(): Promise<Array<{ id: string; callback: string; type: string; cron?: string; time: number; payload?: { afterId: string } }>>;
        };
        api.armAttachmentMaintenance();
        api.armAttachmentMaintenance();
        const before = (await api.listSchedules()).filter((s) => s.callback === "attachmentMaintenance");
        expect(before).toHaveLength(1);
        expect(before[0]).toMatchObject({ type: "cron", cron: "17 * * * *" });
        const sql = (instance as unknown as { sql: AttachmentSql }).sql.bind(instance);
        const clock = { now: Date.now() - DAY };
        const store = new AttachmentStore({ sql, transaction: (fn) => state.storage.transactionSync(fn), now: () => clock.now });
        for (let i = 0; i < ATTACHMENT_SWEEP_BATCH + 2; i += 1) {
          await store.create({ uploadId: crypto.randomUUID(), mimeType: "image/png", bytes: png() });
        }
        await instance.attachmentMaintenance();
        expect(sql<{ n: number }>`SELECT COUNT(*) AS n FROM sh_attachment WHERE state = 'deleted'`[0]!.n).toBe(64);
        const schedules = (await api.listSchedules()).filter((s) => s.callback === "attachmentMaintenance");
        expect(schedules.filter((s) => s.type === "cron")).toEqual(before); // unchanged id/time
        const next = schedules.find((s) => s.type !== "cron")!;
        expect(next).toBeDefined();
        expect(next.time).toBe(Math.floor((Date.now() + 3000) / 1000));
        await api.cancelSchedule(next.id);
        await instance.attachmentMaintenance(next.payload);
        expect(sql<{ n: number }>`SELECT COUNT(*) AS n FROM sh_attachment WHERE state = 'deleted'`[0]!.n).toBe(66);
        expect(sql`SELECT * FROM sh_attachment_chunk`).toHaveLength(0);
        const logs = await instance.channelLogEntries(100);
        expect(logs.filter((l) => l.reason === "attachment_deleted")).toHaveLength(66);
        expect(logs.filter((l) => l.reason === "attachment_sweep").map((l) => JSON.parse(l.detail!).deleted)).toEqual([2, 64]);
      } finally {
        frozen.mockRestore();
        // The lazy store captured Date.now while it was mocked; do not leak that clock.
        (instance as unknown as { attachments_?: AttachmentStore }).attachments_ = undefined;
      }
    });
  });

  it("deleted attachments return private 404s on both endpoints and retain expired history metadata", async () => {
    const cookie = await webLogin();
    const device = await pairDevice("retention-reader");
    const attachment = await runInDurableObject(ownerStub(), async (instance: Steward, state) => {
      const sql = (instance as unknown as { sql: AttachmentSql }).sql.bind(instance);
      const store = new AttachmentStore({ sql, transaction: (fn) => state.storage.transactionSync(fn), now: () => Date.now() - MONTH - DAY });
      const row = await store.create({ uploadId: crypto.randomUUID(), mimeType: "image/png", bytes: png() });
      store.link([
        { attachmentId: row.id, refType: "cmd", refId: "expired-cmd", targetDeviceId: device.deviceId },
        { attachmentId: row.id, refType: "msg", refId: "expired-msg", targetDeviceId: device.deviceId },
      ]);
      const result = store.sweep(Date.now());
      expect(result.deleted).toBe(1);
      const ledger = (instance as unknown as { ledger: Ledger }).ledger;
      for (const type of ["msg", "cmd"] as const) {
        expect(ledger.attachments.forRefs(type, [type === "msg" ? "expired-msg" : "expired-cmd"], Date.now()).values().next().value)
          .toEqual([{ id: row.id, mimeType: "image/png", bytes: row.bytes, state: "expired" }]);
      }
      return row;
    });
    for (const [path, headers] of [
      [`/app/api/attachments/${attachment.id}`, { cookie }],
      [`/connector/attachments/${attachment.id}`, { Authorization: `Bearer ${device.token}` }],
    ] as const) {
      const res = await SELF.fetch(`${BASE}${path}`, { headers });
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });
});
