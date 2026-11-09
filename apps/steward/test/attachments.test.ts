// ADR-0014 phase 2: attachment storage, owner read API, and the device-scoped read endpoint.
import { SELF, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Steward } from "../src/steward.ts";
import {
  configureAndBind,
  connectWeb,
  ownerStub,
  pairDevice,
  pairFakeConnector,
  resetLedgerState,
  webLogin,
} from "./helpers.ts";

const BASE = "https://example.com";
const MAX = 3 * 1024 * 1024;

function png(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

function jpeg(size = 32): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
}

function gif(size = 32): Uint8Array {
  const bytes = new TextEncoder().encode("GIF89a");
  const out = new Uint8Array(Math.max(size, bytes.length));
  out.set(bytes);
  return out;
}

function webp(size = 32): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, 12));
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WEBP"), 8);
  return bytes;
}

async function browser(): Promise<{ cookie: string; csrf: string }> {
  const cookie = await webLogin();
  const snapshot = (await (await SELF.fetch(`${BASE}/app/api/workspace`, { headers: { cookie } })).json()) as { csrf: string };
  return { cookie, csrf: snapshot.csrf };
}

async function upload(
  body: Uint8Array,
  options: {
    cookie: string;
    csrf: string;
    uploadId?: string;
    contentType?: string;
    origin?: string | null;
    contentLength?: number;
  },
): Promise<Response> {
  const headers: Record<string, string> = {
    cookie: options.cookie,
    "x-csrf-token": options.csrf,
    "x-orbit-upload-id": options.uploadId ?? `upload-${crypto.randomUUID()}`,
    "content-type": options.contentType ?? "image/png",
  };
  if (options.origin !== null) headers.origin = options.origin ?? BASE;
  if (options.contentLength !== undefined) headers["content-length"] = String(options.contentLength);
  return SELF.fetch(`${BASE}/app/api/attachments`, { method: "POST", headers, body: body as BodyInit });
}

async function read(id: string, cookie: string): Promise<Response> {
  return SELF.fetch(`${BASE}/app/api/attachments/${id}`, { headers: { cookie } });
}

async function counts(): Promise<{ attachments: number; chunks: number; links: number; inbound: number; outbox: number }> {
  return runInDurableObject(ownerStub(), (instance: Steward) => {
    const sql = (instance as unknown as { sql: (strings: TemplateStringsArray) => Array<{ n: number }> }).sql.bind(instance);
    return {
      attachments: sql`SELECT COUNT(*) AS n FROM sh_attachment`[0]!.n,
      chunks: sql`SELECT COUNT(*) AS n FROM sh_attachment_chunk`[0]!.n,
      links: sql`SELECT COUNT(*) AS n FROM sh_attachment_link`[0]!.n,
      inbound: sql`SELECT COUNT(*) AS n FROM sh_inbound`[0]!.n,
      outbox: sql`SELECT COUNT(*) AS n FROM outbox`[0]!.n,
    };
  });
}

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
  await ownerStub().setAttachmentBudgetForTests(256 * 1024 * 1024);
});

