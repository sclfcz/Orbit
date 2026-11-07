import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodexAdapter } from "../src/codex-adapter.ts";
import { LocalStore } from "../src/store.ts";
import { CommandLog } from "../src/commands.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import { acquireLock, releaseLock, processStartTime } from "../src/locks.ts";
import { codexSessionPath, inspectCodexTail } from "../src/codex-session.ts";
import { readFullSessionHistory } from "../src/full-session-history.ts";
import { fakeClaudeAdapter, fakePiAdapter, makeGitRepo, reportRun, claudeReportRun, tmpDir, waitFor, writeClaudeScenario, writeScenario } from "./helpers.ts";

const managers: WorkerManager[] = [];
const stores: LocalStore[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) { for (const workerId of ["codex-worker", "queue-worker"]) await m.stopProcess(workerId).catch(() => undefined); m.stop(); }
  await new Promise((r) => setTimeout(r, 30));
  for (const s of stores.splice(0)) s.close();
});
const id = "019a0000-0000-7000-8000-000000000001";
function storeAt(dir: string) { const s = new LocalStore(join(dir, "local.sqlite")); stores.push(s); return s; }
function seed(s: LocalStore, path?: string) {
  s.upsertWorker({ workerId: "codex-worker", threadId: "orbit-thread", repoId: "repo", agent: "codex", mode: "write", state: "running", sessionId: id, sessionFile: path });
}
function manager(s: LocalStore, dir: string) {
  const events: any[] = [];
  const adapter = new CodexAdapter({ command: [process.execPath, join(import.meta.dirname, "fake-codex.mjs")], env: { FAKE_CODEX_DIR: dir } });
  const m = new WorkerManager({ store: s, stateDir: dir, adapters: [adapter], emit: (workerId, fields) => events.push({ workerId, ...fields }) });
  managers.push(m); return { m, events, adapter };
}
function recordFile(dir: string, turnId = "turn-1", terminal = true) {
  const file = join(dir, `rollout-${id}.jsonl`);
  const rows = [{ type: "session_meta", payload: { id } },
    { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    ...(terminal ? [{ type: "event_msg", payload: { type: "task_complete", turn_id: turnId, last_agent_message: '{"status":"done","summary":"completed before crash","answer":"42"}' } }] : [])];
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n"); return file;
}
describe("Codex durable identity and crash evidence", () => {
  it("never reaps a worker still held by a live Connector", async () => {
    const dir = tmpDir("codex-live-owner"); const s = storeAt(dir); seed(s);
    s.setAgentProcess("codex-worker", { pid: process.pid, startTime: processStartTime(process.pid) });
    acquireLock(dir, "codex-worker");
    let kills = 0;
    const m = new WorkerManager({ store: s, stateDir: dir, adapters: [new CodexAdapter()], recovery: { killOrphans: async () => { kills++; return []; } } });
    managers.push(m);
    try { await m.reconcileStartup(); expect(kills).toBe(0); expect(s.getWorker("codex-worker")?.state).toBe("running"); }
    finally { releaseLock(dir, "codex-worker"); }
  });
  it.each(["before", "intent", "receipt"])("classifies %s without Pi absence assumptions", (point) => {
    const dir = tmpDir("codex-command"); const s = storeAt(dir); seed(s);
    const log = new CommandLog(s.database); log.begin("c1", { workerId: "codex-worker", kind: "start_worker" }); log.markSending("c1");
    log.expectMarker("c1", {}); // thread exists, no rollout path yet
    if (point !== "before") s.recordDelivery("codex-worker", "c1", "sending");
    if (point === "receipt") s.recordDelivery("codex-worker", "c1", "delivered", "turn-1");
    expect(log.reconcileCrashed()[0]?.recovery).toBe(point === "before" ? "not_delivered" : point === "intent" ? "ambiguous" : "delivered");
  });
  it("persists a created identity before the first input, including model and worktree", async () => {
    const dir = tmpDir("codex-manager"); const repo = await makeGitRepo(dir); const s = storeAt(dir);
    s.addRepo({ repoId: "repo", name: "repo", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
    const { m } = manager(s, dir);
    await m.handleCommand("start", "start_worker", { workerId: "codex-worker", threadId: "orbit-thread", repoId: "repo", mode: "write", agent: "codex", model: "explicit-model", prompt: "task" });
    expect(s.getWorker("codex-worker")).toMatchObject({ sessionId: id, model: "explicit-model", agent: "codex" });
    expect(s.getWorker("codex-worker")?.worktree).toBeTruthy();
    expect(s.deliveries("codex-worker")).toContainEqual(expect.objectContaining({ state: "delivered", turnId: "turn-1" }));
  });
  it("recovers a completed report when acceptance was saved but settlement was lost", async () => {
    const dir = tmpDir("codex-retro"); const s = storeAt(dir); const file = recordFile(dir); seed(s, file);
    s.recordDelivery("codex-worker", "c1", "delivered", "turn-1");
    const { m, events, adapter } = manager(s, dir); await m.reconcileStartup();
    expect(s.getWorker("codex-worker")).toMatchObject({ state: "idle", lastOutcome: "reported", sessionId: id });
    expect(events).toContainEqual(expect.objectContaining({ type: "report", answer: "42" }));
    expect(adapter.workerPids()).toEqual([]);
    const history = await m.history("codex-worker", undefined, 8000, "full"); expect(history.format).toBe("full");
  });
  it("holds uncertain delivery and returns queued messages; neither resume nor send replays", async () => {
    const dir = tmpDir("codex-uncertain"); const s = storeAt(dir); seed(s, recordFile(dir));
    s.recordDelivery("codex-worker", "c1", "sending");
    s.queueDeferred("codex-worker", "later", { text: "must not vanish" });
    const { m, events, adapter } = manager(s, dir); await m.reconcileStartup();
    expect(s.getWorker("codex-worker")).toMatchObject({ state: "broken", lastOutcome: "delivery_ambiguous", sessionId: id });
    expect(events).toContainEqual(expect.objectContaining({ type: "queue_returned", texts: ["must not vanish"] }));
    await expect(m.handleCommand("resume", "resume", { workerId: "codex-worker", reason: "restart" })).rejects.toMatchObject({ code: "ambiguous" });
    await expect(m.handleCommand("send", "send", { workerId: "codex-worker", text: "go", intent: "auto" })).rejects.toMatchObject({ code: "ambiguous" });
    expect(adapter.workerPids()).toEqual([]);
  });
  it("an ambiguous queued input blocks FIFO successors after reopen", async () => {
    const dir = tmpDir("codex-fifo"); const first = storeAt(dir); seed(first, recordFile(dir)); first.setWorkerState("codex-worker", "idle");
    first.queueDeferred("codex-worker", "head", { text: "first" }); first.recordDelivery("codex-worker", "head", "sending");
    first.queueDeferred("codex-worker", "tail", { text: "second" });
    first.close(); stores.splice(stores.indexOf(first), 1);
    const s = storeAt(dir); const { m, adapter } = manager(s, dir); await m.reconcileStartup();
    expect(s.deferred("codex-worker").map((v) => v.state)).toEqual(["ambiguous"]);
    expect(s.deferred("codex-worker", true).map((v) => v.state)).toEqual(["ambiguous", "returned"]);
    expect(s.getWorker("codex-worker")?.lastOutcome).toBe("delivery_ambiguous");
    expect(adapter.workerPids()).toEqual([]);
    const log = new CommandLog(s.database); log.begin("tail", { workerId: "codex-worker", kind: "send" }); log.markSending("tail");
    expect(log.reconcileCrashed()[0]?.recovery).toBe("delivered"); // durable queue acceptance
  });
  it("missing, torn or wrong-turn records cannot authorize replay or fabricated completion", () => {
    const dir = tmpDir("codex-tail"); const file = recordFile(dir);
    expect(inspectCodexTail(file, id, "different-turn")).toEqual({ kind: "lost" });
    expect(inspectCodexTail(null, id, "turn-1")).toEqual({ kind: "lost" });
    appendFileSync(file, '{"torn":'); expect(inspectCodexTail(file, id, "turn-1")).toEqual({ kind: "lost" });
    expect(codexSessionPath("another-thread-id", file)).toBeNull();
  });
  it("a later external turn invalidates an older terminal report as recovery evidence", () => {
    const dir = tmpDir("codex-external"); const file = recordFile(dir);
    appendFileSync(file, JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "external-turn" } }) + "\n");
    expect(inspectCodexTail(file, id, "turn-1")).toEqual({ kind: "lost" });
  });
  it("serves long Codex records in fragments and rejects replacement cursors", async () => {
    const dir = tmpDir("codex-history"); const file = recordFile(dir);
    appendFileSync(file, JSON.stringify({ type: "response_item", payload: { type: "future", text: "🙂".repeat(30000) } }) + "\n");
    const page = await readFullSessionHistory(file, undefined, 8000); expect(page.done).toBe(false);
    renameSync(file, file + ".old"); recordFile(dir);
    await expect(readFullSessionHistory(file, page.cursor ?? undefined, 8000)).rejects.toMatchObject({ code: "cursor_invalid" });
  });
});

