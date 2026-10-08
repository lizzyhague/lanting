import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CatalogCache } from "../catalog-cache.ts";
import { EventChannel } from "../event-channel.ts";
import type {
  AgentAdapter,
  AgentCatalog,
  AgentEvent,
  AgentSession,
  ApprovalAnswer,
  ModelOption,
  PermissionOption,
  SessionOptions,
} from "../types.ts";
import { AcpClient, type AcpPermissionRequest, type AcpUpdate } from "./acp-client.ts";

export type GrokAdapterOptions = {
  executable: string;
  /** Grok 保存会话的根目录，默认取 GROK_HOME，没有就是 ~/.grok。 */
  grokHome?: string;
};

/** session/cancel 之后等这么久这一轮还没结束，就直接关掉 Grok 进程。 */
const INTERRUPT_TIMEOUT_MS = 10_000;
const EXIT_WAIT_MS = 8_000;

/** Grok 要直接问用户问题的工具。群聊里有问题写在回复里，这类请求一律取消。 */
const HUMAN_TOOL_NAMES = new Set(["ask_user_question", "ask_user", "request_user_input", "elicitation"]);

/**
 * 照 Grok Remote 只有两档。always-approve 时开会话带 yoloMode，
 * 仍然送到 lanting 的审批（直接提问的除外）也自动放行。
 */
export const GROK_PERMISSIONS: readonly PermissionOption[] = [
  { id: "ask", label: "逐次确认", description: "需要确认的工具调用都由群主在网页上批准。" },
  {
    id: "always-approve",
    label: "Always approve",
    description: "工具调用不再逐次确认，直接放行。",
    danger: true,
  },
];

const ALWAYS_APPROVE = "always-approve";

export class GrokAdapter implements AgentAdapter {
  readonly kind = "grok";
  readonly displayName = "Grok";
  /** 照 Grok Remote：每轮结束就关掉 Grok 进程。 */
  readonly closeAfterTurn = true;
  readonly #options: GrokAdapterOptions;
  readonly #catalogs = new CatalogCache();

  constructor(options: GrokAdapterOptions) {
    this.#options = options;
  }

