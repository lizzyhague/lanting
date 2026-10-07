/** 把回调式的事件转成可以 for await 的事件流。只能被一个消费者迭代一次。 */
export class EventChannel<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  #wake: (() => void) | null = null;
  #ended = false;
  #iterated = false;

  push(item: T): void {
    if (this.#ended) return;
    this.#items.push(item);
    this.#wake?.();
  }

  end(): void {
    this.#ended = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.#iterated) throw new Error("事件流只能被迭代一次。");
    this.#iterated = true;
    while (true) {
      const item = this.#items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.#ended) return;
      await new Promise<void>((resolve) => {
        this.#wake = () => {
          this.#wake = null;
          resolve();
        };
      });
    }
  }
}
