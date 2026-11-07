// Rollout records are evidence, not a Pi session. Absence never proves non-delivery.
import { closeSync, fstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { parseCodexReport } from "./codex-report.ts";
import type { SessionObservation } from "./session-observation.ts";
import type { ReportPayload } from "./agent.ts";

export function validateCodexPath(path: string, threadId: string): string | null {
  let fd: number | undefined;
  try {
    const actual = realpathSync(path);
    fd = openSync(actual, "r");
    if (!fstatSync(fd).isFile()) return null;
    // session_meta includes base instructions and can exceed a single 64 KiB read.
    // Bound memory while accepting complete metadata records up to 4 MiB.
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(64 * 1024);
    let length = 0;
    let complete = false;
    while (length < 4 * 1024 * 1024) {
      const n = readSync(fd, buf, 0, buf.length, length);
      if (!n) break;
      const end = buf.subarray(0, n).indexOf(10);
      chunks.push(Buffer.from(buf.subarray(0, end < 0 ? n : end)));
      length += n;
      if (end >= 0) { complete = true; break; }
    }
    if (!complete) return null;
    const record = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return record.type === "session_meta" && record.payload?.id === threadId ? actual : null;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

export function codexSessionPath(threadId: string, registeredPath?: string | null, codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex")): string | null {
  if (!/^[a-zA-Z0-9-]{8,100}$/.test(threadId)) return null;
  if (registeredPath) return validateCodexPath(registeredPath, threadId);
  for (const dir of [join(codexHome, "sessions"), join(codexHome, "archived_sessions")]) {
    try {
      for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(`${threadId}.jsonl`)) {
          const path = validateCodexPath(join(entry.parentPath, entry.name), threadId);
          if (path) return path;
        }
      }
    } catch { /* missing local store */ }
  }
  return null;
}

export function observeCodexSession(file: string | null | undefined, threadId?: string | null, tailBytes = 256 * 1024): SessionObservation {
  const unavailable: SessionObservation = { entries: [], lastEntryId: null, readable: false, complete: false, truncated: false };
  if (!file || !threadId || !validateCodexPath(file, threadId)) return unavailable;
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const before = fstatSync(fd); const length = Math.min(before.size, tailBytes);
    const buffer = Buffer.alloc(length); const n = readSync(fd, buffer, 0, length, before.size - length);
    const after = fstatSync(fd); const truncated = before.size > length;
    const lines = buffer.subarray(0, n).toString("utf8").split("\n");
    if (truncated) lines.shift();
    let complete = lines.pop() === "" && n === length && before.size === after.size && before.mtimeMs === after.mtimeMs;
    const entries: SessionObservation["entries"] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const raw = JSON.parse(line);
        if (!raw || typeof raw.type !== "string") { complete = false; continue; }
        entries.push({ ...raw, id: createHash("sha256").update(line).digest("hex") });
      } catch { complete = false; }
    }
    return { entries, lastEntryId: entries.at(-1)?.id ?? null, readable: true, complete, truncated };
  } catch { return unavailable; } finally { if (fd !== undefined) closeSync(fd); }
}

export function inspectCodexTail(file: string | null | undefined, threadId: string | null | undefined, expectedTurnId?: string | null):
  { kind: "settled"; report: ReportPayload } | { kind: "aborted" | "unreported" | "lost" } {
  const tail = observeCodexSession(file, threadId);
  if (!tail.readable || !tail.complete || !expectedTurnId) return { kind: "lost" };
  // A terminal marker for the exact accepted turn, after its final assistant record.
  let text = "";
  let currentTurn: string | undefined;
  let result: ReturnType<typeof inspectCodexTail> = { kind: "lost" };
  for (const entry of tail.entries) {
    const p = entry.payload as any;
    if (entry.type === "event_msg" && p?.type === "task_started") {
      currentTurn = p.turn_id;
      text = "";
      result = { kind: "lost" }; // a later/external turn supersedes an older terminal marker
    }
    if (currentTurn === expectedTurnId && entry.type === "response_item" && p?.type === "message" && p.role === "assistant" && p.phase === "final_answer") {
      text = (p.content ?? []).filter((v: any) => v.type === "output_text").map((v: any) => v.text).join("");
    }
    if (entry.type !== "event_msg" || p?.turn_id !== expectedTurnId) continue;
    if (p.type === "turn_aborted") result = { kind: "aborted" };
    if (p.type === "task_complete") {
      const report = parseCodexReport(typeof p.last_agent_message === "string" ? p.last_agent_message : text);
      result = report ? { kind: "settled", report } : { kind: "unreported" };
    }
  }
  return result;
}
