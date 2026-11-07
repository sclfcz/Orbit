import { describe, expect, it } from "vitest";
import { writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { validateCodexPath } from "../src/codex-session.ts";
import { tmpDir } from "./helpers.ts";

describe("Codex rollout identity header", () => {
  it("accepts a complete metadata record larger than 64 KiB", () => {
    const path = join(tmpDir("codex-large-header"), "rollout.jsonl");
    writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id: "thread-123", base_instructions: "instruction ".repeat(10000) } }) + "\n");
    expect(validateCodexPath(path, "thread-123")).toBe(realpathSync(path));
    expect(validateCodexPath(path, "another-thread")).toBeNull();
  });
  it("refuses incomplete and oversized metadata without accepting an embedded identity", () => {
    const path = join(tmpDir("codex-invalid-header"), "rollout.jsonl");
    const header = JSON.stringify({ type: "session_meta", payload: { id: "thread-123" } });
    writeFileSync(path, header);
    expect(validateCodexPath(path, "thread-123")).toBeNull();
    writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id: "thread-123", base_instructions: "x".repeat(4 * 1024 * 1024) } }) + "\n");
    expect(validateCodexPath(path, "thread-123")).toBeNull();
  });
});
