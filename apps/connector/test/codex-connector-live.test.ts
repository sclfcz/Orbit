// Opt in with ORBIT_CODEX_LIVE=1. Uses existing login, temporary Git/SQLite state,
// real child Connectors and real Codex. Never disables production ownership checks.
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { LocalStore } from "../src/store.ts";
import { EventLog } from "../src/events.ts";
import { codexSessionPath } from "../src/codex-session.ts";
import { CodexTransport } from "../src/codex-transport.ts";
import { childEnv } from "../src/pi-adapter.ts";
import { killOrphans, listDescendants, type ProcRef } from "../src/descendants.ts";
import { processStartTime } from "../src/locks.ts";
import { makeGitRepo, tmpDir, waitFor } from "./helpers.ts";
import { startMockSteward, type MockSteward } from "./mock-steward.ts";

type Frame = Record<string, any>;
const LIVE_TIMEOUT = 240_000;

async function command(mock: MockSteward, kind: string, args: Frame, id?: string): Promise<Frame> {
  const cmdId = mock.sendCmd(kind, args, id);
  return waitFor(() => mock.resultsFor(cmdId), 45_000, `${kind} cmd_result over WS`);
}

// Reconstruct the real rollout exclusively from wire fragments, checking every offset
// and cursor. Small pages force splitting records without manufacturing session data.
async function historyOverWire(mock: MockSteward, workerId: string) {
  const records = new Map<string, { data: string; total: number }>();
  let since: string | undefined;
  let pages = 0;
  let fragments = 0;
  let splitFragments = 0;
  for (; pages < 1000; pages++) {
    const req = mock.sendHistoryReq(workerId, { format: "full", maxBytes: 8000, since });
    let n = 0;
    let last: Frame;
    for (;;) {
      const frame = await waitFor(() => mock.errorsFor(req) ?? mock.historyChunksFor(req)[n], 15_000, "history_chunk over WS") as Frame;
      expect(frame.t, JSON.stringify(frame)).toBe("history_chunk");
      expect(frame).toMatchObject({ re: req, n, format: "full" });
      expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(262144);
      for (const entry of frame.entries) {
        const f = entry.fragment;
        expect(f).toBeTruthy();
        const record = records.get(entry.id) ?? { data: "", total: f.total };
        expect(f.offset).toBe(record.data.length);
        expect(f.total).toBe(record.total);
        record.data += f.data;
        expect(record.data.length).toBeLessThanOrEqual(record.total);
        records.set(entry.id, record);
        fragments++;
        if (f.offset > 0) splitFragments++;
      }
      mock.ackHistory(req, n++);
      last = frame;
      if (frame.done) break;
    }
    if (!last!.truncated) {
      for (const record of records.values()) expect(record.data.length).toBe(record.total);
      return { pages: pages + 1, fragments, splitFragments, lines: [...records.values()].map((r) => r.data) };
    }
    expect(typeof last!.cursor).toBe("string");
    expect(last!.cursor).not.toBe(since);
    since = last!.cursor;
  }
  throw new Error("History did not reach EOF within 1000 pages");
}

