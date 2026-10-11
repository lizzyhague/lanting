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
  CursorAcpClient,
  type CursorBlockingRequest,
  type CursorPermissionOutcome,
  type CursorPermissionRequest,
  type CursorUpdate,
} from "./acp-client.ts";

export type CursorAdapterOptions = {
  executable: string;
};

/** session/cancel 之后等这么久这一轮还没结束，就直接关掉 Cursor 进程。 */
const INTERRUPT_TIMEOUT_MS = 10_000;

/**
 * always-approve 不用 `--force`，而是由 lanting 对 Cursor 发来的每个审批选一次性允许，
 * 所以 Cursor 配置里的 deny 仍然生效；Cursor 自己放行的操作不会出现审批。
 */
export const CURSOR_PERMISSIONS: readonly PermissionOption[] = [
  {
    id: "ask",
    label: "逐次确认",
    description: "Cursor 发来的审批由群主在网页上批准。",
  },
  {
    id: "always-approve",
    label: "Always approve",
    description: "Cursor 发来的审批直接放行；Cursor 配置里的 deny 仍然生效。",
    danger: true,
  },
];

const ALWAYS_APPROVE = "always-approve";

/** plan、ask 会进入方案审批或只读问答，群聊里固定用 agent。 */
const AGENT_MODE = "agent";

