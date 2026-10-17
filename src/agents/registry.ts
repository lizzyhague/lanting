import { AGENT_MODULES } from "./index.ts";
import { isAgentKind, type AgentKind } from "./kinds.ts";
import type { AgentAdapter } from "./types.ts";

/** All CLI kinds lanting supports, regardless of whether the current config sets them up. */
export const SUPPORTED_AGENT_KINDS: readonly { kind: AgentKind; displayName: string }[] =
  AGENT_MODULES.map(({ kind, displayName }) => ({ kind, displayName }));

export function kindDisplayName(kind: AgentKind): string {
  return AGENT_MODULES.find((module) => module.kind === kind)?.displayName ?? kind;
}

/** CLI adapters registered in the current config. */
export class AgentRegistry {
  readonly #adapters = new Map<AgentKind, AgentAdapter>();

  constructor(adapters: Iterable<AgentAdapter>) {
    for (const adapter of adapters) {
      if (this.#adapters.has(adapter.kind)) throw new Error(`CLI kind registered twice: ${adapter.kind}`);
      this.#adapters.set(adapter.kind, adapter);
    }
  }

  get kinds(): AgentKind[] {
    return [...this.#adapters.keys()];
  }

  has(kind: string): kind is AgentKind {
    return isAgentKind(kind) && this.#adapters.has(kind);
  }

  get(kind: AgentKind): AgentAdapter {
    const adapter = this.#adapters.get(kind);
    if (!adapter) throw new Error(`No adapter registered for ${kind}`);
    return adapter;
  }
}
