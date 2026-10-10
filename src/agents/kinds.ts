import { AGENT_MODULES } from "./index.ts";

/** lanting 支持的 CLI 种类；顺序也是设置页下拉里的固定顺序。 */
export const AGENT_KINDS: readonly string[] = AGENT_MODULES.map((module) => module.kind);

export type AgentKind = string;

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === "string" && AGENT_KINDS.includes(value);
}
