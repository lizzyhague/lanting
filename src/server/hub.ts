import type { BrowserEvent } from "./protocol.ts";

/** 推给浏览器的事件。global 发给所有已鉴权连接；按群推送的事件到第 2 步再加。 */
export type EmittedEvent = { target: "global"; payload: BrowserEvent };

export type EventSink = {
  deliver(event: EmittedEvent): void;
};

/** HTTP 升级时已鉴权连接的登记处。请求响应只回给发出请求的连接，不经过这里。 */
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
        // 单个连接发送失败不影响其他设备。
      }
    }
  }
}
