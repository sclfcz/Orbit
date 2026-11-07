import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type RolloutRecord = Record<string, any>;

export interface CorrelatedShellEvidence {
  callId: string;
  toolOutput: string;
}

export function findCorrelatedShellEvidence(rolloutFile: string, command: string): CorrelatedShellEvidence {
  const records = readFileSync(rolloutFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RolloutRecord);
  const call = records.find((record) => record.type === "response_item" &&
    ["function_call", "custom_tool_call"].includes(record.payload?.type) &&
    String(record.payload.input ?? record.payload.arguments ?? "").includes(command))?.payload;
  if (!call) throw new Error("The model did not invoke the requested shell command");
  const result = records.find((record) => record.type === "response_item" &&
    ["function_call_output", "custom_tool_call_output"].includes(record.payload?.type) &&
    record.payload.call_id === call.call_id)?.payload;
  if (!result) throw new Error("The correlated native tool result is missing");
  return {
    callId: String(call.call_id),
    toolOutput: typeof result.output === "string"
      ? result.output
      : result.output.map((part: any) => part.text ?? "").join("\n"),
  };
}

export function withoutCodexHome(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy.CODEX_HOME;
  return copy;
}

export function writeCodexCommandProxy(dir: string, realCommand: string, logPath: string): { command: string; env: NodeJS.ProcessEnv } {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "codex-command-proxy.mjs");
  writeFileSync(file, `#!${process.execPath}
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const log = process.env.CODEX_PROXY_LOG;
const real = process.env.CODEX_PROXY_REAL;
if (!log || !real) {
  console.error("codex proxy requires CODEX_PROXY_LOG and CODEX_PROXY_REAL");
  process.exit(2);
}
const child = spawn(real, process.argv.slice(2), { stdio: ["pipe", "pipe", "pipe"], env: process.env });
process.stdin.on("data", (chunk) => {
  appendFileSync(log, chunk);
  child.stdin.write(chunk);
});
process.stdin.on("end", () => child.stdin.end());
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("close", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
`, { mode: 0o755 });
  return {
    command: file,
    env: { CODEX_PROXY_LOG: logPath, CODEX_PROXY_REAL: realCommand },
  };
}
