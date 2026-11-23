import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { proxyEnvironment } from "../proxy.ts";
import type { AgentFeatures, UsagePart } from "../../features/index.ts";
import { englishText, localText, LocalizedError } from "../../i18n/text.ts";
import { CatalogCache } from "../catalog-cache.ts";
import { EventChannel } from "../event-channel.ts";
import {
  type AgentAdapter,
  type AgentCatalog,
  type AgentEvent,
  type AgentSession,
  type ApprovalAnswer,
  localizedPermission,
  type ModelOption,
  type PermissionOption,
  type SessionOptions,
  type ToolName,
  toolNameOr,
} from "../types.ts";
import {
  AUTH_REQUIRED_CODE,
  OpenCodeAcpClient,
  OpenCodeRpcError,
  type OpenCodePermissionOutcome,
  type OpenCodePermissionRequest,
  type OpenCodeUpdate,
} from "./acp-client.ts";

export type OpenCodeAdapterOptions = { executable: string };

const INTERRUPT_TIMEOUT_MS = 10_000;
const ALWAYS_APPROVE = "always-approve";
const execFileAsync = promisify(execFile);

export const OPENCODE_PERMISSIONS: readonly PermissionOption[] = [
  localizedPermission({
    id: "ask",
    label: localText("permission.ask"),
    description: localText("permission.opencode.ask"),
  }),
  localizedPermission({
    id: ALWAYS_APPROVE,
    label: "Always approve",
    description: localText("permission.opencode.alwaysApprove"),
    danger: true,
  }),
];

export const LOGIN_REQUIRED = localText("error.opencodeLogin");

export function firstMessage(systemPrompt: string, text: string): string {
  return [
    "[lanting group chat rules: they apply to this whole session]",
    systemPrompt.trim(),
    "[End of group chat rules]",
    "",
    text,
  ].join("\n");
}

export class OpenCodeAdapter implements AgentAdapter {
  readonly kind = "opencode";
  readonly closeAfterTurn = true;
  readonly #options: OpenCodeAdapterOptions;
  readonly #catalogCache = new CatalogCache();
  readonly #usage = new Map<string, UsagePart[]>();

  readonly features: AgentFeatures = {
    models: async (cwd, useProxy) => (await this.#catalog(cwd, useProxy)).models,
    permissions: async (cwd, useProxy) => (await this.#catalog(cwd, useProxy)).permissions,
    usage: async ({ nativeId }) => this.#usage.get(nativeId) ?? null,
    deleteSession: async (nativeId, cwd, useProxy) => {
      const client = this.#client(cwd, useProxy);
      try {
        await client.initialize();
        await client.sessionDelete(nativeId);
        this.#usage.delete(nativeId);
      } finally {
        await client.close();
      }
    },
  };

  constructor(options: OpenCodeAdapterOptions) {
    this.#options = options;
  }

  startSession(options: SessionOptions): Promise<AgentSession> {
    return OpenCodeSession.open(null, options, this.#options, (id, usage) => this.#usage.set(id, usage));
  }

  resumeSession(nativeId: string, options: SessionOptions): Promise<AgentSession> {
    return OpenCodeSession.open(nativeId, options, this.#options, (id, usage) => this.#usage.set(id, usage));
  }

  #catalog(cwd: string, useProxy?: boolean): Promise<AgentCatalog> {
    return this.#catalogCache.get(`${cwd}\0${useProxy}`, async () => {
      const { stdout } = await execFileAsync(this.#options.executable, ["api", "--standalone", "GET", "/api/model"], {
        cwd, env: childEnvironment(proxyEnvironment(useProxy)), timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
      });
      return { models: modelOptions(JSON.parse(stdout)), permissions: [...OPENCODE_PERMISSIONS] };
    });
  }

  #client(cwd: string, useProxy?: boolean): OpenCodeAcpClient {
    return new OpenCodeAcpClient({ executable: this.#options.executable, cwd, env: childEnvironment(proxyEnvironment(useProxy)) });
  }
}

type Turn = {
  channel: EventChannel<AgentEvent>;
  segment: string;
  interrupted: boolean;
};

type UsageListener = (sessionId: string, usage: UsagePart[]) => void;

class OpenCodeSession implements AgentSession {
  readonly #client: OpenCodeAcpClient;
  readonly #options: SessionOptions;
  readonly #usage: UsageListener;
  readonly #approvals = new Map<number | string, AbortController>();
  readonly #toolCalls = new Map<string, Record<string, unknown>>();
  #sessionId = "";
  #rulesPending = false;
  #turn: Turn | null = null;

