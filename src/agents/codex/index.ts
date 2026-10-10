import { requireExecutable } from "../../config/fields.ts";
import type { AgentModule } from "../module.ts";
import { CodexAdapter } from "./adapter.ts";

export const codexModule: AgentModule = {
  kind: "codex",
  displayName: "Codex CLI",
  async create(section, label) {
    const executable = await requireExecutable(section.executable, `${label}.executable`);
    return new CodexAdapter({ executable });
  },
};
