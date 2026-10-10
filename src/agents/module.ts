import type { AgentAdapter } from "./types.ts";

export type AgentModule = {
  kind: string;
  displayName: string;
  create(section: Record<string, unknown>, label: string): Promise<AgentAdapter>;
};
