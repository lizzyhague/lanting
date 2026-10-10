import { requireExecutable } from "../../config/fields.ts";
import type { AgentModule } from "../module.ts";
import { GrokAdapter } from "./adapter.ts";

export const grokModule: AgentModule = {
  kind: "grok",
  displayName: "Grok Build",
  async create(section, label) {
    const executable = await requireExecutable(section.executable, `${label}.executable`);
    return new GrokAdapter({ executable });
  },
};