describe("POST /app/api/attachments", () => {
  it("accepts all four allowed types and returns metadata that matches the stored bytes", async () => {
    const { cookie, csrf } = await browser();
    for (const [type, bytes] of [
      ["image/png", png(64)],
      ["image/jpeg", jpeg()],
      ["image/webp", webp()],
      ["image/gif", gif()],
    ] as const) {
      const res = await upload(bytes, { cookie, csrf, contentType: type });
      expect(res.status, type).toBe(200);
      const body = (await res.json()) as { id: string; mimeType: string; bytes: number; sha256: string };
      expect(body).toMatchObject({ mimeType: type, bytes: bytes.byteLength });
      expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
      const got = await read(body.id, cookie);
      expect(got.status).toBe(200);
      expect(got.headers.get("content-type")).toBe(type);
      expect(got.headers.get("cache-control")).toBe("private, no-store");
      expect(got.headers.get("x-content-type-options")).toBe("nosniff");
      expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
    }
  });

  it("round-trips exact chunk boundaries and the maximum body", async () => {
    const { cookie, csrf } = await browser();
    const cases: Array<[string, Uint8Array, string]> = [
      ["smallest-gif", gif(6), "image/gif"],
      ["256KiB", png(256 * 1024), "image/png"],
      ["256KiB+1", png(256 * 1024 + 1), "image/png"],
      ["max", png(MAX), "image/png"],
    ];
    for (const [name, bytes, contentType] of cases) {
      const res = await upload(bytes, { cookie, csrf, contentType });
      expect(res.status, name).toBe(200);
      const { id, sha256 } = (await res.json()) as { id: string; sha256: string };
      const got = await read(id, cookie);
      expect(got.status, name).toBe(200);
      expect(new Uint8Array(await got.arrayBuffer()), name).toEqual(bytes);
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer))].map((b) => b.toString(16).padStart(2, "0")).join("");
      expect(sha256, name).toBe(digest);
    }
  });

  it("rejects Content-Length over the cap before reading, and a streamed body as soon as it passes the cap", async () => {
    const { cookie, csrf } = await browser();
    const declared = await upload(png(8), { cookie, csrf, contentLength: MAX + 1 });
    expect(declared.status).toBe(413);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(png(2048));
        controller.enqueue(new Uint8Array(MAX));
        controller.close();
      },
    });
    const streamed = await SELF.fetch(`${BASE}/app/api/attachments`, {
      method: "POST",
      headers: {
        cookie,
        origin: BASE,
        "x-csrf-token": csrf,
        "x-orbit-upload-id": `upload-${crypto.randomUUID()}`,
        "content-type": "image/png",
      },
      body: stream,
    });
    expect(streamed.status).toBe(413);
    expect(await counts()).toMatchObject({ attachments: 0, chunks: 0, links: 0 });
  });

  it("rejects mismatched magic bytes, SVG, unknown types and empty bodies without leaving rows", async () => {
    const { cookie, csrf } = await browser();
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const cases: Array<[string, Uint8Array, string, number]> = [
      ["mismatch", png(32), "image/jpeg", 415],
      ["svg-as-png", svg, "image/png", 415],
      ["svg-declared", svg, "image/svg+xml", 415],
      ["unknown", png(32), "text/plain", 415],
      ["one-byte", new Uint8Array([0x89]), "image/png", 415],
      ["empty", new Uint8Array(0), "image/png", 400],
    ];
    for (const [name, body, type, status] of cases) {
      const res = await upload(body, { cookie, csrf, contentType: type });
      expect(res.status, name).toBe(status);
    }
    expect(await counts()).toMatchObject({ attachments: 0, chunks: 0, links: 0 });
  });

  it("is idempotent per upload id and refuses different bytes on the same id", async () => {
    const { cookie, csrf } = await browser();
    const id = `upload-${crypto.randomUUID()}`;
    const first = await upload(png(32), { cookie, csrf, uploadId: id });
    const second = await upload(png(32), { cookie, csrf, uploadId: id });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await first.json() as { id: string }).id).toBe((await second.json() as { id: string }).id);
    const conflict = await upload(png(33), { cookie, csrf, uploadId: id });
    expect(conflict.status).toBe(409);
    expect(await counts()).toMatchObject({ attachments: 1, chunks: 1 });
  });

  it("requires CSRF, an exact Origin and a session", async () => {
    const { cookie, csrf } = await browser();
    const noCsrf = await SELF.fetch(`${BASE}/app/api/attachments`, {
      method: "POST",
      headers: { cookie, origin: BASE, "x-orbit-upload-id": `upload-${crypto.randomUUID()}`, "content-type": "image/png" },
      body: png(16) as BodyInit,
    });
    expect(noCsrf.status).toBe(403);
    const wrongOrigin = await upload(png(16), { cookie, csrf, origin: "https://attacker.example" });
    expect(wrongOrigin.status).toBe(403);
    const missingOrigin = await upload(png(16), { cookie, csrf, origin: null });
    expect(missingOrigin.status).toBe(403);
    const noSession = await SELF.fetch(`${BASE}/app/api/attachments`, {
      method: "POST",
      headers: { origin: BASE, "x-csrf-token": csrf, "x-orbit-upload-id": `upload-${crypto.randomUUID()}`, "content-type": "image/png" },
      body: png(16) as BodyInit,
    });
    expect(noSession.status).toBe(401);
    expect(await counts()).toMatchObject({ attachments: 0, chunks: 0 });
  });

  it("enforces the soft budget with 507 and leaves no partial rows", async () => {
    const { cookie, csrf } = await browser();
    await ownerStub().setAttachmentBudgetForTests(1024);
    const res = await upload(png(2048), { cookie, csrf });
    expect(res.status).toBe(507);
    expect(await counts()).toMatchObject({ attachments: 0, chunks: 0 });
  });
});

