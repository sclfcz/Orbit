import type { Ledger, MachineRow, WorkerRow } from "./ledger.ts";
import { imageInputState, type ImageInputState } from "./image-capability.ts";

/**
 * ADR-0014's one worker-bound main-composer route: an owner reply that will take the
 * deterministic open-worker-question relay. Both the server's attachment refusal and the
 * snapshot's `attention[].imageReply` call this, so the UI cannot offer a target the server
 * would reject.
 */
export function workerForOpenQuestionReply(
  ledger: Ledger,
  input: { parentId?: string; routedThreadId?: string | null },
): WorkerRow | null {
  if (!input.parentId) return null;
  const quotedThreadIds = ledger.outbound.threadIdsForProviderMsg(input.parentId);
  const routed = input.routedThreadId ?? (quotedThreadIds.length === 1 ? quotedThreadIds[0]! : null);
  if (!routed || !ledger.threads.get(routed)) return null;
  const routedRow = ledger.outbound.rowForProviderMsg(input.parentId);
  const question = routedRow?.questionId !== null && routedRow?.questionId !== undefined
    ? ledger.questions.get(routedRow.questionId)
    : null;
  if (question?.status !== "open" || question.workerId === null || question.kind !== "report") return null;
  return ledger.workers.get(question.workerId);
}

/** The snapshot's attention.imageReply: present only for a reply that would take the route
 *  above, and carrying that worker's current imageInput state. */
export function attentionImageReply(
  ledger: Ledger,
  row: { id: string; threadId: string | null },
  machines: ReadonlyMap<string, MachineRow>,
): ImageInputState | undefined {
  const outbound = ledger.outbound.row(row.id);
  const parentId = typeof outbound?.providerMsgId === "string" ? outbound.providerMsgId : undefined;
  const worker = workerForOpenQuestionReply(ledger, { parentId, routedThreadId: row.threadId });
  return worker ? imageInputState(worker.agent, machines.get(worker.deviceId)?.agentCaps) : undefined;
}