describe.skipIf(process.env.ORBIT_CODEX_LIVE !== "1")("real Codex full Connector process restart", () => {
  it("persists identity/seq, streams history, classifies cold continuation and never replays a hard-killed task", async () => {
    const dir = tmpDir("orbit-codex-connector-live");
    const stateDir = join(dir, "state");
    const dbPath = join(stateDir, "connector.sqlite");
    const repo = await makeGitRepo(dir);
    const mock = startMockSteward();
    const children: ChildProcess[] = [];
    let companion: CodexTransport | undefined;
    const owned: ProcRef[] = [];
    const evidence: Frame = { directory: dir, boots: [], checks: {}, coldContinuation: "not_attempted", result: "running" };
    const evidencePath = join(dir, "evidence.json");
    const record = (name: string, value: unknown) => {
      evidence.checks[name] = value;
      writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
      console.log(`[codex-connector-live] ${name}: ${JSON.stringify(value)}`);
    };
    // Open this observer while the Connector is stopped: LocalStore's constructor
    // migrates schema, so repeatedly constructing it beside a writer races SQLite DDL.
    let observer: LocalStore | undefined;
    const inspect = <T>(fn: (store: LocalStore) => T): T => fn(observer!);
    const remember = async () => {
      for (const ref of inspect((s) => s.listWorkers().map((w) => s.getAgentProcess(w.workerId)))) {
        if (!ref?.startTime || processStartTime(ref.pid) !== ref.startTime) continue;
        owned.push(ref, ...await listDescendants(ref.pid));
      }
    };
    const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;
    const stop = async (child: ChildProcess, signal: NodeJS.Signals) => {
      if (!exited(child)) child.kill(signal);
      await waitFor(() => exited(child), 15_000, `Connector ${child.pid} exit after ${signal}`);
      if (signal === "SIGTERM") expect(child.exitCode).toBe(0);
      else expect(child.signalCode).toBe(signal);
    };
    try {
      const port = await mock.listen();
      const seed = new LocalStore(dbPath);
      seed.addRepo({ repoId: repo, name: "live-restart", path: repo,
        capability: { kind: "git", gitRoot: repo, defaultBranch: "main", remote: null } });
      seed.saveCredentials({ serverUrl: `http://127.0.0.1:${port}`, deviceId: mock.deviceId, token: mock.token });
      seed.close();
      const fixture = join(dir, "connector-child.mjs");
      await build({ entryPoints: [join(import.meta.dirname, "codex-connector-live-child.ts")], outfile: fixture,
        bundle: true, platform: "node", format: "esm", target: "node22", external: ["bufferutil", "utf-8-validate"],
        banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
      const boot = async () => {
        observer?.close();
        observer = new LocalStore(dbPath);
        observer.database.exec("PRAGMA busy_timeout = 5000");
        const helloCount = mock.hellos().length;
        const logPath = join(dir, `connector-${children.length + 1}.log`);
        const child = spawn(process.execPath, [fixture, stateDir], { cwd: dir, env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
        children.push(child);
        child.stdout!.on("data", (data) => appendFileSync(logPath, data));
        child.stderr!.on("data", (data) => appendFileSync(logPath, data));
        let ready: Frame | undefined;
        child.on("message", (message) => { ready = message as Frame; });
        await waitFor(() => ready || (exited(child) ? { failed: true } : undefined), 30_000, "child startup");
        expect(ready, existsSync(logPath) ? readFileSync(logPath, "utf8") : logPath).toMatchObject({ type: "ready", pid: child.pid });
        await mock.waitHello(helloCount + 1, 15_000);
        const hello = mock.hellos().at(-1)! as Frame;
        expect(hello.agents).toContainEqual(expect.objectContaining({ kind: "codex", version: ready!.version }));
        expect(typeof hello.bootId).toBe("string");
        expect(evidence.boots.map((b: Frame) => b.bootId)).not.toContain(hello.bootId);
        expect(evidence.boots.map((b: Frame) => b.pid)).not.toContain(child.pid);
        evidence.boots.push({ pid: child.pid, bootId: hello.bootId, version: ready!.version, workers: hello.workers });
        record("boots", evidence.boots);
        return { child, hello };
      };
      const first = await boot();
      const workerId = "live-completed";
      const start = await command(mock, "start_worker", { workerId, threadId: "live-restart-completed", repoId: repo, agent: "codex", mode: "write",
        prompt: "Create orbit-restart.txt containing exactly orbit-connector-restart followed by a newline. Work only in the assigned directory. Do not use external tools or network, do not commit, push or create PRs. Finish with the required JSON report, status done, and include the file contents in answer." });
      expect(start).toMatchObject({ ok: true });
      await waitFor(() => mock.events().find((e) => e.workerId === workerId && e.type === "settled"), 90_000, "real Codex report on WS");
      const eventsFor = (id: string) => mock.events().filter((e) => e.workerId === id) as Frame[];
      expect(eventsFor(workerId)).toContainEqual(expect.objectContaining({ type: "report", status: "done" }));
      expect(eventsFor(workerId).find((e) => e.type === "settled")).toMatchObject({ outcome: "reported" });
      const saved = inspect((s) => s.getWorker(workerId)!);
      expect(saved.sessionId).toBe(start.data.sessionId);
      expect(saved.worktree).toBeTruthy();
      expect(saved.worktree).not.toBe(repo);
      expect(readFileSync(join(saved.worktree!, "orbit-restart.txt"), "utf8")).toBe("orbit-connector-restart\n");
      expect(existsSync(join(repo, "orbit-restart.txt"))).toBe(false);
      record("writeAndReport", { sessionId: saved.sessionId, worktree: saved.worktree, report: eventsFor(workerId).find((e) => e.type === "report") });
      await remember();
      await stop(first.child, "SIGTERM");
      const seqBefore = inspect((s) => new EventLog(s.database).nextSeq(workerId) - 1);
      mock.setWelcomeAcks({ [workerId]: seqBefore });
      const second = await boot();
      expect(second.hello.workers).toContainEqual(expect.objectContaining({ workerId, sessionId: saved.sessionId, lastSeq: seqBefore }));
      expect(inspect((s) => s.getWorker(workerId))).toMatchObject({ sessionId: saved.sessionId, worktree: saved.worktree, agent: "codex" });
      record("identityAndSequenceReopened", { sessionId: saved.sessionId, lastSeq: seqBefore });

      const history = await historyOverWire(mock, workerId);
      const sessionPath = codexSessionPath(saved.sessionId!, saved.sessionFile);
      expect(sessionPath).toBeTruthy();
      expect(history.lines).toEqual(readFileSync(sessionPath!, "utf8").split("\n").filter((l) => l.trim()));
      expect(history.pages).toBeGreaterThan(1);
      expect(history.splitFragments).toBeGreaterThan(0);
      expect(history.lines.some((line) => line.includes("orbit-connector-restart"))).toBe(true);
      record("historyOverWebSocket", { pages: history.pages, fragments: history.fragments, splitFragments: history.splitFragments, exactLocalRecordMatch: true });

      // Keep an unrelated real app-server alive throughout cold continuation. It uses
      // the existing home/login but receives no thread or task input.
      companion = new CodexTransport([process.env.ORBIT_CODEX_COMMAND || "codex", "app-server", "--listen", "stdio://"],
        repo, childEnv(), () => {}, () => {}, 20_000);
      await companion.request("initialize", { clientInfo: { name: "orbit_coexistence_acceptance", version: "1" } });
      companion.write({ method: "initialized", params: {} });
      const receiptsBefore = inspect((s) => s.deliveries(workerId));
      const follow = await command(mock, "send", { workerId, intent: "auto", text: "Read orbit-restart.txt from our previous turn. Do not change files or use external tools. Report done and put its exact contents in answer." });
      expect(follow, JSON.stringify(follow)).toMatchObject({ ok: true });
      await waitFor(() => eventsFor(workerId).find((e) => e.type === "settled" && e.seq > seqBefore), 90_000, "cold continuation settlement");
      expect(eventsFor(workerId).find((e) => e.type === "settled" && e.seq > seqBefore)).toMatchObject({ outcome: "reported" });
      expect(eventsFor(workerId).find((e) => e.type === "report" && e.seq > seqBefore)?.answer).toContain("orbit-connector-restart");
      expect(inspect((s) => s.getWorker(workerId)?.sessionId)).toBe(saved.sessionId);
      expect(inspect((s) => s.deliveries(workerId))).toHaveLength(receiptsBefore.length + 1);
      const newSeqs = eventsFor(workerId).filter((e) => e.seq > seqBefore).map((e) => e.seq);
      expect(newSeqs).toEqual(newSeqs.map((_, i) => seqBefore + i + 1));
      expect(companion.child.exitCode).toBeNull(); expect(companion.child.signalCode).toBeNull();
      evidence.coldContinuation = "passed_same_session_with_unrelated_app_server";
      record("coldContinuation", { outcome: evidence.coldContinuation, unrelatedAppServerAlive: true, commandResult: follow });

      const crashId = "live-interrupted";
      const crashCommandId = "live-hard-crash-start";
      const crashArgs = { workerId: crashId, threadId: "live-restart-interrupted", repoId: repo, agent: "codex", mode: "write",
        prompt: "Run this exact shell command in the assigned worktree: printf 'started\\n' >> crash-started.txt; sleep 120; printf 'finished\\n' > crash-finished.txt . Wait for the shell to finish before reporting. Do not shorten or background the sleep. Do not use external tools or network; do not commit or push. Then report done." };
      expect(await command(mock, "start_worker", crashArgs, crashCommandId)).toMatchObject({ ok: true });
      const active = inspect((s) => s.getWorker(crashId)!);
      const marker = join(active.worktree!, "crash-started.txt");
      await waitFor(() => existsSync(marker), 90_000, "real running shell marker before SIGKILL");
      expect(readFileSync(marker, "utf8")).toBe("started\n");
      expect(inspect((s) => s.getWorker(crashId)?.state)).toBe("running");
      expect(eventsFor(crashId).some((e) => e.type === "settled")).toBe(false);
      const receipts = inspect((s) => s.deliveries(crashId));
      expect(receipts).toEqual([expect.objectContaining({ commandId: crashCommandId, state: "delivered", turnId: expect.any(String) })]);
      await remember();
      const activeRef = inspect((s) => s.getAgentProcess(crashId)!);
      expect(activeRef.startTime).toBeTruthy();
      expect(processStartTime(activeRef.pid)).toBe(activeRef.startTime);
      const crashSeq = inspect((s) => new EventLog(s.database).nextSeq(crashId) - 1);
      // Without this fault injection the real CLI observes stdin EOF and durably writes
      // turn_aborted, which is known cancellation, not uncertain completion. Suspend only
      // our identity-checked app-server so it cannot write a terminal record after
      // the Connector dies. Production startup must reap it (TERM then KILL) and classify
      // the untouched real rollout; no session edits or recovery dependency overrides.
      process.kill(activeRef.pid, "SIGSTOP");
      await stop(second.child, "SIGKILL");
      record("hardKillDuringRealTask", { connectorPid: second.child.pid, codexPid: activeRef.pid, codexSuspendedBeforeCrash: true, sessionId: active.sessionId, receipts, lastSeq: crashSeq });
      mock.setWelcomeAcks({ [workerId]: inspect((s) => new EventLog(s.database).nextSeq(workerId) - 1), [crashId]: crashSeq });
      const third = await boot();
      expect(processStartTime(activeRef.pid)).not.toBe(activeRef.startTime);
      expect(third.hello.workers).toContainEqual(expect.objectContaining({ workerId: crashId, sessionId: active.sessionId, state: "broken", lastOutcome: "delivery_ambiguous" }));
      const unknown = await waitFor(() => eventsFor(crashId).find((e) => e.type === "settled" && e.seq > crashSeq), 15_000, "unknown crash outcome on WS");
      expect(unknown).toMatchObject({ outcome: "error", errorClass: "unknown" });
      expect(unknown.lastText).toMatch(/uncertain.*automatic replay is disabled/i);
      expect(unknown.seq).toBe(crashSeq + 1);
      expect(inspect((s) => s.deliveries(crashId))).toEqual(receipts);
      // Explicit retries must be rejected too, not just automatic startup replay.
      for (const kind of ["send", "resume"]) {
        expect(await command(mock, kind, { workerId: crashId, text: "Continue", intent: "auto", reason: "restart" }))
          .toMatchObject({ ok: false, error: { code: "ambiguous" } });
      }
      mock.sendCmd("start_worker", crashArgs, crashCommandId);
      await waitFor(() => mock.acksFor(crashCommandId)?.status === "duplicate", 10_000, "persisted command dedup after restart");
      // Observe a real transport heartbeat after recovery, allowing time for any
      // erroneous automatic restart to show up in receipts, events or file effects.
      const pingCount = mock.pings();
      await waitFor(() => mock.pings() > pingCount, 35_000, "post-recovery heartbeat");
      expect(inspect((s) => s.deliveries(crashId))).toEqual(receipts);
      expect(inspect((s) => s.getWorker(crashId))).toMatchObject({ state: "broken", lastOutcome: "delivery_ambiguous", sessionId: active.sessionId });
      expect(eventsFor(crashId).filter((e) => e.seq > crashSeq && ["started", "resumed", "report"].includes(e.type))).toEqual([]);
      expect(readFileSync(marker, "utf8")).toBe("started\n");
      expect(existsSync(join(active.worktree!, "crash-finished.txt"))).toBe(false);
      record("unknownWithoutReplay", { settlement: unknown, unchangedReceipts: true, duplicateCommandRejected: true, sendAndResumeRejected: true, markerExecutions: 1 });
      evidence.result = "passed";
    } catch (error) {
      evidence.result = "failed";
      evidence.error = error instanceof Error ? error.stack : String(error);
      throw error;
    } finally {
      if (companion && !exited(companion.child)) {
        companion.child.kill("SIGTERM");
        await waitFor(() => exited(companion!.child), 5000, "unrelated test server exit").catch(async () => {
          companion!.child.kill("SIGKILL");
          await waitFor(() => exited(companion!.child), 5000, "unrelated test server killed");
        });
      }
      if (observer) await remember().catch(() => undefined);
      for (const child of children) {
        if (!exited(child)) await stop(child, "SIGTERM").catch(() => stop(child, "SIGKILL"));
      }
      // Only recorded test-owned descendants, identity checked before any signal.
      await killOrphans(owned.filter((ref) => !!ref.startTime));
      observer?.close();
      await mock.close();
      writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
      console.log(`[codex-connector-live] evidence=${evidencePath} result=${evidence.result} coldContinuation=${evidence.coldContinuation}`);
    }
  }, LIVE_TIMEOUT);
});
