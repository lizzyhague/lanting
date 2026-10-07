import {
  deleteSession,
  type EffortLevel,
  type ModelInfo,
  type PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";

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

/** 照 Relayu 的权限菜单。 */
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

/** SDK 没给某个模型的思考强度元数据时，照 Relayu 退回全集。 */
const ALL_EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** 模型列表里的“跟随默认”那一行，选它等于不指定模型。 */
const DEFAULT_MODEL_ID = "default";

export class ClaudeAdapter implements AgentAdapter {
  readonly id = "claude";
  readonly displayName = "Claude";
  /** 照 Relayu：Claude Code 进程常驻，空闲后回收。 */
  readonly closeAfterTurn = false;
  readonly #options: ClaudeAdapterOptions;
  readonly #catalogs = new CatalogCache();

  constructor(options: ClaudeAdapterOptions) {
    this.#options = options;
  }

  catalog(cwd: string): Promise<AgentCatalog> {
    return this.#catalogs.get(cwd, async () => {
      // supportedModels() 只能问运行着的 Claude Code，所以临时起一个不落盘、不发消息的。
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
        await runtime.close("模型列表已取到。");
      }
    });
  }

  /** 照 Relayu：SDK 的 deleteSession；会话文件已经不在也算删掉了。 */
  async deleteSession(nativeId: string, cwd: string): Promise<void> {
    try {
      await deleteSession(nativeId, { dir: cwd });
    } catch (error) {
      if (!isSessionNotFoundError(error)) throw error;
    }
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
    if (!runtime || runtime.closed) throw new Error("Claude Code 运行时已关闭。");
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
      if (event.outcome !== "completed") throw new Error(event.error ?? "压缩被打断了。");
    }
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

/** 与 Relayu 一致：只用 SDK 给出的目录，空 id 和重复 id 去掉。 */
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
