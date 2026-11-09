/** ADR-0014's one capability rule, shared by the server refusal and the workspace snapshot. */
export type ImageInputState = "ready" | "unsupported" | "upgrade_required";

export interface AgentCapabilityLike {
  kind: string;
  imageInput?: "reference";
}

export function imageInputState(agent: string, agentCaps: readonly AgentCapabilityLike[] | undefined): ImageInputState {
  if (agent !== "pi") return "unsupported";
  const pi = agentCaps?.find((entry) => entry.kind === "pi");
  return pi?.imageInput === "reference" ? "ready" : "upgrade_required";
}
