import { requireExecutable } from "../../config/fields.ts";
import type { AgentModule } from "../module.ts";
import { OpenCodeAdapter } from "./adapter.ts";

export const opencodeModule: AgentModule = {
  kind: "opencode",
  displayName: "OpenCode",
  async create(section, label) {
    const executable = await requireExecutable(section.executable, `${label}.executable`);
    return new OpenCodeAdapter({ executable });
  },
};
