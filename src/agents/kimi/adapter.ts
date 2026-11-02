import type { AgentFeatures, UsagePart } from "../../features/index.ts";
import { localText } from "../../i18n/text.ts";
import { CatalogCache } from "../catalog-cache.ts";
import { EventChannel } from "../event-channel.ts";
import {
  type AgentAdapter,
  type AgentCatalog,
  type AgentEvent,
  type AgentSession,
  type ApprovalAnswer,
  deniedMessage,
  genericTool,
  localizedPermission,
  type ModelOption,
  type PermissionOption,
  type SessionOptions,
  type ToolName,
  toolNameOr,
} from "../types.ts";
import {
  AUTH_REQUIRED_CODE,
  KimiAcpClient,
  KimiRpcError,
  type KimiPermissionOutcome,
  type KimiPermissionRequest,
  type KimiSessionConfig,
  type KimiUpdate,
} from "./acp-client.ts";

export type KimiAdapterOptions = { executable: string };

const INTERRUPT_TIMEOUT_MS = 10_000;
const ALWAYS_APPROVE = "always-approve";
const DEFAULT_MODE = "default";
const HUMAN_TOOL_NAMES = ["askuserquestion", "askuser", "requestuserinput", "elicitation"];

export const KIMI_PERMISSIONS: readonly PermissionOption[] = [
  localizedPermission({
    id: "ask",
    label: localText("permission.ask"),
    description: "Ask before Kimi runs a tool that needs approval.",
  }),
  localizedPermission({
    id: ALWAYS_APPROVE,
    label: "Always approve",
    description: "Approve every Kimi tool request for this group without asking.",
    danger: true,
  }),
];

export const LOGIN_REQUIRED = "Kimi Code is not logged in. Run `kimi login` on the server first.";

export function firstMessage(systemPrompt: string, text: string): string {
  return [
    "[lanting group chat rules: they apply to this whole session]",
    systemPrompt.trim(),
    "[End of group chat rules]",
    "",
    text,
  ].join("\n");
}

export class KimiAdapter implements AgentAdapter {
  readonly kind = "kimi";
  readonly closeAfterTurn = true;
  readonly #options: KimiAdapterOptions;
  readonly #catalogCache = new CatalogCache();
  readonly #usage = new Map<string, UsagePart[]>();

