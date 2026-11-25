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
  KiroAcpClient,
  KiroRpcError,
  type KiroPermissionOutcome,
  type KiroPermissionRequest,
  type KiroSessionConfig,
  type KiroUpdate,
} from "./acp-client.ts";
import { ResidentKiroServer } from "./resident.ts";

export type KiroAdapterOptions = {
  executable: string;
  /** How long one account usage read may take before its resident process is reset; tests shorten it. */
  usageTimeoutMs?: number;
  /** Overrides the resident ACP server startup timeout; mainly for tests. */
  startupTimeoutMs?: number;
};

const INTERRUPT_TIMEOUT_MS = 10_000;
const USAGE_TIMEOUT_MS = 15_000;
const ALWAYS_APPROVE = "always-approve";
const DEFAULT_MODE = "vibe";
const HUMAN_TOOL_NAMES = ["askuserquestion", "askuser", "requestuserinput", "elicitation"];

export const KIRO_PERMISSIONS: readonly PermissionOption[] = [
  localizedPermission({
    id: "ask",
    label: localText("permission.ask"),
    description: localText("permission.kiro.ask"),
  }),
  localizedPermission({
    id: ALWAYS_APPROVE,
    label: "Always approve",
    description: localText("permission.kiro.alwaysApprove"),
    danger: true,
  }),
];

export const LOGIN_REQUIRED = localText("error.kiroLogin");

export function firstMessage(systemPrompt: string, text: string): string {
  return [
    "[lanting group chat rules: they apply to this whole session]",
    systemPrompt.trim(),
    "[End of group chat rules]",
    "",
    text,
  ].join("\n");
}

export class KiroAdapter implements AgentAdapter {
  readonly kind = "kiro";
  readonly closeAfterTurn = true;
  readonly #options: KiroAdapterOptions;
  readonly #catalogCache = new CatalogCache();
  readonly #usage = new Map<string, UsagePart[]>();
  readonly #resident: ResidentKiroServer;
  readonly #directResident: ResidentKiroServer;
  /** Only one account usage read per proxy choice is in flight at a time; concurrent calls share it. */
  readonly #quota = new Map<string, Promise<UsagePart[]>>();

  readonly features: AgentFeatures = {
    models: async (cwd, useProxy) => (await this.#catalog(cwd, useProxy)).models,
    permissions: async (cwd, useProxy) => (await this.#catalog(cwd, useProxy)).permissions,
    usage: ({ nativeId, useProxy }) => this.#readUsage(nativeId, useProxy),
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

  constructor(options: KiroAdapterOptions) {
    this.#options = options;
    const residentOptions = (useProxy?: boolean) => ({
      executable: options.executable,
      environment: () => childEnvironment(proxyEnvironment(useProxy)),
      ...(options.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: options.startupTimeoutMs }),
    });
    this.#resident = new ResidentKiroServer(residentOptions(undefined));
    this.#directResident = new ResidentKiroServer(residentOptions(false));
  }

  start(): void {
    this.#resident.start();
  }

  close(): Promise<void> {
    return Promise.all([this.#resident.close(), this.#directResident.close()]).then(() => {});
  }

  startSession(options: SessionOptions): Promise<AgentSession> {
    return KiroSession.open(null, options, this.#options, (id, usage) => this.#usage.set(id, usage));
  }

  resumeSession(nativeId: string, options: SessionOptions): Promise<AgentSession> {
    return KiroSession.open(nativeId, options, this.#options, (id, usage) => this.#usage.set(id, usage));
  }

  #residentFor(useProxy?: boolean): ResidentKiroServer {
    return useProxy === false ? this.#directResident : this.#resident;
  }

  #catalog(cwd: string, useProxy?: boolean): Promise<AgentCatalog> {
    return this.#catalogCache.get(`${cwd}\0${useProxy}`, async () => {
      const client = this.#client(cwd, useProxy);
      let sessionId: string | null = null;
      try {
        await client.initialize();
        const config = await client.sessionNew(cwd);
        sessionId = config.sessionId;
        await applyBaseSettings(client, config.sessionId);
        const catalog = await client.waitForModelConfig(config);
        return { models: modelOptions(catalog), permissions: [...KIRO_PERMISSIONS] };
      } catch (error) {
        throw isAuthRequired(error) ? new LocalizedError(LOGIN_REQUIRED) : error;
      } finally {
        if (sessionId) await client.sessionDelete(sessionId).catch(() => {});
        await client.close();
      }
    });
  }

  #client(cwd: string, useProxy?: boolean): KiroAcpClient {
    return new KiroAcpClient({ executable: this.#options.executable, cwd, env: childEnvironment(proxyEnvironment(useProxy)) });
  }

  /** Context comes from the session's own updates; the account quota is read fresh from the resident server, as Codex does. */
  async #readUsage(nativeId: string, useProxy?: boolean): Promise<UsagePart[]> {
    const key = useProxy === false ? "direct" : "default";
    let quota = this.#quota.get(key);
    if (!quota) {
      quota = this.#readQuota(this.#residentFor(useProxy)).finally(() => {
        if (this.#quota.get(key) === quota) this.#quota.delete(key);
      });
      this.#quota.set(key, quota);
    }
    const parts = await quota;
    const context = this.#usage.get(nativeId) ?? [{ kind: "context", percent: null }];
    return [...context, ...parts];
  }

  /**
   * Reads `_kiro/account/getUsage` on the resident ACP server without opening a session or sending a prompt.
   * Kiro 3.3+ answers this method without listing it in its advertised extension methods.
   */
  async #readQuota(resident: ResidentKiroServer): Promise<UsagePart[]> {
    try {
      const response = await resident.request("_kiro/account/getUsage", {}, {
        timeoutMs: this.#options.usageTimeoutMs ?? USAGE_TIMEOUT_MS,
      });
      const parts = accountUsageParts(response);
      return parts.length ? parts : [{ kind: "unavailable" }];
    } catch (error) {
      console.error(`Reading the Kiro account usage failed: ${errorText(error)}`);
      return [{ kind: "unavailable" }];
    }
  }
}

