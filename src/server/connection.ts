import { GroupError } from "../group/runtime.ts";
import type { GroupService } from "../group/service.ts";
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
  groups: GroupService;
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
  readonly #subscriptions = new Set<string>();
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
    this.#subscriptions.clear();
    this.#globalBuffered = null;
  }

  deliver(event: EmittedEvent): void {
    if (this.#disposed) return;
    if (event.target === "group") {
      if (this.#subscriptions.has(event.groupId)) this.#send({ type: "event", event: event.payload });
      return;
    }
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
      const known = error instanceof RequestError || error instanceof GroupError;
      const code = known ? error.code : "internal_error";
      if (!known) console.error(error);
      const message = error instanceof Error ? error.message : "请求处理失败。";
      const details = error instanceof RequestError ? error.details : undefined;
      this.#respondError(request.requestId, code, message, details);
    });
  }

  async #handle(request: BrowserRequest): Promise<void> {
    const groups = this.#services.groups;
    switch (request.type) {
      case "connection.ready": {
        this.#respondOk(request.requestId, {});
        this.#drainGlobalBuffered();
        return;
      }
      case "app.state": {
        const directories = await groups.directories();
        this.#respondOk(request.requestId, {
          agents: groups.agents(),
          directories,
          groups: groups.groups(),
        });
        return;
      }
      case "group.create": {
        const group = await groups.create(request);
        this.#respondOk(request.requestId, { group });
        return;
      }
      case "group.subscribe": {
        // 快照和登记之间没有 await：之后的群事件一定排在快照之后。
        const snapshot = groups.snapshot(request.groupId);
        this.#subscriptions.add(request.groupId);
        this.#respondOk(request.requestId, snapshot);
        return;
      }
      case "group.unsubscribe": {
        this.#subscriptions.delete(request.groupId);
        this.#respondOk(request.requestId, {});
        return;
      }
      case "group.callOrder": {
        const group = await groups.setCallOrder(request.groupId, request.order);
        this.#respondOk(request.requestId, { group });
        return;
      }
      case "round.start": {
        this.#respondOk(request.requestId, groups.startRound(request.groupId, request.text, request.order));
        return;
      }
      case "round.interrupt": {
        this.#respondOk(request.requestId, { interrupted: await groups.interrupt(request.groupId) });
        return;
      }
      case "agent.catalog": {
        this.#respondOk(request.requestId, await groups.catalog(request.groupId, request.agent));
        return;
      }
      case "agent.settings": {
        const { model, effort, permission } = request;
        const group = await groups.setAgentSettings(request.groupId, request.agent, { model, effort, permission });
        this.#respondOk(request.requestId, { group });
        return;
      }
      case "group.compact": {
        groups.compact(request.groupId, request.agents);
        this.#respondOk(request.requestId, {});
        return;
      }
      case "group.rename": {
        const group = await groups.rename(request.groupId, request.title);
        this.#respondOk(request.requestId, { group });
        return;
      }
      case "groups.trash": {
        this.#respondOk(request.requestId, await groups.trash(request.groupIds));
        return;
      }
      case "groups.restore": {
        this.#respondOk(request.requestId, await groups.restore(request.groupIds));
        return;
      }
      case "groups.purge": {
        this.#respondOk(request.requestId, await groups.purge(request.groupIds));
        return;
      }
      case "approval.respond": {
        if (!groups.respondApproval(request.approvalId, request.decision)) {
          throw new RequestError("approval_settled", "这条审批已经处理过或已失效。");
        }
        this.#respondOk(request.requestId, {});
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
