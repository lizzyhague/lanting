import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { EventChannel } from "../event-channel.ts";
import type { AgentAdapter, AgentEvent, AgentSession, ApprovalAnswer, SessionOptions } from "../types.ts";
import { AcpClient, type AcpPermissionRequest, type AcpUpdate } from "./acp-client.ts";

export type GrokAdapterOptions = {
  executable: string;
};

/** session/cancel 之后等这么久这一轮还没结束，就直接关掉 Grok 进程。 */
const INTERRUPT_TIMEOUT_MS = 10_000;
const EXIT_WAIT_MS = 8_000;

/** Grok 要直接问用户问题的工具。群聊里有问题写在回复里，这类请求一律取消。 */
const HUMAN_TOOL_NAMES = new Set(["ask_user_question", "ask_user", "request_user_input", "elicitation"]);

export class GrokAdapter implements AgentAdapter {
  readonly id = "grok";
  readonly displayName = "Grok";
  /** 照 Grok Remote：每轮结束就关掉 Grok 进程。 */
  readonly closeAfterTurn = true;
  readonly #options: GrokAdapterOptions;

  constructor(options: GrokAdapterOptions) {
    this.#options = options;
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
    const child = spawn(adapter.executable, ["agent", "--no-leader", "stdio"], {
      cwd: options.cwd,
      env: withoutWebLoginToken(process.env),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    const session = new GrokSession(child, options);
    try {
      if (child.pid === undefined) throw new Error("无法启动 Grok。");
      await session.#client.initialize();
      if (sessionId) {
        await session.#client.sessionResume(sessionId, options.cwd, false);
        session.#sessionId = sessionId;
      } else {
        session.#sessionId = await session.#client.sessionNew(options.cwd, false, options.systemPrompt);
      }
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
