import {
  query,
  type EffortLevel,
  type ModelInfo,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type Query,
  type SDKAssistantMessage,
  type SDKControlGetContextUsageResponse,
  type SDKControlGetUsageResponse,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";

import { ProcessGroup } from "../../platform/process-group.ts";
import type { ApprovalAnswer, ApprovalAsk } from "../types.ts";
import { createPreToolUseHook } from "./tool-policy.ts";

/*
 * Low-level Claude Code runtime, ported from Relayu `src/claude/session-runtime.ts`, minus Relayu's own
 * product features (companion, routine, rewind, etc.), keeping only start, send, interrupt, compact, usage queries and close.
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
  /** New sessions are created with sessionId; existing ones are reattached with resume. */
  resume: boolean;
  /** Only for querying the model list: writes no session file and sends no messages. */
  ephemeral?: boolean;
  cwd: string;
  /** Appended after Claude Code's preset system prompt. */
  appendSystemPrompt: string;
  pathToClaudeCodeExecutable: string;
  permissionMode: PermissionMode;
  /** null means unspecified, following Claude Code's default. */
  model: string | null;
  effort: EffortLevel | null;
  onEvent: (event: RuntimeEvent) => void;
  requestApproval: (ask: ApprovalAsk) => Promise<ApprovalAnswer>;
};

/** Upper bound on waiting for idle after result. In practice idle follows result immediately; a timeout means this runtime can no longer be trusted. */
const IDLE_WATCHDOG_MS = 30_000;
/** Separate wait limits for the interrupt acknowledgement and the idle that follows. */
const INTERRUPT_TIMEOUT_MS = 10_000;

/**
 * In the group chat an AI with a question writes it in its reply and the group owner decides what's next, so AskUserQuestion isn't offered.
 */
const DISALLOWED_TOOLS = ["AskUserQuestion"];

/**
 * Must be built on top of the full inherited process.env, or OAuth and proxy settings are lost.
 * Both the web login token and the long-lived OAuth token are removed: the CLI doesn't need the former, and whether to provide the latter is up to each deployment;
 * this project doesn't choose Claude Code's auth method.
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
  /** A `/compact` round: settled as failed if no compaction success signal arrives. */
  expectCompaction: boolean;
  compactResult: "success" | "failed" | null;
  compactError: string | null;
  compactBoundary: boolean;
};