  /** 照 Grok Remote：模型列表在 initialize 的返回里，不用开会话。 */
  catalog(cwd: string): Promise<AgentCatalog> {
    return this.#catalogs.get("", async () => {
      const child = spawnGrok(this.#options.executable, cwd);
      const client = new AcpClient(child);
      try {
        if (child.pid === undefined) throw new Error("无法启动 Grok。");
        return { models: modelOptions(await client.initialize()), permissions: [...GROK_PERMISSIONS] };
      } finally {
        await client.close();
        await terminateGroup(child);
      }
    });
  }

  /**
   * Grok 没有删除会话的 RPC。照 Grok Remote 删磁盘目录 `<GROK_HOME>/sessions/<分组>/<会话 id>`；
   * 找不到目录就当作已经删掉了。
   */
  async deleteSession(nativeId: string): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(nativeId) || nativeId.includes("..")) {
      throw new Error(`Grok 会话 id 格式不对：${nativeId}`);
    }
    const root = path.join(this.#options.grokHome ?? resolveGrokHome(), "sessions");
    for (const group of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!group.isDirectory()) continue;
      const directory = path.join(root, group.name, nativeId);
      const info = await stat(directory).catch(() => null);
      if (info?.isDirectory()) await rm(directory, { recursive: true, force: true });
    }
  }

  startSession(options: SessionOptions): Promise<AgentSession> {
    return GrokSession.open(null, options, this.#options);
  }

  resumeSession(nativeId: string, options: SessionOptions): Promise<AgentSession> {
    return GrokSession.open(nativeId, options, this.#options);
  }
}

type Turn = {
  channel: EventChannel<AgentEvent>;
  /** 当前这一段 agent_message；下一个工具调用出现时转成过程信息。 */
  segment: string;
  /** 群主已经要求打断；之后结束的这一轮按 interrupted 处理。 */
  interrupted: boolean;
};

/**
 * 每个原生会话一个独立的 `grok agent stdio` 子进程（独立进程组）。
 * 明文回复以这一轮最后一段 agent_message 为准，之前的过渡文字转成过程信息。
 */
class GrokSession implements AgentSession {
  readonly #process: ChildProcessWithoutNullStreams;
  readonly #client: AcpClient;
  readonly #options: SessionOptions;
  readonly #approvals = new Set<AbortController>();
  #sessionId = "";
  #turn: Turn | null = null;
  #exited = false;
  #stderrTail = "";

  private constructor(child: ChildProcessWithoutNullStreams, options: SessionOptions) {
    this.#process = child;
    this.#client = new AcpClient(child);
    this.#options = options;
    this.#client.on("update", (payload: AcpUpdate) => this.#onUpdate(payload));
    this.#client.on("permission", (request: AcpPermissionRequest) => this.#onPermission(request));
    this.#client.on("stderr", (text: string) => {
      this.#stderrTail = `${this.#stderrTail}\n${text}`.slice(-8_192);
    });
    this.#client.on("exit", () => {
      this.#exited = true;
      for (const controller of this.#approvals) controller.abort();
      this.#finish({ type: "end", outcome: "failed", text: this.#turn?.segment ?? "", error: "Grok 进程已退出。" });
    });
  }

  static async open(
    sessionId: string | null,
    options: SessionOptions,
    adapter: GrokAdapterOptions,
  ): Promise<GrokSession> {
    const child = spawnGrok(adapter.executable, options.cwd);
    const session = new GrokSession(child, options);
    const yolo = options.settings.permission === ALWAYS_APPROVE;
    try {
      if (child.pid === undefined) throw new Error("无法启动 Grok。");
      await session.#client.initialize();
      if (sessionId) {
        await session.#client.sessionResume(sessionId, options.cwd, yolo);
        session.#sessionId = sessionId;
      } else {
        session.#sessionId = await session.#client.sessionNew(options.cwd, yolo, options.systemPrompt);
      }
      const { model, effort } = options.settings;
      if (model) await session.#client.sessionSetModel(session.#sessionId, model, effort);
      return session;
    } catch (error) {
      if (session.#stderrTail.trim()) console.error(`Grok stderr：${session.#stderrTail.trim()}`);
      await session.close();
      throw error;
    }
  }

  get nativeId(): string {
    return this.#sessionId;
  }

  get alive(): boolean {
    return !this.#exited;
  }

  async *send(text: string): AsyncIterable<AgentEvent> {
    if (!this.alive) throw new Error("Grok 进程已关闭。");
    if (this.#turn) throw new Error("Grok 还在处理上一轮。");
    const turn: Turn = { channel: new EventChannel<AgentEvent>(), segment: "", interrupted: false };
    this.#turn = turn;
    void this.#client.sessionPrompt(this.#sessionId, text).then(
      (result) => {
        const stop = result?.stopReason ?? "end_turn";
        if (turn.interrupted || stop === "cancelled") {
          this.#finish({ type: "end", outcome: "interrupted", text: turn.segment });
        } else if (stop === "end_turn") {
          this.#finish({ type: "end", outcome: "completed", text: turn.segment });
        } else {
          this.#finish({ type: "end", outcome: "failed", text: turn.segment, error: `Grok 提前结束了这一轮（${stop}）。` });
        }
      },
      (error: unknown) => {
        this.#finish({
          type: "end",
          outcome: turn.interrupted ? "interrupted" : "failed",
          text: turn.segment,
          ...(turn.interrupted ? {} : { error: error instanceof Error ? error.message : String(error) }),
        });
      },
    );
    yield* turn.channel;
  }

  async compact(): Promise<void> {
    if (!this.alive) throw new Error("Grok 进程已关闭。");
    if (this.#turn) throw new Error("Grok 还在处理上一轮。");
    await this.#client.sessionCompact(this.#sessionId);
  }

  async interrupt(): Promise<void> {
    const turn = this.#turn;
    if (!turn) return;
    turn.interrupted = true;
    for (const controller of this.#approvals) controller.abort();
    this.#client.sessionCancel(this.#sessionId);
    const ended = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), INTERRUPT_TIMEOUT_MS);
      void (async () => {
        while (this.#turn === turn && this.alive) await new Promise((r) => setTimeout(r, 50));
        clearTimeout(timer);
        resolve(true);
      })();
    });
    if (!ended) {
      this.#finish({ type: "end", outcome: "interrupted", text: turn.segment });
      await this.close();
    }
  }

  async close(): Promise<void> {
    for (const controller of this.#approvals) controller.abort();
    if (this.#sessionId && this.alive) await withTimeout(this.#client.sessionClose(this.#sessionId), 2_000);
    await this.#client.close();
    await terminateGroup(this.#process);
  }

  #finish(event: Extract<AgentEvent, { type: "end" }>): void {
    const turn = this.#turn;
    if (!turn) return;
    this.#turn = null;
    turn.channel.push(event);
    turn.channel.end();
  }

  #onUpdate(payload: AcpUpdate): void {
    const turn = this.#turn;
    if (!turn || payload.sessionId !== this.#sessionId) return;
    const update = payload.update;
    const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
    if (kind === "agent_message_chunk") {
      const text = contentText(update.content);
      if (!text) return;
      turn.segment += text;
      turn.channel.push({ type: "text", delta: text });
      return;
    }
    if (kind === "tool_call") {
      const activity = toolActivity(update);
      if (!activity) return;
      if (turn.segment.trim()) turn.channel.push({ type: "activity", activity: { kind: "note", text: turn.segment } });
      turn.segment = "";
      turn.channel.push({ type: "activity", activity });
    }
  }

  #onPermission(request: AcpPermissionRequest): void {
    if (request.sessionId !== this.#sessionId || !this.#turn || this.#turn.interrupted) {
      this.#client.respondPermission(request.rpcId, { outcome: "cancelled" });
      return;
    }
    if (isHumanRequired(request.toolCall)) {
      this.#client.respondPermission(request.rpcId, { outcome: "cancelled" });
      this.#turn.channel.push({
        type: "activity",
        activity: { kind: "denied", toolName: "提问", message: "群聊里不直接向群主提问，问题请写在回复里。" },
      });
      return;
    }
    if (this.#options.settings.permission === ALWAYS_APPROVE) {
      this.#client.respondPermission(request.rpcId, permissionOutcome(request, { decision: "allow", message: "" }));
      return;
    }
    const controller = new AbortController();
    this.#approvals.add(controller);
    const tool = toolActivity(request.toolCall);
    void this.#options.requestApproval({
      toolName: tool?.toolName ?? "操作",
      detail: [tool?.detail, permissionReason(request.toolCall)].filter(Boolean).join("\n"),
    }, controller.signal).then((answer) => {
      this.#approvals.delete(controller);
      this.#client.respondPermission(request.rpcId, permissionOutcome(request, answer));
    });
  }
}

function resolveGrokHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.GROK_HOME?.trim() || path.join(os.homedir(), ".grok");
}

function spawnGrok(executable: string, cwd: string): ChildProcessWithoutNullStreams {
  const child = spawn(executable, ["agent", "--no-leader", "stdio"], {
    cwd,
    env: withoutWebLoginToken(process.env),
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
  // 启动失败（比如路径不对）时 pid 为空，调用方会报“无法启动 Grok”；
  // 不接住 error 事件的话，整个服务会因为未处理的 error 退出。
  child.on("error", (error) => console.error(`Grok 进程出错：${error.message}`));
  return child;
}

/** initialize 返回的 `_meta.modelState.availableModels`，照 Grok Remote 读取。 */
export function modelOptions(initialize: unknown): ModelOption[] {
  const models = objectField(objectField(objectField(initialize)._meta).modelState).availableModels;
  if (!Array.isArray(models)) return [];
  return models.flatMap((entry) => {
    const model = objectField(entry);
    if (typeof model.modelId !== "string" || !model.modelId) return [];
    const efforts = objectField(model._meta).reasoningEfforts;
    return [{
      id: model.modelId,
      label: typeof model.name === "string" && model.name ? model.name : model.modelId,
      description: typeof model.description === "string" ? model.description : "",
      efforts: Array.isArray(efforts)
        ? efforts.map((effort) => objectField(effort).id).filter((id): id is string => typeof id === "string" && !!id)
        : [],
    }];
  });
}

function permissionOutcome(
  request: AcpPermissionRequest,
  answer: ApprovalAnswer,
): { outcome: "cancelled" } | { outcome: "selected"; optionId: string } {
  // 只给一次性的允许或拒绝，不建立长期授权规则。
  const pick = (kind: string, pattern: RegExp) =>
    request.options.find((option) => option.kind === kind) ??
    request.options.find((option) => pattern.test(option.optionId) && !/always/i.test(option.optionId));
  const option = answer.decision === "allow" ? pick("allow_once", /allow/i) : pick("reject_once", /reject|deny/i);
  return option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
}

/** 把 ACP 的 tool_call 缩成一行过程信息。 */
export function toolActivity(toolCall: Record<string, unknown>): { kind: "tool"; toolName: string; detail: string } | null {
  const toolKind = typeof toolCall.kind === "string" ? toolCall.kind : "";
  if (toolKind === "think") return null;
  const title = typeof toolCall.title === "string" && toolCall.title.trim() ? toolCall.title.trim() : "";
  const input = objectField(toolCall.rawInput);
  const detail = ["command", "path", "file_path", "pattern", "query", "url"]
    .map((key) => input[key])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? "";
  return {
    kind: "tool",
    toolName: (title || toolKind || "工具").slice(0, 120),
    detail: detail === title ? "" : detail.replaceAll(/\s+/gu, " ").trim().slice(0, 240),
  };
}

function permissionReason(toolCall: Record<string, unknown>): string {
  const input = objectField(toolCall.rawInput);
  const tool = objectField(objectField(toolCall._meta)["x.ai/tool"]);
  const description = input.description ?? objectField(tool.input).description;
  return typeof description === "string" ? description.slice(0, 600) : "";
}

function isHumanRequired(toolCall: Record<string, unknown>): boolean {
  const tool = objectField(objectField(toolCall._meta)["x.ai/tool"]);
  return [toolCall.name, toolCall.toolName, tool.name, toolCall.title].some((candidate) =>
    typeof candidate === "string" &&
    HUMAN_TOOL_NAMES.has(candidate.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""))
  );
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  const text = objectField(content).text;
  return typeof text === "string" ? text : "";
}

function objectField(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 网页登录令牌 CLI 用不到，留着只会让每个工具子进程都能拿到网页端的控制权。 */
function withoutWebLoginToken(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnvironment = { ...environment };
  delete childEnvironment.ACCESS_TOKEN;
  return childEnvironment;
}

/** 先 SIGTERM 整个进程组，等不到退出再 SIGKILL。 */
async function terminateGroup(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.pid === undefined) return;
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, name);
    } catch {
      try {
        child.kill(name);
      } catch {
        // 进程已经不在了。
      }
    }
  };
  signal("SIGTERM");
  const result = await withTimeout(exited.then(() => "exited" as const), EXIT_WAIT_MS);
  if (result !== "exited") {
    signal("SIGKILL");
    await exited;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
