import { EventChannel } from "../event-channel.ts";
import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
  ApprovalAnswer,
  ApprovalAsk,
  SessionOptions,
} from "../types.ts";
import { AppServerClient, type JsonObject, type RequestId } from "./client.ts";

export type CodexAdapterOptions = {
  executable: string;
};

const INITIALIZE_PARAMS = {
  clientInfo: { name: "lanting", title: "lanting", version: "0.1.0" },
  capabilities: { experimentalApi: true, requestAttestation: false },
};

/** `turn/interrupt` 等这么久没有回执，就直接关掉 app-server。 */
const INTERRUPT_TIMEOUT_MS = 10_000;

export class CodexAdapter implements AgentAdapter {
  readonly id = "codex";
  readonly displayName = "Codex";
  /** 照 Codex Remote：每轮结束就关掉 app-server。 */
  readonly closeAfterTurn = true;
  readonly #options: CodexAdapterOptions;

  constructor(options: CodexAdapterOptions) {
    this.#options = options;
  }

  startSession(options: SessionOptions): Promise<AgentSession> {
    return CodexSession.open(null, options, this.#options);
  }

  resumeSession(nativeId: string, options: SessionOptions): Promise<AgentSession> {
    return CodexSession.open(nativeId, options, this.#options);
  }
}

type Turn = {
  channel: EventChannel<AgentEvent>;
  id: string | null;
  /** 最近一条已完成的 agentMessage；下一个工具调用出现时转成过程信息。 */
  pending: string;
  lastError: string | null;
  interruptRequested: boolean;
};

/**
 * 每个原生会话一个独立的 codex app-server 子进程（独立进程组），
 * 关闭时连同它启动的工具进程一起结束。
 *
 * 明文回复以这一轮最后一条 agentMessage 为准，之前的过渡文字转成过程信息。
 */
class CodexSession implements AgentSession {
  readonly #client: AppServerClient;
  readonly #options: SessionOptions;
  readonly #approvals = new Map<RequestId, AbortController>();
  #threadId = "";
  #turn: Turn | null = null;
  #exited = false;

  private constructor(client: AppServerClient, options: SessionOptions) {
    this.#client = client;
    this.#options = options;
    client.onNotification((message) => this.#onNotification(message));
    client.onServerRequest((message) => this.#onServerRequest(message));
    void client.whenExited().then(() => {
      this.#exited = true;
      this.#finish({ type: "end", outcome: "failed", text: this.#turn?.pending ?? "", error: "codex app-server 已退出。" });
    });
  }

  static async open(
    threadId: string | null,
    options: SessionOptions,
    adapter: CodexAdapterOptions,
  ): Promise<CodexSession> {
    const client = new AppServerClient({
      codexBinary: adapter.executable,
      workingDirectory: options.cwd,
      processGroup: true,
    });
    const session = new CodexSession(client, options);
    try {
      await client.initialize(INITIALIZE_PARAMS);
      const response = threadId
        ? await client.request("thread/resume", {
          threadId,
          cwd: options.cwd,
          developerInstructions: options.systemPrompt,
        })
        : await client.request("thread/start", {
          cwd: options.cwd,
          ephemeral: false,
          serviceName: "lanting",
          developerInstructions: options.systemPrompt,
        });
      const id = readThreadId(response);
      if (threadId && id !== threadId) throw new Error("Codex 返回了错误的会话。");
      session.#threadId = id;
      return session;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  get nativeId(): string {
    return this.#threadId;
  }

  get alive(): boolean {
    return !this.#exited && !this.#client.closed;
  }

  async *send(text: string): AsyncIterable<AgentEvent> {
    if (!this.alive) throw new Error("codex app-server 已关闭。");
    if (this.#turn) throw new Error("Codex 还在处理上一轮。");
    const turn: Turn = {
      channel: new EventChannel<AgentEvent>(),
      id: null,
      pending: "",
      lastError: null,
      interruptRequested: false,
    };
    this.#turn = turn;
    try {
      const response = await this.#client.request("turn/start", {
        threadId: this.#threadId,
        input: [{ type: "text", text, text_elements: [] }],
      });
      const turnId = readTurnId(response);
      // turn/started 通知可能先到，也可能这一轮在响应之前就已经结束。
      if (this.#turn === turn) {
        turn.id ??= turnId;
        if (turn.interruptRequested) void this.interrupt();
      }
    } catch (error) {
      if (this.#turn === turn) this.#turn = null;
      throw error;
    }
    yield* turn.channel;
  }

  async interrupt(): Promise<void> {
    const turn = this.#turn;
    if (!turn) return;
    turn.interruptRequested = true;
    for (const controller of this.#approvals.values()) controller.abort();
    if (!turn.id) return;
    let timer: NodeJS.Timeout | undefined;
    const acknowledged = await Promise.race([
      this.#client.request("turn/interrupt", { threadId: this.#threadId, turnId: turn.id })
        .then(() => true, () => false),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), INTERRUPT_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    if (!acknowledged) {
      this.#finish({ type: "end", outcome: "interrupted", text: turn.pending });
      await this.close();
    }
  }

  async close(): Promise<void> {
    for (const controller of this.#approvals.values()) controller.abort();
    await this.#client.close();
  }

  #finish(event: Extract<AgentEvent, { type: "end" }>): void {
    const turn = this.#turn;
    if (!turn) return;
    this.#turn = null;
    turn.channel.push(event);
    turn.channel.end();
  }

  #push(event: AgentEvent): void {
    this.#turn?.channel.push(event);
  }

  #onNotification(message: JsonObject): void {
    const params = asObject(message.params);
    if (!params) return;
    // Codex 自己收回了审批：撤下网页上的卡片，不再回复。
    if (message.method === "serverRequest/resolved") {
      const requestId = params.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") {
        const controller = this.#approvals.get(requestId);
        this.#approvals.delete(requestId);
        controller?.abort();
      }
      return;
    }
    if (params.threadId !== this.#threadId) return;
    const turn = this.#turn;
    if (!turn) return;
    // 只认这一轮的通知；turn id 还不知道时先记下第一个出现的。
    if (typeof params.turnId === "string") {
      if (turn.id && params.turnId !== turn.id) return;
    }

    switch (message.method) {
      case "turn/started": {
        const id = asObject(params.turn)?.id;
        if (typeof id === "string" && !turn.id) {
          turn.id = id;
          if (turn.interruptRequested) void this.interrupt();
        }
        return;
      }
      case "item/agentMessage/delta":
        if (typeof params.delta === "string") this.#push({ type: "text", delta: params.delta });
        return;
      case "item/started": {
        const activity = toolActivity(asObject(params.item));
        if (!activity) return;
        if (turn.pending.trim()) this.#push({ type: "activity", activity: { kind: "note", text: turn.pending } });
        turn.pending = "";
        this.#push({ type: "activity", activity });
        return;
      }
      case "item/completed": {
        const item = asObject(params.item);
        if (item?.type === "agentMessage" && typeof item.text === "string") turn.pending = item.text;
        return;
      }
      case "error": {
        const error = asObject(params.error);
        if (params.willRetry !== true && typeof error?.message === "string") turn.lastError = error.message;
        return;
      }
      case "turn/completed": {
        const completed = asObject(params.turn);
        if (!completed || (turn.id && completed.id !== turn.id)) return;
        const status = completed.status;
        const error = asObject(completed.error)?.message;
        const outcome = status === "completed" ? "completed" : status === "interrupted" ? "interrupted" : "failed";
        this.#finish({
          type: "end",
          outcome,
          text: turn.pending,
          ...(outcome === "failed"
            ? { error: typeof error === "string" ? error : turn.lastError ?? "Codex 未能完成这一轮。" }
            : {}),
        });
        return;
      }
    }
  }

  #onServerRequest(message: JsonObject): void {
    const id = message.id;
    if (typeof id !== "string" && typeof id !== "number") return;
    const params = asObject(message.params) ?? {};
    const method = typeof message.method === "string" ? message.method : "";
    const approval = readApproval(method, params);
    if (!approval || params.threadId !== this.#threadId) {
      this.#client.rejectServerRequest(id, `lanting 不支持这个请求：${method}`);
      return;
    }
    const controller = new AbortController();
    this.#approvals.set(id, controller);
    void this.#options.requestApproval(approval.ask, controller.signal)
      .then((answer) => {
        // 已被 Codex 收回的请求不再回复。
        if (!this.#approvals.delete(id)) return;
        if (!this.#client.closed) this.#client.respondToServerRequest(id, approval.respond(answer));
      })
      .catch((error: unknown) => {
        this.#approvals.delete(id);
        console.error(`Codex 审批处理出错：${error instanceof Error ? error.message : String(error)}`);
      });
  }
}

type ParsedApproval = {
  ask: ApprovalAsk;
  respond: (answer: ApprovalAnswer) => JsonObject;
};

function readApproval(method: string, params: JsonObject): ParsedApproval | null {
  const reason = typeof params.reason === "string" ? params.reason : "";
  const decision = (answer: ApprovalAnswer) => ({ decision: answer.decision === "allow" ? "accept" : "decline" });
  if (method === "item/commandExecution/requestApproval") {
    const command = typeof params.command === "string" ? params.command : "";
    const network = asObject(params.networkApprovalContext);
    const target = network && typeof network.host === "string" ? `网络：${String(network.protocol ?? "")} ${network.host}` : "";
    return {
      ask: { toolName: "命令", detail: [command, target, reason].filter(Boolean).join("\n") },
      respond: decision,
    };
  }
  if (method === "item/fileChange/requestApproval") {
    return { ask: { toolName: "修改文件", detail: reason }, respond: decision };
  }
  if (method === "item/permissions/requestApproval") {
    const permissions = asObject(params.permissions) ?? {};
    return {
      ask: { toolName: "扩大权限", detail: [reason, JSON.stringify(permissions).slice(0, 600)].filter(Boolean).join("\n") },
      respond: (answer) => {
        if (answer.decision !== "allow") return { permissions: {}, scope: "turn" };
        const granted: JsonObject = {};
        if (permissions.network != null) granted.network = permissions.network;
        if (permissions.fileSystem != null) granted.fileSystem = permissions.fileSystem;
        return { permissions: granted, scope: "turn" };
      },
    };
  }
  return null;
}

/** 把 Codex 的工具类 ThreadItem 缩成一行过程信息；不是工具的返回 null。 */
export function toolActivity(item: JsonObject | null): { kind: "tool"; toolName: string; detail: string } | null {
  if (!item || typeof item.type !== "string") return null;
  const clip = (value: unknown) =>
    typeof value === "string" ? value.replaceAll(/\s+/gu, " ").trim().slice(0, 240) : "";
  switch (item.type) {
    case "commandExecution":
      return { kind: "tool", toolName: "命令", detail: clip(item.command) };
    case "fileChange": {
      const paths = Array.isArray(item.changes)
        ? item.changes.map((change) => asObject(change)?.path).filter((value) => typeof value === "string")
        : [];
      return { kind: "tool", toolName: "修改文件", detail: clip(paths.join(", ")) };
    }
    case "webSearch": {
      const action = asObject(item.action);
      return { kind: "tool", toolName: "网页", detail: clip(item.query ?? action?.query ?? action?.url) };
    }
    case "mcpToolCall":
      return { kind: "tool", toolName: [item.server, item.tool].filter(Boolean).join(" · ") || "MCP", detail: "" };
    case "dynamicToolCall":
      return { kind: "tool", toolName: [item.namespace, item.tool].filter(Boolean).join(" · ") || "工具", detail: "" };
    case "imageView":
      return { kind: "tool", toolName: "查看图片", detail: clip(item.path) };
    default:
      return null;
  }
}

function readThreadId(value: unknown): string {
  const id = asObject(asObject(value)?.thread)?.id;
  if (typeof id !== "string" || !id) throw new Error("Codex 返回了无法识别的会话。");
  return id;
}

function readTurnId(value: unknown): string {
  const id = asObject(asObject(value)?.turn)?.id;
  if (typeof id !== "string" || !id) throw new Error("Codex 返回了无法识别的任务启动结果。");
  return id;
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}