  private constructor(client: OpenCodeAcpClient, options: SessionOptions, usage: UsageListener) {
    this.#client = client;
    this.#options = options;
    this.#usage = usage;
    client.on("update", (payload: OpenCodeUpdate) => this.#onUpdate(payload));
    client.on("permission", (request: OpenCodePermissionRequest) => this.#onPermission(request));
    client.on("exit", () => {
      this.#cancelApprovals();
    });
  }

  static async open(
    sessionId: string | null,
    options: SessionOptions,
    adapter: OpenCodeAdapterOptions,
    usage: UsageListener,
  ): Promise<OpenCodeSession> {
    const client = new OpenCodeAcpClient({
      executable: adapter.executable,
      cwd: options.cwd,
      env: childEnvironment(proxyEnvironment(options.useProxy)),
    });
    const session = new OpenCodeSession(client, options, usage);
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
      if (client.stderrTail.trim()) console.error(`OpenCode stderr: ${client.stderrTail.trim()}`);
      await session.close();
      throw isAuthRequired(error) ? new LocalizedError(LOGIN_REQUIRED) : error;
    }
  }

  get nativeId(): string | null {
    return this.#sessionId || null;
  }

  get alive(): boolean {
    return this.#client.alive;
  }

  async *send(text: string): AsyncIterable<AgentEvent> {
    if (!this.alive) throw new Error("The OpenCode process is closed.");
    if (this.#turn) throw new Error("OpenCode is still handling the previous round.");
    const turn: Turn = { channel: new EventChannel<AgentEvent>(), segment: "", interrupted: false };
    this.#toolCalls.clear();
    this.#turn = turn;
    const prompt = this.#rulesPending ? firstMessage(this.#options.systemPrompt, text) : text;
    this.#rulesPending = false;
    void this.#client.sessionPrompt(this.#sessionId, prompt).then(
      (result) => {
        if (this.#turn !== turn) return;
        const stop = result.stopReason ?? "end_turn";
        if (turn.interrupted || stop === "cancelled") {
          this.#finish({ type: "end", outcome: "interrupted", text: turn.segment });
        } else if (stop === "end_turn") {
          this.#finish({ type: "end", outcome: "completed", text: turn.segment });
        } else {
          this.#finish({ type: "end", outcome: "failed", text: turn.segment, error: `OpenCode ended the round early (${stop}).` });
        }
      },
      (error: unknown) => {
        if (this.#turn !== turn) return;
        this.#finish({
          type: "end",
          outcome: turn.interrupted ? "interrupted" : "failed",
          text: turn.segment,
          ...(turn.interrupted ? {} : isAuthRequired(error)
            ? { error: englishText(LOGIN_REQUIRED), errorText: LOGIN_REQUIRED }
            : { error: errorText(error) }),
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
    this.#cancelApprovals();
    turn.channel.push(event);
    turn.channel.end();
  }

  #onUpdate(payload: OpenCodeUpdate): void {
    if (payload.sessionId !== this.#sessionId) return;
    const update = payload.update;
    const child = objectField(objectField(update._meta)["opencode/child-session"]);
    const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
    if (kind === "usage_update" && !child.id) {
      const used = finiteNumber(update.used);
      const size = finiteNumber(update.size);
      if (used !== null && size !== null && size > 0) {
        this.#usage(this.#sessionId, [{ kind: "context", percent: Math.max(0, Math.min(100, used / size * 100)) }]);
      }
      return;
    }
    const turn = this.#turn;
    if (!turn) return;
    if (kind === "agent_message_chunk" && !child.id) {
      const text = contentText(update.content);
      if (!text) return;
      turn.segment += text;
      turn.channel.push({ type: "text", delta: text });
      return;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      const id = typeof update.toolCallId === "string" ? update.toolCallId : "";
      const previous = id ? this.#toolCalls.get(id) : undefined;
      this.#rememberToolCall(update);
      const toolCall = (id ? this.#toolCalls.get(id) : undefined) ?? update;
      if (objectField(objectField(toolCall._meta)["opencode/child-session"]).id) return;
      if (kind === "tool_call_update") {
        if (previous && JSON.stringify(toolActivity(previous)) !== JSON.stringify(toolActivity(toolCall))) {
          turn.channel.push({ type: "activity.update", toolCallId: id, activity: { ...toolActivity(toolCall), toolCallId: id } });
        }
        return;
      }
      if (turn.segment.trim()) turn.channel.push({ type: "activity", activity: { kind: "note", text: turn.segment } });
      turn.segment = "";
      turn.channel.push({ type: "activity", activity: { ...toolActivity(toolCall), ...(id ? { toolCallId: id } : {}) } });
    }
  }

  #rememberToolCall(update: Record<string, unknown>): void {
    const id = typeof update.toolCallId === "string" ? update.toolCallId : "";
    if (!id) return;
    const previous = this.#toolCalls.get(id) ?? {};
    const merged = { ...previous, ...update };
    // OpenCode first titles a call with the tool's name, then retitles it with a sentence that already holds the
    // arguments ("Reading /path"). Keeping the first title stops the name from repeating the detail line.
    if (typeof previous.title === "string" && previous.title.trim()) merged.title = previous.title;
    const input = inputFromContent(update.content);
    if (input) merged.rawInput = { ...objectField(previous.rawInput), ...objectField(merged.rawInput), ...input };
    this.#toolCalls.set(id, merged);
  }

  #onPermission(request: OpenCodePermissionRequest): void {
    const turn = this.#turn;
    if (request.sessionId !== this.#sessionId || !turn || turn.interrupted) {
      this.#client.respondPermission(request.rpcId, { outcome: "cancelled" });
      return;
    }
    const id = typeof request.toolCall.toolCallId === "string" ? request.toolCall.toolCallId : "";
    const toolCall = { ...(id ? this.#toolCalls.get(id) : {}), ...request.toolCall };
    if (this.#options.settings.permission === ALWAYS_APPROVE) {
      this.#client.respondPermission(request.rpcId, permissionOutcome(request, { decision: "allow", message: "" }));
      return;
    }
    const controller = new AbortController();
    this.#approvals.set(request.rpcId, controller);
    const tool = toolActivity(toolCall);
    const settle = (outcome: OpenCodePermissionOutcome) => {
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

async function applySettings(client: OpenCodeAcpClient, sessionId: string, options: SessionOptions): Promise<void> {
  if (options.settings.model) await client.sessionSetConfigOption(sessionId, "model", options.settings.model);
  if (options.settings.effort) await client.sessionSetConfigOption(sessionId, "effort", options.settings.effort);
}

export function modelOptions(payload: unknown): ModelOption[] {
  const data = objectField(payload).data;
  if (!Array.isArray(data)) throw new Error("OpenCode returned an invalid model catalog.");
  return data.flatMap((entry): ModelOption[] => {
    const model = objectField(entry);
    if (typeof model.id !== "string" || !model.id || typeof model.providerID !== "string" || !model.providerID) return [];
    const variants = Array.isArray(model.variants) ? model.variants.map(objectField)
      .map((variant) => variant.id).filter((id): id is string => typeof id === "string" && !!id) : [];
    const id = `${model.providerID}/${model.id}`;
    return [{ id, label: typeof model.name === "string" && model.name ? model.name : id,
      description: "", efforts: variants }];
  });
}

function permissionOutcome(request: OpenCodePermissionRequest, answer: ApprovalAnswer): OpenCodePermissionOutcome {
  const kind = answer.decision === "allow" ? "allow_once" : "reject_once";
  const option = request.options.find((candidate) => candidate.kind === kind);
  return option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
}

export function toolActivity(toolCall: Record<string, unknown>): { kind: "tool"; detail: string } & ToolName {
  const title = typeof toolCall.title === "string" ? toolCall.title.trim() : "";
  const toolKind = typeof toolCall.kind === "string" ? toolCall.kind : "";
  const input = objectField(toolCall.rawInput);
  const value = (keys: string[]) => keys.map((key) => input[key])
    .find((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)?.trim() ?? "";
  const command = value(["command", "cmd"]);
  const path = value(["path", "file_path", "absolute_path", "file", "directory"]);
  const query = value(["pattern", "query", "regex", "glob"]);
  const child = objectField(objectField(toolCall._meta)["opencode/child-session"]);
  const childLabel = typeof child.title === "string" && child.title.trim() ? child.title.trim()
    : typeof child.id === "string" ? child.id : "";
  const detail = [childLabel, command || [query, path].filter(Boolean).join(" · ")].filter(Boolean)
    .join(": ").replaceAll(/\s+/gu, " ").trim().slice(0, 240);
  if (toolKind === "execute" || title.toLowerCase() === "bash") {
    return { kind: "tool", toolName: "bash", detail };
  }
  return { kind: "tool", ...toolNameOr(title || toolKind, "tool.generic"), detail };
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

function isAuthRequired(error: unknown): boolean {
  return error instanceof OpenCodeRpcError && error.code === AUTH_REQUIRED_CODE && /auth(?:entication)?[ _-]+required/i.test(error.message);
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
