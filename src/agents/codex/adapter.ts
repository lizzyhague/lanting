import type { AgentFeatures, UsagePart } from "../../features/index.ts";
import { EventChannel } from "../event-channel.ts";
import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
  ApprovalAnswer,
  ApprovalAsk,
  ModelOption,
  PermissionOption,
  SessionOptions,
} from "../types.ts";
import { AppServerClient, AppServerRpcError, type JsonObject, type RequestId } from "./client.ts";
import { ResidentAppServer } from "./resident.ts";

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
  readonly kind = "codex";
  /** 照 Codex Remote：每轮结束就关掉 app-server。 */
  readonly closeAfterTurn = true;
  readonly features: AgentFeatures = {
    compact: (session) => asOwnSession(session).compact(),
    deleteSession: (nativeId, cwd) => this.#deleteSession(nativeId, cwd),
    models: () => listModels(this.#resident),
    permissions: (cwd) => listPermissions(this.#resident, cwd),
    usage: (request) => this.#usage(request.nativeId),
  };
  readonly #options: CodexAdapterOptions;
  readonly #resident: ResidentAppServer;
  /**
   * 照 Codex Remote：上下文只在发言时从 thread/tokenUsage/updated 记下，不为读上下文去恢复会话。
   * 只放内存，进程关掉后仍保留；lanting 重启后要等这个成员再发言。
   */
  readonly #contexts = new Map<string, number>();
  /** 同一时间只有一个额度查询在途，并发调用共用它。 */
  #quota: Promise<QuotaWindow[]> | null = null;

  constructor(options: CodexAdapterOptions) {
    this.#options = options;
    this.#resident = new ResidentAppServer({
      executable: options.executable,
      initializeParams: INITIALIZE_PARAMS,
    });
  }

  start(): void {
    this.#resident.start();
  }

  close(): Promise<void> {
    return this.#resident.close();
  }

  /** 照 Codex Remote：临时起一个 app-server 调 thread/delete；已经不存在也算删掉了。 */
  async #deleteSession(nativeId: string, cwd: string): Promise<void> {
    const client = new AppServerClient({
      codexBinary: this.#options.executable,
      workingDirectory: cwd,
      processGroup: true,
    });
    try {
      await client.initialize(INITIALIZE_PARAMS);
      await client.request("thread/delete", { threadId: nativeId });
    } catch (error) {
      if (!isAlreadyDeleted(error, nativeId)) throw error;
    } finally {
      await client.close();
    }
  }

  startSession(options: SessionOptions): Promise<AgentSession> {
    return CodexSession.open(null, options, this.#options, this.#onTokenUsage);
  }

  resumeSession(nativeId: string, options: SessionOptions): Promise<AgentSession> {
    return CodexSession.open(nativeId, options, this.#options, this.#onTokenUsage);
  }

  /** 照 Codex Remote：按最近一次调用的 token 用量估算上下文。 */
  readonly #onTokenUsage: TokenUsageListener = (threadId, tokenUsage) => {
    const usage = asObject(tokenUsage);
    const used = finiteNumber(asObject(usage?.last)?.totalTokens);
    const max = finiteNumber(usage?.modelContextWindow);
    if (used !== null && used >= 0 && max !== null && max > 0) this.#contexts.set(threadId, used / max * 100);
    else this.#contexts.delete(threadId);
  };

  async #usage(threadId: string): Promise<UsagePart[]> {
    this.#quota ??= readQuota(this.#resident).finally(() => {
      this.#quota = null;
    });
    const windows = await this.#quota;
    const context = this.#contexts.get(threadId);
    return usageParts(context ?? null, windows);
  }
}

export type QuotaWindow = { label: string; remainingPercent: number | null; resetsAt: number | null };

