import type { BrowserEvent } from "./protocol.ts";

/** Events pushed to the browser. global goes to all authenticated connections; group only to connections subscribed to that group. */
export type EmittedEvent =
  | { target: "global"; payload: BrowserEvent }
  | { target: "group"; groupId: string; payload: BrowserEvent };

export type EventSink = {
  deliver(event: EmittedEvent): void;
};

/** Registry of connections authenticated at HTTP upgrade. Request responses go back only to the requesting connection, not through here. */
export class ConnectionHub {
  readonly #sinks = new Set<EventSink>();

  add(sink: EventSink): void {
    this.#sinks.add(sink);
  }

  remove(sink: EventSink): void {
    this.#sinks.delete(sink);
  }

  get size(): number {
    return this.#sinks.size;
  }

  handle(event: EmittedEvent): void {
    for (const sink of [...this.#sinks]) {
      try {
        sink.deliver(event);
      } catch {
        // A send failure on one connection doesn't affect other devices.
      }
    }
  }
}
