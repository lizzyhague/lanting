import { randomUUID } from "node:crypto";

import { EventChannel } from "../event-channel.ts";
import type { AgentAdapter, AgentEvent, AgentSession, SessionOptions } from "../types.ts";
import { ClaudeRuntime, type RuntimeEvent } from "./runtime.ts";

export type ClaudeAdapterOptions = {
  pathToClaudeCodeExecutable: string;
};

export class ClaudeAdapter implements AgentAdapter {
  readonly id = "claude";
  readonly displayName = "Claude";
  /** 照 Relayu：Claude Code 进程常驻，空闲后回收。 */
  readonly closeAfterTurn = false;
  readonly #options: ClaudeAdapterOptions;

  constructor(options: ClaudeAdapterOptions) {
    this.#options = options;
  }

  startSession(options: SessionOptions): Promise<AgentSession> {
    // Claude Code 允许事先指定会话 id，开会话时就能记下对应关系。
    return ClaudeSession.open(randomUUID(), false, options, this.#options);
  }

  resumeSession(nativeId: string, options: SessionOptions): Promise<AgentSession> {
    return ClaudeSession.open(nativeId, true, options, this.#options);
  }
}

/**
 * 把运行时的回调事件转成统一接口的事件流。
 *
 * 明文回复以这一轮最后一条 assistant 文字为准：工具调用之前的过渡文字
 * （“我先看一下……”）转成过程信息，只给群主看，不进群聊记录。
 */
class ClaudeSession implements AgentSession {
  readonly nativeId: string;
  #runtime: ClaudeRuntime | null = null;
  #channel: EventChannel<AgentEvent> | null = null;
  #pending = "";

  private constructor(nativeId: string) {
    this.nativeId = nativeId;
  }

  static async open(
    nativeId: string,
    resume: boolean,
    options: SessionOptions,
    adapter: ClaudeAdapterOptions,
  ): Promise<ClaudeSession> {
    const session = new ClaudeSession(nativeId);
    session.#runtime = await ClaudeRuntime.start({
      sessionId: nativeId,
      resume,
      cwd: options.cwd,
      appendSystemPrompt: options.systemPrompt,
      pathToClaudeCodeExecutable: adapter.pathToClaudeCodeExecutable,
      onEvent: (event) => session.#onEvent(event),
      requestApproval: options.requestApproval,
    });
    return session;
  }

  get alive(): boolean {
    return this.#runtime !== null && !this.#runtime.closed;
  }

  async *send(text: string): AsyncIterable<AgentEvent> {
    const runtime = this.#runtime;
    if (!runtime || runtime.closed) throw new Error("Claude Code 运行时已关闭。");
    const channel = new EventChannel<AgentEvent>();
    this.#channel = channel;
    this.#pending = "";
    try {
      await runtime.startTurn(text);
      yield* channel;
    } finally {
      if (this.#channel === channel) this.#channel = null;
    }
  }

  async interrupt(): Promise<void> {
    await this.#runtime?.interrupt();
  }

  async close(): Promise<void> {
    await this.#runtime?.close("会话已关闭。");
  }

  #onEvent(event: RuntimeEvent): void {
    const channel = this.#channel;
    if (!channel) return;
    switch (event.type) {
      case "assistant.delta":
        channel.push({ type: "text", delta: event.text });
        return;
      case "assistant.message":
        this.#pending = event.text;
        return;
      case "tool.started":
        if (this.#pending.trim()) {
          channel.push({ type: "activity", activity: { kind: "note", text: this.#pending } });
        }
        this.#pending = "";
        channel.push({
          type: "activity",
          activity: { kind: "tool", toolName: event.toolName, detail: event.detail },
        });
        return;
      case "tool.denied":
        channel.push({
          type: "activity",
          activity: { kind: "denied", toolName: event.toolName, message: event.message },
        });
        return;
      case "turn.ended": {
        const text = this.#pending.trim() ? this.#pending : event.resultText;
        const outcome = event.outcome;
        channel.push({
          type: "end",
          outcome: outcome.status,
          text,
          ...(outcome.status === "failed" ? { error: outcome.message } : {}),
        });
        channel.end();
        return;
      }
      case "closed":
        channel.end();
        return;
    }
  }
}
