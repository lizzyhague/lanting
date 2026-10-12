import type { AgentFeatures } from "../../features/index.ts";
import { EventChannel } from "../event-channel.ts";
import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
  ApprovalAnswer,
  PermissionOption,
  SessionOptions,
} from "../types.ts";
import {
  AntigravityAcpClient,
  AntigravityRpcError,
  AUTH_REQUIRED_CODE,
  type AntigravityPermissionOutcome,
  type AntigravityPermissionRequest,
  type AntigravityUpdate,
} from "./acp-client.ts";

export type AntigravityAdapterOptions = {
  executable: string;
};

/** session/cancel 之后等这么久这一轮还没结束，就直接关掉 Antigravity 进程。 */
const INTERRUPT_TIMEOUT_MS = 10_000;

/**
 * always-approve 不用 Server 自带的 `auto_edit`、`yolo` 模式，而是由 lanting 对每个审批选一次性允许；
 * 不选 `allow_always`，免得把授权写进 Antigravity 的会话附属文件。
 */
export const ANTIGRAVITY_PERMISSIONS: readonly PermissionOption[] = [
  {
    id: "ask",
    label: "逐次确认",
    description: "Antigravity 发来的审批由群主在网页上批准。",
  },
  {
    id: "always-approve",
    label: "Always approve",
    description: "Antigravity 发来的审批直接放行。",
    danger: true,
  },
];

const ALWAYS_APPROVE = "always-approve";

/** 审批交给 lanting，Server 的权限模式固定为 default。 */
const DEFAULT_MODE = "default";

/**
 * 凭据失效、不能静默刷新时，Server 不报错，而是在 stderr 打出这一行授权地址，再等浏览器回调最多 5 分钟。
 * 回调要回到服务器本机，网页上的群主完成不了，看到这一行就结束这一轮。
 */
const LOGIN_PROMPT = "Open the following link to authenticate the ACP server";

export const LOGIN_REQUIRED_MESSAGE = "Antigravity 需要重新登录：请在服务器上完成 ACP Server 登录，见部署文档。";

/**
 * `_meta` 里的系统提示词会被忽略，工作目录里的 `AGENTS.md` 也不会自动进上下文，
 * 群聊规则只能作为新会话第一条 user 消息的开头发一次；恢复会话时规则已经在会话历史里，不再发。
 */
export function firstMessage(systemPrompt: string, text: string): string {
  return [
    "[lanting group chat rules: they apply to this whole session]",
    systemPrompt.trim(),
    "[End of group chat rules]",
    "",
    text,
  ].join("\n");
}

export class AntigravityAdapter implements AgentAdapter {
  readonly kind = "antigravity";
  /** 每轮结束关掉 ACP 进程，下次用 session id 恢复，与 Codex、Grok、Pi、Cursor 一致。 */
  readonly closeAfterTurn = true;
  /**
   * 不实现 models：模型列表只在 `session/new` 的返回里，取一次就会留下一个空会话；
   * 模型选择也不跨进程保留，每次恢复都要用 `session/set_config_option` 重设。
   * 不实现 usage：Server 每轮会发 `usage_update`（上下文已用量和上限），首版没有接。
   * 不实现 deleteSession、compact：ACP Server 没有删除会话和压缩接口。
   */
  readonly features: AgentFeatures = {
    permissions: async () => [...ANTIGRAVITY_PERMISSIONS],
  };
  readonly #options: AntigravityAdapterOptions;

  constructor(options: AntigravityAdapterOptions) {
    this.#options = options;
  }

