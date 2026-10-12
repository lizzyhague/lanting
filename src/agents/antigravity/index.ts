import { requireExecutable } from "../../config/fields.ts";
import type { AgentModule } from "../module.ts";
import { AntigravityAdapter } from "./adapter.ts";

export const antigravityModule: AgentModule = {
  kind: "antigravity",
  displayName: "Antigravity",
  async create(section, label) {
    const executable = await requireExecutable(section.executable, `${label}.executable`);
    return new AntigravityAdapter({ executable });
  },
};
