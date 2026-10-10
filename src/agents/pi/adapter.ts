import type { AgentFeatures } from "../../features/index.ts";
import { CatalogCache } from "../catalog-cache.ts";
import { EventChannel } from "../event-channel.ts";
import type {
  AgentAdapter,
  AgentCatalog,
  AgentEvent,
  AgentSession,
  ModelOption,
  PermissionOption,
  SessionOptions,
} from "../types.ts";
import { PiRpcClient, type PiEvent, type PiUiRequest } from "./rpc-client.ts";

export type PiAdapterOptions = {
  executable: string;
};

/** abort 之后等这么久这一轮还没 settle，就直接关掉 Pi 进程。 */
const INTERRUPT_TIMEOUT_MS = 10_000;

/**
 * 审批由 pi-minimal-permission-system 扩展负责，它只管 read、edit、write、bash，
 * 规则写在 Pi 自己的用户配置里。always-approve 不用扩展的 yolo，而是由 lanting
 * 替群主回答“允许”，所以规则里的 deny 仍然生效。
 */
export const PI_PERMISSIONS: readonly PermissionOption[] = [
  {
    id: "ask",
    label: "逐次确认",
    description: "read、edit、write、bash 按 Pi 权限扩展的规则执行，需要确认的由群主在网页上批准。",
  },
  {
    id: "always-approve",
    label: "Always approve",
    description: "需要确认的 read、edit、write、bash 直接放行；Pi 权限规则里的 deny 仍然生效。",
    danger: true,
  },
];

const ALWAYS_APPROVE = "always-approve";