  startSession(options: SessionOptions): Promise<AgentSession> {
    return AntigravitySession.open(null, options, this.#options);
  }

  resumeSession(nativeId: string, options: SessionOptions): Promise<AgentSession> {
    return AntigravitySession.open(nativeId, options, this.#options);
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
 * 每个原生会话一个独立的 ACP Server 子进程（独立进程组）。
 * 明文回复以这一轮最后一段 agent_message 为准，之前的过渡文字转成过程信息。
 */
class AntigravitySession implements AgentSession {
  readonly #client: AntigravityAcpClient;
  readonly #options: SessionOptions;
  /** 网页上还没回答的审批，按 Server 的 JSON-RPC id。 */
  readonly #approvals = new Map<number | string, AbortController>();
  #sessionId = "";
  /** 新会话还没把群聊规则发出去。 */
  #rulesPending = false;
  /** Server 已经在等浏览器登录；进程随即关掉。 */
  #loginRequired = false;
  #turn: Turn | null = null;

  private constructor(client: AntigravityAcpClient, options: SessionOptions) {
    this.#client = client;
    this.#options = options;
    client.on("update", (payload: AntigravityUpdate) => this.#onUpdate(payload));
    client.on("permission", (request: AntigravityPermissionRequest) => this.#onPermission(request));
    client.on("diagnostic", () => {
      if (!this.#loginRequired && client.stderrTail.includes(LOGIN_PROMPT)) this.#onLoginRequired();
    });
    client.on("exit", () => {
      this.#cancelApprovals();
      const turn = this.#turn;
      if (!turn) return;
      this.#finish(turn.interrupted
        ? { type: "end", outcome: "interrupted", text: turn.segment }
        : { type: "end", outcome: "failed", text: turn.segment, error: "Antigravity 进程已退出。" });
    });
  }

  static async open(
    sessionId: string | null,
    options: SessionOptions,
    adapter: AntigravityAdapterOptions,
  ): Promise<AntigravitySession> {
    const client = new AntigravityAcpClient({
      executable: adapter.executable,
      cwd: options.cwd,
      env: childEnvironment(process.env),
    });
    const session = new AntigravitySession(client, options);
    try {
      await client.initialize();
      if (sessionId) {
        // resume 不重放历史，上下文照样保留。
        await client.sessionResume(sessionId, options.cwd);
        session.#sessionId = sessionId;
      } else {
        session.#sessionId = await client.sessionNew(options.cwd);
        session.#rulesPending = true;
      }
      await client.sessionSetMode(session.#sessionId, DEFAULT_MODE);
      return session;
    } catch (error) {
      if (client.stderrTail.trim()) console.error(`Antigravity stderr：${client.stderrTail.trim()}`);
      await session.close();
      throw session.#loginRequired || isAuthRequired(error) ? new Error(LOGIN_REQUIRED_MESSAGE) : error;
    }
  }

  get nativeId(): string | null {
    return this.#sessionId || null;
  }

  get alive(): boolean {
    return this.#client.alive;
  }

  async *send(text: string): AsyncIterable<AgentEvent> {
    if (!this.alive) throw new Error("Antigravity 进程已关闭。");
    if (this.#turn) throw new Error("Antigravity 还在处理上一轮。");
    const turn: Turn = { channel: new EventChannel<AgentEvent>(), segment: "", interrupted: false };
    this.#turn = turn;
    const prompt = this.#rulesPending ? firstMessage(this.#options.systemPrompt, text) : text;
    this.#rulesPending = false;
    void this.#client.sessionPrompt(this.#sessionId, prompt).then(
      (result) => {
        const stop = result.stopReason ?? "end_turn";
        if (turn.interrupted || stop === "cancelled") {
          this.#finish({ type: "end", outcome: "interrupted", text: turn.segment });
        } else if (stop === "end_turn") {
          this.#finish({ type: "end", outcome: "completed", text: turn.segment });
        } else {
          this.#finish({ type: "end", outcome: "failed", text: turn.segment, error: `Antigravity 提前结束了这一轮（${stop}）。` });
        }
      },
      (error: unknown) => {
        const message = isAuthRequired(error) ? LOGIN_REQUIRED_MESSAGE : error instanceof Error ? error.message : String(error);
        this.#finish({
          type: "end",
          outcome: turn.interrupted ? "interrupted" : "failed",
          text: turn.segment,
          ...(turn.interrupted ? {} : { error: message }),
        });
      },
    );
    yield* turn.channel;
  }

  async interrupt(): Promise<void> {
    const turn = this.#turn;
    if (!turn) return;
    turn.interrupted = true;
    this.#cancelApprovals();
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

  /** 不等那 5 分钟：结束这一轮，关掉进程；开会话时由 open 改写成登录提示。 */
  #onLoginRequired(): void {
    this.#loginRequired = true;
    const turn = this.#turn;
    if (turn) this.#finish({ type: "end", outcome: "failed", text: turn.segment, error: LOGIN_REQUIRED_MESSAGE });
    void this.close();
  }

  #onUpdate(payload: AntigravityUpdate): void {
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
      if (turn.segment.trim()) turn.channel.push({ type: "activity", activity: { kind: "note", text: turn.segment } });
      turn.segment = "";
      turn.channel.push({ type: "activity", activity: toolActivity(update) });
    }
  }

  /** 同一轮里同一条命令可能连着审批两次（模型选错工作目录后重试），每次都独立处理。 */
  #onPermission(request: AntigravityPermissionRequest): void {
    const turn = this.#turn;
    if (request.sessionId !== this.#sessionId || !turn || turn.interrupted) {
      this.#client.respondPermission(request.rpcId, { outcome: "cancelled" });
      return;
    }
    if (this.#options.settings.permission === ALWAYS_APPROVE) {
      this.#client.respondPermission(request.rpcId, permissionOutcome(request, { decision: "allow", message: "" }));
      return;
    }
    const controller = new AbortController();
    this.#approvals.set(request.rpcId, controller);
    const tool = toolActivity(request.toolCall);
    const settle = (outcome: AntigravityPermissionOutcome) => {
      // 已经撤下的审批由撤下的一方回过 cancelled，迟到的网页答复不再写回。
      if (this.#approvals.get(request.rpcId) !== controller) return;
      this.#approvals.delete(request.rpcId);
      this.#client.respondPermission(request.rpcId, outcome);
    };
    this.#options.requestApproval({
      toolName: tool.toolName,
      detail: [tool.detail, workingDirectory(request.toolCall)].filter(Boolean).join("\n"),
    }, controller.signal).then(
      (answer) => settle(permissionOutcome(request, answer)),
      () => settle({ outcome: "cancelled" }),
    );
  }

  /** 撤下网页上的审批，并告诉仍在运行的 Server 这些请求取消了。 */
  #cancelApprovals(): void {
    for (const [rpcId, controller] of this.#approvals) {
      this.#approvals.delete(rpcId);
      controller.abort();
      this.#client.respondPermission(rpcId, { outcome: "cancelled" });
    }
  }
}

