import { requireExecutable } from "../../config/fields.ts";
import type { AgentModule } from "../module.ts";
import { CursorAdapter } from "./adapter.ts";

export const cursorModule: AgentModule = {
  kind: "cursor",
  displayName: "Cursor",
  async create(section, label) {
    const executable = await requireExecutable(section.executable, `${label}.executable`);
    return new CursorAdapter({ executable });
  },
};