/** Pi 的思考档位，顺序同 Pi 的 EXTENDED_THINKING_LEVELS。 */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export class PiAdapter implements AgentAdapter {
  readonly kind = "pi";
  /** 每轮结束关掉 RPC 进程，下次用 session 文件恢复，与 Codex、Grok 一致。 */
  readonly closeAfterTurn = true;
  readonly features: AgentFeatures = {
    compact: (session) => asOwnSession(session).compact(),
    models: async (cwd) => (await this.#catalog(cwd)).models,
    permissions: async (cwd) => (await this.#catalog(cwd)).permissions,
  };
  readonly #options: PiAdapterOptions;
  readonly #catalogs = new CatalogCache();

  constructor(options: PiAdapterOptions) {
    this.#options = options;
  }

  /** 启动一个不保存 session 的短命 RPC 进程查模型列表；Pi 只返回有凭据的模型。 */
  #catalog(cwd: string): Promise<AgentCatalog> {
    return this.#catalogs.get("", async () => {
      const client = new PiRpcClient({
        executable: this.#options.executable,
        args: ["--no-session"],
        cwd,
        env: childEnvironment(process.env),
      });
      try {
        return { models: modelOptions(await client.getAvailableModels()), permissions: [...PI_PERMISSIONS] };
      } finally {
        await client.close();
      }
    });
  }

  startSession(options: SessionOptions): Promise<AgentSession> {
    return PiSession.open(null, options, this.#options);
  }

  resumeSession(nativeId: string, options: SessionOptions): Promise<AgentSession> {
    return PiSession.open(nativeId, options, this.#options);
  }
}

function asOwnSession(session: AgentSession): PiSession {
  if (!(session instanceof PiSession)) throw new Error("会话不属于 Pi。");
  return session;
}

type Turn = {
  channel: EventChannel<AgentEvent>;
  /** 当前这段 assistant 正文；工具调用或新的 assistant 消息出现时转成过程信息。 */
  segment: string;
  /** 最后一条完成的 assistant 消息，agent_settled 时以它为准。 */
  last: Record<string, unknown> | null;
  /** 有一条 assistant 消息开始了还没结束。 */
  streaming: boolean;
  /** 群主已经要求打断；之后结束的这一轮按 interrupted 处理。 */
  interrupted: boolean;
};

/**
 * 每个原生会话一个独立的 `pi --mode rpc` 子进程（独立进程组）。
 * nativeId 是 Pi 的 session 文件路径，恢复时用 switch_session 加载。
 */
class PiSession implements AgentSession {
  readonly #client: PiRpcClient;
  readonly #options: SessionOptions;
  /** 网页上还没回答的审批，按 Pi 的 UI 请求 id。 */
  readonly #approvals = new Map<string, AbortController>();
  #sessionFile = "";
  #turn: Turn | null = null;

  private constructor(client: PiRpcClient, options: SessionOptions) {
    this.#client = client;
    this.#options = options;
    client.on("event", (event: PiEvent) => this.#onEvent(event));
    client.on("ui", (request: PiUiRequest) => this.#onUi(request));
    client.on("exit", () => {
      this.#cancelApprovals();
      const turn = this.#turn;
      if (!turn) return;
      this.#finish(turn.interrupted
        ? { type: "end", outcome: "interrupted", text: lastText(turn) }
        : { type: "end", outcome: "failed", text: lastText(turn), error: "Pi 进程已退出。" });
    });
  }

  static async open(
    sessionFile: string | null,
    options: SessionOptions,
    adapter: PiAdapterOptions,
  ): Promise<PiSession> {
    // 群聊 system prompt 不存进 Pi 的 session 文件，新建和恢复都要传。
    const client = new PiRpcClient({
      executable: adapter.executable,
      args: ["--append-system-prompt", options.systemPrompt],
      cwd: options.cwd,
      env: childEnvironment(process.env),
    });
    const session = new PiSession(client, options);
    try {
      if (sessionFile) {
        const { cancelled } = await client.switchSession(sessionFile);
        if (cancelled) throw new Error("Pi 扩展拒绝了恢复会话。");
      }
      const state = await client.getState();
      if (typeof state.sessionFile !== "string" || !state.sessionFile) {
        throw new Error("Pi 没有返回 session 文件路径。");
      }
      session.#sessionFile = state.sessionFile;
      const { model, effort } = options.settings;
      const modelChanged = Boolean(model) && model !== currentModelId(state);
      if (model && modelChanged) {
        const { provider, modelId } = splitModelId(model);
        await client.setModel(provider, modelId);
      }
      if (effort && (modelChanged || state.thinkingLevel !== effort)) {
        await client.setThinkingLevel(effort);
      }
      return session;
    } catch (error) {
      if (client.stderrTail.trim()) console.error(`Pi stderr：${client.stderrTail.trim()}`);
      await session.close();
      throw error;
    }
  }

  get nativeId(): string | null {
    return this.#sessionFile || null;
  }

  get alive(): boolean {
    return this.#client.alive;
  }

  async *send(text: string): AsyncIterable<AgentEvent> {
    if (!this.alive) throw new Error("Pi 进程已关闭。");
    if (this.#turn) throw new Error("Pi 还在处理上一轮。");
    const turn: Turn = { channel: new EventChannel<AgentEvent>(), segment: "", last: null, streaming: false, interrupted: false };
    this.#turn = turn;
    // 事件监听先于 prompt 装好；prompt 成功只表示已接受，这一轮在 agent_settled 才结束。
    void this.#client.prompt(text).then(
      (result) => {
        // handled：Pi 当作扩展命令处理掉了，不会有 run，也不会有 agent_settled。
        if (result.disposition === "handled" && this.#turn === turn) {
          this.#finish({ type: "end", outcome: "completed", text: "" });
        }
      },
      (error: unknown) => {
        this.#finish({
          type: "end",
          outcome: turn.interrupted ? "interrupted" : "failed",
          text: lastText(turn),
          ...(turn.interrupted ? {} : { error: error instanceof Error ? error.message : String(error) }),
        });
      },
    );
    yield* turn.channel;
  }

  async compact(): Promise<void> {
    if (!this.alive) throw new Error("Pi 进程已关闭。");
    if (this.#turn) throw new Error("Pi 还在处理上一轮。");
    await this.#client.compact();
  }

  async interrupt(): Promise<void> {
    const turn = this.#turn;
    if (!turn) return;
    turn.interrupted = true;
    this.#cancelApprovals();
    await this.#client.abort().catch(() => {});
    const ended = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), INTERRUPT_TIMEOUT_MS);
      void (async () => {
        while (this.#turn === turn && this.alive) await new Promise((r) => setTimeout(r, 50));
        clearTimeout(timer);
        resolve(true);
      })();
    });
    if (!ended) {
      this.#finish({ type: "end", outcome: "interrupted", text: lastText(turn) });
      await this.close();
    }
  }

  async close(): Promise<void> {
    this.#cancelApprovals();
    await this.#client.close();
  }

  #finish(event: Extract<AgentEvent, { type: "end" }>): void {
    const turn = this.#turn;
    if (!turn) return;
    this.#turn = null;
    turn.channel.push(event);
    turn.channel.end();
  }

  #note(turn: Turn, text: string): void {
    turn.channel.push({ type: "activity", activity: { kind: "note", text } });
  }

  /** 把已经流出的正文收进过程信息，正文从下一段重新开始。 */
  #flushSegment(turn: Turn): void {
    if (turn.segment.trim()) this.#note(turn, turn.segment);
    turn.segment = "";
  }

  #onEvent(event: PiEvent): void {
    const turn = this.#turn;
    if (!turn) return;
    switch (event.type) {
      case "message_start":
        if (objectField(event.message).role === "assistant") {
          this.#flushSegment(turn);
          turn.streaming = true;
        }
        return;
      case "message_update": {
        const update = objectField(event.assistantMessageEvent);
        if (update.type === "text_delta" && typeof update.delta === "string" && update.delta) {
          turn.segment += update.delta;
          turn.channel.push({ type: "text", delta: update.delta });
        }
        return;
      }
      case "message_end": {
        const message = objectField(event.message);
        if (message.role === "assistant") {
          turn.last = message;
          turn.streaming = false;
        }
        return;
      }
      case "tool_execution_start":
        this.#flushSegment(turn);
        turn.channel.push({ type: "activity", activity: toolActivity(event) });
        return;
      case "auto_retry_start":
        this.#note(turn, `Pi 自动重试（${event.attempt}/${event.maxAttempts}）：${stringField(event.errorMessage)}`);
        return;
      case "compaction_start":
        this.#note(turn, "Pi 正在压缩上下文。");
        return;
      case "compaction_end":
        if (typeof event.errorMessage === "string") this.#note(turn, `Pi 压缩上下文失败：${event.errorMessage}`);
        return;
      case "extension_error":
        this.#note(turn, `Pi 扩展出错：${stringField(event.error)}`);
        return;
      case "agent_settled":
        this.#settle(turn, event.aborted === true);
        return;
    }
  }

  #settle(turn: Turn, aborted: boolean): void {
    const last = turn.last;
    const text = lastText(turn);
    if (turn.interrupted || aborted || last?.stopReason === "aborted") {
      this.#finish({ type: "end", outcome: "interrupted", text });
    } else if (last?.stopReason === "error") {
      this.#finish({ type: "end", outcome: "failed", text, error: stringField(last.errorMessage) || "Pi 调用模型出错。" });
    } else if (!text.trim()) {
      this.#finish({ type: "end", outcome: "failed", text, error: "Pi 没有给出最终回复。" });
    } else {
      this.#finish({ type: "end", outcome: "completed", text });
    }
  }

  #onUi(request: PiUiRequest): void {
    const { id, method } = request;
    if (method === "confirm") {
      this.#confirm(request);
      return;
    }
    if (method === "select" || method === "input" || method === "editor") {
      // lanting 只接 confirm；其他对话框不回答的话 Pi 会一直等。
      this.#client.respondUi(id, { cancelled: true });
      const turn = this.#turn;
      if (turn) {
        turn.channel.push({
          type: "activity",
          activity: { kind: "denied", toolName: stringField(request.title) || method, message: "lanting 不支持这类 Pi 扩展对话框。" },
        });
      }
      return;
    }
    if (method === "notify" && this.#turn && typeof request.message === "string") {
      this.#note(this.#turn, request.message);
    }
  }

  #confirm(request: PiUiRequest): void {
    const { id } = request;
    const turn = this.#turn;
    if (!turn || turn.interrupted) {
      this.#client.respondUi(id, { cancelled: true });
      return;
    }
    if (this.#options.settings.permission === ALWAYS_APPROVE) {
      this.#client.respondUi(id, { confirmed: true });
      return;
    }
    const controller = new AbortController();
    this.#approvals.set(id, controller);
    this.#options.requestApproval({
      toolName: stringField(request.title) || "Pi",
      detail: stringField(request.message),
    }, controller.signal).then(
      (answer) => {
        if (this.#approvals.get(id) !== controller) return;
        this.#approvals.delete(id);
        this.#client.respondUi(id, { confirmed: answer.decision === "allow" });
      },
      () => {
        if (this.#approvals.get(id) !== controller) return;
        this.#approvals.delete(id);
        this.#client.respondUi(id, { cancelled: true });
      },
    );
  }

  /** 撤下网页上的审批，并告诉仍在运行的 Pi 这些对话框取消了。 */
  #cancelApprovals(): void {
    for (const [id, controller] of this.#approvals) {
      this.#approvals.delete(id);
      controller.abort();
      this.#client.respondUi(id, { cancelled: true });
    }
  }
}

