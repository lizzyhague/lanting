/**
 * Replaces attachment storage paths with the original filenames before the browser sees them: ai-remote-upload requires paths to stay out of the browser.
 * AI replies and tool calls may echo paths verbatim, so they are all replaced here.
 */
export class PathRedactor {
  readonly #pairs: [string, string][];
  readonly #longest: number;

  constructor(paths: ReadonlyMap<string, string>) {
    // Longer ones first, so a path that is a prefix of another isn't half-replaced.
    this.#pairs = [...paths].filter(([path]) => path.length > 0).sort((a, b) => b[0].length - a[0].length);
    this.#longest = this.#pairs.reduce((max, [path]) => Math.max(max, path.length), 0);
  }

  get empty(): boolean {
    return this.#pairs.length === 0;
  }

  redact(text: string): string {
    let result = text;
    for (const [path, name] of this.#pairs) result = result.replaceAll(path, name);
    return result;
  }

  /** Replaces every string in the object; used for progress info such as tool calls. */
  redactDeep<T>(value: T): T {
    if (this.empty) return value;
    if (typeof value === "string") return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((item) => this.redactDeep(item)) as T;
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.redactDeep(item)])) as T;
    }
    return value;
  }

  /** For streaming text: a path may be split across two deltas, so the end of each delta is held back until the following text arrives. */
  stream(): { push(delta: string): string; flush(): string } {
    let pending = "";
    return {
      push: (delta) => {
        if (this.empty) return delta;
        pending += delta;
        let cut = Math.max(0, pending.length - (this.#longest - 1));
        // The held-back tail may contain the start of a path; a path that appeared in full but crosses the cut is held back whole until next time.
        for (const [path] of this.#pairs) {
          let index = pending.indexOf(path);
          while (index !== -1) {
            if (index < cut && index + path.length > cut) cut = index;
            index = pending.indexOf(path, index + 1);
          }
        }
        const ready = pending.slice(0, cut);
        pending = pending.slice(cut);
        return this.redact(ready);
      },
      flush: () => {
        const rest = this.redact(pending);
        pending = "";
        return rest;
      },
    };
  }
}
