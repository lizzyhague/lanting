import { AGENT_MODULES } from "./index.ts";

/** CLI kinds lanting supports; the order is also the fixed order of the settings page dropdown. */
export const AGENT_KINDS: readonly string[] = AGENT_MODULES.map((module) => module.kind);

export type AgentKind = string;

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === "string" && AGENT_KINDS.includes(value);
}
