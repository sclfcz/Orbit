import type { ReportPayload } from "./agent.ts";
import { normalizeReport } from "./pi-adapter.ts";

const text = { type: ["string", "null"] };
const strings = { type: ["array", "null"], items: { type: "string" } };
// Strict structured-output subset: every property required, optional values nullable.
export const CODEX_REPORT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["status", "summary", "changes", "decisions", "leftovers", "tests", "question", "next", "answer"],
  properties: {
    status: { type: "string", enum: ["done", "blocked", "needs_decision"] }, summary: { type: "string" },
    changes: strings, decisions: strings, leftovers: strings, question: text, next: text, answer: text,
    tests: { type: ["object", "null"], additionalProperties: false, required: ["ran", "passed", "note"],
      properties: { ran: { type: "boolean" }, passed: { type: ["boolean", "null"] }, note: text } },
  },
};

export function parseCodexReport(value: string): ReportPayload | null {
  let raw: Record<string, any>;
  try { raw = JSON.parse(value); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.summary !== "string" || !["done", "blocked", "needs_decision"].includes(raw.status)) return null;
  for (const key of Object.keys(raw)) if (!Object.hasOwn(CODEX_REPORT_SCHEMA.properties, key)) return null;
  for (const key of ["changes", "decisions", "leftovers"]) {
    if (raw[key] != null && (!Array.isArray(raw[key]) || !raw[key].every((v: unknown) => typeof v === "string"))) return null;
  }
  for (const key of ["question", "next", "answer"]) if (raw[key] != null && typeof raw[key] !== "string") return null;
  if (raw.tests != null && (typeof raw.tests !== "object" || typeof raw.tests.ran !== "boolean" ||
    raw.tests.passed != null && typeof raw.tests.passed !== "boolean" || raw.tests.note != null && typeof raw.tests.note !== "string")) return null;
  if (raw.tests != null && Object.keys(raw.tests).some((key) => !["ran", "passed", "note"].includes(key))) return null;
  return normalizeReport(raw);
}