/**
 * The plan's limited breakdowns are shown as credits left of the limit, resetting on the billing date. Bonus and
 * add-on credits follow one by one; entries with nothing left are left out.
 */
export function accountUsageParts(response: unknown): UsagePart[] {
  const data = objectField(objectField(response).data);
  const resetsOn = typeof data.billingCycleReset === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(data.billingCycleReset)
    ? data.billingCycleReset : null;
  const list = (value: unknown) => Array.isArray(value) ? value.map(objectField) : [];
  const parts: UsagePart[] = list(data.usageBreakdowns).flatMap((breakdown): UsagePart[] => {
    const used = finiteNumber(breakdown.used);
    const limit = finiteNumber(breakdown.limit);
    if (breakdown.hasLimit === false || used === null || limit === null || limit <= 0) return [];
    const name = typeof breakdown.displayName === "string" && breakdown.displayName.trim()
      ? breakdown.displayName.trim() : "Kiro";
    return [{ kind: "credits", name, left: Math.max(0, limit - used), total: limit, ...(resetsOn ? { resetsOn } : {}) }];
  });
  for (const entry of [...list(data.bonusCredits), ...list(data.addOnCredits)]) {
    const total = finiteNumber(entry.total);
    const used = finiteNumber(entry.used) ?? 0;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name || total === null || total - used <= 0) continue;
    const days = finiteNumber(entry.daysUntilExpiry);
    parts.push({ kind: "credits", name, left: total - used, total, ...(days !== null && days >= 0 ? { expiresInDays: days } : {}) });
  }
  return parts;
}

type Turn = {
  channel: EventChannel<AgentEvent>;
  segment: string;
  interrupted: boolean;
};

type UsageListener = (sessionId: string, usage: UsagePart[]) => void;

class KiroSession implements AgentSession {
  readonly #client: KiroAcpClient;
  readonly #options: SessionOptions;
  readonly #usage: UsageListener;
  readonly #approvals = new Map<number | string, AbortController>();
  readonly #toolCalls = new Map<string, Record<string, unknown>>();
  readonly #openingUsage = new Map<string, UsagePart[]>();
  #sessionId = "";
  #rulesPending = false;
  #turn: Turn | null = null;

