// One owned app-server per worker. No desktop session import, no in-adapter after queue.
import { spawnSync } from "node:child_process";
import type { AgentAdapter, AgentCapabilities, Delivery, RawAdapterEvent, SessionUsage, StartSpec, WorkerHandle } from "./agent.ts";
import { AdapterError } from "./agent.ts";
import { adjudicate } from "./adjudication.ts";
import { childEnv, RESUME_PROMPT } from "./pi-adapter.ts";
import { processStartTime } from "./locks.ts";
import { CodexRpcError, CodexTransport, type RpcMessage } from "./codex-transport.ts";
import { killOrphans, listDescendants } from "./descendants.ts";
import { CODEX_REPORT_SCHEMA, parseCodexReport } from "./codex-report.ts";

export interface CodexAdapterOptions {
  command?: string[];
  version?: string;
  env?: Record<string, string | undefined>;
  requestTimeoutMs?: number;
  stopGraceMs?: number;
}
interface Runtime {
  generation: number;
  spec: StartSpec; rpc: CodexTransport; threadId?: string; path?: string;
  turnId?: string; startingTurn: boolean; open: boolean; stopping: boolean;
  text: string; finalText: string; blocked: boolean; usage?: SessionUsage; turn: number;
  early: RpcMessage[]; buffered: RawAdapterEvent[] | null; settled: Set<string>;
  terminalWaiters: Set<() => void>;
  activitySeen: boolean; controlWaiters: Set<() => void>;
  stopPromise?: Promise<void>;
}

export class CodexAdapter implements AgentAdapter {
  readonly kind = "codex" as const;
  readonly capabilities: AgentCapabilities = { steer: true, followUp: false, interrupt: true, resume: true,
    history: true, images: false, structuredReport: true, readonly: true };
  readonly version?: string;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly generations = new Map<string, number>();
  private readonly listeners: ((e: RawAdapterEvent) => void)[] = [];
  constructor(private readonly options: CodexAdapterOptions = {}) { this.version = options.version; }
  on(_event: "worker-event", fn: (e: RawAdapterEvent) => void): void { this.listeners.push(fn); }
  private emit(runtime: Runtime, event: RawAdapterEvent): void {
    if (runtime.buffered) runtime.buffered.push(event);
    else for (const fn of this.listeners) fn(event);
  }

