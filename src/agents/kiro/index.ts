import { requireExecutable } from "../../config/fields.ts";
import type { AgentModule } from "../module.ts";
import { KiroAdapter } from "./adapter.ts";

export const kiroModule: AgentModule = {
  kind: "kiro",
  displayName: "Kiro CLI",
  async create(section, label) {
    const executable = await requireExecutable(section.executable, `${label}.executable`);
    return new KiroAdapter({ executable });
  },
};
