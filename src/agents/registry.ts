import type { AgentAdapter } from "./types.ts";

const AGENT_ID_PATTERN = /^[a-z][a-z0-9]{0,15}$/u;

/** 已登记的 AI。登记顺序就是界面上的排列顺序。 */
export class AgentRegistry {
  readonly #adapters = new Map<string, AgentAdapter>();

  constructor(adapters: Iterable<AgentAdapter>) {
    for (const adapter of adapters) {
      if (!AGENT_ID_PATTERN.test(adapter.id)) {
        throw new Error(`AI 标签名只能用小写字母和数字，并以字母开头：${adapter.id}`);
      }
      if (this.#adapters.has(adapter.id)) throw new Error(`AI 重复登记：${adapter.id}`);
      this.#adapters.set(adapter.id, adapter);
    }
  }

  get ids(): string[] {
    return [...this.#adapters.keys()];
  }

  has(id: string): boolean {
    return this.#adapters.has(id);
  }

  get(id: string): AgentAdapter {
    const adapter = this.#adapters.get(id);
    if (!adapter) throw new Error(`没有登记这个 AI：${id}`);
    return adapter;
  }
}