/** get_state 里当前模型，格式和成员设置相同：`provider/modelId`。 */
function currentModelId(state: Record<string, unknown>): string | null {
  const model = objectField(state.model);
  if (typeof model.provider !== "string" || !model.provider || typeof model.id !== "string" || !model.id) return null;
  return `${model.provider}/${model.id}`;
}

/** lanting 里的模型 id 是 `provider/modelId`；modelId 本身可能还带斜杠。 */
export function splitModelId(id: string): { provider: string; modelId: string } {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) throw new Error(`Pi 模型 id 格式不对：${id}`);
  return { provider: id.slice(0, slash), modelId: id.slice(slash + 1) };
}

/** get_available_models 的模型对象转成成员面板的选项。 */
export function modelOptions(models: Record<string, unknown>[]): ModelOption[] {
  return models.flatMap((model) => {
    if (typeof model.provider !== "string" || !model.provider || typeof model.id !== "string" || !model.id) return [];
    const levels = supportedThinkingLevels(model);
    return [{
      id: `${model.provider}/${model.id}`,
      label: typeof model.name === "string" && model.name ? model.name : model.id,
      description: model.provider,
      efforts: levels.length > 1 ? levels : [],
    }];
  });
}

/** 照 Pi 的 getSupportedThinkingLevels：thinkingLevelMap 里为 null 的档位不支持，xhigh、max 要明确列出。 */
function supportedThinkingLevels(model: Record<string, unknown>): string[] {
  if (model.reasoning !== true) return ["off"];
  const map = objectField(model.thinkingLevelMap);
  return THINKING_LEVELS.filter((level) => {
    const mapped = map[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

function toolActivity(event: PiEvent): { kind: "tool"; toolName: string; detail: string } {
  const args = objectField(event.args);
  const detail = ["command", "path", "file_path", "pattern", "query", "url"]
    .map((key) => args[key])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? "";
  return {
    kind: "tool",
    toolName: (stringField(event.toolName) || "工具").slice(0, 120),
    detail: detail.replaceAll(/\s+/gu, " ").trim().slice(0, 240),
  };
}

/** 最后一条 assistant 消息的正文；它还没结束（比如被打断）时用正在流出的这一段。 */
function lastText(turn: Turn): string {
  if (turn.streaming || !turn.last) return turn.segment;
  const content = turn.last.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => objectField(block))
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function objectField(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * 网页登录令牌 CLI 用不到，留着只会让每个工具子进程都能拿到网页端的控制权。
 * 权限扩展的 yolo 和非交互开关也不从环境继承，否则会绕过扩展的 deny 规则。
 */
function childEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child = { ...environment };
  delete child.ACCESS_TOKEN;
  delete child.PI_MINIMAL_PERMISSION_SYSTEM_YOLO;
  delete child.PI_MINIMAL_PERMISSION_SYSTEM_NONINTERACTIVE;
  return child;
}