/**
 * 只按 kind 选一次性的允许或拒绝，不按 optionId 写死：执行类有三项，编辑类只有两项。
 * 不选 allow_always。
 */
function permissionOutcome(request: AntigravityPermissionRequest, answer: ApprovalAnswer): AntigravityPermissionOutcome {
  const kind = answer.decision === "allow" ? "allow_once" : "reject_once";
  const option = request.options.find((candidate) => candidate.kind === kind);
  return option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
}

function isAuthRequired(error: unknown): boolean {
  return error instanceof AntigravityRpcError && error.code === AUTH_REQUIRED_CODE;
}

/**
 * 把 ACP 的 tool_call 缩成一行过程信息。执行类的标题就是命令；
 * 编辑、读取类的标题是 "Run create_file?" 这类说明，路径在 rawInput 或 locations 里。
 */
export function toolActivity(toolCall: Record<string, unknown>): { kind: "tool"; toolName: string; detail: string } {
  const toolKind = typeof toolCall.kind === "string" ? toolCall.kind : "";
  const title = typeof toolCall.title === "string" ? toolCall.title.trim() : "";
  const input = objectField(toolCall.rawInput);
  const locations = Array.isArray(toolCall.locations) ? toolCall.locations : [];
  const detail = [
    ...["CommandLine", "TargetFile", "absolute_path", "file_path", "path"].map((key) => input[key]),
    objectField(locations[0]).path,
  ].find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? "";
  return {
    kind: "tool",
    toolName: (title || toolKind || "工具").slice(0, 120),
    detail: detail.trim() === title ? "" : detail.replaceAll(/\s+/gu, " ").trim().slice(0, 240),
  };
}

/** 执行类审批带着命令的工作目录。模型可能填成工作区之外的目录，如实显示，不另外拦截。 */
function workingDirectory(toolCall: Record<string, unknown>): string {
  const cwd = objectField(toolCall.rawInput).Cwd;
  return typeof cwd === "string" && cwd.trim() ? `工作目录：${cwd.trim()}` : "";
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  const text = objectField(content).text;
  return typeof text === "string" ? text : "";
}

function objectField(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * 网页登录令牌 CLI 用不到，留着只会让每个工具子进程都能拿到网页端的控制权。
 * Claude 的长期 OAuth token 也不交给其他 CLI 及其工具子进程。
 * 去掉 TERM、BROWSER：有它们时 Server 可能尝试打开浏览器或在 stdout 打印网页内容，探测时也都去掉了。
 */
function childEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child = { ...environment };
  delete child.ACCESS_TOKEN;
  delete child.CLAUDE_CODE_OAUTH_TOKEN;
  delete child.TERM;
  delete child.BROWSER;
  return child;
}
