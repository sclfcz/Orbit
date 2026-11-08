import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectorApp } from "../src/connector-app.ts";
import { LocalStore } from "../src/store.ts";
import { fakePiAdapter, makeGitRepo, tmpDir, waitFor, writeScenario } from "./helpers.ts";
import { startMockSteward, type MockSteward } from "./mock-steward.ts";

let dir: string;
let repo: string;
let stateDir: string;
let store: LocalStore;
let mock: MockSteward;
let app: ConnectorApp;

beforeEach(async () => {
  dir = realpathSync(tmpDir("sig-remove-directory"));
  repo = await makeGitRepo(dir);
  stateDir = join(dir, "state");
  store = new LocalStore(join(stateDir, "connector.sqlite"));
  mock = startMockSteward();
  const port = await mock.listen();
  store.saveCredentials({ serverUrl: `http://127.0.0.1:${port}`, deviceId: mock.deviceId, token: mock.token });
  const scenario = writeScenario(dir, "scenario", []);
  app = new ConnectorApp({ store, stateDir, adapter: fakePiAdapter(stateDir, scenario) });
  await app.start();
  await mock.waitHello();
});

afterEach(async () => {
  await app?.manager.stopProcess("w-done").catch(() => undefined);
  app?.stop();
  await mock.close();
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

function registerRepo(): void {
  store.addRepo({
    repoId: repo,
    name: "repo-a",
    path: repo,
    capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null },
  });
}

function seedWorker(overrides: Record<string, unknown> = {}): void {
  store.upsertWorker({
    workerId: "w-done",
    threadId: "thread-remove",
    repoId: repo,
    agent: "pi",
    mode: "write",
    state: "idle",
    lastOutcome: "reported",
    ...overrides,
  });
}

async function unregister(): Promise<Record<string, any>> {
  const cmdId = mock.sendCmd("unregister_repo", { repoId: repo });
  return waitFor(() => mock.resultsFor(cmdId)) as Promise<Record<string, any>>;
}

describe("owner directory removal over the connector transport", () => {
  it("removes only the registration, keeps worker/worktree records, and blocks new work", async () => {
    registerRepo();
    const worktree = join(dir, "owned-worktree");
    mkdirSync(worktree);
    seedWorker({ sessionId: "session-remove", worktree, branch: "sig/remove" });
    expect(await unregister()).toMatchObject({ ok: true, data: { repoId: repo } });
    expect(await unregister()).toMatchObject({ ok: true, data: { repoId: repo } });
    expect(store.getRepo(repo)).toBeNull();
    expect(store.getWorker("w-done")).toMatchObject({ state: "idle", lastOutcome: "reported", worktree });
    expect(existsSync(worktree)).toBe(true);

    const helloCount = mock.hellos().length;
    mock.dropConn();
    await mock.waitHello(helloCount + 1);
    expect(mock.hellos().at(-1)?.repos).toEqual([]);

    const start = mock.sendCmd("start_worker", {
      workerId: "w-new",
      threadId: "new-thread",
      repoId: repo,
      mode: "readonly",
      prompt: "inspect",
    });
    expect(await waitFor(() => mock.resultsFor(start))).toMatchObject({ ok: false, error: { code: "not_registered_repo" } });
    const send = mock.sendCmd("send", { workerId: "w-done", text: "continue", intent: "auto" });
    expect(await waitFor(() => mock.resultsFor(send))).toMatchObject({ ok: false, error: { code: "not_registered_repo" } });
    const resume = mock.sendCmd("resume", { workerId: "w-done", reason: "manual" });
    expect(await waitFor(() => mock.resultsFor(resume))).toMatchObject({ ok: false, error: { code: "not_registered_repo" } });
  });

  it("rejects an active worker", async () => {
    registerRepo();
    seedWorker({ state: "running" });
    expect(await unregister()).toMatchObject({ ok: false, error: { code: "repo_worker_active" } });
    expect(store.getRepo(repo)).not.toBeNull();
  });

  it("rejects a recovering worker", async () => {
    registerRepo();
    seedWorker({ state: "recovering" });
    expect(await unregister()).toMatchObject({ ok: false, error: { code: "repo_worker_recovering" } });
    expect(store.getRepo(repo)).not.toBeNull();
  });

  it("rejects queued after messages", async () => {
    registerRepo();
    seedWorker();
    store.queueDeferred("w-done", "queued-after", { text: "later" });
    expect(await unregister()).toMatchObject({ ok: false, error: { code: "repo_queued_messages" } });
    expect(store.getRepo(repo)).not.toBeNull();
  });

  it("rejects uncertain delivery", async () => {
    registerRepo();
    seedWorker({ lastOutcome: "delivery_ambiguous" });
    expect(await unregister()).toMatchObject({ ok: false, error: { code: "repo_delivery_ambiguous" } });
    expect(store.getRepo(repo)).not.toBeNull();
  });

  it("rejects a pending serial queue item", async () => {
    registerRepo();
    seedWorker({ state: "queued" });
    expect(await unregister()).toMatchObject({ ok: false, error: { code: "repo_serial_queue_pending" } });
    expect(store.getRepo(repo)).not.toBeNull();
  });
});
