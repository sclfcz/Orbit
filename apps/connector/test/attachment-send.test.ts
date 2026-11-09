// ADR-0014 phase 4: authenticated attachment pulls, temporary files, deferred replay and Pi
// image/model gates over the real ConnectorApp + mock Steward + fake-pi transport.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectorApp } from "../src/connector-app.ts";
import { CommandLog } from "../src/commands.ts";
import { isLockHeld } from "../src/locks.ts";
import { LocalStore } from "../src/store.ts";
import {
  fakePiAdapter,
  makeGitRepo,
  reportRun,
  tmpDir,
  waitFor,
  writeScenario,
  type ScenarioStep,
} from "./helpers.ts";
import { startMockSteward, type MockSteward } from "./mock-steward.ts";

let dir: string;
let stateDir: string;
let repo: string;
let store: LocalStore;
let mock: MockSteward;
let app: ConnectorApp;
let logPath: string;

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const response = (body: Uint8Array, status = 200) => new Response(body as BodyInit, { status });
const png = (size = 64): Uint8Array => {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
};
const ref = (bytes: Uint8Array, id = "att-1") => ({
  id, mimeType: "image/png", bytes: bytes.byteLength, sha256: sha(bytes),
});
const prompts = () => existsSync(logPath)
  ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
  : [];