  private constructor(client: KiroAcpClient, options: SessionOptions, usage: UsageListener) {
    this.#client = client;
    this.#options = options;
    this.#usage = usage;
    client.on("update", (payload: KiroUpdate) => this.#onUpdate(payload));
    client.on("permission", (request: KiroPermissionRequest) => this.#onPermission(request));
    client.on("exit", () => {
      this.#cancelApprovals();
      const turn = this.#turn;
      if (!turn) return;
      this.#finish(turn.interrupted
        ? { type: "end", outcome: "interrupted", text: turn.segment }
        : { type: "end", outcome: "failed", text: turn.segment, error: "The Kiro process exited." });
    });
  }

  static async open(
    sessionId: string | null,
    options: SessionOptions,
    adapter: KiroAdapterOptions,
    usage: UsageListener,
  ): Promise<KiroSession> {
    const client = new KiroAcpClient({
      executable: adapter.executable,
      cwd: options.cwd,
      env: childEnvironment(proxyEnvironment(options.useProxy)),
    });
    const session = new KiroSession(client, options, usage);
    try {
      await client.initialize();
      const config = sessionId
        ? await client.sessionLoad(sessionId, options.cwd)
        : await client.sessionNew(options.cwd);
      session.#sessionId = config.sessionId;
      const openingUsage = session.#openingUsage.get(config.sessionId);
      if (openingUsage) usage(config.sessionId, openingUsage);
      session.#openingUsage.clear();
      session.#rulesPending = sessionId === null;
      await client.waitForModelConfig(config);
      await applySettings(client, config.sessionId, options);
      return session;
    } catch (error) {
      if (client.stderrTail.trim()) console.error(`Kiro stderr: ${client.stderrTail.trim()}`);
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
    if (!this.alive) throw new Error("The Kiro process is closed.");
    if (this.#turn) throw new Error("Kiro is still handling the previous round.");
    const turn: Turn = { channel: new EventChannel<AgentEvent>(), segment: "", interrupted: false };
    this.#toolCalls.clear();
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
          this.#finish({ type: "end", outcome: "failed", text: turn.segment, error: `Kiro ended the round early (${stop}).` });
        }
      },
      (error: unknown) => {
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
    turn.channel.push(event);
    turn.channel.end();
  }

  #onUpdate(payload: KiroUpdate): void {
    const update = payload.update;
    const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
    const insideSubagent = isInsideSubagent(update);
    if (kind === "session_info_update") {
      if (insideSubagent) return;
      const kiro = objectField(objectField(update._meta).kiro);
      const percent = finiteNumber(objectField(kiro.contextUsage).usagePercentage);
      if (percent !== null) {
        const usage: UsagePart[] = [{ kind: "context", percent: Math.max(0, Math.min(100, percent)) }];
        if (!this.#sessionId && payload.sessionId) {
          // Session notifications can arrive in the same stdout chunk as the creation response.
          this.#openingUsage.set(payload.sessionId, usage);
        } else if (payload.sessionId === this.#sessionId) {
          this.#usage(this.#sessionId, usage);
        }
      }
      return;
    }
    if (payload.sessionId !== this.#sessionId) return;
    const turn = this.#turn;
    if (!turn) return;
    if (kind === "agent_message_chunk") {
      if (insideSubagent) return;
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
      // A sub-agent's own tool calls stay remembered for approval details but are not shown.
      if (insideSubagent) return;
      const toolCall = (id ? this.#toolCalls.get(id) : undefined) ?? update;
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
    const input = inputFromContent(update.content);
    if (input) merged.rawInput = { ...objectField(previous.rawInput), ...objectField(merged.rawInput), ...input };
    this.#toolCalls.set(id, merged);
  }

  #onPermission(request: KiroPermissionRequest): void {
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
    const settle = (outcome: KiroPermissionOutcome) => {
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

async function applySettings(client: KiroAcpClient, sessionId: string, options: SessionOptions): Promise<void> {
  await applyBaseSettings(client, sessionId);
  if (options.settings.model) await client.sessionSetConfigOption(sessionId, "model", options.settings.model);
  if (options.settings.effort) await client.sessionSetConfigOption(sessionId, "effortLevel", options.settings.effort);
}

async function applyBaseSettings(client: KiroAcpClient, sessionId: string): Promise<void> {
  await client.sessionSetConfigOption(sessionId, "mode", DEFAULT_MODE);
  await client.sessionSetConfigOption(sessionId, "autopilot", "off");
  await client.sessionSetConfigOption(sessionId, "contentCollection", "disabled");
}

export function modelOptions(config: KiroSessionConfig): ModelOption[] {
  const entry = config.configOptions.map(objectField).find((option) => option.id === "model");
  if (!entry || !Array.isArray(entry.options)) return [];
  return entry.options.map(objectField).flatMap((option) => {
    if (typeof option.value !== "string") return [];
    const meta = objectField(objectField(option._meta).kiro);
    const efforts = meta.hasEffort === true && Array.isArray(meta.effortLevels)
      ? meta.effortLevels.filter((value): value is string => typeof value === "string") : [];
    const defaultEffort = typeof meta.defaultEffortLevel === "string" && efforts.includes(meta.defaultEffortLevel)
      ? meta.defaultEffortLevel : null;
    return [{
      id: option.value,
      label: typeof option.name === "string" && option.name ? option.name : option.value,
      description: typeof option.description === "string" ? option.description : "",
      efforts,
      ...(defaultEffort ? { defaultEffort } : {}),
    }];
  });
}

/**
 * Kiro tags everything a sub-agent produces with `_meta.kiro.agentSubtaskId`. The parent's own call that
 * starts the sub-agent carries the same id plus `kind: "agent-subtask"`; only that call is kept.
 */
function isInsideSubagent(update: Record<string, unknown>): boolean {
  const kiro = objectField(objectField(update._meta).kiro);
  return typeof kiro.agentSubtaskId === "string" && kiro.agentSubtaskId !== "" && kiro.kind !== "agent-subtask";
}

function permissionOutcome(request: KiroPermissionRequest, answer: ApprovalAnswer): KiroPermissionOutcome {
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
  const detail = (command || [query, path].filter(Boolean).join(" · ")).replaceAll(/\s+/gu, " ").trim().slice(0, 240);
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

function isHumanRequired(toolCall: Record<string, unknown>): boolean {
  const title = typeof toolCall.title === "string" ? toolCall.title.toLowerCase().replaceAll(/[^a-z0-9]/gu, "") : "";
  return HUMAN_TOOL_NAMES.some((name) => title.includes(name));
}

function isAuthRequired(error: unknown): boolean {
  return error instanceof KiroRpcError && error.code === AUTH_REQUIRED_CODE &&
    /authentication required|not logged in/iu.test(error.message);
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