/**
 * Cursor 没有追加 system prompt 的启动参数或会话字段，群聊规则只能作为新会话第一条
 * user 消息的开头发一次；恢复会话时规则已经在会话历史里，不再发。
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

export class CursorAdapter implements AgentAdapter {
  readonly kind = "cursor";
  /** 每轮结束关掉 ACP 进程，下次用 session id 恢复，与 Codex、Grok、Pi 一致。 */
  readonly closeAfterTurn = true;
  /**
   * 不实现 models：`session/set_model` 会改写 Cursor 的全局默认模型，多个 Cursor 成员会互相影响，
   * 所以跟随 Cursor 当前的默认模型。ACP 也没有压缩、删除会话和用量接口。
   */
  readonly features: AgentFeatures = {
    permissions: async () => [...CURSOR_PERMISSIONS],
  };
  readonly #options: CursorAdapterOptions;

  constructor(options: CursorAdapterOptions) {
    this.#options = options;
  }

  startSession(options: SessionOptions): Promise<AgentSession> {
    return CursorSession.open(null, options, this.#options);
  }

  resumeSession(nativeId: string, options: SessionOptions): Promise<AgentSession> {
    return CursorSession.open(nativeId, options, this.#options);
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
 * 每个原生会话一个独立的 `agent acp` 子进程（独立进程组）。
 * 明文回复以这一轮最后一段 agent_message 为准，之前的过渡文字转成过程信息。
 */
class CursorSession implements AgentSession {
  readonly #client: CursorAcpClient;
  readonly #options: SessionOptions;
  /** 网页上还没回答的审批，按 Cursor 的 JSON-RPC id。 */
  readonly #approvals = new Map<number | string, AbortController>();
  #sessionId = "";
  /** 新会话还没把群聊规则发出去。 */
  #rulesPending = false;
  #turn: Turn | null = null;

  private constructor(client: CursorAcpClient, options: SessionOptions) {
    this.#client = client;
    this.#options = options;
    client.on("update", (payload: CursorUpdate) => this.#onUpdate(payload));
    client.on("permission", (request: CursorPermissionRequest) => this.#onPermission(request));
    client.on("blocking", (request: CursorBlockingRequest) => this.#onBlocking(request));
    client.on("exit", () => {
      this.#cancelApprovals();
      const turn = this.#turn;
      if (!turn) return;
      this.#finish(turn.interrupted
        ? { type: "end", outcome: "interrupted", text: turn.segment }
        : { type: "end", outcome: "failed", text: turn.segment, error: "Cursor 进程已退出。" });
    });
  }

  static async open(
    sessionId: string | null,
    options: SessionOptions,
    adapter: CursorAdapterOptions,
  ): Promise<CursorSession> {
    const client = new CursorAcpClient({
      executable: adapter.executable,
      cwd: options.cwd,
      env: childEnvironment(process.env),
    });
    const session = new CursorSession(client, options);
    try {
      await client.initialize();
      await client.authenticate();
      if (sessionId) {
        // 加载时 Cursor 先把历史重放成 session/update；这时还没有当前轮，重放不会进群聊。
        await client.sessionLoad(sessionId, options.cwd);
        session.#sessionId = sessionId;
      } else {
        session.#sessionId = await client.sessionNew(options.cwd);
        session.#rulesPending = true;
      }
      await client.sessionSetMode(session.#sessionId, AGENT_MODE);
      return session;
    } catch (error) {
      if (client.stderrTail.trim()) console.error(`Cursor stderr：${client.stderrTail.trim()}`);
      await session.close();
      throw error;
    }
  }

  get nativeId(): string | null {
    return this.#sessionId || null;
  }

  get alive(): boolean {
    return this.#client.alive;
  }

  async *send(text: string): AsyncIterable<AgentEvent> {
    if (!this.alive) throw new Error("Cursor 进程已关闭。");
    if (this.#turn) throw new Error("Cursor 还在处理上一轮。");
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
          this.#finish({ type: "end", outcome: "failed", text: turn.segment, error: `Cursor 提前结束了这一轮（${stop}）。` });
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

  #onUpdate(payload: CursorUpdate): void {
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

  #onPermission(request: CursorPermissionRequest): void {
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
    const settle = (outcome: CursorPermissionOutcome) => {
      // 已经撤下的审批由撤下的一方回过 cancelled，迟到的网页答复不再写回。
      if (this.#approvals.get(request.rpcId) !== controller) return;
      this.#approvals.delete(request.rpcId);
      this.#client.respondPermission(request.rpcId, outcome);
    };
    this.#options.requestApproval({
      toolName: tool.toolName,
      detail: [tool.detail, permissionReason(request.toolCall)].filter(Boolean).join("\n"),
    }, controller.signal).then(
      (answer) => settle(permissionOutcome(request, answer)),
      () => settle({ outcome: "cancelled" }),
    );
  }

  /** 客户端已经回了 cancelled，这里只告诉群主。 */
  #onBlocking(request: CursorBlockingRequest): void {
    const turn = this.#turn;
    if (!turn) return;
    const toolName = request.method === "cursor/create_plan" ? "确认方案" : "提问";
    turn.channel.push({
      type: "activity",
      activity: { kind: "denied", toolName, message: "群聊里不直接向群主提问或请求确认，问题请写在回复里。" },
    });
  }

  /** 撤下网页上的审批，并告诉仍在运行的 Cursor 这些请求取消了。 */
  #cancelApprovals(): void {
    for (const [rpcId, controller] of this.#approvals) {
      this.#approvals.delete(rpcId);
      controller.abort();
      this.#client.respondPermission(rpcId, { outcome: "cancelled" });
    }
  }
}

/** 只选一次性的允许或拒绝，不选 allow-always，不把授权规则写进 Cursor 配置。 */
function permissionOutcome(request: CursorPermissionRequest, answer: ApprovalAnswer): CursorPermissionOutcome {
  const kind = answer.decision === "allow" ? "allow_once" : "reject_once";
  const option = request.options.find((candidate) => candidate.kind === kind);
  return option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
}

/** 把 ACP 的 tool_call 缩成一行过程信息。Cursor 的标题常常是用反引号包起来的命令。 */
export function toolActivity(toolCall: Record<string, unknown>): { kind: "tool"; toolName: string; detail: string } {
  const toolKind = typeof toolCall.kind === "string" ? toolCall.kind : "";
  const rawTitle = typeof toolCall.title === "string" ? toolCall.title.trim() : "";
  const title = /^`[^`]+`$/u.test(rawTitle) ? rawTitle.slice(1, -1).trim() : rawTitle;
  const input = objectField(toolCall.rawInput);
  const detail = ["command", "path", "file_path", "pattern", "query", "url"]
    .map((key) => input[key])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? "";
  return {
    kind: "tool",
    toolName: (title || toolKind || "工具").slice(0, 120),
    detail: detail.trim() === title ? "" : detail.replaceAll(/\s+/gu, " ").trim().slice(0, 240),
  };
}

/** Cursor 在审批的 tool call 内容里说明原因，比如 “Not in allowlist: touch”。 */
function permissionReason(toolCall: Record<string, unknown>): string {
  const content = Array.isArray(toolCall.content) ? toolCall.content : [];
  return content
    .map((entry) => contentText(objectField(entry).content))
    .filter(Boolean)
    .join("\n")
    .slice(0, 600);
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
 */
function childEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child = { ...environment };
  delete child.ACCESS_TOKEN;
  delete child.CLAUDE_CODE_OAUTH_TOKEN;
  return child;
}
