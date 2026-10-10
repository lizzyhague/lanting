import { requireExecutable } from "../../config/fields.ts";
import type { AgentModule } from "../module.ts";
import { ClaudeAdapter } from "./adapter.ts";

export const claudeModule: AgentModule = {
  kind: "claude",
  displayName: "Claude Code",
  async create(section, label) {
    const executable = await requireExecutable(section.executable, `${label}.executable`);
    return new ClaudeAdapter({ pathToClaudeCodeExecutable: executable });
  },
};