  readonly features: AgentFeatures = {
    models: async (cwd) => (await this.#catalog(cwd)).models,
    permissions: async (cwd) => (await this.#catalog(cwd)).permissions,
    usage: async ({ nativeId }) => this.#usage.get(nativeId) ?? null,
    deleteSession: async (nativeId, cwd) => {
      const client = this.#client(cwd);
      try {
        await client.initialize();
        await client.sessionDelete(nativeId).catch((error: unknown) => {
          // Kimi reports an unknown session as invalidParams; lanting deletion is idempotent.
          if (!(error instanceof KimiRpcError) || error.code !== -32602) throw error;
        });
        this.#usage.delete(nativeId);
      } finally {
        await client.close();
      }
    },
  };

  constructor(options: KimiAdapterOptions) {
    this.#options = options;
  }

  startSession(options: SessionOptions): Promise<AgentSession> {
    return KimiSession.open(null, options, this.#options, (id, usage) => this.#usage.set(id, usage));
  }

  resumeSession(nativeId: string, options: SessionOptions): Promise<AgentSession> {
    return KimiSession.open(nativeId, options, this.#options, (id, usage) => this.#usage.set(id, usage));
  }

  #catalog(cwd: string): Promise<AgentCatalog> {
    return this.#catalogCache.get(cwd, async () => {
      const client = this.#client(cwd);
      let sessionId: string | null = null;
      try {
        await client.initialize();
        const config = await client.sessionNew(cwd);
        sessionId = config.sessionId;
        return { models: modelOptions(config), permissions: [...KIMI_PERMISSIONS] };
      } finally {
        if (sessionId) await client.sessionDelete(sessionId).catch(() => {});
        await client.close();
      }
    });
  }

  #client(cwd: string): KimiAcpClient {
    return new KimiAcpClient({ executable: this.#options.executable, cwd, env: childEnvironment(process.env) });
  }
}

type Turn = {
  channel: EventChannel<AgentEvent>;
  segment: string;
  thought: string;
  interrupted: boolean;
};

type UsageListener = (sessionId: string, usage: UsagePart[]) => void;

class KimiSession implements AgentSession {
  readonly #client: KimiAcpClient;
  readonly #options: SessionOptions;
  readonly #usage: UsageListener;
  readonly #approvals = new Map<number | string, AbortController>();
  readonly #toolCalls = new Map<string, Record<string, unknown>>();
  #sessionId = "";
  #rulesPending = false;
  #turn: Turn | null = null;

  private constructor(client: KimiAcpClient, options: SessionOptions, usage: UsageListener) {
    this.#client = client;
    this.#options = options;
    this.#usage = usage;
    client.on("update", (payload: KimiUpdate) => this.#onUpdate(payload));
    client.on("permission", (request: KimiPermissionRequest) => this.#onPermission(request));
    client.on("exit", () => {
      this.#cancelApprovals();
      const turn = this.#turn;
      if (!turn) return;
      this.#finish(turn.interrupted
        ? { type: "end", outcome: "interrupted", text: turn.segment }
        : { type: "end", outcome: "failed", text: turn.segment, error: "The Kimi process exited." });
    });
  }

  static async open(
    sessionId: string | null,
    options: SessionOptions,
    adapter: KimiAdapterOptions,
    usage: UsageListener,
  ): Promise<KimiSession> {
    const client = new KimiAcpClient({
      executable: adapter.executable,
      cwd: options.cwd,
      env: childEnvironment(process.env),
    });
    const session = new KimiSession(client, options, usage);
    try {
      await client.initialize();
      const config = sessionId
        ? await client.sessionResume(sessionId, options.cwd)
        : await client.sessionNew(options.cwd);
      session.#sessionId = config.sessionId;
      session.#rulesPending = sessionId === null;
      await applySettings(client, config.sessionId, options);
      return session;
    } catch (error) {
      if (client.stderrTail.trim()) console.error(`Kimi stderr: ${client.stderrTail.trim()}`);
      await session.close();
      throw isAuthRequired(error) ? new Error(LOGIN_REQUIRED) : error;
    }
  }

  get nativeId(): string | null {
    return this.#sessionId || null;
  }

  get alive(): boolean {
    return this.#client.alive;
  }

  async *send(text: string): AsyncIterable<AgentEvent> {
    if (!this.alive) throw new Error("The Kimi process is closed.");
    if (this.#turn) throw new Error("Kimi is still handling the previous round.");
    const turn: Turn = { channel: new EventChannel<AgentEvent>(), segment: "", thought: "", interrupted: false };
    this.#turn = turn;
    const prompt = this.#rulesPending ? firstMessage(this.#options.systemPrompt, text) : text;
    this.#rulesPending = false;
    void this.#client.sessionPrompt(this.#sessionId, prompt).then(
      (result) => {
        const stop = result.stopReason ?? "end_turn";
        this.#flushThought(turn);
        if (turn.interrupted || stop === "cancelled") {
          this.#finish({ type: "end", outcome: "interrupted", text: turn.segment });
        } else if (stop === "end_turn") {
          this.#finish({ type: "end", outcome: "completed", text: turn.segment });
        } else {
          this.#finish({ type: "end", outcome: "failed", text: turn.segment, error: `Kimi ended the round early (${stop}).` });
        }
      },
      (error: unknown) => {
        this.#finish({
          type: "end",
          outcome: turn.interrupted ? "interrupted" : "failed",
          text: turn.segment,
          ...(turn.interrupted ? {} : { error: isAuthRequired(error) ? LOGIN_REQUIRED : errorText(error) }),
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

  #flushThought(turn: Turn): void {
    if (turn.thought.trim()) turn.channel.push({ type: "activity", activity: { kind: "note", text: turn.thought } });
    turn.thought = "";
  }

  #onUpdate(payload: KimiUpdate): void {
    if (payload.sessionId !== this.#sessionId) return;
    const update = payload.update;
    const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
    if (kind === "usage_update") {
      const used = finiteNumber(update.used);
      const size = finiteNumber(update.size);
      if (used !== null && size !== null && size > 0) {
        this.#usage(this.#sessionId, [{ kind: "context", percent: Math.max(0, Math.min(100, used / size * 100)) }]);
      }
      return;
    }
    const turn = this.#turn;
    if (!turn) return;
    if (kind === "agent_thought_chunk") {
      turn.thought += contentText(update.content);
      return;
    }
    if (kind === "agent_message_chunk") {
      this.#flushThought(turn);
      const text = contentText(update.content);
      if (!text) return;
      turn.segment += text;
      turn.channel.push({ type: "text", delta: text });
      return;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      this.#rememberToolCall(update);
      if (kind !== "tool_call") return;
      this.#flushThought(turn);
      if (turn.segment.trim()) turn.channel.push({ type: "activity", activity: { kind: "note", text: turn.segment } });
      turn.segment = "";
      turn.channel.push({ type: "activity", activity: toolActivity(update) });
    }
  }

  #rememberToolCall(update: Record<string, unknown>): void {
    const id = typeof update.toolCallId === "string" ? update.toolCallId : "";
    if (!id) return;
    const previous = this.#toolCalls.get(id) ?? {};
    const merged = { ...previous, ...update };
    const input = inputFromContent(update.content);
    if (input) merged.rawInput = { ...objectField(previous.rawInput), ...objectField(merged.rawInput), ...input };
    this.#toolCalls.set(id, merged);
  }

  #onPermission(request: KimiPermissionRequest): void {
    const turn = this.#turn;
    if (request.sessionId !== this.#sessionId || !turn || turn.interrupted) {
      this.#client.respondPermission(request.rpcId, { outcome: "cancelled" });
      return;
    }
    const id = typeof request.toolCall.toolCallId === "string" ? request.toolCall.toolCallId : "";
    const toolCall = { ...(id ? this.#toolCalls.get(id) : {}), ...request.toolCall };
    if (isHumanRequired(toolCall)) {
      this.#client.respondPermission(request.rpcId, { outcome: "cancelled" });
      turn.channel.push({
        type: "activity",
        activity: { kind: "denied", ...genericTool("tool.question"), ...deniedMessage(localText("denied.askInReply")) },
      });
      return;
    }
    if (this.#options.settings.permission === ALWAYS_APPROVE) {
      this.#client.respondPermission(request.rpcId, permissionOutcome(request, { decision: "allow", message: "" }));
      return;
    }
    const controller = new AbortController();
    this.#approvals.set(request.rpcId, controller);
    const tool = toolActivity(toolCall);
    const settle = (outcome: KimiPermissionOutcome) => {
      if (this.#approvals.get(request.rpcId) !== controller) return;
      this.#approvals.delete(request.rpcId);
      this.#client.respondPermission(request.rpcId, outcome);
    };
    void this.#options.requestApproval({
      ...(tool.toolKey ? { toolName: tool.toolName, toolKey: tool.toolKey } : { toolName: tool.toolName }),
      detail: tool.detail || permissionReason(request.toolCall),
    }, controller.signal).then(
      (answer) => settle(permissionOutcome(request, answer)),
      () => settle({ outcome: "cancelled" }),
    );
  }

  #cancelApprovals(): void {
    for (const [rpcId, controller] of this.#approvals) {
      this.#approvals.delete(rpcId);
      controller.abort();
      this.#client.respondPermission(rpcId, { outcome: "cancelled" });
    }
  }
}

async function applySettings(client: KimiAcpClient, sessionId: string, options: SessionOptions): Promise<void> {
  await client.sessionSetConfigOption(sessionId, "mode", DEFAULT_MODE);
  if (options.settings.model) await client.sessionSetConfigOption(sessionId, "model", options.settings.model);
  if (options.settings.effort) await client.sessionSetConfigOption(sessionId, "thinking", options.settings.effort);
}

export function modelOptions(config: KimiSessionConfig): ModelOption[] {
  const model = selectOption(config.configOptions, "model");
  const thinking = selectOption(config.configOptions, "thinking");
  const efforts = thinking.options.map((option) => option.value);
  return model.options.map((option) => ({
    id: option.value,
    label: option.name || option.value,
    description: option.description,
    efforts,
    ...(thinking.currentValue ? { defaultEffort: thinking.currentValue } : {}),
  }));
}

function selectOption(values: unknown[], id: string): {
  currentValue: string;
  options: Array<{ value: string; name: string; description: string }>;
} {
  const entry = values.map(objectField).find((candidate) => candidate.id === id) ?? {};
  const options = Array.isArray(entry.options) ? entry.options.map(objectField).flatMap((option) =>
    typeof option.value === "string"
      ? [{
        value: option.value,
        name: typeof option.name === "string" ? option.name : "",
        description: typeof option.description === "string" ? option.description : "",
      }]
      : []) : [];
  return { currentValue: typeof entry.currentValue === "string" ? entry.currentValue : "", options };
}

function permissionOutcome(request: KimiPermissionRequest, answer: ApprovalAnswer): KimiPermissionOutcome {
  const kind = answer.decision === "allow" ? "allow_once" : "reject_once";
  const option = request.options.find((candidate) => candidate.kind === kind);
  return option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
}

export function toolActivity(toolCall: Record<string, unknown>): { kind: "tool"; detail: string } & ToolName {
  const title = typeof toolCall.title === "string" ? toolCall.title.trim() : "";
  const toolKind = typeof toolCall.kind === "string" ? toolCall.kind : "";
  const input = objectField(toolCall.rawInput);
  const detail = ["command", "path", "file_path", "absolute_path"].map((key) => input[key])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? "";
  if (toolKind === "execute" || title.toLowerCase() === "bash") {
    return { kind: "tool", toolName: "bash", detail: detail.replaceAll(/\s+/gu, " ").trim().slice(0, 240) };
  }
  return { kind: "tool", ...toolNameOr(title || toolKind, "tool.generic"), detail: detail.trim().slice(0, 240) };
}

function inputFromContent(content: unknown): Record<string, unknown> | null {
  const text = contentText(content).trim();
  if (!text.startsWith("{")) return null;
  try {
    return objectField(JSON.parse(text));
  } catch {
    return null;
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((item) => contentText(objectField(item).content)).join("");
  const object = objectField(content);
  if (typeof object.text === "string") return object.text;
  return object.content === undefined ? "" : contentText(object.content);
}

function permissionReason(toolCall: Record<string, unknown>): string {
  return contentText(toolCall.content).replace(/^Requesting approval to\s*/u, "").trim().slice(0, 240);
}

function isHumanRequired(toolCall: Record<string, unknown>): boolean {
  const title = typeof toolCall.title === "string" ? toolCall.title.toLowerCase().replaceAll(/[^a-z0-9]/gu, "") : "";
  return HUMAN_TOOL_NAMES.some((name) => title.includes(name));
}

function isAuthRequired(error: unknown): boolean {
  return error instanceof KimiRpcError && error.code === AUTH_REQUIRED_CODE;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function objectField(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function childEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child = { ...environment };
  delete child.ACCESS_TOKEN;
  delete child.CLAUDE_CODE_OAUTH_TOKEN;
  return child;
}
