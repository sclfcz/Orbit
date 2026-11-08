// Opt-in only: creates new Orbit-owned threads in a dedicated temporary Git repository.
// Never joins a desktop session, rewrites global config, copies auth, pushes or deploys.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodexAdapter, detectCodex } from "../src/codex-adapter.ts";
import { CodexTransport } from "../src/codex-transport.ts";
import { childEnv } from "../src/pi-adapter.ts";
import { codexSessionPath, inspectCodexTail } from "../src/codex-session.ts";
import { readFullSessionHistory } from "../src/full-session-history.ts";
import { git, makeGitRepo, tmpDir, waitFor } from "./helpers.ts";
import { findCorrelatedShellEvidence } from "./codex-live-helpers.ts";
import { VERSION } from "../src/version.ts";

describe.skipIf(process.env.ORBIT_CODEX_LIVE !== "1")("real Codex acceptance", () => {
  it("handshakes and reads configuration without calling a model", async () => {
    const version = detectCodex(); expect(version.installed).toBe(true);
    const dir = tmpDir("orbit-codex-live-probe");
    const rpc = new CodexTransport(["codex", "app-server", "--listen", "stdio://"], dir, childEnv(), () => {}, () => {}, 15000);
    try {
      await rpc.request("initialize", { clientInfo: { name: "orbit_connector", title: "Orbit", version: VERSION } });
      rpc.write({ method: "initialized", params: {} });
      const config = await rpc.request("config/read", { cwd: dir, includeLayers: false });
      expect(config.config).toBeTruthy();
      writeFileSync("/tmp/orbit-codex-live-probe.json", JSON.stringify({ version: version.version, handshake: "passed", configRead: "passed" }));
    } finally { rpc.child.kill("SIGTERM"); }
  }, 20000);

  it("writes in a test worktree, reports, cold-resumes the same thread and reads its local record", async () => {
    const dir = tmpDir("orbit-codex-live-write"); const main = await makeGitRepo(dir); const repo = join(dir, "worktree");
    await git(main, ["worktree", "add", "-b", "orbit-smoke", repo]);
    const a = new CodexAdapter({ requestTimeoutMs: 20000 });
    const events: any[] = []; a.on("worker-event", (e) => events.push(e));
    let identity: string | undefined;
    let turnId: string | undefined;
    try {
      const spec = { workerId: "orbit-live", threadId: "test", cwd: repo, mode: "write" as const,
        prompt: "Create orbit-smoke.txt containing exactly orbit-smoke. Do not use external tools or network, do not commit or push. Then report done using the required JSON schema.", commandId: "live-start",
        onSession: (_: string | null, __: string | null, id?: string) => { identity = id; },
        onDelivery: (_: string, state: string, id?: string) => { if (state === "delivered") turnId = id; } };
      const h = await a.start(spec); expect(identity).toBe(h.sessionId);
      const settled = await waitFor(() => events.find((e) => e.type === "settled"), 60000, "real Codex report");
      expect(settled.outcome).toBe("reported"); expect(existsSync(join(repo, "orbit-smoke.txt"))).toBe(true);
      // The original server still owns this idle thread. A second server must refuse
      // thread/resume before input, even without a model turn currently running.
      const contender = new CodexAdapter({ requestTimeoutMs: 20000 });
      const competingInput: string[] = [];
      try {
        await expect(contender.start({ ...spec, workerId: "orbit-contender", resumeSessionId: h.sessionId,
          onSession: () => { throw new Error("Native resume accepted a second writer"); },
          onDelivery: (_, state) => { competingInput.push(state); },
        })).rejects.toMatchObject({ code: "session_in_use", retriable: true });
        expect(competingInput).toEqual([]);
        expect(a.isRunning(spec.workerId)).toBe(true);
      } finally { await contender.stopProcess("orbit-contender"); }
      await a.stopProcess(spec.workerId); events.length = 0;
      const resumed = await a.start({ ...spec, resumeSessionId: h.sessionId, commandId: "live-resume", prompt: "Do not change files. Report the contents of orbit-smoke.txt from our previous turn in answer." });
      expect(resumed.sessionId).toBe(h.sessionId);
      const follow = await waitFor(() => events.find((e) => e.type === "settled"), 60000, "real Codex continuation");
      expect(follow.outcome).toBe("reported");
      const file = codexSessionPath(h.sessionId, resumed.sessionFile ?? h.sessionFile); expect(file).toBeTruthy();
      expect((await readFullSessionHistory(file!, undefined, 8000)).entries.length).toBeGreaterThan(0);
      expect(existsSync(join(main, "orbit-smoke.txt"))).toBe(false);
      const recovered = inspectCodexTail(file, h.sessionId, turnId); expect(recovered.kind).toBe("settled");
      writeFileSync("/tmp/orbit-codex-live-write.json", JSON.stringify({ version: detectCodex().version, worktreeWriteAndReport: "passed", coldAdapterResume: "passed", localHistory: "passed", terminalTailEvidence: recovered.kind, testRepo: repo, threadId: h.sessionId }));
    } finally { await a.stopProcess("orbit-live"); }
  }, 150000);
  it("proves the native sandbox denies an actual write, with a writable positive control", async () => {
    const dir = tmpDir("orbit-codex-live-sandbox"); const repo = await makeGitRepo(dir);
    const rpc = new CodexTransport(["codex", "app-server", "--listen", "stdio://"], repo, childEnv(), () => {}, () => {}, 20000);
    const file = join(repo, "sandbox-probe.txt");
    try {
      await rpc.request("initialize", { clientInfo: { name: "orbit_acceptance", version: "1" } });
      rpc.write({ method: "initialized", params: {} });
      const command = ["/bin/sh", "-c", "printf orbit-sandbox-probe > sandbox-probe.txt"];
      const denied = await rpc.request("command/exec", { command, cwd: repo, timeoutMs: 10000,
        sandboxPolicy: { type: "readOnly", networkAccess: false } });
      expect(denied.exitCode).not.toBe(0);
      expect(denied.stderr).toMatch(/operation not permitted|permission denied|read-only file system/i);
      expect(existsSync(file)).toBe(false);
      const allowed = await rpc.request("command/exec", { command, cwd: repo, timeoutMs: 10000,
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [repo], networkAccess: false,
          excludeTmpdirEnvVar: true, excludeSlashTmp: true } });
      expect(allowed.exitCode).toBe(0);
      expect(readFileSync(file, "utf8")).toBe("orbit-sandbox-probe");
      writeFileSync("/tmp/orbit-codex-live-sandbox.json", JSON.stringify({
        version: detectCodex().version, nativeSandbox: "passed", denied, allowed,
        scope: "standalone command/exec; does not certify inherited external tools or a readonly model turn",
      }));
    } finally { rpc.child.kill("SIGTERM"); }
  }, 40000);

  it("checks readonly or explicitly refuses inherited external tools", async () => {
    const dir = tmpDir("orbit-codex-live-readonly"); const repo = await makeGitRepo(dir);
    const a = new CodexAdapter({ requestTimeoutMs: 20000 }); const events: any[] = []; a.on("worker-event", (e) => events.push(e));
    try {
      try {
        await a.start({ workerId: "live-readonly", threadId: "test", cwd: repo, mode: "readonly", commandId: "live-readonly",
          prompt: "Try to create readonly-probe.txt containing probe in the current directory using the local shell. If sandbox denies it, report blocked explaining the denial. Do not use external tools or network." });
      } catch (error) {
        if ((error as any).code !== "unsupported_capability") throw error;
        writeFileSync("/tmp/orbit-codex-live-readonly.json", JSON.stringify({ readonly: "refused_unverifiable_external_tools", realReadonlyEnforcement: "not_verified" }));
        return;
      }
      const settled = await waitFor(() => events.find((e) => e.type === "settled"), 60000);
      expect(settled.outcome).toBe("reported"); expect(existsSync(join(repo, "readonly-probe.txt"))).toBe(false);
      // An absent file can also mean the model declined to attempt a write. Only the
      // separate command/exec probe supplies direct OS-denial evidence.
      writeFileSync("/tmp/orbit-codex-live-readonly.json", JSON.stringify({ readonly: "reported_without_artifact", realReadonlyEnforcement: "not_verified" }));
    } finally { await a.stopProcess("live-readonly"); }
  }, 90000);

  it.skipIf(!process.env.ORBIT_CODEX_READONLY_HOME)("reads through a clean readonly model turn and proves its attempted write was denied", async () => {
    const home = process.env.ORBIT_CODEX_READONLY_HOME!;
    const dir = tmpDir("orbit-codex-live-clean-readonly"); const repo = await makeGitRepo(dir);
    const marker = `orbit-readonly-${randomUUID()}`;
    const input = join(repo, "readonly-input.txt"); const output = join(repo, "readonly-probe.txt");
    writeFileSync(input, `${marker}\n`);
    const command = "cat readonly-input.txt; printf orbit-readonly-must-be-denied > readonly-probe.txt";
    const a = new CodexAdapter({ env: { CODEX_HOME: home }, requestTimeoutMs: 20000 });
    const events: any[] = []; a.on("worker-event", (e) => events.push(e));
    try {
      // Unlike the inherited-config check, refusal here fails the test: a real
      // model turn and correlated native tool output are required for acceptance.
      const handle = await a.start({ workerId: "live-clean-readonly", threadId: "test", cwd: repo, mode: "readonly", commandId: "clean-readonly",
        prompt: `Validate this readonly sandbox using the local shell. Execute exactly this command once:\n\n${command}\n\nRead the actual output; do not guess the input file contents. Do not use external integrations, alter the command, attempt alternate writes, commit or push. A denied write is the expected result. Finish with the required JSON report, status done, including the input file's exact contents and the write denial/exit code in answer.` });
      const settled = await waitFor(() => events.find((e) => e.type === "settled"), 90000, "clean readonly model report");
      expect(settled).toMatchObject({ outcome: "reported", report: { status: "done" } });
      expect(settled.report.answer).toContain(marker);
      expect(readFileSync(input, "utf8")).toBe(`${marker}\n`);
      expect(existsSync(output)).toBe(false);
      await a.stopProcess("live-clean-readonly");
      const file = codexSessionPath(handle.sessionId, handle.sessionFile, home);
      expect(file).toBeTruthy();
      const { toolOutput } = findCorrelatedShellEvidence(file!, command);
      expect(toolOutput).toContain(marker);
      expect(toolOutput).toMatch(/operation not permitted|permission denied|read-only file system/i);
      expect(toolOutput).toMatch(/"exit_code"\s*:\s*[1-9]\d*|exited with code\s+[1-9]\d*/i);
      writeFileSync("/tmp/orbit-codex-live-clean-readonly.json", JSON.stringify({
        version: detectCodex().version, readonlyModel: "passed", actualRead: true,
        correlatedShellWriteDenied: true, inputUnchanged: true, outputAbsent: true,
        report: "done", threadId: handle.sessionId, testRepo: repo,
      }));
    } finally { await a.stopProcess("live-clean-readonly"); }
  }, 120000);

  it("steers and interrupts a real shell job without leaving background writes alive", async () => {
    const dir = tmpDir("orbit-codex-live-controls"); const repo = await makeGitRepo(dir);
    const a = new CodexAdapter({ requestTimeoutMs: 20000 }); const events: any[] = []; a.on("worker-event", (e) => events.push(e));
    try {
      await a.start({ workerId: "live-controls", threadId: "test", cwd: repo, mode: "write", commandId: "controls-start",
        prompt: "Run this exact shell command in the current directory: printf started > control-started.txt; sleep 20; printf finished > control-finished.txt . Wait for the shell to finish before reporting. Do not shorten the sleep, use external tools/network, commit or push. Finish with the required report." });
      await waitFor(() => existsSync(join(repo, "control-started.txt")), 60000, "real shell started before control");
      expect(existsSync(join(repo, "control-finished.txt"))).toBe(false);
      const observedStart = Date.now();
      await a.send("live-controls", { text: "Keep the same task and mention control-steer-confirmed in your final report.", commandId: "controls-steer" }, "steer");
      const interrupt = await a.interrupt("live-controls");
      const settled = await waitFor(() => events.find((e) => e.type === "settled"), 30000);
      expect(settled.outcome).toBe("aborted");
      expect(a.isRunning("live-controls")).toBe(false);
      // Wait beyond the original shell deadline: native turn_aborted alone previously
      // left a unified-exec shell alive, which wrote this file after cancellation.
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, observedStart + 22000 - Date.now())));
      expect(existsSync(join(repo, "control-finished.txt"))).toBe(false);
      writeFileSync("/tmp/orbit-codex-live-controls.json", JSON.stringify({ steer: "accepted", interruptRpc: "accepted", actualTerminal: settled.outcome,
        ownedProcessStopped: true, noLateShellWrite: true, alreadySettled: interrupt.alreadySettled ?? false, testRepo: repo }));
    } finally { await a.stopProcess("live-controls"); }
  }, 120000);
});
