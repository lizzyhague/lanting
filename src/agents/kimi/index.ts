import { requireExecutable } from "../../config/fields.ts";
import type { AgentModule } from "../module.ts";
import { KimiAdapter } from "./adapter.ts";

export const kimiModule: AgentModule = {
  kind: "kimi",
  displayName: "Kimi Code",
  async create(section, label) {
    const executable = await requireExecutable(section.executable, `${label}.executable`);
    return new KimiAdapter({ executable });
  },
};
