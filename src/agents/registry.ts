import { AGENT_KINDS, isAgentKind, type AgentKind } from "./kinds.ts";
import type { AgentAdapter } from "./types.ts";

const DISPLAY_NAMES: Readonly<Record<AgentKind, string>> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  grok: "Grok Build",
};

/** lanting 支持的全部 CLI 种类，不受当前 config 是否配置影响。 */
export const SUPPORTED_AGENT_KINDS: readonly { kind: AgentKind; displayName: string }[] =
  AGENT_KINDS.map((kind) => ({ kind, displayName: DISPLAY_NAMES[kind] }));

/** 当前 config 已登记的 CLI 适配器。 */
export class AgentRegistry {
  readonly #adapters = new Map<AgentKind, AgentAdapter>();

  constructor(adapters: Iterable<AgentAdapter>) {
    for (const adapter of adapters) {
      if (this.#adapters.has(adapter.kind)) throw new Error(`CLI 种类重复登记：${adapter.kind}`);
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
    if (!adapter) throw new Error(`没有登记这个 AI：${kind}`);
    return adapter;
  }
}
