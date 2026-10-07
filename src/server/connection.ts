import type { ConnectionHub, EmittedEvent, EventSink } from "./hub.ts";
import {
  parseBrowserRequest,
  ProtocolError,
  type BrowserEvent,
  type BrowserMessage,
  type BrowserRequest,
} from "./protocol.ts";

export type BrowserSocket = {
  send(data: string): void;
  close(code: number, reason: string): void;
};

export type BrowserConnectionServices = {
  hub: ConnectionHub;
};

/** 处理请求时可以抛出的业务错误，code 原样回给浏览器。 */
export class RequestError extends Error {
  readonly code: string;
  readonly details: Record<string, string> | undefined;

  constructor(code: string, message: string, details?: Record<string, string>) {
    super(message);
    this.name = "RequestError";
    this.code = code;
    this.details = details;
  }
}

export class BrowserConnection implements EventSink {
  readonly #socket: BrowserSocket;
  readonly #services: BrowserConnectionServices;
  /** 连接建立后、页面发 connection.ready 之前的全局事件先暂存，之后按原顺序冲刷。 */
  #globalBuffered: BrowserEvent[] | null = [];
  #disposed = false;

  constructor(socket: BrowserSocket, services: BrowserConnectionServices) {
    this.#socket = socket;
    this.#services = services;
    this.#services.hub.add(this);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#services.hub.remove(this);
    this.#globalBuffered = null;
  }

  deliver(event: EmittedEvent): void {
    if (this.#disposed) return;
    if (this.#globalBuffered) {
      this.#globalBuffered.push(event.payload);
      return;
    }
    this.#send({ type: "event", event: event.payload });
  }

  receiveText(source: string): void {
    let request: BrowserRequest;
    try {
      request = parseBrowserRequest(source);
    } catch (error) {
      this.#sendProtocolError(error);
      return;
    }

    void this.#handle(request).catch((error: unknown) => {
      const code = error instanceof RequestError ? error.code : "internal_error";
      const message = error instanceof Error ? error.message : "请求处理失败。";
      const details = error instanceof RequestError ? error.details : undefined;
      this.#respondError(request.requestId, code, message, details);
    });
  }

  async #handle(request: BrowserRequest): Promise<void> {
    switch (request.type) {
      case "connection.ready": {
        this.#respondOk(request.requestId, {});
        this.#drainGlobalBuffered();
        return;
      }
    }
  }

  #drainGlobalBuffered(): void {
    const queue = this.#globalBuffered;
    if (!queue) return;
    this.#globalBuffered = null;
    for (const event of queue) this.#send({ type: "event", event });
  }

  #respondOk(requestId: string, data: unknown): void {
    this.#send({ type: "response", requestId, ok: true, data });
  }

  #respondError(
    requestId: string,
    code: string,
    message: string,
    details?: Record<string, string>,
  ): void {
    this.#send({
      type: "response",
      requestId,
      ok: false,
      error: { code, message, ...(details ? { details } : {}) },
    });
  }

  #sendProtocolError(error: unknown): void {
    const known = error instanceof ProtocolError
      ? error
      : new ProtocolError("invalid_message", "无法解析消息。");
    this.#send({
      type: "error",
      requestId: known.requestId,
      error: { code: known.code, message: known.message },
    });
  }

  #send(message: BrowserMessage): void {
    if (this.#disposed) return;
    this.#socket.send(JSON.stringify(message));
  }
}
