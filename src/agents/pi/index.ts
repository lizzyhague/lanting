import { requireExecutable } from "../../config/fields.ts";
import type { AgentModule } from "../module.ts";
import { PiAdapter } from "./adapter.ts";

export const piModule: AgentModule = {
  kind: "pi",
  displayName: "Pi",
  async create(section, label) {
    const executable = await requireExecutable(section.executable, `${label}.executable`);
    return new PiAdapter({ executable });
  },
};
