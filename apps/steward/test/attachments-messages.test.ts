// ADR-0014 phase 2: the two worker-bound routes that may carry attachment ids, the
// capability gate, and the rule that every refusal happens before sh_inbound/outbox/link.
import { SELF, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { ErrorMessageSchema } from "@alexlikevibe/protocol";
import type { Steward } from "../src/steward.ts";
import {
  configureAndBind,
  connectWeb,
  ownerStub,
  pairFakeConnector,
  resetLedgerState,
  scriptModel,
  waitRunsSettled,
  waitWhileOutboundPending,
  webLogin,
  type FakeConnector,
} from "./helpers.ts";

const BASE = "https://example.com";

function png(size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

async function browser(): Promise<{ cookie: string; csrf: string }> {
  const cookie = await webLogin();
  const snapshot = (await (await SELF.fetch(`${BASE}/app/api/workspace`, { headers: { cookie } })).json()) as { csrf: string };
  return { cookie, csrf: snapshot.csrf };
}

async function upload(cookie: string, csrf: string, bytes = png()): Promise<{ id: string }> {
  const res = await SELF.fetch(`${BASE}/app/api/attachments`, {
    method: "POST",
    headers: {
      cookie,
      origin: BASE,
      "x-csrf-token": csrf,
      "x-orbit-upload-id": `upload-${crypto.randomUUID()}`,
      "content-type": "image/png",
    },
    body: bytes as BodyInit,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string };
}

async function postMessage(cookie: string, csrf: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/app/api/messages`, {
    method: "POST",
    headers: { cookie, origin: BASE, "content-type": "application/json", "x-csrf-token": csrf },
    body: JSON.stringify(body),
  });
}

async function workspace(cookie: string): Promise<{
  messages: Array<{ id: string; attachments?: Array<{ id: string; state: string }> }>;
  threads: Array<{
    timeline: Array<{ id: number; attachments?: Array<{ id: string; state: string }> }>;
    workers: Array<{ id: string; imageInput: string }>;
  }>;
  attention: Array<{ id: string; kind: string; imageReply?: string }>;
}> {
  const res = await SELF.fetch(`${BASE}/app/api/workspace`, { headers: { cookie } });
  expect(res.status).toBe(200);
  return await res.json() as never;
}

async function waitWorkspaceAttachment(cookie: string, msgId: string, state: string, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = await workspace(cookie);
    const message = snap.messages.find((entry) => entry.id === `user:web:${msgId}`);
    const id = message?.attachments?.[0]?.id;
    const timeline = snap.threads.flatMap((thread) => thread.timeline).find((entry) => id && entry.attachments?.some((attachment) => attachment.id === id));
    if (message?.attachments?.[0]?.state === state && timeline?.attachments?.[0]?.state === state) return snap;
    if (Date.now() > deadline) throw new Error(`attachment state ${state} never reached: ${JSON.stringify({ message, timeline })}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitFor<T>(get: () => Promise<T>, timeoutMs = 8000, what = "condition"): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await get();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function counts(): Promise<{ attachments: number; links: number; inbound: number; outbox: number }> {
  return runInDurableObject(ownerStub(), (instance: Steward) => {
    const sql = (instance as unknown as { sql: (strings: TemplateStringsArray) => Array<{ n: number }> }).sql.bind(instance);
    return {
      attachments: sql`SELECT COUNT(*) AS n FROM sh_attachment`[0]!.n,
      links: sql`SELECT COUNT(*) AS n FROM sh_attachment_link`[0]!.n,
      inbound: sql`SELECT COUNT(*) AS n FROM sh_inbound`[0]!.n,
      outbox: sql`SELECT COUNT(*) AS n FROM outbox`[0]!.n,
    };
  });
}

async function runningWorker(options: { name: string; imageInput: boolean; agents?: string[]; agent?: string }): Promise<{
  fake: FakeConnector;
  workerId: string;
  threadId: string;
}> {
  const fake = await pairFakeConnector(options.name, { run: null, autorun: false, agents: options.agents });
  fake.imageInput = options.imageInput;
  await fake.connect();
  const outcome = await ownerStub().dispatchForTest({
    prompt: "看图任务",
    repoRef: "repo-a",
    newTitle: `看图-${options.name}`,
    ...(options.agent ? { agent: options.agent } : {}),
    machineHint: options.name,
  });
  if (outcome.kind !== "dispatched") throw new Error(`dispatch failed: ${JSON.stringify(outcome)}`);
  const start = (await fake.waitForCmds(1))[0]!;
  fake.send({ t: "cmd_ack", re: start.id, status: "accepted" });
  await fake.emit("started", outcome.workerId, { sessionId: outcome.workerId, branch: "sig/x-1" });
  return { fake, workerId: outcome.workerId, threadId: outcome.threadId };
}

async function sendFromSession(
  cookie: string,
  workerId: string,
  id: string,
  attachments?: string[],
  text = "看这张图",
) {
  const { ws, reader } = await connectWeb(cookie);
  ws.send(JSON.stringify({ t: "subscribe", workerId }));
  ws.send(JSON.stringify({
    t: "worker_cmd",
    id,
    workerId,
    kind: "send",
    args: { text, ...(attachments ? { attachments } : {}) },
  }));
  return { ws, reader };
}

beforeEach(async () => {
  await resetLedgerState();
  await configureAndBind("ou_owner");
  await ownerStub().setAttachmentBudgetForTests(256 * 1024 * 1024);
});

describe("session-view send with attachments", { timeout: 30_000 }, () => {
  it("writes reference-only args and a cmd link", async () => {
    const { fake, workerId } = await runningWorker({ name: "mac-a", imageInput: true });
    const { cookie, csrf } = await browser();
    const one = await upload(cookie, csrf);
    const two = await upload(cookie, csrf);
    const { ws, reader } = await sendFromSession(cookie, workerId, "wc-img-1", [one.id, two.id]);

    const send = (await fake.waitForCmds(2))[1]!;
    const args = send.args as Record<string, unknown>;
    expect(Array.isArray(args.attachments)).toBe(true);
    const refs = args.attachments as Array<Record<string, unknown>>;
    expect(refs).toHaveLength(2);
    for (const ref of refs) {
      expect(Object.keys(ref).sort()).toEqual(["bytes", "id", "mimeType", "sha256"]);
      expect(ref).not.toHaveProperty("data");
    }
    const outbox = await runInDurableObject(ownerStub(), (instance: Steward) => {
      const sql = (instance as unknown as { sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown }).sql.bind(instance);
      return (sql`SELECT payload FROM outbox WHERE cmdId = 'wc-img-1'` as Array<{ payload: string }>)[0]!;
    });
    expect(outbox.payload).not.toContain("base64");
    expect(outbox.payload).not.toContain("data:image");
    expect((await counts()).links).toBe(2);
    const logs = JSON.stringify(await ownerStub().channelLogEntries(50));
    expect(logs).not.toContain("iVBORw0KGgo");

    fake.send({ t: "cmd_result", re: "wc-img-1", ok: true, data: {} });
    await reader.nextWhere((m) => m.t === "cmd_result" && m.re === "wc-img-1");
    ws.close();
  }, 30_000);

  it("redelivers the same reference array after the connector reconnects", async () => {
    const { fake, workerId } = await runningWorker({ name: "mac-redeliver", imageInput: true });
    const { cookie, csrf } = await browser();
    const image = await upload(cookie, csrf);
    const { ws } = await sendFromSession(cookie, workerId, "wc-redeliver", [image.id]);
    const first = (await fake.waitForCmds(2))[1]!;
    const before = JSON.stringify((first.args as Record<string, unknown>).attachments);
    expect(before).toContain(image.id);

    fake.close(); // no cmd_ack: the outbox row is still sent/unsettled
    await fake.connect();
    const redelivered = (await fake.waitForCmds(3))[2]!;
    expect(JSON.stringify((redelivered.args as Record<string, unknown>).attachments)).toBe(before);
    expect(JSON.stringify(redelivered.args)).not.toContain("data:image");
    ws.close();
    fake.close();
  }, 30_000);

  it("refuses Codex workers with unsupported_capability and writes nothing", async () => {
    const { fake, workerId } = await runningWorker({ name: "mac-codex", imageInput: true, agents: ["codex"], agent: "codex" });
    const { cookie, csrf } = await browser();
    const image = await upload(cookie, csrf);
    const before = await counts();
    const { ws, reader } = await sendFromSession(cookie, workerId, "wc-codex", [image.id]);
    const error = await reader.nextWhere((m) => m.t === "error" && m.re === "wc-codex");
    expect(error.code).toBe("unsupported_capability");
    expect(await counts()).toMatchObject({ links: before.links, outbox: before.outbox });
    ws.close();
    fake.close();
  }, 30_000);

  it("refuses a Pi connector without imageInput with upgrade_required", async () => {
    const { fake, workerId } = await runningWorker({ name: "mac-old", imageInput: false });
    const { cookie, csrf } = await browser();
    const image = await upload(cookie, csrf);
    const before = await counts();
    const { ws, reader } = await sendFromSession(cookie, workerId, "wc-old", [image.id]);
    const error = await reader.nextWhere((m) => m.t === "error" && m.re === "wc-old");
    expect(error.code).toBe("upgrade_required");
    expect(await counts()).toMatchObject({ links: before.links, outbox: before.outbox });
    ws.close();
    fake.close();
  }, 30_000);

  it("refuses forged ids and over-budget totals without creating links", async () => {
    const { fake, workerId } = await runningWorker({ name: "mac-b", imageInput: true });
    const { cookie, csrf } = await browser();
    const before = await counts();

    const forged = await sendFromSession(cookie, workerId, "wc-forged", ["01NOTAREALATTACHMENT00000"]);
    expect((await forged.reader.nextWhere((m) => m.t === "error" && m.re === "wc-forged")).code).toBe("attachment_not_found");
    forged.ws.close();

    const big = png(2 * 1024 * 1024 + 128 * 1024);
    const a = await upload(cookie, csrf, big);
    const b = await upload(cookie, csrf, big);
    const c = await upload(cookie, csrf, big);
    const tooBig = await sendFromSession(cookie, workerId, "wc-too-big", [a.id, b.id, c.id]);
    expect((await tooBig.reader.nextWhere((m) => m.t === "error" && m.re === "wc-too-big")).code).toBe("too_large");
    tooBig.ws.close();

    expect((await counts()).links).toBe(before.links);
    expect((await counts()).outbox).toBe(before.outbox);
    fake.close();
  }, 40_000);

  it("returns duplicate_attachment through a schema-valid error frame", async () => {
    const { fake, workerId } = await runningWorker({ name: "mac-dup", imageInput: true });
    const { cookie, csrf } = await browser();
    const image = await upload(cookie, csrf);
    const before = await counts();
    const { ws, reader } = await sendFromSession(cookie, workerId, "wc-dup", [image.id, image.id]);
    const error = await reader.nextWhere((m) => m.t === "error" && m.re === "wc-dup");
    expect(error.code).toBe("duplicate_attachment");
    expect(ErrorMessageSchema.safeParse(error).success).toBe(true);
    expect((await counts()).links).toBe(before.links);
    expect((await counts()).outbox).toBe(before.outbox);
    ws.close();
    fake.close();
  }, 30_000);
});

describe("main composer attachments", { timeout: 30_000 }, () => {
  it("exposes the same three imageInput states the server uses", async () => {
    const ready = await runningWorker({ name: "mac-ready", imageInput: true });
    const unsupported = await runningWorker({ name: "mac-codex-2", imageInput: true, agents: ["codex"], agent: "codex" });
    const upgrade = await runningWorker({ name: "mac-upgrade", imageInput: false });
    const { cookie } = await browser();
    const snap = await workspace(cookie);
    const states = new Map(snap.threads.flatMap((thread) => thread.workers).map((worker) => [worker.id, worker.imageInput]));
    expect(states.get(ready.workerId)).toBe("ready");
    expect(states.get(unsupported.workerId)).toBe("unsupported");
    expect(states.get(upgrade.workerId)).toBe("upgrade_required");
    ready.fake.close();
    unsupported.fake.close();
    upgrade.fake.close();
  }, 30_000);

  it("rejects ordinary messages and closed-report replies before sh_inbound/outbox/link", async () => {
    const { cookie, csrf } = await browser();
    const image = await upload(cookie, csrf);
    const before = await counts();

    const ordinary = await postMessage(cookie, csrf, {
      id: `web-${crypto.randomUUID()}`,
      text: "看看这个",
      attachments: [image.id],
    });
    expect(ordinary.status).toBe(400);
    expect((await ordinary.json() as { error: string }).error).toBe("attachments_not_allowed");
    const action = await SELF.fetch(`${BASE}/app/api/actions`, {
      method: "POST",
      headers: { cookie, origin: BASE, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ id: `web-${crypto.randomUUID()}`, cardId: "card-1", action: "yes", attachments: [image.id] }),
    });
    expect(action.status).toBe(400);
    expect((await action.json() as { error: string }).error).toBe("attachments_not_allowed");
    expect(await counts()).toMatchObject({ inbound: before.inbound, outbox: before.outbox, links: before.links });
  });

  it("rejects image-only messages and unknown ids", async () => {
    const { cookie, csrf } = await browser();
    const image = await upload(cookie, csrf);
    const before = await counts();
    const noText = await postMessage(cookie, csrf, { id: `web-${crypto.randomUUID()}`, text: "", attachments: [image.id] });
    expect(noText.status).toBe(400);
    const unknown = await postMessage(cookie, csrf, {
      id: `web-${crypto.randomUUID()}`,
      text: "看看",
      attachments: ["01NOTAREALATTACHMENT00000"],
    });
    expect(unknown.status).toBe(400);
    const duplicate = await postMessage(cookie, csrf, {
      id: `web-${crypto.randomUUID()}`,
      text: "看看",
      attachments: [image.id, image.id],
    });
    expect(duplicate.status).toBe(400);
    expect((await duplicate.json() as { error: string }).error).toBe("duplicate_attachment");
    const five = await postMessage(cookie, csrf, {
      id: `web-${crypto.randomUUID()}`,
      text: "看看",
      attachments: [image.id, image.id, image.id, image.id, image.id],
    });
    expect(five.status).toBe(400);
    expect(await counts()).toMatchObject({ inbound: before.inbound, outbox: before.outbox, links: before.links });
  });

  it("rejects a message whose attachments total more than 6 MiB", async () => {
    const { cookie, csrf } = await browser();
    const big = png(2 * 1024 * 1024 + 128 * 1024);
    const ids = [(await upload(cookie, csrf, big)).id, (await upload(cookie, csrf, big)).id, (await upload(cookie, csrf, big)).id];
    const before = await counts();
    const res = await postMessage(cookie, csrf, { id: `web-${crypto.randomUUID()}`, text: "看看", attachments: ids });
    expect(res.status).toBe(413);
    expect((await res.json() as { error: string }).error).toBe("too_large");
    expect(await counts()).toMatchObject({ inbound: before.inbound, outbox: before.outbox, links: before.links });
  });

  it("relays an answer to an open worker question with reference-only args and msg+cmd links", async () => {
    const { fake, workerId } = await runningWorker({ name: "mac-q", imageInput: true });
    await fake.emit("report", workerId, {
      type: "report",
      status: "needs_decision",
      summary: "需要看截图决定",
      question: "用哪个方案？",
    });
    const deadline = Date.now() + 8000;
    let qid = "";
    for (;;) {
      const snap = await ownerStub().debugSnapshot();
      const q = snap.questions.find((item) => item.workerId === workerId && item.status === "open");
      if (q) { qid = q.qid; break; }
      if (Date.now() > deadline) throw new Error("question never opened");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await scriptModel(fauxAssistantMessage([fauxText("(boom)")], { stopReason: "error", errorMessage: "down" }));
    await waitRunsSettled();
    await ownerStub().shrinkQuestionWindowForTest(0);
    await ownerStub().sweepQuestionFallbackForTest();
    await waitWhileOutboundPending();
    const card = (await ownerStub().outboundRows(50)).find((row) => row.kind === "card" && row.questionId === qid);
    expect(card).toBeTruthy();

    const { cookie, csrf } = await browser();
    const image = await upload(cookie, csrf);
    expect((await workspace(cookie)).attention.find((entry) => entry.id === card!.id)?.imageReply).toBe("ready");
    const msgId = `web-${crypto.randomUUID()}`;
    const res = await postMessage(cookie, csrf, {
      id: msgId,
      text: "用第二个方案",
      replyTo: card!.id,
      attachments: [image.id],
    });
    expect(res.status).toBe(202);
    const send = (await fake.waitForCmds(2))[1]!;
    const args = send.args as Record<string, unknown>;
    expect(args.attachments).toEqual([
      expect.objectContaining({ id: image.id, mimeType: "image/png", bytes: 64 }),
    ]);
    expect(JSON.stringify(args)).not.toContain("data:image");
    const sent = await waitWorkspaceAttachment(cookie, msgId, "sent");
    expect(sent.messages.find((entry) => entry.id === `user:web:${msgId}`)?.attachments).toEqual([
      expect.objectContaining({ id: image.id, mimeType: "image/png", bytes: 64, state: "sent" }),
    ]);
    expect((await counts()).links).toBe(2); // one msg link + one cmd link
    const linkTypes = await runInDurableObject(ownerStub(), (instance: Steward) => {
      const sql = (instance as unknown as { sql: (strings: TemplateStringsArray) => Array<Record<string, string>> }).sql.bind(instance);
      return sql`SELECT refType FROM sh_attachment_link ORDER BY refType`;
    });
    expect(linkTypes.map((row) => row.refType)).toEqual(["cmd", "msg"]);
    fake.send({ t: "cmd_ack", re: send.id, status: "accepted" });
    fake.send({ t: "cmd_result", re: send.id, ok: true, data: { remoteWorkerId: "x" } });
    const delivered = await waitWorkspaceAttachment(cookie, msgId, "delivered");
    expect(delivered.messages.find((entry) => entry.id === `user:web:${msgId}`)?.attachments?.[0]?.state).toBe("delivered");

    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const sql = (instance as unknown as { sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown }).sql.bind(instance);
      sql`UPDATE outbox SET state = 'failed' WHERE cmdId = ${send.id}`;
    });
    await waitWorkspaceAttachment(cookie, msgId, "failed");

    await runInDurableObject(ownerStub(), (instance: Steward) => {
      const sql = (instance as unknown as { sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown }).sql.bind(instance);
      sql`UPDATE sh_attachment SET expiresAt = 0 WHERE id = ${image.id}`;
    });
    const expired = await waitWorkspaceAttachment(cookie, msgId, "expired");
    expect(JSON.stringify(expired)).not.toMatch(/data:image|iVBORw0KGgo|base64/);
    const snap = await ownerStub().debugSnapshot();
    expect(snap.questions.find((q) => q.qid === qid)).toMatchObject({ status: "answered" });
    fake.close();
  }, 60_000);

  it("keeps the old hello/text path working", async () => {
    const { fake, workerId } = await runningWorker({ name: "mac-text", imageInput: false });
    const { cookie } = await browser();
    const { ws, reader } = await sendFromSession(cookie, workerId, "wc-text-only", undefined, "只发文字");
    const send = (await fake.waitForCmds(2))[1]!;
    expect(send.args).toMatchObject({ text: "只发文字" });
    expect(send.args).not.toHaveProperty("attachments");
    fake.send({ t: "cmd_result", re: "wc-text-only", ok: true, data: {} });
    await reader.nextWhere((m) => m.t === "cmd_result" && m.re === "wc-text-only");
    ws.close();
    fake.close();
  }, 30_000);

  it("surfaces an attachment failure on the main reply path", async () => {
    const { fake, workerId } = await runningWorker({ name: "mac-fail", imageInput: true });
    await fake.emit("report", workerId, {
      type: "report",
      status: "needs_decision",
      summary: "需要图片",
      question: "看哪张图？",
    });
    const deadline = Date.now() + 8000;
    let qid = "";
    for (;;) {
      const snap = await ownerStub().debugSnapshot();
      const q = snap.questions.find((item) => item.workerId === workerId && item.status === "open");
      if (q) { qid = q.qid; break; }
      if (Date.now() > deadline) throw new Error("question never opened");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await scriptModel(fauxAssistantMessage([fauxText("(boom)")], { stopReason: "error", errorMessage: "down" }));
    await waitRunsSettled();
    await ownerStub().shrinkQuestionWindowForTest(0);
    await ownerStub().sweepQuestionFallbackForTest();
    await waitWhileOutboundPending();
    const card = (await ownerStub().outboundRows(50)).find((row) => row.kind === "card" && row.questionId === qid);
    const { cookie, csrf } = await browser();
    const image = await upload(cookie, csrf);
    const msgId = `web-${crypto.randomUUID()}`;
    expect((await postMessage(cookie, csrf, { id: msgId, text: "这张", replyTo: card!.id, attachments: [image.id] })).status).toBe(202);
    const send = (await fake.waitForCmds(2))[1]!;
    fake.send({ t: "cmd_ack", re: send.id, status: "accepted" });
    fake.send({ t: "cmd_result", re: send.id, ok: false, error: { code: "attachment_unavailable", message: "missing", retriable: false } });
    const text = await waitFor(async () => {
      await waitWhileOutboundPending();
      return (await ownerStub().outboundRows(50)).find((row) => row.kind === "text" && row.status === "sent" && JSON.parse(row.payload as string).text.includes("图片暂时无法读取"));
    }, 10_000, "main-path attachment failure");
    expect(text).toBeTruthy();
    fake.close();
  }, 60_000);
});