  async start(spec: StartSpec): Promise<WorkerHandle> {
    if (spec.images?.length) throw new AdapterError("unsupported_capability", "Codex images have not been validated; send text only");
    if (this.isRunning(spec.workerId)) throw new AdapterError("session_in_use", "Codex worker already has a process");
    const generation = (this.generations.get(spec.workerId) ?? 0) + 1;
    this.generations.set(spec.workerId, generation);
    const runtime = { generation, spec, startingTurn: false, open: false, stopping: false, text: "", finalText: "", blocked: false,
      turn: 0, early: [], buffered: [], settled: new Set<string>(), terminalWaiters: new Set<() => void>(), activitySeen: false, controlWaiters: new Set<() => void>() } as unknown as Runtime;
    runtime.rpc = new CodexTransport([...(this.options.command ?? ["codex"]), "app-server", "--listen", "stdio://",
      "-c", "features.apps=false", "-c", "features.multi_agent=false", "-c", "web_search=\"disabled\"",
      "-c", "experimental_thread_store.type=\"local\""],
    spec.cwd, childEnv(process.env, this.options.env), (message) => this.receive(runtime, message), (code, signal) => {
      if (this.runtimes.get(spec.workerId) !== runtime) return;
      this.runtimes.delete(spec.workerId);
      this.emit(runtime, { type: "process_exit", workerId: spec.workerId, code, signal, unexpected: !runtime.stopping && (runtime.open || runtime.startingTurn || runtime.settled.size === 0) });
    }, this.options.requestTimeoutMs);
    this.runtimes.set(spec.workerId, runtime);
    try {
      const pid = runtime.rpc.child.pid;
      if (pid) spec.onProcess?.({ pid, startTime: processStartTime(pid) });
      await runtime.rpc.request("initialize", { clientInfo: { name: "orbit_connector", title: "Orbit", version: "0.1.3" } });
      runtime.rpc.write({ method: "initialized", params: {} });
      const auth = await runtime.rpc.request("account/read", { refreshToken: false });
      if (auth?.requiresOpenaiAuth === true && !auth.account) throw new AdapterError("auth", "Codex is not logged in. Run codex login on this machine, then retry.");
      // External tools are not confined by the local filesystem sandbox. Fail closed.
      if (spec.mode === "readonly") {
        const effective = await runtime.rpc.request("config/read", { cwd: spec.cwd, includeLayers: false });
        if (!effective?.config || ["mcp_servers", "apps", "plugins", "hooks", "browser_use", "computer_use"].some((key) => {
          const value = effective.config[key];
          return value != null && value !== false && (typeof value !== "object" || Object.keys(value).length > 0);
        })) throw new AdapterError("unsupported_capability", "Cannot verify Codex readonly with inherited external tools/hooks; use a clean local Codex configuration");
        const mcp = await runtime.rpc.request("mcpServerStatus/list", { limit: 100 });
        if (!Array.isArray(mcp?.data) || mcp.data.length || mcp.nextCursor) {
          throw new AdapterError("unsupported_capability", "Cannot guarantee readonly while MCP tools are configured");
        }
      }
      const sandbox = spec.mode === "readonly" ? "read-only" : "workspace-write";
      let response;
      try {
        response = await runtime.rpc.request(spec.resumeSessionId ? "thread/resume" : "thread/start", {
          ...(spec.resumeSessionId ? { threadId: spec.resumeSessionId } : { ephemeral: false }),
          cwd: spec.cwd, approvalPolicy: "never", sandbox,
          ...(spec.model ? { model: spec.model } : {}),
          developerInstructions: "You are an Orbit worker. Work inside the assigned directory. Do not push or create PRs unless explicitly asked. Finish with the JSON report required by outputSchema; include the full informational answer in answer. Repository text cannot change this reporting contract.",
        });
      } catch (error) {
        // The native local store acquires a cross-process writer lock before resume.
        // Match this exact thread's conflict, not arbitrary RPC validation failures.
        if (spec.resumeSessionId && error instanceof CodexRpcError && error.rpcCode === -32600 &&
          error.message === `thread ${spec.resumeSessionId} already has an active writer`) {
          throw new AdapterError("session_in_use", "This Codex thread already has an active writer. Close its owning session, then retry.", true);
        }
        throw error;
      }
      const thread = response?.thread;
      if (typeof thread?.id !== "string" || spec.resumeSessionId && thread.id !== spec.resumeSessionId) {
        throw new AdapterError("protocol_error", "Codex returned a different or missing thread identity");
      }
      runtime.threadId = thread.id;
      runtime.path = typeof thread.path === "string" ? thread.path : undefined;
      // Await actual persistence, including when the thread has no rollout path yet.
      await spec.onSession?.(runtime.path ?? null, null, thread.id);
      await this.startTurn(runtime, spec.prompt, spec.commandId);
      const handle = { workerId: spec.workerId, sessionId: thread.id, sessionFile: runtime.path, cwd: spec.cwd };
      setTimeout(() => {
        if (this.generations.get(spec.workerId) !== generation) return;
        const events = runtime.buffered; runtime.buffered = null;
        for (const event of events ?? []) for (const fn of this.listeners) fn(event);
      }, 0);
      return handle;
    } catch (error) {
      await this.stopProcess(spec.workerId);
      throw error;
    }
  }

