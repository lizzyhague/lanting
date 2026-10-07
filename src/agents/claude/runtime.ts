import {
  query,
  type Options,
  type PermissionResult,
  type Query,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";

import { ProcessGroup } from "../../platform/process-group.ts";
import type { ApprovalAnswer, ApprovalAsk } from "../types.ts";
import { createPreToolUseHook } from "./tool-policy.ts";

/*
 * Claude Code 的底层运行时，搬自 Relayu `src/claude/session-runtime.ts`，去掉了 Relayu 自己的
 * 产品功能（伴、routine、rewind、用量查询等），只留启动、发消息、打断、关闭。
 */

export type RuntimeEvent =
  | { type: "assistant.delta"; text: string }
  | { type: "assistant.message"; text: string }
  | { type: "tool.started"; toolName: string; detail: string }
  | { type: "tool.denied"; toolName: string; message: string }
  | { type: "turn.ended"; outcome: TurnOutcome; resultText: string }
  | { type: "closed"; reason: string };

export type TurnOutcome =
  | { status: "completed" }
  | { status: "interrupted" }
  | { status: "failed"; message: string };

export type ClaudeRuntimeOptions = {
  sessionId: string;
  /** 新会话用 sessionId 创建，老会话用 resume 接回。 */
  resume: boolean;
  cwd: string;
  /** 追加在 Claude Code 预设系统提示词之后。 */
  appendSystemPrompt: string;
  pathToClaudeCodeExecutable: string;
  onEvent: (event: RuntimeEvent) => void;
  requestApproval: (ask: ApprovalAsk) => Promise<ApprovalAnswer>;
};

/** result 之后等 idle 的上限。实测 idle 紧随 result 到达；超时说明这个运行时已不可信。 */
const IDLE_WATCHDOG_MS = 30_000;
/** interrupt 的回执与随后的 idle 各自的等待上限。 */
const INTERRUPT_TIMEOUT_MS = 10_000;

/**
 * 群聊里 AI 有问题直接写在回复里，由群主决定下一步，所以不提供 AskUserQuestion。
 */
const DISALLOWED_TOOLS = ["AskUserQuestion"];

/**
 * 必须在继承完整 process.env 的基础上改，否则会丢掉 OAuth 与代理设置。
 * 网页登录令牌和长期 OAuth token 都剔除：CLI 用不到前者，后者交不交由各部署自己决定，
 * 本项目不替 Claude Code 选择认证方式。
 */
export function claudeCodeEnvironment(
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const {
    ACCESS_TOKEN: _webLoginToken,
    CLAUDE_CODE_OAUTH_TOKEN: _longLivedToken,
    ...inherited
  } = base;
  return {
    ...inherited,
    CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
    CLAUDE_CODE_PROMPT_CACHE_TTL: "1h",
  };
}

type Turn = {
  result: SDKResultMessage | null;
  interrupted: boolean;
};

/**
 * 一个会话对应一个长驻 Query、一条永不关闭的输入队列和唯一一条读取循环。
 * 单轮的 result 不结束循环、不关闭队列，否则子进程会退出。
 */
export class ClaudeRuntime {
  readonly #options: ClaudeRuntimeOptions;
  readonly #input = new InputQueue();
  #query: Query | null = null;
  #readLoop: Promise<void> = Promise.resolve();
  #turn: Turn | null = null;
  #idleWatchdog: NodeJS.Timeout | null = null;
  #turnEndWaiters: Array<() => void> = [];
  #closePromise: Promise<void> | null = null;
  #forcedOutcome: TurnOutcome | null = null;
  #processGroup: ProcessGroup | null = null;
  #exitConfirmed = true;

  private constructor(options: ClaudeRuntimeOptions) {
    this.#options = options;
  }

  static async start(options: ClaudeRuntimeOptions): Promise<ClaudeRuntime> {
    const runtime = new ClaudeRuntime(options);
    try {
      await runtime.#begin();
      return runtime;
    } catch (error) {
      await runtime.close("Claude Code 运行时初始化失败。");
      throw error;
    }
  }

  get sessionId(): string {
    return this.#options.sessionId;
  }

  get busy(): boolean {
    return this.#turn !== null;
  }

  get closed(): boolean {
    return this.#closePromise !== null;
  }

  /** close() 之后为 false 表示进程树没能确认退出。 */
  get exitConfirmed(): boolean {
    return this.#exitConfirmed;
  }

  async #begin(): Promise<void> {
    // 必须在 query() 之前建好：spawn 回调一旦被调用，进程组 id 就由这个实例持有。
    const processGroup = new ProcessGroup();
    this.#processGroup = processGroup;
    const options: Options = {
      cwd: this.#options.cwd,
      ...(this.#options.resume
        ? { resume: this.#options.sessionId }
        : { sessionId: this.#options.sessionId }),
      pathToClaudeCodeExecutable: this.#options.pathToClaudeCodeExecutable,
      // 自己接管 spawn，才能让 CLI 连同它的工具子进程落在同一个独立进程组里。
      spawnClaudeCodeProcess: processGroup.spawn,
      systemPrompt: { type: "preset", preset: "claude_code", append: this.#options.appendSystemPrompt },
      settingSources: ["user", "project"],
      // 手机可能几分钟后才处理审批；SDK 内部期限显式关闭，超时由审批登记处负责。
      settings: { dialogExpiry: "never" },
      permissionMode: "default",
      disallowedTools: DISALLOWED_TOOLS,
      includePartialMessages: true,
      env: claudeCodeEnvironment(),
      hooks: {
        PreToolUse: [{
          hooks: [createPreToolUseHook({
            cwd: this.#options.cwd,
            onDenied: (toolName, message) => {
              this.#options.onEvent({ type: "tool.denied", toolName, message });
            },
          })],
        }],
      },
      canUseTool: (toolName, input) => this.#canUseTool(toolName, input),
    };

    const conversation = query({ prompt: this.#input.stream(), options });
    this.#query = conversation;
    this.#readLoop = this.#read(conversation);
    // 长驻会话的启动门槛是 initializationResult()，不是对话流里的 system/init。
    await conversation.initializationResult();
  }

  async #canUseTool(toolName: string, input: Record<string, unknown>): Promise<PermissionResult> {
    // 不在进行中的一轮里、或这一轮正在打断时，不再放行任何新的工具调用。
    if (!this.#turn || this.#turn.interrupted) {
      return { behavior: "deny", message: "当前没有进行中的发言，已拒绝这次工具调用。" };
    }
    const answer = await this.#options.requestApproval({
      toolName,
      detail: describeToolInput(input),
    });
    return answer.decision === "allow"
      ? { behavior: "allow" }
      : { behavior: "deny", message: answer.message || "群主拒绝了这次工具调用。" };
  }

  /** resolve 时消息已经交给 SDK 的输入队列。 */
  async startTurn(text: string): Promise<void> {
    if (this.closed) throw new Error("运行时已关闭。");
    if (this.#turn) throw new Error("会话仍在处理上一轮。");
    this.#turn = { result: null, interrupted: false };
    try {
      await this.#input.push({
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
        uuid: randomUUID(),
      });
    } catch (error) {
      this.#turn = null;
      throw error;
    }
  }

  /**
   * 回执里 still_queued 非空说明排队消息仍会执行，只能关闭整个运行时；
   * 回执或随后的 idle 超时同样关闭。
   */
  async interrupt(): Promise<"interrupted" | "closed"> {
    const conversation = this.#query;
    if (!conversation || this.closed) return "closed";
    if (!this.#turn) return "interrupted";
    this.#turn.interrupted = true;

    const receipt = await withTimeout(conversation.interrupt(), INTERRUPT_TIMEOUT_MS);
    if (!receipt.ok || (receipt.value?.still_queued?.length ?? 0) > 0) {
      await this.close("打断未能确认，已关闭运行时。");
      return "closed";
    }
    if (!await this.#waitForTurnEnd(INTERRUPT_TIMEOUT_MS)) {
      await this.close("打断后未回到空闲，已关闭运行时。");
      return "closed";
    }
    return "interrupted";
  }

  /**
   * 关闭并确认旧进程连同它 spawn 的子进程真正退出。本方法不会 reject：
   * 确认失败时把 exitConfirmed 置 false，只记日志。
   */
  close(reason: string): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    const processGroup = this.#processGroup;
    this.#closePromise = (async () => {
      this.#input.close();
      try {
        this.#query?.close();
      } catch {
        // 已经退出的进程再关一次不算错误。
      }
      // 读取循环结束只说明 stdout 到了 EOF，不等于进程已经退出，更管不到它的子进程。
      await this.#readLoop.catch(() => undefined);
      this.#exitConfirmed = processGroup === null || await processGroup.terminate();
      if (!this.#exitConfirmed) console.error(`Claude Code 进程未确认退出（${this.#options.sessionId}）。`);
      this.#finishTurn(this.#forcedOutcome ?? { status: "interrupted" });
      this.#options.onEvent({ type: "closed", reason });
    })();
    return this.#closePromise;
  }

  async #read(conversation: Query): Promise<void> {
    try {
      for await (const message of conversation) this.#handle(message);
      if (!this.#closePromise) {
        this.#forcedOutcome = { status: "failed", message: "Claude Code 运行时已退出。" };
        void this.close("Claude Code 运行时已退出。");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Claude Code 运行时读取失败。";
      // stderr 尾部只进服务端日志，可能带绝对路径，不送往浏览器。
      const stderrTail = this.#closePromise ? "" : this.#processGroup?.stderrTail.trim();
      if (stderrTail) console.error(`Claude Code stderr（${this.#options.sessionId}）：${stderrTail}`);
      this.#forcedOutcome = { status: "failed", message };
      if (!this.#closePromise) void this.close(message);
    }
  }

  #handle(message: SDKMessage): void {
    if ("session_id" in message && message.session_id &&
      message.session_id !== this.#options.sessionId) {
      return;
    }
    if (message.type === "stream_event") {
      const event = message.event;
      if (event.type === "content_block_delta" && event.delta.type === "text_delta" && this.#turn) {
        this.#options.onEvent({ type: "assistant.delta", text: event.delta.text });
      }
      return;
    }
    if (message.type === "assistant") {
      this.#emitAssistant(message);
      return;
    }
    if (message.type === "system" && message.subtype === "permission_denied") {
      this.#options.onEvent({ type: "tool.denied", toolName: message.tool_name, message: message.message });
      return;
    }
    if (message.type === "system" && message.subtype === "session_state_changed") {
      // 恢复运行时时会收到上一轮遗留的 idle：没有本轮 result 就必须忽略。
      if (message.state === "idle" && this.#turn?.result) {
        this.#finishTurn(outcomeOf(this.#turn.result, this.#turn.interrupted));
      }
      return;
    }
    if (message.type === "result" && this.#turn) {
      this.#turn.result = message;
      // result 不代表会话已空闲；继续等 idle。看门狗只是兜底。
      this.#clearWatchdog();
      this.#idleWatchdog = setTimeout(() => {
        const text = "本轮结束后没有等到会话回到空闲状态。";
        this.#forcedOutcome = { status: "failed", message: text };
        void this.close(text);
      }, IDLE_WATCHDOG_MS);
      this.#idleWatchdog.unref();
    }
  }

  #emitAssistant(message: SDKAssistantMessage): void {
    if (!this.#turn) return;
    const text = message.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (text.trim()) this.#options.onEvent({ type: "assistant.message", text });
    for (const block of message.message.content) {
      if (block.type !== "tool_use") continue;
      this.#options.onEvent({
        type: "tool.started",
        toolName: block.name,
        detail: describeToolInput(block.input),
      });
    }
  }

  #finishTurn(outcome: TurnOutcome): void {
    const turn = this.#turn;
    if (!turn) return;
    this.#turn = null;
    this.#clearWatchdog();
    const waiters = this.#turnEndWaiters;
    this.#turnEndWaiters = [];
    for (const waiter of waiters) waiter();
    const result = turn.result;
    this.#options.onEvent({
      type: "turn.ended",
      outcome: turn.interrupted && outcome.status !== "failed" ? { status: "interrupted" } : outcome,
      // SDK 偶尔不发 Claude 的文字回答，只把它留在 result 里，由调用方兜底。
      resultText: result?.subtype === "success" ? result.result : "",
    });
  }

  #clearWatchdog(): void {
    if (this.#idleWatchdog) clearTimeout(this.#idleWatchdog);
    this.#idleWatchdog = null;
  }

  #waitForTurnEnd(timeoutMs: number): Promise<boolean> {
    if (!this.#turn) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref();
      this.#turnEndWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

/** 输入队列：单轮 result 不能关闭它，否则子进程退出。 */
class InputQueue {
  #items: Array<{ message: SDKUserMessage; handOver: () => void; fail: (error: unknown) => void }> = [];
  #notify: (() => void) | null = null;
  #closed = false;
  #started = false;

  push(message: SDKUserMessage): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("输入队列已关闭。"));
    return new Promise<void>((resolve, reject) => {
      this.#items.push({ message, handOver: resolve, fail: reject });
      this.#notify?.();
    });
  }

  close(): void {
    this.#closed = true;
    const error = new Error("输入队列已关闭。");
    for (const item of this.#items.splice(0)) item.fail(error);
    this.#notify?.();
  }

  /** 全程只能有一条读取循环；第二条循环会各拿到一半消息，症状是随机丢消息。 */
  async *stream(): AsyncGenerator<SDKUserMessage> {
    if (this.#started) throw new Error("输入队列只能被迭代一次。");
    this.#started = true;
    while (!this.#closed) {
      const item = this.#items.shift();
      if (!item) {
        await new Promise<void>((resolve) => {
          this.#notify = () => {
            this.#notify = null;
            resolve();
          };
        });
        continue;
      }
      item.handOver();
      yield item.message;
    }
  }
}

function outcomeOf(result: SDKResultMessage, interrupted: boolean): TurnOutcome {
  if (interrupted) return { status: "interrupted" };
  if (result.subtype === "success") {
    return result.is_error
      ? { status: "failed", message: result.result || "Claude 未能完成回答。" }
      : { status: "completed" };
  }
  if (result.errors.length > 0) return { status: "failed", message: result.errors.join("；") };
  const labels: Record<typeof result.subtype, string> = {
    error_during_execution: "Claude 执行时发生错误。",
    error_max_turns: "本轮已达到最大步骤数。",
    error_max_budget_usd: "本轮已达到费用上限。",
    error_max_structured_output_retries: "结构化输出重试次数已用完。",
  };
  return { status: "failed", message: labels[result.subtype] };
}

export function describeToolInput(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const record = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "query", "url", "prompt"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return `${key}: ${value.replaceAll(/\s+/gu, " ").trim().slice(0, 240)}`;
    }
  }
  return "";
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise.then((value) => ({ ok: true, value }) as const),
      new Promise<{ ok: false }>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false }), timeoutMs);
        timer.unref();
      }),
    ]);
  } catch {
    return { ok: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