describe("owner read endpoint", () => {
  it("requires a session and refuses unknown or expired attachments", async () => {
    const { cookie, csrf } = await browser();
    const created = (await (await upload(png(32), { cookie, csrf })).json()) as { id: string };
    expect((await SELF.fetch(`${BASE}/app/api/attachments/${created.id}`)).status).toBe(401);
    expect((await read("does-not-exist", cookie)).status).toBe(404);

    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const sql = (instance as unknown as { sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown }).sql.bind(instance);
      sql`UPDATE sh_attachment SET expiresAt = 0 WHERE id = ${created.id}`;
    });
    expect((await read(created.id, cookie)).status).toBe(404);
  });
});

describe("device read endpoint", () => {
  it("authorizes only the target device and rejects missing, wrong, revoked and stale-epoch credentials", async () => {
    const fake = await pairFakeConnector("mac-a", { run: null, autorun: false });
    fake.imageInput = true;
    await fake.connect();
    const dispatched = await ownerStub().dispatchForTest({ prompt: "看图", repoRef: "repo-a", newTitle: "看图" });
    if (dispatched.kind !== "dispatched") throw new Error(`dispatch failed: ${JSON.stringify(dispatched)}`);
    const start = (await fake.waitForCmds(1))[0]!;
    fake.send({ t: "cmd_ack", re: start.id, status: "accepted" });
    await fake.emit("started", dispatched.workerId, { sessionId: dispatched.workerId, branch: "sig/x-1" });

    const { cookie, csrf } = await browser();
    const image = png(64);
    const attachment = (await (await upload(image, { cookie, csrf })).json()) as { id: string };
    const { ws, reader } = await connectWeb(cookie);
    ws.send(JSON.stringify({ t: "subscribe", workerId: dispatched.workerId }));
    ws.send(JSON.stringify({
      t: "worker_cmd", id: "wc-attachment-1", workerId: dispatched.workerId, kind: "send",
      args: { text: "看这张图", attachments: [attachment.id] },
    }));
    const send = (await fake.waitForCmds(2))[1]!;
    expect(send.kind).toBe("send");
    fake.send({ t: "cmd_result", re: "wc-attachment-1", ok: true, data: {} });
    await reader.nextWhere((m) => m.t === "cmd_result" && m.re === "wc-attachment-1");

    const url = `${BASE}/connector/attachments/${attachment.id}`;
    expect((await SELF.fetch(url)).status).toBe(401);
    const other = await pairDevice("mac-b");
    expect((await SELF.fetch(url, { headers: { Authorization: `Bearer ${other.token}` } })).status).toBe(404);
    const allowed = await SELF.fetch(url, { headers: { Authorization: `Bearer ${fake.token}` } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await allowed.arrayBuffer())).toEqual(image);
    expect((await counts()).links).toBeGreaterThan(0);

    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const sql = (instance as unknown as { sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown }).sql.bind(instance);
      sql`UPDATE device SET epoch = epoch + 1 WHERE deviceId = ${fake.deviceId}`;
    });
    expect((await SELF.fetch(url, { headers: { Authorization: `Bearer ${fake.token}` } })).status).toBe(401);

    await ownerStub().revoke(fake.deviceId);
    expect((await SELF.fetch(url, { headers: { Authorization: `Bearer ${fake.token}` } })).status).toBe(401);
    ws.close();
  }, 30_000);
});

describe("log hygiene", () => {
  it("never logs image bytes or base64 fragments", async () => {
    const { cookie, csrf } = await browser();
    const bytes = png(256);
    const base64Fragment = btoa(String.fromCharCode(...bytes.slice(0, 24)));
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await upload(bytes, { cookie, csrf });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    expect((await read(id, cookie)).status).toBe(200);
    const logs = JSON.stringify(await ownerStub().channelLogEntries(50));
    const printed = JSON.stringify(consoleSpy.mock.calls);
    consoleSpy.mockRestore();
    expect(logs).not.toContain(base64Fragment);
    expect(printed).not.toContain(base64Fragment);
    expect(logs).not.toContain("iVBORw0KGgo");
  });
});
