import { afterEach, describe, expect, it } from "vitest";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentAdapter, AgentKind, Delivery, RawAdapterEvent, StartSpec } from "../src/agent.ts";
import { LocalStore } from "../src/store.ts";
import { WorkerManager } from "../src/worker-manager.ts";
import { fakeClaudeAdapter, claudeReportRun, tmpDir, waitFor, writeClaudeScenario } from "./helpers.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function gate() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

class ControlledAdapter implements AgentAdapter {
  readonly capabilities = { steer: true, followUp: false, interrupt: true, resume: true, history: true, images: false, structuredReport: true, readonly: true };
  hot = true;
  streaming = false;
  inputs: Array<{ text: string; how: Delivery }> = [];
  beforeInput?: () => void;
  afterInput?: () => Promise<void>;
  rejectSend?: () => void;
  rejectStart = false;
  constructor(readonly kind: AgentKind = "codex") {}
  on(_event: "worker-event", _fn: (event: RawAdapterEvent) => void) {}
  async start(spec: StartSpec) {
    await spec.onSession?.(null, null, "thread-12345678");
    this.beforeInput?.();
    await spec.onDelivery?.(spec.commandId, "sending");
    if (this.rejectStart) {
      await spec.onDelivery?.(spec.commandId, "not_delivered");
      throw new Error("invalid parameters");
    }
    this.inputs.push({ text: spec.prompt, how: "prompt" });
    await spec.onDelivery?.(spec.commandId, "delivered", "turn-next");
    this.hot = true; this.streaming = true;
    await this.afterInput?.();
    return { workerId: spec.workerId, sessionId: "thread-12345678", cwd: spec.cwd };
  }
  async send(_id: string, input: { text: string; commandId?: string }, how: Delivery) {
    this.beforeInput?.(); this.rejectSend?.();
    this.inputs.push({ text: input.text, how }); this.streaming = true;
    await this.afterInput?.();
    return {};
  }
  async resume() { this.beforeInput?.(); this.streaming = true; }
  async interrupt() { return { returned: [], alreadySettled: !this.streaming }; }
  async stopProcess() { this.hot = false; this.streaming = false; }
  isRunning() { return this.hot; }
  isStreaming() { return this.streaming; }
}
function setup(kind: AgentKind = "codex", recovery: Record<string, unknown> = {}) {
  const dir = tmpDir("delivery-boundaries");
  const store = new LocalStore(join(dir, "connector.sqlite"));
  const adapter = new ControlledAdapter(kind);
  const events: Array<Record<string, unknown>> = [];
  store.addRepo({ repoId: "repo", name: "repo", path: dir, capability: { kind: "git", gitRoot: dir, defaultBranch: "main", remote: null } });
  store.upsertWorker({ workerId: "worker", threadId: "thread", repoId: "repo", agent: kind, mode: "readonly", state: "idle", sessionId: "thread-12345678" });
  const manager = new WorkerManager({ store, stateDir: dir, adapter, recovery: { idleReclaimMs: 60_000, ...recovery }, emit: (_id, event) => events.push(event) });
  cleanup.push(() => { manager.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, adapter, manager, events };
}

describe("durable input boundaries", () => {
  it("does not let interrupt-then pass an unresolved Codex input", async () => {
    const { manager, store, adapter } = setup();
    store.recordDelivery("worker", "uncertain", "sending");
    await expect(manager.handleCommand("next", "interrupt", { workerId: "worker", then: { text: "must not execute" } })).rejects.toMatchObject({ code: "ambiguous" });
    expect(adapter.inputs).toEqual([]);
  });

  it("rechecks uncertainty when an already-pending send drains", async () => {
    const { manager, store, adapter } = setup();
    store.setWorkerState("worker", "starting");
    const pending = manager.handleCommand("next", "send", { workerId: "worker", text: "must not execute", intent: "now" });
    const rejected = expect(pending).rejects.toMatchObject({ code: "ambiguous" });
    store.recordDelivery("worker", "uncertain", "sending");
    store.setWorkerState("worker", "idle");
    await (manager as any).drainPendingSends("worker");
    await rejected;
    expect(adapter.inputs).toEqual([]);
  });

  it("does not launch a cold queued input returned during prelaunch checks", async () => {
    const entered = gate(), release = gate();
    const { manager, store, adapter } = setup("pi", { findSessionHolders: async () => { entered.resolve(); await release.promise; return []; } });
    adapter.hot = false;
    store.setSessionObservation("worker", "/missing-session.jsonl", null);
    store.queueDeferred("worker", "queued", { text: "returned instruction" });
    const drain = (manager as any).drainDeferredSends("worker");
    await entered.promise;
    await manager.stopProcess("worker");
    release.resolve();
    await drain;
    expect(adapter.inputs).toEqual([]);
    expect(store.deferred("worker", true)[0]?.state).toBe("returned");
  });

  it("honors a stop before the cold queue transition begins", async () => {
    const { manager, store, adapter } = setup("pi");
    adapter.hot = false;
    store.queueDeferred("worker", "queued", { text: "returned instruction" });
    const drain = (manager as any).drainDeferredSends("worker");
    await manager.stopProcess("worker");
    await drain;
    expect(adapter.inputs).toEqual([]);
    expect(store.deferred("worker", true)[0]?.state).toBe("returned");
  });

  it.each([true, false])("claims an in-flight state before %s-hot manual resume submits work", async (hot) => {
    const { manager, store, adapter } = setup();
    adapter.hot = hot;
    // This test isolates the delivery boundary from the machine's unrelated Codex processes.
    (manager as any).checkSessionBeforeRelaunch = async () => undefined;
    const observed: string[] = [];
    adapter.beforeInput = () => { observed.push(store.getWorker("worker")!.state); };
    await manager.handleCommand("resume", "resume", { workerId: "worker" });
    expect(observed).toHaveLength(1);
    expect(["starting", "running", "recovering"]).toContain(observed[0]);
  });

  it("steers now input while after work is queued", async () => {
    const { manager, store, adapter } = setup();
    store.setWorkerState("worker", "running"); adapter.streaming = true;
    store.queueDeferred("worker", "later", { text: "later task" });
    await expect(manager.handleCommand("now", "send", { workerId: "worker", text: "stop editing that file", intent: "now" })).resolves.toMatchObject({ delivery: "steer" });
    expect(adapter.inputs).toEqual([{ text: "stop editing that file", how: "steer" }]);
    expect(store.deferred("worker").map((send) => send.commandId)).toEqual(["later"]);
  });

  it("returns known-unsent work when authentication settlement breaks the worker", async () => {
    const { manager, store, events } = setup();
    store.setWorkerState("worker", "running");
    store.queueDeferred("worker", "later", { text: "later task" });
    await (manager as any).onAdapterEvent({ type: "settled", workerId: "worker", outcome: "error", errorClass: "auth" });
    expect(store.deferred("worker", true)[0]?.state).toBe("returned");
    expect(events).toContainEqual(expect.objectContaining({ type: "queue_returned", texts: ["later task"] }));
  });

  it("pumps deferred work after live Codex crash reconciliation restores completion", async () => {
    const { manager, store, adapter, dir } = setup();
    const file = join(dir, "rollout.jsonl");
    writeFileSync(file, [
      { type: "session_meta", payload: { id: "thread-12345678" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: '{"status":"done","summary":"finished"}' } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    store.setSessionIdentity("worker", "thread-12345678", file);
    store.setWorkerState("worker", "running");
    store.recordDelivery("worker", "previous", "delivered", "turn-1");
    store.queueDeferred("worker", "later", { text: "next task" });
    adapter.hot = false;
    (manager as any).checkSessionBeforeRelaunch = async () => undefined;
    await (manager as any).onAdapterEvent({ type: "process_exit", workerId: "worker", code: 1, signal: null, unexpected: true });
    await waitFor(() => adapter.inputs.length > 0, 250, "recovered FIFO must drain");
    expect(adapter.inputs).toEqual([{ text: "next task", how: "prompt" }]);
  });

  it.each([true, false])("drains FIFO after a terminal event precedes delivery return (hot=%s)", async (hot) => {
    const { manager, store, adapter, events } = setup();
    adapter.hot = hot;
    (manager as any).checkSessionBeforeRelaunch = async () => undefined;
    adapter.afterInput = async () => {
      adapter.streaming = false;
      await (manager as any).onAdapterEvent({ type: "settled", workerId: "worker", outcome: "unreported" });
    };
    store.queueDeferred("worker", "head", { text: "first" });
    store.queueDeferred("worker", "tail", { text: "second" });
    await (manager as any).drainDeferredSends("worker");
    await waitFor(() => store.deferred("worker", true).every((send) => send.state === "delivered"), 250, "early terminal FIFO continuation");
    expect(adapter.inputs.map((input) => input.text)).toEqual(["first", "second"]);
    expect(store.getWorker("worker")?.state).toBe("idle");
    expect(events.at(-1)?.type).toBe("settled");
  });

  it("preserves a terminal idle state when cold relaunch returns afterwards", async () => {
    const { manager, store, adapter, events } = setup();
    adapter.hot = false;
    (manager as any).checkSessionBeforeRelaunch = async () => undefined;
    adapter.afterInput = async () => {
      adapter.streaming = false;
      await (manager as any).onAdapterEvent({ type: "settled", workerId: "worker", outcome: "unreported" });
    };
    await manager.handleCommand("cold", "send", { workerId: "worker", text: "quick task", intent: "auto" });
    expect(store.getWorker("worker")).toMatchObject({ state: "idle", lastOutcome: "unreported" });
    const terminal = events.findIndex((event) => event.type === "settled");
    expect(events.slice(terminal + 1).some((event) => event.type === "started")).toBe(false);
  });

  it("breaks an uncertain queue head and returns its unsent successors", async () => {
    const { manager, store, adapter, events } = setup();
    store.queueDeferred("worker", "head", { text: "uncertain" });
    store.queueDeferred("worker", "tail", { text: "known unsent" });
    adapter.rejectSend = () => { store.recordDelivery("worker", "head", "sending"); throw new Error("connection lost"); };
    await (manager as any).drainDeferredSends("worker");
    expect(store.getWorker("worker")).toMatchObject({ state: "broken", lastOutcome: "delivery_ambiguous" });
    expect(store.deferred("worker", true).map((send) => send.state)).toEqual(["ambiguous", "returned"]);
    expect(events).toContainEqual(expect.objectContaining({ type: "queue_returned", texts: ["known unsent"] }));
    expect(events).toContainEqual(expect.objectContaining({ type: "settled", lastText: expect.stringMatching(/uncertain|inspect/i) }));
  });

  it("returns a definitely rejected queue head without preserving a false uncertain receipt", async () => {
    const { manager, store, adapter, events } = setup();
    adapter.hot = false; adapter.rejectStart = true;
    (manager as any).checkSessionBeforeRelaunch = async () => undefined;
    store.queueDeferred("worker", "head", { text: "rejected" });
    store.queueDeferred("worker", "tail", { text: "known unsent" });
    await (manager as any).drainDeferredSends("worker");
    expect(store.deliveries("worker")).toEqual([]);
    expect(store.deferred("worker", true).map((send) => send.state)).toEqual(["returned", "returned"]);
    expect(events).toContainEqual(expect.objectContaining({ type: "queue_returned", texts: ["rejected", "known unsent"] }));
    expect(store.getWorker("worker")?.state).toBe("idle");
  });

  it.each([false, true])("includes actionable lastText when recovery finds ambiguity (queued=%s)", async (queued) => {
    const { manager, store, events } = setup();
    store.setWorkerState("worker", "running");
    if (queued) store.queueDeferred("worker", "input", { text: "uncertain" });
    store.recordDelivery("worker", "input", "sending");
    await manager.reconcileStartup();
    expect(events).toContainEqual(expect.objectContaining({ type: "settled", lastText: expect.stringMatching(/inspect/i) }));
  });

  it("does not deliver Claude input after stop during its write-ahead hook", async () => {
    const dir = tmpDir("claude-stopped-write-ahead"), entered = gate(), release = gate();
    const log = join(dir, "prompts.jsonl");
    const adapter = fakeClaudeAdapter(dir, writeClaudeScenario(dir, "claude", [claudeReportRun({ status: "done", summary: "done" })]), { FAKE_CLAUDE_LOG: log });
    cleanup.push(async () => { await adapter.stopProcess("claude-worker"); rmSync(dir, { recursive: true, force: true }); });
    const start = adapter.start({ workerId: "claude-worker", threadId: "thread", cwd: dir, mode: "write", prompt: "must not execute", commandId: "queued", onSession: async () => { entered.resolve(); await release.promise; } });
    const result = start.then(() => "started", () => "stopped");
    await entered.promise;
    await adapter.stopProcess("claude-worker");
    release.resolve();
    expect(await result).toBe("stopped");
    expect(existsSync(log)).toBe(false);
  });

  it("awaits Claude's write-ahead hook before writing the prompt", async () => {
    const dir = tmpDir("claude-write-ahead");
    const log = join(dir, "prompts.jsonl");
    const adapter = fakeClaudeAdapter(dir, writeClaudeScenario(dir, "claude", [claudeReportRun({ status: "done", summary: "done" })]), { FAKE_CLAUDE_LOG: log });
    cleanup.push(async () => { await adapter.stopProcess("claude-worker"); rmSync(dir, { recursive: true, force: true }); });
    let called = false;
    await adapter.start({ workerId: "claude-worker", threadId: "thread", cwd: dir, mode: "write", prompt: "queued task", commandId: "queued", onSession: async () => {
      await Promise.resolve();
      expect(existsSync(log)).toBe(false);
      called = true;
    } });
    expect(called).toBe(true);
  });
});
