/** lanting 支持的 CLI 种类；顺序也是设置页下拉里的固定顺序。 */
export const AGENT_KINDS = ["claude", "codex", "grok"] as const;

export type AgentKind = (typeof AGENT_KINDS)[number];

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === "string" && (AGENT_KINDS as readonly string[]).includes(value);
}
