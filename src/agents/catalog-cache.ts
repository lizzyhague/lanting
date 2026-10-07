import type { AgentCatalog } from "./types.ts";

/** 模型和权限的列表不常变，查一次缓存这么久，免得每次打开成员面板都启动一次 CLI。 */
const CATALOG_TTL_MS = 10 * 60_000;

/** 按 key 缓存查询结果。查询失败不缓存，下次重新查。 */
export class CatalogCache {
  readonly #entries = new Map<string, { at: number; value: Promise<AgentCatalog> }>();
  readonly #ttlMs: number;

  constructor(ttlMs = CATALOG_TTL_MS) {
    this.#ttlMs = ttlMs;
  }

  get(key: string, load: () => Promise<AgentCatalog>): Promise<AgentCatalog> {
    const cached = this.#entries.get(key);
    if (cached && Date.now() - cached.at < this.#ttlMs) return cached.value;
    const value = load();
    const entry = { at: Date.now(), value };
    this.#entries.set(key, entry);
    value.catch(() => {
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
    });
    return value;
  }
}