/** 照 Codex Remote 的 #refreshQuota。查询失败时返回空数组，不把上次的额度冒充为当前值。 */
async function readQuota(client: Pick<ResidentAppServer, "request">): Promise<QuotaWindow[]> {
  try {
    const response = asObject(await client.request("account/rateLimits/read", undefined));
    const byId = asObject(response?.rateLimitsByLimitId);
    const snapshots = byId && Object.keys(byId).length ? Object.values(byId) : [response?.rateLimits];
    return snapshots.flatMap((value) => {
      const snapshot = asObject(value);
      if (!snapshot) return [];
      const name = typeof snapshot.limitName === "string" ? snapshot.limitName
        : typeof snapshot.limitId === "string" ? snapshot.limitId : "Codex";
      return [snapshot.primary, snapshot.secondary].flatMap((value) => {
        const window = asObject(value);
        if (!window) return [];
        const minutes = finiteNumber(window.windowDurationMins);
        const duration = minutes === null ? "" : minutes % 1440 === 0
          ? `${minutes / 1440} 天` : minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
        const used = finiteNumber(window.usedPercent);
        return [{
          label: `${name}${duration ? `（${duration}）` : ""}`,
          remainingPercent: used === null ? null : Math.max(0, Math.min(100, 100 - used)),
          resetsAt: finiteNumber(window.resetsAt),
        }];
      });
    });
  } catch (error) {
    console.error(`读取 Codex 套餐额度失败：${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/** 文字照 Codex Remote 的 renderSessionMetrics。resetsAt 是 unix 秒，交出前换成 ISO 字符串。 */
export function usageParts(context: number | null, windows: readonly QuotaWindow[]): UsagePart[] {
  const parts: UsagePart[] = [{ text: context === null ? "上下文等待更新" : `上下文约 ${context.toFixed(1)}%` }];
  if (windows.length === 0) {
    parts.push({ text: "额度查询不可用" });
    return parts;
  }
  for (const quota of windows) {
    const left = typeof quota.remainingPercent === "number" ? `${quota.remainingPercent.toFixed(1)}%` : "未知";
    const label = quota.label.replace(/^codex（(.+)）$/iu, "$1");
    parts.push(quota.resetsAt === null
      ? { text: `${label}剩余 ${left}` }
      : { text: `${label}剩余 ${left}，{time} 重置`, time: new Date(quota.resetsAt * 1000).toISOString() });
  }
  return parts;
}

function asOwnSession(session: AgentSession): CodexSession {
  if (!(session instanceof CodexSession)) throw new Error("会话不属于 Codex CLI。");
  return session;
}

type TokenUsageListener = (threadId: string, tokenUsage: unknown) => void;

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
  readonly #onTokenUsage: TokenUsageListener;
  readonly #approvals = new Map<RequestId, AbortController>();
  #threadId = "";
  #turn: Turn | null = null;
  #exited = false;

  private constructor(client: AppServerClient, options: SessionOptions, onTokenUsage: TokenUsageListener) {
    this.#client = client;
    this.#options = options;
    this.#onTokenUsage = onTokenUsage;
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
    onTokenUsage: TokenUsageListener,
  ): Promise<CodexSession> {
    const client = new AppServerClient({
      codexBinary: adapter.executable,
      workingDirectory: options.cwd,
      processGroup: true,
    });
    const session = new CodexSession(client, options, onTokenUsage);
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
      const settings = settingsUpdate(options);
      if (settings) await client.request("thread/settings/update", { threadId: id, ...settings });
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

  /** 照 Codex Remote：压缩也是一轮，等它的 turn/completed。 */
  async compact(): Promise<void> {
    for await (const event of this.#run(() =>
      this.#client.request("thread/compact/start", { threadId: this.#threadId }).then(() => null)
    )) {
      if (event.type !== "end") continue;
      if (event.outcome !== "completed") throw new Error(event.error ?? "压缩被打断了。");
    }
  }

  send(text: string): AsyncIterable<AgentEvent> {
    return this.#run(async () => readTurnId(await this.#client.request("turn/start", {
      threadId: this.#threadId,
      input: [{ type: "text", text, text_elements: [] }],
    })));
  }

  /** start 发出这一轮的请求，返回 turn id；不在响应里给 id 的返回 null，等 turn/started。 */
  async *#run(start: () => Promise<string | null>): AsyncIterable<AgentEvent> {
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
      const turnId = await start();
      // turn/started 通知可能先到，也可能这一轮在响应之前就已经结束。
      if (this.#turn === turn && turnId) {
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
    // 上下文用量不按 turn 过滤：压缩、恢复之后的用量也要记下。
    if (message.method === "thread/tokenUsage/updated") {
      this.#onTokenUsage(this.#threadId, params.tokenUsage);
      return;
    }
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

/** 照 Codex Remote 认这一条错误。 */
function isAlreadyDeleted(error: unknown, threadId: string): boolean {
  return error instanceof AppServerRpcError &&
    error.code === -32600 &&
    error.message === `no rollout found for thread id ${threadId}`;
}

/** 照 Codex Remote：模型和思考强度一起设，权限传权限档案的 id。没有要改的返回 null。 */
function settingsUpdate(options: SessionOptions): JsonObject | null {
  const { model, effort, permission } = options.settings;
  const update: JsonObject = {};
  if (model) {
    update.model = model;
    if (effort) update.effort = effort;
  }
  if (permission) update.permissions = permission;
  return Object.keys(update).length > 0 ? update : null;
}

async function listModels(client: Pick<AppServerClient, "request">): Promise<ModelOption[]> {
  const models: ModelOption[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const response = asObject(await client.request("model/list", { cursor, limit: 100, includeHidden: false }));
    if (!response || !Array.isArray(response.data)) throw new Error("Codex 返回了无法识别的模型列表。");
    for (const value of response.data) {
      const model = asObject(value);
      if (!model || typeof model.id !== "string" || model.hidden === true) continue;
      const efforts = Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts
          .map((option) => asObject(option)?.reasoningEffort)
          .filter((effort): effort is string => typeof effort === "string")
        : [];
      const defaultEffort = typeof model.defaultReasoningEffort === "string" ? model.defaultReasoningEffort : "";
      models.push({
        id: model.id,
        label: typeof model.displayName === "string" && model.displayName ? model.displayName : model.id,
        description: [
          typeof model.description === "string" ? model.description : "",
          defaultEffort ? `默认思考强度：${defaultEffort}` : "",
        ].filter(Boolean).join(" · "),
        efforts,
      });
    }
    const next: unknown = response.nextCursor;
    cursor = typeof next === "string" && !seen.has(next) ? next : null;
    if (cursor) seen.add(cursor);
  } while (cursor);
  return models;
}

/** 权限档案只有 id 和说明，照 Codex Remote 按名字给出中文标签。不可选的档案不列出。 */
async function listPermissions(client: Pick<AppServerClient, "request">, cwd: string): Promise<PermissionOption[]> {
  const response = asObject(await client.request("permissionProfile/list", { cursor: null, limit: 100, cwd }));
  if (!response || !Array.isArray(response.data)) throw new Error("Codex 返回了无法识别的权限列表。");
  return response.data.flatMap((value) => {
    const profile = asObject(value);
    if (!profile || typeof profile.id !== "string" || profile.allowed !== true) return [];
    const id = profile.id;
    const danger = isFullAccessProfile(id);
    return [{
      id,
      label: permissionLabel(id),
      description: typeof profile.description === "string" && profile.description
        ? profile.description
        : permissionDescription(id),
      ...(danger ? { danger } : {}),
    }];
  });
}

function permissionLabel(id: string): string {
  if (isFullAccessProfile(id)) return "完全访问";
  const normalized = id.toLowerCase();
  if (normalized.includes("read")) return "只读";
  if (normalized.includes("workspace") || normalized.includes("auto")) return "自动（可修改项目）";
  return id;
}

function permissionDescription(id: string): string {
  if (isFullAccessProfile(id)) return "可以不受沙箱限制地操作主机；请谨慎选择。";
  const normalized = id.toLowerCase();
  if (normalized.includes("read")) return "可以阅读和分析；修改文件或执行高权限操作前会受限。";
  if (normalized.includes("workspace") || normalized.includes("auto")) {
    return "可在项目目录内工作，超出范围或敏感操作仍会询问。";
  }
  return "由当前 Codex 配置提供的权限方案。";
}

function isFullAccessProfile(id: string): boolean {
  const normalized = id.toLowerCase();
  return normalized.includes("full") || normalized.includes("danger");
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

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}
