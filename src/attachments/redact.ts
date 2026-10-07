/**
 * 把附件的存储路径换成原文件名再给浏览器看：ai-remote-upload 规定路径不进浏览器。
 * AI 的回复和工具调用里可能原样带出路径，这里统一替换。
 */
export class PathRedactor {
  readonly #pairs: [string, string][];
  readonly #longest: number;

  constructor(paths: ReadonlyMap<string, string>) {
    // 长的先换，免得一条路径是另一条的前缀时只换掉一半。
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

  /** 对象里的所有字符串都替换，用于工具调用等过程信息。 */
  redactDeep<T>(value: T): T {
    if (this.empty) return value;
    if (typeof value === "string") return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((item) => this.redactDeep(item)) as T;
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.redactDeep(item)])) as T;
    }
    return value;
  }

  /** 流式文字用：路径可能被拆在两段增量里，所以每段末尾留一截，等后文到了再替换。 */
  stream(): { push(delta: string): string; flush(): string } {
    let pending = "";
    return {
      push: (delta) => {
        if (this.empty) return delta;
        pending += delta;
        let cut = Math.max(0, pending.length - (this.#longest - 1));
        // 留下的那一截里可能是路径的开头；已经完整出现、但跨过切点的路径整条留到下次。
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
