// Newline-delimited app-server JSON-RPC. stderr never enters the protocol parser.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { AdapterError } from "./agent.ts";

export type RpcMessage = { id?: number | string; method?: string; params?: any; result?: any; error?: { code: number; message: string } };

export class CodexRpcError extends AdapterError {
  constructor(readonly rpcCode: number, message: string) { super("codex_rpc", message); }
  // JSON-RPC request validation failures occur before the method is invoked.
  get rejectedBeforeExecution(): boolean { return [-32600, -32601, -32602].includes(this.rpcCode); }
}

export class CodexTransport {
  readonly child: ChildProcessWithoutNullStreams;
  lastOutputAt = Date.now();
  private nextId = 0;
  private ended = false;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(command: string[], cwd: string, env: NodeJS.ProcessEnv, private readonly receive: (message: RpcMessage) => void,
    private readonly exited: (code: number | null, signal: NodeJS.Signals | null) => void, private readonly timeoutMs = 30_000) {
    this.child = spawn(command[0]!, command.slice(1), { cwd, env, stdio: "pipe", detached: true });
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.lastOutputAt = Date.now();
      buffer += decoder.write(chunk);
      if (buffer.length > 32 * 1024 * 1024) return this.fail(new AdapterError("protocol_error", "Codex protocol line too large"));
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let message: RpcMessage;
        try { message = JSON.parse(line); } catch { this.fail(new AdapterError("protocol_error", "Invalid Codex JSON-RPC")); return; }
        if (!message || typeof message !== "object") { this.fail(new AdapterError("protocol_error", "Invalid Codex envelope")); return; }
        if (message.method) {
          try { this.receive(message); } catch { this.fail(new AdapterError("protocol_error", "Invalid Codex notification/request")); return; }
        } // server request is never a response
        else if (typeof message.id === "number") {
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          clearTimeout(pending.timer); this.pending.delete(message.id);
          if (message.error) pending.reject(new CodexRpcError(message.error.code, message.error.message));
          else pending.resolve(message.result);
        }
      }
    });
    this.child.stderr.on("data", () => undefined); // drain; no content in lifecycle logs
    this.child.stdin.on("error", (e) => this.fail(e));
    this.child.on("error", (e) => {
      this.fail(e);
      // Failed spawn emits error/close but no exit. Remove the nonexistent runtime.
      if (this.child.pid === undefined) this.exited(null, null);
    });
    this.child.on("exit", (code, signal) => {
      this.fail(new AdapterError("not_running", "Codex app-server exited"));
      this.exited(code, signal);
    });
  }

  request(method: string, params: unknown): Promise<any> {
    if (this.ended) return Promise.reject(new AdapterError("not_running", "Codex app-server is not running"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AdapterError("timeout", `Codex ${method} timed out; delivery may be uncertain`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error as Error); }
    });
  }

  write(message: unknown): void {
    if (this.ended) throw new AdapterError("not_running", "Codex app-server is not running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private fail(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
    this.child.kill("SIGTERM");
  }
}
