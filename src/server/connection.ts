import { SharedUploadError } from "../attachments/types.ts";
import { PALETTE } from "../agents/palette.ts";
import { GroupError } from "../group/runtime.ts";
import type { GroupService } from "../group/service.ts";
import { SettingsError } from "../state/settings-store.ts";
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
      const known = error instanceof RequestError || error instanceof GroupError || error instanceof SettingsError ||
        error instanceof SharedUploadError;
      const code = known ? error.code : "internal_error";
      if (!known) console.error(error);
      const message = error instanceof Error ? error.message : "请求处理失败。";
      const details = error instanceof RequestError || error instanceof GroupError
        ? error.details
        : error instanceof SettingsError
          ? settingsErrorDetails(error)
          : undefined;
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
          directories,
          groups: groups.groups(),
          settings: groups.settings(),
          agentKinds: groups.agentKinds(),
          palette: PALETTE,
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
        // 回复快照之后再读 usage，usage.updated 一定排在快照之后。
        void groups.refreshUsage(request.groupId, "view");
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
        this.#respondOk(
          request.requestId,
          await groups.startRound(request.groupId, request.text, request.order, request.attachmentIds),
        );
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
      case "group.pin": {
        const group = await groups.setPinned(request.groupId, request.pinned);
        this.#respondOk(request.requestId, { group });
        return;
      }
      case "group.usage": {
        const group = await groups.setUsageAgent(request.groupId, request.agent);
        this.#respondOk(request.requestId, { group });
        return;
      }
      case "group.usage.refresh": {
        // 结果走 usage.updated；usage 关着时 refreshUsage 什么也不做。
        void groups.refreshUsage(request.groupId, "visible");
        this.#respondOk(request.requestId, {});
        return;
      }
      case "attachment.ticket": {
        const { ticket, expiresAtMs, attachment } = await groups.createAttachmentTicket(request.groupId, {
          originalName: request.originalName,
          declaredMime: request.declaredMime,
          expectedSize: request.expectedSize,
        });
        this.#respondOk(request.requestId, { ticket, expiresAtMs, attachment });
        return;
      }
      case "settings.username": {
        this.#respondOk(request.requestId, { settings: await groups.setUsername(request.username) });
        return;
      }
      case "settings.collaboration": {
        this.#respondOk(request.requestId, { settings: await groups.setCollaboration(request.collaboration) });
        return;
      }
      case "settings.agent.add": {
        this.#respondOk(request.requestId, await groups.addAgent());
        return;
      }
      case "settings.agent.update": {
        const { agentId, ...patch } = request;
        this.#respondOk(request.requestId, { settings: await groups.updateAgent(agentId, patch) });
        return;
      }
      case "settings.agent.remove": {
        this.#respondOk(request.requestId, { settings: await groups.removeAgent(request.agentId) });
        return;
      }
      case "settings.agent.reorder": {
        this.#respondOk(request.requestId, { settings: await groups.reorderAgents(request.order) });
        return;
      }
      case "settings.catalog": {
        this.#respondOk(request.requestId, await groups.settingsCatalog(request.agentId));
        return;
      }
      case "settings.defaults": {
        const { model, effort, permission } = request;
        const settings = await groups.setDefaultSettings(request.agentId, { model, effort, permission });
        this.#respondOk(request.requestId, { settings });
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

function settingsErrorDetails(error: SettingsError): Record<string, string> | undefined {
  const details = {
    ...(error.field ? { field: error.field } : {}),
    ...(error.agentId ? { agentId: error.agentId } : {}),
  };
  return Object.keys(details).length > 0 ? details : undefined;
}
