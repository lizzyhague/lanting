import {
  deleteSession,
  type EffortLevel,
  type ModelInfo,
  type PermissionMode,
  type SDKControlGetContextUsageResponse,
  type SDKControlGetUsageResponse,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";

import type { AgentFeatures, UsagePart } from "../../features/index.ts";
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
import { ClaudeRuntime, type RuntimeEvent } from "./runtime.ts";

export type ClaudeAdapterOptions = {
  pathToClaudeCodeExecutable: string;
};

/** Follows Relayu's permission menu. */
export const CLAUDE_PERMISSIONS: readonly (PermissionOption & { id: PermissionMode })[] = [
  { id: "default", label: "Default", description: "按 lanting 规则逐次确认可写或有副作用的工具。" },
  { id: "acceptEdits", label: "Accept Edits", description: "自动接受文件编辑，其他调用仍逐次确认。" },
  { id: "plan", label: "Plan Mode", description: "只规划，不执行会改变项目的工具调用。" },
  { id: "dontAsk", label: "Don't Ask", description: "不弹审批；没有预先允许的调用直接拒绝。" },
  { id: "auto", label: "Auto", description: "由 Claude Code 的模型分类器判断要不要确认。" },
  {
    id: "bypassPermissions",
    label: "Bypass Permissions",
    description: "普通调用不再逐次确认，读取秘密文件等硬拒绝仍然保留。",
    danger: true,
  },
];

/** When the SDK has no reasoning effort metadata for a model, fall back to the full set, as Relayu does. */
const ALL_EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** The "follow default" row in the model list; choosing it means no model is specified. */
const DEFAULT_MODEL_ID = "default";

export class ClaudeAdapter implements AgentAdapter {
  readonly kind = "claude";
  /** As in Relayu: the Claude Code process stays resident and is reclaimed when idle. */
  readonly closeAfterTurn = false;
  readonly features: AgentFeatures = {
    compact: (session) => asOwnSession(session).compact(),
    deleteSession: (nativeId, cwd) => this.#deleteSession(nativeId, cwd),
    models: async (cwd) => (await this.#catalog(cwd)).models,
    permissions: async (cwd) => (await this.#catalog(cwd)).permissions,
    // As in Relayu: opening a group or switching members starts a process if none is running; reply completion and returning to the foreground only read running ones.
    usage: async (request) => {
      const session = await request.session(request.reason === "view");
      return session ? asOwnSession(session).usage() : null;
    },
  };
  readonly #options: ClaudeAdapterOptions;
  readonly #catalogs = new CatalogCache();

  constructor(options: ClaudeAdapterOptions) {
    this.#options = options;
  }

  #catalog(cwd: string): Promise<AgentCatalog> {
    return this.#catalogs.get(cwd, async () => {
      // supportedModels() can only ask a running Claude Code, so start a temporary one that writes nothing to disk and sends no messages.
      const runtime = await ClaudeRuntime.start({
        sessionId: randomUUID(),
        resume: false,
        ephemeral: true,
        cwd,
        appendSystemPrompt: "",
        pathToClaudeCodeExecutable: this.#options.pathToClaudeCodeExecutable,
        permissionMode: "default",
        model: null,
        effort: null,
        onEvent: () => {},
        requestApproval: () => Promise.resolve({ decision: "deny", message: "" }),
      });
      try {
        return { models: modelOptions(await runtime.listModels()), permissions: [...CLAUDE_PERMISSIONS] };
      } finally {
        await runtime.close("Model list fetched.");
      }
    });
  }

  /** As in Relayu: the SDK's deleteSession; a session file that is already gone counts as deleted. */
  async #deleteSession(nativeId: string, cwd: string): Promise<void> {
    try {
      await deleteSession(nativeId, { dir: cwd });
    } catch (error) {
      if (!isSessionNotFoundError(error)) throw error;
    }
  }

  startSession(options: SessionOptions): Promise<AgentSession> {
    // Claude Code allows the session id to be chosen up front, so the mapping is recorded when the session opens.
    return ClaudeSession.open(randomUUID(), false, options, this.#options);
  }

  resumeSession(nativeId: string, options: SessionOptions): Promise<AgentSession> {
    return ClaudeSession.open(nativeId, true, options, this.#options);
  }
}

function asOwnSession(session: AgentSession): ClaudeSession {
  if (!(session instanceof ClaudeSession)) throw new Error("The session does not belong to Claude Code.");
  return session;
}

/**
 * Converts runtime callback events into the shared interface's event stream.
 *
 * The plain reply is the round's last assistant text: interim text before tool calls
 * ("let me take a look first...") becomes progress info, shown only to the group owner and kept out of the chat record.
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
      permissionMode: permissionMode(options.settings.permission),
      model: options.settings.model === DEFAULT_MODEL_ID ? null : options.settings.model,
      effort: effortLevel(options.settings.effort),
      onEvent: (event) => session.#onEvent(event),
      requestApproval: options.requestApproval,
    });
    return session;
  }

  get alive(): boolean {
    return this.#runtime !== null && !this.#runtime.closed;
  }

  send(text: string): AsyncIterable<AgentEvent> {
    return this.#run(text, false);
  }

  async *#run(text: string, expectCompaction: boolean): AsyncIterable<AgentEvent> {
    const runtime = this.#runtime;
    if (!runtime || runtime.closed) throw new Error("The Claude Code runtime is closed.");
    const channel = new EventChannel<AgentEvent>();
    this.#channel = channel;
    this.#pending = "";
    try {
      await runtime.startTurn(text, expectCompaction);
      yield* channel;
    } finally {
      if (this.#channel === channel) this.#channel = null;
    }
  }

  async interrupt(): Promise<void> {
    await this.#runtime?.interrupt();
  }

  async compact(): Promise<void> {
    for await (const event of this.#run("/compact", true)) {
      if (event.type !== "end") continue;
      if (event.outcome !== "completed") throw new Error(event.error ?? "Compaction was interrupted.");
    }
  }

  /**
   * Follows Relayu's metrics: read context first; a failed quota read is only logged and context is returned as usual.
   * Both are SDK control requests: they don't compete with replies or wait for them to finish.
   */
  async usage(): Promise<UsagePart[]> {
    const runtime = this.#runtime;
    if (!runtime || runtime.closed) throw new Error("The Claude Code runtime is closed.");
    const context = await runtime.getContextUsage();
    let usage: SDKControlGetUsageResponse | null = null;
    try {
      usage = await runtime.getUsage();
    } catch (error) {
      console.error(`Reading the Claude Code plan quota failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return usageParts(context, usage);
  }

  async close(): Promise<void> {
    await this.#runtime?.close("Session closed.");
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

/** Same as Relayu: use only the catalog the SDK provides, dropping empty and duplicate ids. */
export function modelOptions(models: readonly ModelInfo[]): ModelOption[] {
  const options: ModelOption[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const id = model.value.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    options.push({
      id,
      label: model.displayName || id,
      description: model.description,
      efforts: model.supportsEffort === false
        ? []
        : [...(model.supportedEffortLevels ?? ALL_EFFORT_LEVELS)],
    });
  }
  return options;
}

type RateWindow = { utilization: number | null; resets_at: string | null } | null | undefined;

/** Windows follow Relayu's sessionMetricsOf; text follows its renderMetrics. */
export function usageParts(
  context: Pick<SDKControlGetContextUsageResponse, "percentage">,
  usage: Pick<SDKControlGetUsageResponse, "rate_limits_available" | "rate_limits"> | null,
): UsagePart[] {
  const parts: UsagePart[] = [{ text: `上下文 ${Number(context.percentage || 0).toFixed(1)}%` }];
  const rateLimits = usage?.rate_limits;
  if (usage?.rate_limits_available !== true || !rateLimits) {
    parts.push({ text: "额度查询不可用" });
    return parts;
  }
  const windows: Array<[string, RateWindow]> = [
    ["5 小时", rateLimits.five_hour],
    ["7 天", rateLimits.seven_day],
    ["Opus 7 天", rateLimits.seven_day_opus],
    ["Sonnet 7 天", rateLimits.seven_day_sonnet],
    ["OAuth Apps 7 天", rateLimits.seven_day_oauth_apps],
  ];
  for (const [label, window] of windows) {
    if (!window) continue;
    const left = window.utilization === null ? "未知" : `${Math.max(0, 100 - window.utilization).toFixed(1)}%`;
    parts.push(window.resets_at
      ? { text: `${label}剩余 ${left}，{time} 重置`, time: window.resets_at }
      : { text: `${label}剩余 ${left}` });
  }
  return parts;
}

function isSessionNotFoundError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return true;
  const message = error instanceof Error ? error.message : "";
  return /(?:session.*not found|not found.*session)/iu.test(message);
}

function permissionMode(value: string | null): PermissionMode {
  return CLAUDE_PERMISSIONS.find((option) => option.id === value)?.id ?? "default";
}

function effortLevel(value: string | null): EffortLevel | null {
  return ALL_EFFORT_LEVELS.find((level) => level === value) ?? null;
}