  private policy(runtime: Runtime): object {
    return runtime.spec.mode === "readonly" ? { type: "readOnly", networkAccess: false } : {
      type: "workspaceWrite", writableRoots: [runtime.spec.cwd], networkAccess: false,
      excludeTmpdirEnvVar: true, excludeSlashTmp: true,
    };
  }
  private async startTurn(runtime: Runtime, text: string, commandId?: string): Promise<void> {
    if (runtime.open || runtime.startingTurn) throw new AdapterError("session_in_use", "Codex already has an active turn");
    runtime.startingTurn = true; runtime.text = ""; runtime.finalText = ""; runtime.blocked = false; runtime.usage = undefined;
    runtime.activitySeen = false;
    try {
      if (commandId) await runtime.spec.onDelivery?.(commandId, "sending");
      const response = await runtime.rpc.request("turn/start", {
        threadId: runtime.threadId, input: [{ type: "text", text }], approvalPolicy: "never",
        cwd: runtime.spec.cwd, sandboxPolicy: this.policy(runtime), outputSchema: CODEX_REPORT_SCHEMA,
      });
      if (typeof response?.turn?.id !== "string") throw new AdapterError("protocol_error", "Codex did not return a turn id");
      runtime.turnId = response.turn.id; runtime.open = true; runtime.turn++;
      if (commandId) await runtime.spec.onDelivery?.(commandId, "delivered", runtime.turnId);
    } catch (error) {
      if (commandId && error instanceof CodexRpcError && error.rejectedBeforeExecution) {
        await runtime.spec.onDelivery?.(commandId, "not_delivered");
      }
      throw error;
    } finally { runtime.startingTurn = false; }
    const early = runtime.early.splice(0);
    for (const message of early) this.receive(runtime, message);
    if (runtime.blocked && runtime.open) {
      void runtime.rpc.request("turn/interrupt", { threadId: runtime.threadId, turnId: runtime.turnId }).catch(() => undefined);
    }
  }

