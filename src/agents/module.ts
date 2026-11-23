import type { AgentAdapter } from "./types.ts";

export type AgentModuleContext = {
  /**
   * This CLI kind's own directory under lanting's data directory, for state the module keeps between restarts.
   * It isn't created in advance; a module that needs it creates it with ensurePrivateDirectory.
   */
  stateDirectory: string;
};

export type AgentModule = {
  kind: string;
  displayName: string;
  create(section: Record<string, unknown>, label: string, context: AgentModuleContext): Promise<AgentAdapter>;
};
