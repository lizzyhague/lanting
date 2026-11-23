import path from "node:path";
import { setTimeout } from "node:timers/promises";
import type { AppConfig } from "../config/load.ts";
import { ExecutableUnavailableError } from "../config/fields.ts";
import { AGENT_MODULES } from "./index.ts";
import type { AgentAdapter } from "./types.ts";

/**
 * Only unavailable executables are recoverable; malformed configuration still fails startup.
 * Each module gets `<dataDirectory>/agents/<kind>` as its state directory.
 */
export async function createConfiguredAdapters(
  config: Pick<AppConfig, "agents">,
  dataDirectory: string,
  options: {
    wait?: () => Promise<void>;
    warn?: (message: string) => void;
  } = {},
): Promise<AgentAdapter[]> {
  const adapters: AgentAdapter[] = [];
  const wait = options.wait ?? (() => setTimeout(1_000));
  const warn = options.warn ?? console.warn;
  // Preserve module order for the interface.
  for (const module of AGENT_MODULES) {
    const section = config.agents[module.kind];
    if (!section) continue;
    const context = { stateDirectory: path.join(dataDirectory, "agents", module.kind) };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        adapters.push(await module.create(section, `agents.${module.kind}`, context));
        break;
      } catch (error) {
        if (!(error instanceof ExecutableUnavailableError)) throw error;
        warn(`${module.displayName}: executable unavailable (attempt ${attempt}/3). ${error.message}${
          attempt === 3 ? " Skipping this CLI; lanting will continue without it." : " Retrying in 1 second."
        }`);
        if (attempt < 3) await wait();
      }
    }
  }
  return adapters;
}