/**
 * One session maps to one long-lived Query, one never-closed input queue and exactly one read loop.
 * A round's result neither ends the loop nor closes the queue, or the subprocess would exit.
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
      await runtime.close("Claude Code runtime initialization failed.");
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

  /** false after close() means the process tree couldn't be confirmed to have exited. */
  get exitConfirmed(): boolean {
    return this.#exitConfirmed;
  }

  async #begin(): Promise<void> {
    // Must exist before query(): once the spawn callback runs, this instance holds the process group id.
    const processGroup = new ProcessGroup();
    this.#processGroup = processGroup;
    const options: Options = {
      cwd: this.#options.cwd,
      ...(this.#options.resume
        ? { resume: this.#options.sessionId }
        : { sessionId: this.#options.sessionId }),
      ...(this.#options.ephemeral ? { persistSession: false } : {}),
      pathToClaudeCodeExecutable: this.#options.pathToClaudeCodeExecutable,
      // Taking over spawn ourselves puts the CLI and its tool subprocesses in one separate process group.
      spawnClaudeCodeProcess: processGroup.spawn,
      systemPrompt: { type: "preset", preset: "claude_code", append: this.#options.appendSystemPrompt },
      settingSources: ["user", "project"],
      // A phone may handle an approval minutes later; the SDK's internal deadline is explicitly disabled and the approval registry owns timeouts.
      settings: { dialogExpiry: "never" },
      permissionMode: this.#options.permissionMode,
      // Only lets the SDK accept bypassPermissions; reading secret files and the like is still hard-denied by PreToolUse.
      allowDangerouslySkipPermissions: true,
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
    // A long-lived session's readiness gate is initializationResult(), not system/init in the conversation stream.
    await conversation.initializationResult();
    // As in Relayu: model and reasoning effort aren't launch arguments; they are set once ready, so new and resumed sessions take the same path.
    if (this.#options.model) await conversation.setModel(this.#options.model);
    if (this.#options.effort) await conversation.applyFlagSettings({ effortLevel: this.#options.effort });
  }

  /** Models actually available to the account. */
  async listModels(): Promise<ModelInfo[]> {
    if (!this.#query) throw new Error("The runtime is not ready.");
    return this.#query.supportedModels();
  }

  /** Plan quota: an experimental SDK API whose fields may change. */
  async getUsage(): Promise<SDKControlGetUsageResponse> {
    if (!this.#query) throw new Error("The runtime is not ready.");
    return this.#query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
  }

  async getContextUsage(): Promise<SDKControlGetContextUsageResponse> {
    if (!this.#query) throw new Error("The runtime is not ready.");
    return this.#query.getContextUsage();
  }

  async #canUseTool(toolName: string, input: Record<string, unknown>): Promise<PermissionResult> {
    // Outside an active round, or while the round is being interrupted, no new tool calls are allowed.
    if (!this.#turn || this.#turn.interrupted) {
      return { behavior: "deny", message: "No reply is in progress, so this tool call was denied." };
    }
    if (this.#options.permissionMode === "bypassPermissions") return { behavior: "allow" };
    const answer = await this.#options.requestApproval({
      toolName,
      detail: describeToolInput(input),
    });
    return answer.decision === "allow"
      ? { behavior: "allow" }
      : { behavior: "deny", message: answer.message || "The user denied this tool call." };
  }

  /**
   * On resolve the message has been handed to the SDK's input queue.
   * expectCompaction is for `/compact`: as in Relayu, it is sent as a round's internal message.
   */
  async startTurn(text: string, expectCompaction = false): Promise<void> {
    if (this.closed) throw new Error("The runtime is closed.");
    if (this.#turn) throw new Error("The session is still handling the previous round.");
    this.#turn = {
      result: null,
      interrupted: false,
      expectCompaction,
      compactResult: null,
      compactError: null,
      compactBoundary: false,
    };
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
   * A non-empty still_queued in the acknowledgement means queued messages will still run, so the whole runtime must be closed;
   * a timeout on the acknowledgement or the following idle closes it too.
   */
  async interrupt(): Promise<"interrupted" | "closed"> {
    const conversation = this.#query;
    if (!conversation || this.closed) return "closed";
    if (!this.#turn) return "interrupted";
    this.#turn.interrupted = true;

    const receipt = await withTimeout(conversation.interrupt(), INTERRUPT_TIMEOUT_MS);
    if (!receipt.ok || (receipt.value?.still_queued?.length ?? 0) > 0) {
      await this.close("The interrupt was not acknowledged; the runtime was closed.");
      return "closed";
    }
    if (!await this.#waitForTurnEnd(INTERRUPT_TIMEOUT_MS)) {
      await this.close("The session did not return to idle after the interrupt; the runtime was closed.");
      return "closed";
    }
    return "interrupted";
  }

  /**
   * Closes and confirms the old process and the children it spawned have really exited. This method never rejects:
   * if confirmation fails it sets exitConfirmed to false and only logs.
   */
  close(reason: string): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    const processGroup = this.#processGroup;
    this.#closePromise = (async () => {
      this.#input.close();
      try {
        this.#query?.close();
      } catch {
        // Closing an already-exited process again isn't an error.
      }
      // The read loop ending only means stdout hit EOF; it doesn't mean the process exited, let alone its children.
      await this.#readLoop.catch(() => undefined);
      this.#exitConfirmed = processGroup === null || await processGroup.terminate();
      if (!this.#exitConfirmed) console.error(`Claude Code process exit not confirmed (${this.#options.sessionId}).`);
      this.#finishTurn(this.#forcedOutcome ?? { status: "interrupted" });
      this.#options.onEvent({ type: "closed", reason });
    })();
    return this.#closePromise;
  }

  async #read(conversation: Query): Promise<void> {
    try {
      for await (const message of conversation) this.#handle(message);
      if (!this.#closePromise) {
        this.#forcedOutcome = { status: "failed", message: "The Claude Code runtime exited." };
        void this.close("The Claude Code runtime exited.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Reading from the Claude Code runtime failed.";
      // The stderr tail goes only to server logs; it may contain absolute paths, so it isn't sent to the browser.
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
    if (message.type === "system" && message.subtype === "compact_boundary") {
      if (this.#turn) this.#turn.compactBoundary = true;
      return;
    }
    if (message.type === "system" && message.subtype === "status" && message.compact_result) {
      if (this.#turn) {
        this.#turn.compactResult = message.compact_result;
        this.#turn.compactError = message.compact_error ?? null;
      }
      return;
    }
    if (message.type === "system" && message.subtype === "session_state_changed") {
      // Restoring the runtime delivers an idle left over from the previous round: without this round's result it must be ignored.
      if (message.state === "idle" && this.#turn?.result) {
        this.#finishTurn(outcomeOf(this.#turn.result, this.#turn.interrupted));
      }
      return;
    }
    if (message.type === "result" && this.#turn) {
      this.#turn.result = message;
      // result doesn't mean the session is idle; keep waiting for idle. The watchdog is only a fallback.
      this.#clearWatchdog();
      this.#idleWatchdog = setTimeout(() => {
        const text = "The session did not return to idle after the round.";
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
    const final = turn.expectCompaction && outcome.status === "completed"
      ? compactionOutcome(turn)
      : outcome;
    this.#options.onEvent({
      type: "turn.ended",
      outcome: turn.interrupted && final.status !== "failed" ? { status: "interrupted" } : final,
      // The SDK occasionally doesn't send Claude's text answer and leaves it only in result; the caller falls back to it.
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

/** Input queue: a round's result must not close it, or the subprocess exits. */
class InputQueue {
  #items: Array<{ message: SDKUserMessage; handOver: () => void; fail: (error: unknown) => void }> = [];
  #notify: (() => void) | null = null;
  #closed = false;
  #started = false;

  push(message: SDKUserMessage): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("The input queue is closed."));
    return new Promise<void>((resolve, reject) => {
      this.#items.push({ message, handOver: resolve, fail: reject });
      this.#notify?.();
    });
  }

  close(): void {
    this.#closed = true;
    const error = new Error("The input queue is closed.");
    for (const item of this.#items.splice(0)) item.fail(error);
    this.#notify?.();
  }

  /** Only one read loop may ever exist; a second one would get half the messages each, showing up as randomly lost messages. */
  async *stream(): AsyncGenerator<SDKUserMessage> {
    if (this.#started) throw new Error("The input queue can only be iterated once.");
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

/** Explicit failure wins; in short sessions result may still be success, so compaction's own signal must be checked. */
function compactionOutcome(turn: Turn): TurnOutcome {
  if (turn.compactResult === "failed") {
    return { status: "failed", message: turn.compactError || "Claude Code could not compact the context." };
  }
  if (turn.compactBoundary || turn.compactResult === "success") return { status: "completed" };
  return { status: "failed", message: "The round ended without confirming that compaction succeeded." };
}

function outcomeOf(result: SDKResultMessage, interrupted: boolean): TurnOutcome {
  if (interrupted) return { status: "interrupted" };
  if (result.subtype === "success") {
    return result.is_error
      ? { status: "failed", message: result.result || "Claude could not finish the answer." }
      : { status: "completed" };
  }
  if (result.errors.length > 0) return { status: "failed", message: result.errors.join("；") };
  const labels: Record<typeof result.subtype, string> = {
    error_during_execution: "Claude hit an error during execution.",
    error_max_turns: "The round reached the maximum number of turns.",
    error_max_budget_usd: "The round reached the budget limit.",
    error_max_structured_output_retries: "Structured output retries are exhausted.",
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