beforeEach(async () => {
  dir = tmpDir("attachment-send");
  stateDir = join(dir, "state");
  repo = await makeGitRepo(dir);
  logPath = join(dir, "fake-pi.log");
  store = new LocalStore(join(stateDir, "connector.sqlite"));
  store.addRepo({ repoId: repo, name: "repo-a", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
  mock = startMockSteward();
  const port = await mock.listen();
  store.saveCredentials({ serverUrl: `http://127.0.0.1:${port}`, deviceId: mock.deviceId, token: mock.token });
});

afterEach(async () => {
  app?.stop();
  await mock?.close();
  store?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

async function startApp(runs: ScenarioStep[][], fetchImpl: typeof fetch, extra: Record<string, unknown> = {}): Promise<void> {
  const scenario = writeScenario(dir, "scenario", runs, undefined, extra);
  app = new ConnectorApp({
    store,
    stateDir,
    adapter: fakePiAdapter(stateDir, scenario, { FAKE_PI_LOG: logPath }),
    fetchImpl,
  });
  await app.start();
  await mock.waitConnected();
  await mock.waitHello();
}

async function startWorker(workerId = "w-img-1"): Promise<string> {
  const id = mock.sendCmd("start_worker", {
    workerId, threadId: "image-task", repoId: repo, mode: "write", prompt: "inspect files",
  });
  expect(await waitFor(() => mock.resultsFor(id), 15_000, "start result")).toMatchObject({ ok: true });
  return workerId;
}

describe("attachment pulls and Pi delivery (ADR-0014 phase 4)", { timeout: 30_000 }, () => {
  it("rejects malformed attachment references before touching a worker or the network", async () => {
    const bytes = png();
    await startApp([reportRun({ status: "done", summary: "ready" })], (async () => response(bytes)) as typeof fetch);
    const good = ref(bytes);
    const invalid = [
      [good, good],
      Array.from({ length: 5 }, (_, i) => ref(bytes, `a-${i}`)),
      [{ ...good, mimeType: "image/svg+xml" }],
      [{ ...good, bytes: 3 * 1024 * 1024 + 1 }],
      [{ ...good, sha256: "bad" }],
      [
        { ...good, id: "a", bytes: 2.5 * 1024 * 1024 },
        { ...good, id: "b", bytes: 2.5 * 1024 * 1024 },
        { ...good, id: "c", bytes: 2.5 * 1024 * 1024 },
      ],
    ];
    for (const attachments of invalid) {
      await expect(app.manager.handleCommand("bad", "send", { workerId: "w-none", text: "x", attachments }))
        .rejects.toMatchObject({ code: "bad_request" });
    }
  }, 30_000);

  it("acks immediately while the pull is slow, then sends the exact Pi image block and cleans up", async () => {
    const bytes = png();
    const fetchImpl = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      return response(bytes);
    }) as typeof fetch;
    await startApp([reportRun({ status: "done", summary: "ready" }), reportRun({ status: "done", summary: "saw it" })], fetchImpl);
    expect(mock.hellos().at(-1)!.agents).toContainEqual(expect.objectContaining({ kind: "pi", imageInput: "reference" }));
    const workerId = await startWorker();
    await waitFor(() => store.getWorker(workerId)?.state === "idle", 10_000, "worker idle");

    const cmd = mock.sendCmd("send", { workerId, text: "look at this", intent: "auto", attachments: [ref(bytes)] });
    expect(await waitFor(() => mock.acksFor(cmd), 1000, "early ack")).toMatchObject({ status: "accepted" });
    expect(mock.resultsFor(cmd)).toBeUndefined();
    expect(await waitFor(() => mock.resultsFor(cmd), 10_000, "send result")).toMatchObject({ ok: true });
    const prompt = prompts().find((entry) => entry.text === "look at this");
    expect(prompt?.images).toEqual([{ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: "image/png" }]);
    expect(readdirSync(join(stateDir, "attachments"))).toEqual([]);
  }, 30_000);

  it("returns attachment_unavailable after bounded failures and never calls the agent", async () => {
    const bytes = png();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return response(new Uint8Array(), 503);
    }) as typeof fetch;
    await startApp([reportRun({ status: "done", summary: "ready" })], fetchImpl);
    const workerId = await startWorker();
    await waitFor(() => store.getWorker(workerId)?.state === "idle", 10_000, "worker idle");
    const before = prompts().filter((entry) => entry.type === "prompt").length;
    const cmd = mock.sendCmd("send", { workerId, text: "should not arrive", intent: "auto", attachments: [ref(bytes)] });
    expect(await waitFor(() => mock.resultsFor(cmd), 10_000, "send result")).toMatchObject({
      ok: false,
      error: { code: "attachment_unavailable" },
    });
    expect(calls).toBe(3);
    expect(prompts().filter((entry) => entry.type === "prompt")).toHaveLength(before);
    expect(readdirSync(join(stateDir, "attachments"))).toEqual([]);
  }, 30_000);

  it("stores only references in deferred_send and re-pulls them at run end", async () => {
    const bytes = png();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return response(bytes);
    }) as typeof fetch;
    await startApp([[
      { emit: { type: "agent_start" } },
      { emit: { type: "turn_start" } },
      { delayMs: 900 },
      { emit: { type: "agent_settled", aborted: false } },
    ]], fetchImpl);
    const workerId = await startWorker();
    await waitFor(() => store.getWorker(workerId)?.state === "running", 10_000, "worker running");
    const cmd = mock.sendCmd("send", { workerId, text: "after this", intent: "after", attachments: [ref(bytes)] });
    expect(await waitFor(() => mock.resultsFor(cmd), 10_000, "queued result")).toMatchObject({
      ok: true, data: { delivery: "queued", effect: "after_run_end" },
    });
    const deferred = store.deferred(workerId, true).find((entry) => entry.commandId === cmd);
    expect(JSON.stringify(deferred)).not.toContain("base64");
    expect(deferred?.attachments).toHaveLength(1);
    await waitFor(() => prompts().some((entry) => entry.text === "after this"), 10_000, "deferred delivery");
    expect(calls).toBe(2);
    const deferredPrompt = prompts().find((entry) => entry.text === "after this")!;
    expect(deferredPrompt.images).toEqual([{ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: "image/png" }]);
  }, 30_000);

  it("returns a deferred item when the re-pull fails, without breaking the worker", async () => {
    const bytes = png();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls === 1 ? response(bytes) : response(new Uint8Array(), 404);
    }) as typeof fetch;
    await startApp([[
      { emit: { type: "agent_start" } },
      { emit: { type: "turn_start" } },
      { delayMs: 700 },
      { emit: { type: "agent_settled", aborted: false } },
    ]], fetchImpl);
    const workerId = await startWorker();
    await waitFor(() => store.getWorker(workerId)?.state === "running", 10_000, "worker running");
    const cmd = mock.sendCmd("send", { workerId, text: "after this", intent: "after", attachments: [ref(bytes)] });
    await waitFor(() => mock.resultsFor(cmd), 10_000, "queued result");
    expect(await waitFor(() => store.deferred(workerId, true).find((entry) => entry.commandId === cmd)?.state === "returned", 10_000, "returned"))
      .toBe(true);
    await waitFor(
      () => mock.events().some((event) => event.type === "queue_returned" && event.reason === "attachment_unavailable"),
      10_000,
      "queue_returned event",
    );
    expect(store.getWorker(workerId)?.state).not.toBe("broken");
  }, 30_000);

  it("rejects text-only Pi models before the prompt", async () => {
    const bytes = png();
    const fetchImpl = (async () => response(bytes)) as typeof fetch;
    await startApp([reportRun({ status: "done", summary: "ready" })], fetchImpl, {
      model: { provider: "fake", id: "text-only", input: ["text"] },
    });
    const workerId = await startWorker();
    await waitFor(() => store.getWorker(workerId)?.state === "idle", 10_000, "worker idle");
    const before = prompts().filter((entry) => entry.type === "prompt").length;
    const cmd = mock.sendCmd("send", { workerId, text: "must not prompt", intent: "auto", attachments: [ref(bytes)] });
    expect(await waitFor(() => mock.resultsFor(cmd), 10_000, "model result")).toMatchObject({
      ok: false,
      error: { code: "model_no_image_input" },
    });
    expect(prompts().filter((entry) => entry.type === "prompt")).toHaveLength(before);
  }, 30_000);

  it("passes the exact image block on steer and cold relaunch", async () => {
    const bytes = png();
    const fetchImpl = (async () => response(bytes)) as typeof fetch;
    await startApp([[
      { emit: { type: "agent_start" } },
      { emit: { type: "turn_start" } },
      { delayMs: 900 },
      { emit: { type: "agent_settled", aborted: false } },
    ], reportRun({ status: "done", summary: "ready" })], fetchImpl);
    const workerId = await startWorker();
    await waitFor(() => store.getWorker(workerId)?.state === "running", 10_000, "worker running");
    const steer = mock.sendCmd("send", { workerId, text: "steer with image", intent: "now", attachments: [ref(bytes)] });
    expect(await waitFor(() => mock.resultsFor(steer), 10_000, "steer result")).toMatchObject({ ok: true });
    await waitFor(() => prompts().some((entry) => entry.type === "steer" && entry.text === "steer with image"), 10_000, "steer log");
    expect(prompts().find((entry) => entry.type === "steer")?.images).toEqual([
      { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: "image/png" },
    ]);
    expect(readdirSync(join(stateDir, "attachments"))).toEqual([]);

    await waitFor(() => store.getWorker(workerId)?.state === "idle", 10_000, "worker idle");
    await app.manager.stopProcess(workerId);
    const cold = mock.sendCmd("send", { workerId, text: "cold with image", intent: "auto", attachments: [ref(bytes)] });
    expect(await waitFor(() => mock.resultsFor(cold), 10_000, "cold result")).toMatchObject({ ok: true, data: { relaunched: true } });
    const coldPrompt = prompts().find((entry) => entry.text === "cold with image");
    expect(coldPrompt?.images).toEqual([{ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: "image/png" }]);
    expect(readdirSync(join(stateDir, "attachments"))).toEqual([]);
  }, 30_000);

  it("rejects text-only models on steer and cold relaunch", async () => {
    const bytes = png();
    const fetchImpl = (async () => response(bytes)) as typeof fetch;
    await startApp([[
      { emit: { type: "agent_start" } },
      { emit: { type: "turn_start" } },
      { delayMs: 700 },
      { emit: { type: "agent_settled", aborted: false } },
    ], reportRun({ status: "done", summary: "ready" })], fetchImpl, {
      model: { provider: "fake", id: "text-only", input: ["text"] },
    });
    const workerId = await startWorker();
    await waitFor(() => store.getWorker(workerId)?.state === "running", 10_000, "worker running");
    const before = prompts().filter((entry) => entry.type === "prompt").length;
    const steer = mock.sendCmd("send", { workerId, text: "steer must not run", intent: "now", attachments: [ref(bytes)] });
    expect(await waitFor(() => mock.resultsFor(steer), 10_000, "steer error")).toMatchObject({
      ok: false, error: { code: "model_no_image_input" },
    });
    await waitFor(() => store.getWorker(workerId)?.state === "idle", 10_000, "worker idle");
    await app.manager.stopProcess(workerId);
    const cold = mock.sendCmd("send", { workerId, text: "cold must not run", intent: "auto", attachments: [ref(bytes)] });
    expect(await waitFor(() => mock.resultsFor(cold), 10_000, "cold error")).toMatchObject({
      ok: false, error: { code: "model_no_image_input" },
    });
    expect(prompts().filter((entry) => entry.type === "prompt")).toHaveLength(before);
    expect(store.getWorker(workerId)?.state).toBe("idle");
    expect(isLockHeld(stateDir, workerId)).toBe(false);
    expect(existsSync(join(stateDir, "attachments"))).toBe(true);
    expect(readdirSync(join(stateDir, "attachments"))).toEqual([]);
  }, 30_000);

  it("reconciles a crash during the attachment pull as not_delivered", async () => {
    const fetchImpl = (() => new Promise<Response>(() => {})) as typeof fetch;
    await startApp([reportRun({ status: "done", summary: "ready" })], fetchImpl);
    const workerId = await startWorker();
    await waitFor(() => store.getWorker(workerId)?.state === "idle", 10_000, "worker idle");
    const cmd = mock.sendCmd("send", { workerId, text: "crash while fetching", intent: "auto", attachments: [ref(png())] });
    await waitFor(() => new CommandLog(store.database).get(cmd)?.state === "sending", 10_000, "sending row");
    app.simulateCrash();
    const restarted = new ConnectorApp({ store, stateDir, adapter: fakePiAdapter(stateDir, writeScenario(dir, "unused", [])) });
    const recovered = new CommandLog(store.database).get(cmd);
    expect(recovered?.state).toBe("failed");
    expect(recovered?.result).toMatchObject({ ok: false, error: { code: "not_delivered" } });
    restarted.stop();
  }, 30_000);
});
