import { antigravityModule } from "./antigravity/index.ts";
import { claudeModule } from "./claude/index.ts";
import { codexModule } from "./codex/index.ts";
import { cursorModule } from "./cursor/index.ts";
import { grokModule } from "./grok/index.ts";
import { piModule } from "./pi/index.ts";
import type { AgentModule } from "./module.ts";

export const AGENT_MODULES: readonly AgentModule[] = [claudeModule, codexModule, grokModule, piModule, cursorModule, antigravityModule];
