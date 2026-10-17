import type { AgentCatalog } from "./types.ts";

/** Model and permission lists rarely change; a lookup is cached this long so opening the member panel doesn't start a CLI every time. */
const CATALOG_TTL_MS = 10 * 60_000;

/** Caches lookup results by key. Failed lookups aren't cached and are retried next time. */
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
