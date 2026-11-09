/** ADR-0014's one capability rule, shared by the server refusal and the workspace snapshot. */
export type ImageInputState = "ready" | "unsupported" | "upgrade_required";

export interface AgentCapabilityLike {
  kind: string;
  imageInput?: "reference";
}

/**
 * A worker can take images when its machine's hello advertises `imageInput: "reference"` for
 * that worker's own agent kind. Each agent turns this on separately, after its own live
 * acceptance (ADR-0014 phases 6 and 7). Pi has shipped image input since 0.4.0, so a Pi entry
 * without the flag means an old connector that needs `orbit upgrade`. For any other agent a
 * missing flag means the agent cannot take images yet.
 */
export function imageInputState(agent: string, agentCaps: readonly AgentCapabilityLike[] | undefined): ImageInputState {
  const entry = agentCaps?.find((candidate) => candidate.kind === agent);
  if (entry?.imageInput === "reference") return "ready";
  return agent === "pi" ? "upgrade_required" : "unsupported";
}
