/** Turns callback-style events into an event stream usable with for await. Can be iterated only once, by one consumer. */
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
    if (this.#iterated) throw new Error("The event stream can only be iterated once.");
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