describe.each(["pi", "claude-code"])("%s durable after queue regression", (kind) => {
  it("reopens the database and delivers queued instructions exactly once in FIFO order", async () => {
    const dir = tmpDir("durable-after"); const repo = await makeGitRepo(dir); const s = storeAt(dir);
    s.addRepo({ repoId: "repo", name: "repo", path: repo, capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
    s.upsertWorker({ workerId: "queue-worker", threadId: "thread", repoId: "repo", agent: kind, mode: "write", state: "idle" });
    s.queueDeferred("queue-worker", "one", { text: "first after" }); s.queueDeferred("queue-worker", "two", { text: "second after" });
    s.close(); stores.splice(stores.indexOf(s), 1);
    const reopened = storeAt(dir); const events: any[] = [];
    const log = join(dir, "prompts.jsonl");
    const adapter = kind === "pi" ? fakePiAdapter(dir, writeScenario(dir, "pi", [reportRun({ status: "done", summary: "one" }), reportRun({ status: "done", summary: "two" })]), { FAKE_PI_LOG: log })
      : fakeClaudeAdapter(dir, writeClaudeScenario(dir, "claude", [claudeReportRun({ status: "done", summary: "one" }), claudeReportRun({ status: "done", summary: "two" })]), { FAKE_CLAUDE_LOG: log });
    const m = new WorkerManager({ store: reopened, stateDir: dir, adapters: [adapter], emit: (_, fields) => events.push(fields) }); managers.push(m);
    await m.reconcileStartup();
    await waitFor(() => reopened.deferred("queue-worker", true).every((v) => v.state === "delivered") && events.filter((e) => e.type === "settled").length >= 2);
    const text = readFileSync(log, "utf8"); expect(text.match(/first after/g)).toHaveLength(1); expect(text.match(/second after/g)).toHaveLength(1);
  });
});
