import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodexAdapter, detectCodex } from "../src/codex-adapter.ts";
import type { RawAdapterEvent, StartSpec } from "../src/agent.ts";
import { tmpDir, waitFor } from "./helpers.ts";
import { pidAlive, processStartTime } from "../src/locks.ts";

const adapters: CodexAdapter[] = [];
afterEach(async () => { for (const a of adapters.splice(0)) for (const p of a.workerPids()) await a.stopProcess(p.workerId); });
function setup(options = {}) {
  const dir = tmpDir("codex-adapter");
  const command = [process.execPath, join(import.meta.dirname, "fake-codex.mjs")];
  const adapter = new CodexAdapter({ command, env: { FAKE_CODEX_DIR: dir, FAKE_CODEX_OPTIONS: JSON.stringify(options) }, requestTimeoutMs: 1000, stopGraceMs: 20 });
  adapters.push(adapter);
  const events: RawAdapterEvent[] = [];
  adapter.on("worker-event", (e) => events.push(e));
  const spec: StartSpec = { workerId: "worker-codex", threadId: "orbit-thread", cwd: dir, mode: "write", prompt: "compute 42", commandId: "start-1" };
  const requests = () => readFileSync(join(dir, "requests.jsonl"), "utf8").trim().split("\n").map((v) => JSON.parse(v));
  return { dir, command, adapter, spec, events, requests };
}
describe("Codex app-server", () => {
  it("persists real thread id before input, processes early fragmented duplicate notifications once", async () => {
    const t = setup({ fragment: true, early: true, duplicate: true, noPath: true });
    let persisted = false;
    const receipts: string[] = [];
    t.spec.onSession = async (path, _, id) => {
      expect(path).toBeNull(); expect(id).toMatch(/^019a/);
      expect(t.requests().some((r) => r.method === "turn/start")).toBe(false);
      await new Promise((r) => setTimeout(r, 20)); persisted = true;
    };
    t.spec.onDelivery = (_, state) => { expect(persisted).toBe(true); receipts.push(state); };
    const handle = await t.adapter.start(t.spec);
    expect(handle.sessionId).not.toBe("different-session-tree-root");
    await waitFor(() => t.events.find((e) => e.type === "settled"));
    expect(t.events.filter((e) => e.type === "settled")).toEqual([expect.objectContaining({ outcome: "reported", report: expect.objectContaining({ answer: "42" }), usage: undefined })]);
    expect(receipts).toEqual(["sending", "delivered"]);
    const input = t.requests().find((r) => r.method === "turn/start").params;
    expect(input.sandboxPolicy).toEqual({ type: "workspaceWrite", writableRoots: [t.dir], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
    expect(input.outputSchema.properties.answer).toBeDefined();
  });
  it.each([{ invalid: true, outcome: "unreported" }, { failed: true, outcome: "error" }])("adjudicates $outcome", async ({ outcome, ...options }) => {
    const t = setup(options); await t.adapter.start(t.spec);
    const event = await waitFor(() => t.events.find((e) => e.type === "settled"));
    expect(event).toMatchObject({ outcome });
    if (outcome === "error") expect(event).toMatchObject({ errorClass: "auth" });
  });
  it("steers the current turn and waits for actual cancellation", async () => {
    const t = setup({ hold: true }); await t.adapter.start(t.spec);
    await t.adapter.send(t.spec.workerId, { text: "change", commandId: "send-1" }, "steer");
    expect(t.requests().find((r) => r.method === "turn/steer").params.expectedTurnId).toBe("turn-1");
    await t.adapter.interrupt(t.spec.workerId);
    expect(t.adapter.isStreaming(t.spec.workerId)).toBe(true);
    await waitFor(() => t.events.find((e) => e.type === "settled"));
    expect(t.events).toContainEqual(expect.objectContaining({ outcome: "aborted" }));
  });
  it("waits for activity when the turn-start receipt precedes control readiness", async () => {
    const t = setup({ hold: true, delayActivity: 100 }); await t.adapter.start(t.spec);
    const sending = t.adapter.send(t.spec.workerId, { text: "early steer", commandId: "early" }, "steer");
    expect(t.requests().some((r) => r.method === "turn/steer")).toBe(false);
    await sending;
    expect(t.requests().filter((r) => r.method === "turn/steer")).toHaveLength(1);
  });
  it("natural completion wins interrupt race", async () => {
    const t = setup({ hold: true, completeOnInterrupt: true }); await t.adapter.start(t.spec);
    expect(await t.adapter.interrupt(t.spec.workerId)).toMatchObject({ alreadySettled: true });
    await waitFor(() => t.events.find((e) => e.type === "settled"));
    expect(t.events).toContainEqual(expect.objectContaining({ outcome: "reported" }));
  });
  it("waits for terminal evidence when a no-active-turn RPC error precedes completion", async () => {
    const t = setup({ hold: true, completeAfterInterruptError: true }); await t.adapter.start(t.spec);
    expect(await t.adapter.interrupt(t.spec.workerId)).toMatchObject({ alreadySettled: true });
    await waitFor(() => t.events.find((e) => e.type === "settled"));
    expect(t.events).toContainEqual(expect.objectContaining({ outcome: "reported" }));
  });
  it("recovers a missing terminal notification from the exact server-owned turn", async () => {
    const t = setup({ hold: true, missingTerminal: true }); await t.adapter.start(t.spec);
    expect(await t.adapter.interrupt(t.spec.workerId)).toMatchObject({ alreadySettled: true });
    await waitFor(() => t.events.find((e) => e.type === "settled"));
    expect(t.events).toContainEqual(expect.objectContaining({ outcome: "reported" }));
  });
  it("denies server requests and settles as error instead of silently approving", async () => {
    const t = setup({ serverRequest: true }); await t.adapter.start(t.spec);
    await waitFor(() => t.events.find((e) => e.type === "settled"));
    expect(t.events).toContainEqual(expect.objectContaining({ outcome: "error" }));
    expect(readFileSync(join(t.dir, "responses.jsonl"), "utf8")).toContain("noninteractive");
  });
  it("readonly fails closed with external tools and applies explicit sandbox otherwise", async () => {
    const bad = setup({ external: true }); bad.spec.mode = "readonly";
    await expect(bad.adapter.start(bad.spec)).rejects.toMatchObject({ code: "unsupported_capability" });
    expect(bad.requests().some((r) => r.method === "turn/start")).toBe(false);
    const good = setup(); good.spec.mode = "readonly"; await good.adapter.start(good.spec);
    expect(good.requests().find((r) => r.method === "turn/start").params.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
  });
  it("times out handshake and rejects pending requests on early exit", async () => {
    const t = setup({ initTimeout: true }); await expect(t.adapter.start(t.spec)).rejects.toMatchObject({ code: "timeout" });
    const exited = setup({ exitBeforeReceipt: true }); await expect(exited.adapter.start(exited.spec)).rejects.toMatchObject({ code: "not_running" });
  });
  it("resumes by thread.id and omits unset model overrides", async () => {
    const t = setup(); const h = await t.adapter.start(t.spec);
    await waitFor(() => t.events.find((e) => e.type === "settled"));
    await t.adapter.stopProcess(t.spec.workerId);
    await t.adapter.start({ ...t.spec, commandId: "second", resumeSessionId: h.sessionId });
    const req = t.requests().find((r) => r.method === "thread/resume");
    expect(req.params.threadId).toBe(h.sessionId); expect(req.params).not.toHaveProperty("model"); expect(req.params).not.toHaveProperty("path");
  });
  it.each([
    { rpcCode: -32600, thread: "019a0000-0000-7000-8000-000000000001", code: "session_in_use", retriable: true },
    { rpcCode: -32600, thread: "different-thread", code: "codex_rpc", retriable: false },
    { rpcCode: -32000, thread: "019a0000-0000-7000-8000-000000000001", code: "codex_rpc", retriable: false },
  ])("classifies only the exact native writer conflict ($rpcCode / $thread)", async ({ rpcCode, thread, code, retriable }) => {
    const t = setup({ resumeError: { code: rpcCode, message: `thread ${thread} already has an active writer` } });
    const h = await t.adapter.start(t.spec);
    await waitFor(() => t.events.find((e) => e.type === "settled"));
    await t.adapter.stopProcess(t.spec.workerId);
    const receipts: string[] = [];
    await expect(t.adapter.start({ ...t.spec, resumeSessionId: h.sessionId,
      onSession: () => { throw new Error("Conflict must precede persistence/input"); },
      onDelivery: (_, state) => { receipts.push(state); },
    })).rejects.toMatchObject({ code, retriable });
    expect(receipts).toEqual([]);
    expect(t.requests().filter((r) => r.method === "turn/start")).toHaveLength(1);
    expect(t.adapter.isRunning(t.spec.workerId)).toBe(false);
    expect(JSON.parse(readFileSync(join(t.dir, "args.json"), "utf8"))).toContain('experimental_thread_store.type="local"');
  });
  it("refuses missing authentication before sending work", async () => {
    const t = setup({ noAuth: true }); await expect(t.adapter.start(t.spec)).rejects.toMatchObject({ code: "auth" });
    expect(t.requests().some((r) => r.method === "turn/start")).toBe(false);
  });
  it("rejects malformed protocol and ignores late terminals from a previous turn", async () => {
    const broken = setup({ malformed: true }); await expect(broken.adapter.start(broken.spec)).rejects.toMatchObject({ code: "protocol_error" });
    const t = setup({ latePrevious: true }); await t.adapter.start(t.spec);
    await waitFor(() => t.events.filter((e) => e.type === "settled").length === 1);
    await t.adapter.send(t.spec.workerId, { text: "next", commandId: "next" }, "prompt");
    await waitFor(() => t.events.filter((e) => e.type === "settled").length === 2);
    expect(t.events.filter((e) => e.type === "settled").every((e) => e.outcome === "reported")).toBe(true);
  });
  it("keeps inherited environment when adding per-process overrides", async () => {
    const t = setup(); await t.adapter.start(t.spec);
    expect(JSON.parse(readFileSync(join(t.dir, "env.json"), "utf8"))).toEqual({ home: true, path: true, override: t.dir });
  });
  it("cleans up failed spawns so retry is not blocked by a phantom runtime", async () => {
    const t = setup();
    const missing = new CodexAdapter({ command: [join(t.dir, "missing")], stopGraceMs: 20 });
    for (let i = 0; i < 2; i++) {
      await expect(missing.start(t.spec)).rejects.toMatchObject({ code: "ENOENT" });
      expect(missing.isRunning(t.spec.workerId)).toBe(false);
    }
  });
  it("does not classify process exit after a terminal as a second crash", async () => {
    const t = setup({ exitAfterTerminal: true }); await t.adapter.start(t.spec);
    await waitFor(() => t.events.find((e) => e.type === "process_exit"));
    expect(t.events.filter((e) => e.type === "settled")).toHaveLength(1);
    expect(t.events).toContainEqual(expect.objectContaining({ type: "process_exit", unexpected: false }));
  });
  it.each([-32600, -32601, -32602, -32000])("preserves rejection code %s and clears only pre-execution intent", async (code) => {
    const t = setup({ rejectStart: code }); const receipts: string[] = [];
    t.spec.onDelivery = (_, state) => { receipts.push(state); };
    await expect(t.adapter.start(t.spec)).rejects.toMatchObject({ rpcCode: code });
    expect(receipts).toEqual(code === -32000 ? ["sending"] : ["sending", "not_delivered"]);
  });
  it("records definitely rejected steer as not delivered", async () => {
    const t = setup({ hold: true, rejectSteer: -32602 }); const receipts: string[] = [];
    t.spec.onDelivery = (command, state) => { if (command === "rejected") receipts.push(state); };
    await t.adapter.start(t.spec);
    await expect(t.adapter.send(t.spec.workerId, { text: "change", commandId: "rejected" }, "steer")).rejects.toMatchObject({ rpcCode: -32602 });
    expect(receipts).toEqual(["sending", "not_delivered"]);
  });
  it("stops detached owned shell jobs before emitting interrupted settlement", async () => {
    const t = setup({ hold: true, detachedJob: true }); await t.adapter.start(t.spec);
    const pid = Number(readFileSync(join(t.dir, "job-pid"), "utf8"));
    const identity = processStartTime(pid);
    let jobAliveAtSettlement: boolean | undefined;
    t.adapter.on("worker-event", (event) => {
      if (event.type === "settled") jobAliveAtSettlement = pidAlive(pid);
    });
    try {
      expect(pidAlive(pid)).toBe(true);
      await t.adapter.interrupt(t.spec.workerId);
      await waitFor(() => t.events.find((e) => e.type === "settled"));
      expect(jobAliveAtSettlement).toBe(false);
      expect(t.adapter.isRunning(t.spec.workerId)).toBe(false);
    } finally {
      if (identity && processStartTime(pid) === identity) { try { process.kill(pid, "SIGKILL"); } catch {} }
    }
  });
  it("detects only supported CLI metadata and missing commands", () => {
    const t = setup(); expect(detectCodex(t.command).installed).toBe(true);
    expect(detectCodex([join(t.dir, "missing")]).installed).toBe(false);
    for (const version of ["0.165.0", "0.166.0-alpha.5", "0.168.0", "0.166.0-beta.1"]) {
      expect(detectCodex([...t.command, `--fake-version=codex-cli ${version}`]).installed).toBe(false);
    }
    for (const version of ["0.166.0-alpha.6", "0.166.0", "0.167.0"]) {
      expect(detectCodex([...t.command, `--fake-version=codex-cli ${version}`]).installed).toBe(true);
    }
  });
  it("probes codex on an explicitly supplied service PATH", () => {
    const dir = tmpDir("codex-detect");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const fake = join(import.meta.dirname, "fake-codex.mjs");
    writeFileSync(
      join(bin, "codex"),
      `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`,
      { mode: 0o755 },
    );

    expect(detectCodex(["codex"], { PATH: bin })).toMatchObject({ installed: true, version: "codex-cli 0.166.0-alpha.6" });
    expect(
      detectCodex(["codex", "--fake-version=codex-cli 0.168.0"], { PATH: bin }).installed,
    ).toBe(false);

    const empty = join(dir, "empty");
    mkdirSync(empty);
    expect(detectCodex(["codex"], { PATH: empty })).toMatchObject({ installed: false });
  });
  it("treats a version probe that exceeds the five-second budget as unavailable", () => {
    const slow = join(tmpDir("codex-slow"), "slow.mjs");
    writeFileSync(slow, "setTimeout(() => {}, 10_000);\n");
    const probe = detectCodex([process.execPath, slow]);
    expect(probe.installed).toBe(false);
    expect(probe.diagnostic).toContain("timed out");
  }, 10_000);
});