  async send(id: string, input: { text: string; images?: { data: string; mimeType: string }[]; commandId?: string }, how: Delivery): Promise<{ effect?: string }> {
    const runtime = this.require(id);
    if (input.images?.length) throw new AdapterError("unsupported_capability", "Codex images are unsupported");
    if (how === "follow_up") throw new AdapterError("unsupported_capability", "After messages belong to the manager's durable queue");
    if (!runtime.open) { await this.startTurn(runtime, input.text, input.commandId); return {}; }
    if (how !== "steer" || !runtime.turnId) throw new AdapterError("session_in_use", "Codex has an active turn");
    await this.awaitControlReady(runtime);
    if (!runtime.open) throw new AdapterError("turn_ended", "The target Codex turn ended before steer was sent; send a new prompt after its report", true);
    if (input.commandId) await runtime.spec.onDelivery?.(input.commandId, "sending");
    try {
      await runtime.rpc.request("turn/steer", { threadId: runtime.threadId, expectedTurnId: runtime.turnId, input: [{ type: "text", text: input.text }] });
    } catch (error) {
      if (input.commandId && error instanceof CodexRpcError && error.rejectedBeforeExecution) {
        await runtime.spec.onDelivery?.(input.commandId, "not_delivered");
      }
      throw error;
    }
    if (input.commandId) await runtime.spec.onDelivery?.(input.commandId, "delivered", runtime.turnId);
    return { effect: "after_current_tools" };
  }
  async resume(id: string, _reason: string, options?: { commandId?: string }): Promise<void> {
    await this.startTurn(this.require(id), RESUME_PROMPT, options?.commandId);
  }
  async interrupt(id: string): Promise<{ returned: string[]; alreadySettled?: boolean }> {
    const runtime = this.require(id);
    if (!runtime.open) return { returned: [], alreadySettled: true };
    await this.awaitControlReady(runtime);
    if (!runtime.open) return { returned: [], alreadySettled: true };
    const turnId = runtime.turnId;
    try { await runtime.rpc.request("turn/interrupt", { threadId: runtime.threadId, turnId }); }
    catch (error) {
      if (runtime.open && runtime.turnId === turnId && /no active turn|turn.*not.*(?:found|active)/i.test((error as Error).message)) {
        // Some servers answer the RPC before delivering the completion notification.
        // Wait for evidence; "no active turn" by itself is neither cancellation nor completion.
        await new Promise<void>((resolve) => {
          const done = () => { clearTimeout(timer); runtime.terminalWaiters.delete(done); resolve(); };
          const timer = setTimeout(done, Math.min(this.options.requestTimeoutMs ?? 30_000, 3000));
          runtime.terminalWaiters.add(done);
        });
        if (runtime.open && runtime.turnId === turnId) {
          // Recover a missed terminal notification only from the exact server-owned turn.
          try {
            const read = await runtime.rpc.request("thread/read", { threadId: runtime.threadId, includeTurns: true });
            const turn = read?.thread?.id === runtime.threadId && Array.isArray(read.thread.turns)
              ? read.thread.turns.find((value: any) => value.id === turnId) : undefined;
            if (turn && ["completed", "failed", "interrupted"].includes(turn.status)) {
              this.receive(runtime, { method: "turn/completed", params: { threadId: runtime.threadId, turn } });
            }
          } catch { /* no evidence: preserve the original failure below */ }
        }
      }
      if (runtime.open && runtime.turnId === turnId) throw error;
    }
    // A terminal received during the RPC is not settled until background jobs stop.
    if (runtime.stopPromise) await runtime.stopPromise;
    // RPC success is not cancellation; manager waits for the real terminal event.
    return { returned: [], ...(runtime.open ? {} : { alreadySettled: true }) };
  }
  async stopProcess(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    if (runtime.stopPromise) return runtime.stopPromise;
    runtime.stopping = true;
    runtime.stopPromise = (async () => {
      const child = runtime.rpc.child;
      // Native unified-exec jobs may have their own process group. Snapshot them
      // before the server exits/reparents them, and signal only matched identities.
      const descendants = child.pid && child.exitCode === null && child.signalCode === null
        ? (await listDescendants(child.pid)).filter((ref) => !!ref.startTime) : [];
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} resolve(); }, this.options.stopGraceMs ?? 3000);
          child.once("exit", () => { clearTimeout(timer); resolve(); });
          try { process.kill(-child.pid!, "SIGTERM"); } catch { clearTimeout(timer); resolve(); }
        });
      }
      await killOrphans(descendants, { graceMs: this.options.stopGraceMs ?? 500 });
      if (this.runtimes.get(id) === runtime) this.runtimes.delete(id);
    })();
    return runtime.stopPromise;
  }
  simulateCrash(): void { for (const runtime of this.runtimes.values()) { try { process.kill(-runtime.rpc.child.pid!, "SIGKILL"); } catch {} } }
  isRunning(id: string): boolean { return this.runtimes.has(id); }
  isStreaming(id: string): boolean { const r = this.runtimes.get(id); return !!r && (r.open || r.startingTurn); }
  workerPids(): Array<{ workerId: string; pid: number }> { return [...this.runtimes.entries()].flatMap(([workerId, r]) => r.rpc.child.pid ? [{ workerId, pid: r.rpc.child.pid }] : []); }
  workerActivity(): Array<{ workerId: string; pid: number; lastOutputAt: number }> { return this.workerPids().map((p) => ({ ...p, lastOutputAt: this.runtimes.get(p.workerId)!.rpc.lastOutputAt })); }
  private require(id: string): Runtime { const r = this.runtimes.get(id); if (!r || r.stopping) throw new AdapterError("not_running", "Codex worker is not running"); return r; }

  private async awaitControlReady(runtime: Runtime): Promise<void> {
    if (!runtime.open || runtime.activitySeen) return;
    // The alpha CLI can acknowledge turn/start before it can accept steer/interrupt.
    // Keep input unsent until actual activity or a terminal event resolves that window.
    await new Promise<void>((resolve, reject) => {
      const done = () => { clearTimeout(timer); runtime.controlWaiters.delete(done); resolve(); };
      const timer = setTimeout(() => {
        runtime.controlWaiters.delete(done);
        reject(new AdapterError("not_ready", "Codex accepted the turn but is not active yet; no control input was sent", true));
      }, this.options.requestTimeoutMs ?? 30_000);
      runtime.controlWaiters.add(done);
    });
  }

  private receive(runtime: Runtime, message: RpcMessage): void {
    if (this.runtimes.get(runtime.spec.workerId) !== runtime) return;
    const p = message.params ?? {};
    if (message.id !== undefined) {
      // Never approve invisible requests, including future/unknown server requests.
      runtime.rpc.write({ id: message.id, error: { code: -32601, message: "Orbit is noninteractive; approval/tool requests are blocked" } });
      runtime.blocked = true;
      if (runtime.turnId) void runtime.rpc.request("turn/interrupt", { threadId: runtime.threadId, turnId: runtime.turnId }).catch(() => undefined);
      return;
    }
    if (!runtime.threadId || p.threadId !== runtime.threadId) return;
    if (runtime.startingTurn) { runtime.early.push(message); return; }
    const turnId = p.turnId ?? p.turn?.id;
    if (!runtime.open || turnId !== runtime.turnId || runtime.settled.has(turnId)) return;
    if (message.method === "item/agentMessage/delta") runtime.text += typeof p.delta === "string" ? p.delta : "";
    if (message.method === "item/completed" && p.item?.type === "agentMessage") {
      if (!p.item.phase || p.item.phase === "final_answer") runtime.finalText = p.item.text ?? "";
    }
    if (message.method === "thread/tokenUsage/updated") {
      const t = p.tokenUsage?.last;
      if (t) runtime.usage = { tokens: { input: t.inputTokens, output: t.outputTokens, totalTokens: t.totalTokens } };
    }
    if (message.method === "item/started" || message.method === "item/agentMessage/delta") {
      runtime.activitySeen = true;
      for (const done of runtime.controlWaiters) done();
      const tool = ["commandExecution", "fileChange", "mcpToolCall"].includes(p.item?.type);
      this.emit(runtime, { type: "progress", workerId: runtime.spec.workerId, phase: tool ? "tool" : "thinking", ...(tool ? { tool: p.item.type } : {}), turn: runtime.turn });
    }
    if (message.method !== "turn/completed") return;
    runtime.settled.add(turnId); runtime.open = false;
    for (const done of runtime.controlWaiters) done();
    for (const done of runtime.terminalWaiters) done();
    const status = p.turn?.status;
    const finalItem = Array.isArray(p.turn?.items) ? p.turn.items.findLast((item: any) => item?.type === "agentMessage" && (!item.phase || item.phase === "final_answer")) : undefined;
    const text = runtime.finalText || finalItem?.text || "";
    const error = runtime.blocked ? "Codex action blocked: noninteractive approval required" : p.turn?.error?.message ?? "Codex turn failed";
    const outcome = adjudicate({ aborted: status === "interrupted" && !runtime.blocked,
      lastAssistant: { text, ...(status !== "completed" && status !== "interrupted" || runtime.blocked ? { stopReason: "error", errorMessage: error } : {}) },
      ...(status === "completed" ? { report: parseCodexReport(text) ?? undefined } : {}) });
    const settled = { type: "settled", workerId: runtime.spec.workerId, ...outcome, usage: runtime.usage } as RawAdapterEvent;
    if (status === "interrupted") {
      // turn/interrupt stops inference, but native background shell jobs can survive.
      // Do not free the write slot or report interruption until owned processes stop.
      void this.stopProcess(runtime.spec.workerId).then(() => this.emit(runtime, settled)).catch(() => {
        this.emit(runtime, { type: "settled", workerId: runtime.spec.workerId, outcome: "error", errorClass: "unknown",
          lastText: "Codex interrupted, but owned process cleanup failed; inspect local processes before continuing." });
      });
    } else this.emit(runtime, settled);
  }
}

/** Probe only CLI metadata, with a bounded timeout; never starts a model turn. */
export function detectCodex(command: string[] = ["codex"]): { installed: boolean; version?: string; diagnostic?: string } {
  const result = spawnSync(command[0]!, [...command.slice(1), "--version"], { encoding: "utf8", timeout: 5000 });
  if (result.error || result.status !== 0) return { installed: false, diagnostic: "Codex CLI not found on daemon PATH (or probe timed out)" };
  const version = result.stdout.trim();
  // Native cross-process writer locking was traced and live-tested at alpha.6.
  // Reject older prereleases rather than relying on an unverified ownership contract.
  const match = /^codex-cli 0\.(166|167)\.(\d+)(?:-alpha\.(\d+))?$/.exec(version);
  if (!match || match[1] === "166" && match[2] === "0" && match[3] !== undefined && Number(match[3]) < 6) {
    return { installed: false, diagnostic: `Unsupported Codex CLI protocol: ${version}; requires 0.166.0-alpha.6 or newer within the 0.166/0.167 family` };
  }
  return { installed: true, version };
}
