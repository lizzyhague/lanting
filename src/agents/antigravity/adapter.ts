import { proxyEnvironment } from "../proxy.ts";
import type { AgentFeatures, UsagePart, UsageWindow } from "../../features/index.ts";
import { englishText, localText, LocalizedError } from "../../i18n/text.ts";
import { CatalogCache } from "../catalog-cache.ts";
import { EventChannel } from "../event-channel.ts";
import {
  type AgentAdapter,
  type AgentCatalog,
  type AgentEvent,
  type AgentSession,
  type AgentSettings,
  type ApprovalAnswer,
  localizedPermission,
  type ModelOption,
  type PermissionOption,
  type SessionOptions,
  type ToolName,
  toolNameOr,
} from "../types.ts";
import {
  AntigravityAcpClient,
  AntigravityRpcError,
  AUTH_REQUIRED_CODE,
  type AntigravityPermissionOutcome,
  type AntigravityPermissionRequest,
  type AntigravitySessionConfig,
  type AntigravityUpdate,
} from "./acp-client.ts";
import { LOGIN_PROMPT, ResidentAntigravityServer } from "./resident.ts";

export type AntigravityAdapterOptions = {
  executable: string;
  /** Holds the catalog session's id; it is also that session's working directory. */
  stateDirectory: string;
  /** Extra workspace roots passed to group sessions on both session/new and session/resume. */
  additionalDirectories?: readonly string[];
  /** Overrides the resident ACP Server startup timeout; mainly for tests. */
  startupTimeoutMs?: number;
  /** Overrides the model catalog lookup timeout; mainly for tests. */
  catalogTimeoutMs?: number;
  /** Overrides the `/usage` quota prompt timeout; mainly for tests. */
  usageTimeoutMs?: number;
};

type ContextListener = (sessionId: string, percent: number) => void;

/** If the round hasn't ended this long after session/cancel, the Antigravity process is closed outright. */
const INTERRUPT_TIMEOUT_MS = 10_000;

/** If a catalog refresh does not finish this quickly, the resident process is reset so queued requests can proceed. */
const DEFAULT_CATALOG_TIMEOUT_MS = 30_000;

/** If `/usage` does not answer this quickly, the resident process is reset so later requests can restart cleanly. */
const DEFAULT_USAGE_TIMEOUT_MS = 15_000;

/**
 * always-approve doesn't use the Server's own `auto_edit` or `yolo` modes; instead lanting picks a one-time allow for each approval.
 * `allow_always` isn't chosen, so the grant isn't written into Antigravity's session side files.
 */
export const ANTIGRAVITY_PERMISSIONS: readonly PermissionOption[] = [
  localizedPermission({
    id: "ask",
    label: localText("permission.ask"),
    description: localText("permission.antigravity.ask"),
  }),
  localizedPermission({
    id: "always-approve",
    label: "Always approve",
    description: localText("permission.antigravity.alwaysApprove"),
    danger: true,
  }),
];

const ALWAYS_APPROVE = "always-approve";

/** Approvals go to lanting; the Server's permission mode is fixed to default. */
const DEFAULT_MODE = "default";

/**
 * Disables `run_workflow`, whose built-in skill is otherwise materialized into `<cwd>/skills/system/run-workflow/SKILL.md`
 * whenever ACP Server opens or resumes a session. Sent on resume as well so earlier sessions pick up the filter too.
 */
const DISABLED_TOOLS: readonly string[] = ["run_workflow"];

export const LOGIN_REQUIRED = localText("error.antigravityLogin");

/**
 * The system prompt in `_meta` is ignored and `AGENTS.md` in the working directory isn't loaded into context automatically,
 * so the group chat rules can only be sent once, at the start of a new session's first user message; on resume they are already in the session history and aren't sent again.
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

export class AntigravityAdapter implements AgentAdapter {
  readonly kind = "antigravity";
  /** Closes the ACP process after every round and resumes by session id next time, same as Codex, Grok, Pi and Cursor. */
  readonly closeAfterTurn = true;
  /**
   * The ACP Server has no model-list request and no way to delete a session; the model list only comes with `session/new` and `session/resume`,
   * and quota limits come from sending `/usage` to an open session (handled locally by ACP Server before any LLM call).
   * One resident ACP Server process keeps a single empty catalog session open (id saved in the state directory) for both model lookups and `/usage` quota reads.
   * The model and thinking-level choices don't persist across processes, so they are set again with `session/set_config_option` every time a group session opens.
   * Context share comes from the Server's `usage_update` notifications during turns, kept in memory per session; quota limits report Gemini Models only.
   * deleteSession and compact aren't implemented: the ACP Server has no delete-session or compaction API.
   */
  readonly features: AgentFeatures = {
    models: async (_cwd, useProxy) => (await this.#catalog(useProxy)).models,
    permissions: async () => [...ANTIGRAVITY_PERMISSIONS],
    usage: (request) => this.#usage(request.nativeId, request.useProxy),
  };
  readonly #options: AntigravityAdapterOptions;
  readonly #catalogCache = new CatalogCache();
  readonly #contexts = new Map<string, number>();
  readonly #resident: ResidentAntigravityServer;
  readonly #directResident: ResidentAntigravityServer;
  /** Coalesces concurrent quota reads per proxy mode so several usage refreshes share one `/usage` call. */
  readonly #quota = new Map<string, Promise<UsagePart[]>>();
  /** Serializes catalog-session.json creation across proxy and direct residents. */
  #catalogLock: Promise<unknown> = Promise.resolve();

  constructor(options: AntigravityAdapterOptions) {
    this.#options = options;
    const withCatalogLock = <T>(work: () => Promise<T>): Promise<T> => {
      const next = this.#catalogLock.then(work);
      this.#catalogLock = next.catch(() => {});
      return next;
    };
    const residentOptions = (useProxy?: boolean) => ({
      executable: options.executable,
      stateDirectory: options.stateDirectory,
      disabledTools: DISABLED_TOOLS,
      environment: childEnvironment(proxyEnvironment(useProxy)),
      loginError: () => new LocalizedError(LOGIN_REQUIRED),
      withCatalogLock,
      ...(options.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: options.startupTimeoutMs }),
    });
    this.#resident = new ResidentAntigravityServer(residentOptions(undefined));
    this.#directResident = new ResidentAntigravityServer(residentOptions(false));
  }

  start(): void {
    this.#resident.start();
  }

  close(): Promise<void> {
    return Promise.all([this.#resident.close(), this.#directResident.close()]).then(() => {});
  }

  startSession(options: SessionOptions): Promise<AgentSession> {
    return AntigravitySession.open(null, options, this.#options, (id, percent) => this.#contexts.set(id, percent));
  }

  resumeSession(nativeId: string, options: SessionOptions): Promise<AgentSession> {
    return AntigravitySession.open(nativeId, options, this.#options, (id, percent) => this.#contexts.set(id, percent));
  }

  #residentFor(useProxy?: boolean): ResidentAntigravityServer {
    return useProxy === false ? this.#directResident : this.#resident;
  }

  /** The model list doesn't depend on the group's directory; only the proxy choice changes how the Server is reached. */
  #catalog(useProxy?: boolean): Promise<AgentCatalog> {
    return this.#catalogCache.get(String(useProxy), () => this.#readCatalog(useProxy));
  }

  async #readCatalog(useProxy?: boolean): Promise<AgentCatalog> {
    const models = await this.#residentFor(useProxy).run(
      async (handle) => {
        const config = handle.takeFreshConfig() ?? await handle.refreshSession();
        return readModels(handle.client, config);
      },
      {
        timeoutMs: this.#options.catalogTimeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS,
        operation: "model lookup",
      },
    );
    // The Server leaves the list out when it can't list models; failing keeps the empty result out of the cache.
    if (models.length === 0) throw new Error("Antigravity returned no model list.");
    return { models, permissions: [...ANTIGRAVITY_PERMISSIONS] };
  }

  async #usage(nativeId: string, useProxy?: boolean): Promise<UsagePart[]> {
    const key = useProxy === false ? "direct" : "default";
    let pending = this.#quota.get(key);
    if (!pending) {
      pending = this.#readQuota(this.#residentFor(useProxy)).finally(() => {
        if (this.#quota.get(key) === pending) this.#quota.delete(key);
      });
      this.#quota.set(key, pending);
    }
    const quota = await pending;
    return [{ kind: "context", percent: this.#contexts.get(nativeId) ?? null }, ...quota];
  }

  async #readQuota(resident: ResidentAntigravityServer): Promise<UsagePart[]> {
    try {
      const text = await resident.run(
        async (handle) => {
          const chunks: string[] = [];
          const onUpdate = (payload: AntigravityUpdate) => {
            if (payload.sessionId !== handle.sessionId) return;
            if (payload.update.sessionUpdate !== "agent_message_chunk") return;
            const delta = contentText(payload.update.content);
            if (delta) chunks.push(delta);
          };
          handle.client.on("update", onUpdate);
          try {
            await handle.client.sessionPrompt(handle.sessionId, "/usage");
          } finally {
            handle.client.off("update", onUpdate);
          }
          return chunks.join("");
        },
        {
          timeoutMs: this.#options.usageTimeoutMs ?? DEFAULT_USAGE_TIMEOUT_MS,
          operation: "/usage",
        },
      );
      const parts = parseAntigravityQuota(text);
      return parts.length > 0 ? parts : [{ kind: "unavailable" }];
    } catch (error) {
      console.error(`Reading the Antigravity quota failed: ${error instanceof Error ? error.message : String(error)}`);
      return [{ kind: "unavailable" }];
    }
  }
}

type Turn = {
  channel: EventChannel<AgentEvent>;
  /** The current agent_message segment; becomes progress info when the next tool call appears. */
  segment: string;
  /** The group owner has asked to interrupt; the round that ends afterwards counts as interrupted. */
  interrupted: boolean;
};

/**
 * One separate ACP Server subprocess (in its own process group) per native session.
 * The plain reply is the round's last agent_message; earlier interim text becomes progress info.
 */
class AntigravitySession implements AgentSession {
  readonly #client: AntigravityAcpClient;
  readonly #options: SessionOptions;
  readonly #onContext: ContextListener;
  /** Approvals not yet answered on the web page, keyed by the Server's JSON-RPC id. */
  readonly #approvals = new Map<number | string, AbortController>();
  #sessionId = "";
  /** The new session hasn't sent the group chat rules yet. */
  #rulesPending = false;
  /** The Server is already waiting for a browser login; the process is closed right away. */
  #loginRequired = false;
  #turn: Turn | null = null;

  private constructor(client: AntigravityAcpClient, options: SessionOptions, onContext: ContextListener) {
    this.#client = client;
    this.#options = options;
    this.#onContext = onContext;
    client.on("update", (payload: AntigravityUpdate) => this.#onUpdate(payload));
    client.on("permission", (request: AntigravityPermissionRequest) => this.#onPermission(request));
    client.on("diagnostic", () => {
      if (!this.#loginRequired && client.stderrTail.includes(LOGIN_PROMPT)) this.#onLoginRequired();
    });
    client.on("exit", () => {
      this.#cancelApprovals();
      const turn = this.#turn;
      if (!turn) return;
      this.#finish(turn.interrupted
        ? { type: "end", outcome: "interrupted", text: turn.segment }
        : { type: "end", outcome: "failed", text: turn.segment, error: "The Antigravity process exited." });
    });
  }

  static async open(
    sessionId: string | null,
    options: SessionOptions,
    adapter: AntigravityAdapterOptions,
    onContext: ContextListener,
  ): Promise<AntigravitySession> {
    const client = new AntigravityAcpClient({
      executable: adapter.executable,
      cwd: options.cwd,
      env: childEnvironment(proxyEnvironment(options.useProxy)),
    });
    const session = new AntigravitySession(client, options, onContext);
    try {
      await client.initialize();
      const additionalDirectories = adapter.additionalDirectories ?? [];
      const openOptions = { additionalDirectories, disabledTools: DISABLED_TOOLS };
      // resume doesn't replay history, and context is still kept; additionalDirectories must be sent again because ACP clears stored roots when omitted.
      const config = sessionId
        ? await client.sessionResume(sessionId, options.cwd, openOptions)
        : await client.sessionNew(options.cwd, openOptions);
      session.#sessionId = config.sessionId;
      session.#rulesPending = sessionId === null;
      await client.sessionSetMode(session.#sessionId, DEFAULT_MODE);
      await applyModelSettings(client, config, options.settings);
      return session;
    } catch (error) {
      if (client.stderrTail.trim()) console.error(`Antigravity stderr: ${client.stderrTail.trim()}`);
      await session.close();
      throw session.#loginRequired || isAuthRequired(error) ? new LocalizedError(LOGIN_REQUIRED) : error;
    }
  }

  get nativeId(): string | null {
    return this.#sessionId || null;
  }

  get alive(): boolean {
    return this.#client.alive;
  }

  async *send(text: string): AsyncIterable<AgentEvent> {
    if (!this.alive) throw new Error("The Antigravity process is closed.");
    if (this.#turn) throw new Error("Antigravity is still handling the previous round.");
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
          this.#finish({ type: "end", outcome: "failed", text: turn.segment, error: `Antigravity ended the round early (${stop}).` });
        }
      },
      (error: unknown) => {
        const failure = isAuthRequired(error)
          ? { error: englishText(LOGIN_REQUIRED), errorText: LOGIN_REQUIRED }
          : { error: error instanceof Error ? error.message : String(error) };
        this.#finish({
          type: "end",
          outcome: turn.interrupted ? "interrupted" : "failed",
          text: turn.segment,
          ...(turn.interrupted ? {} : failure),
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

  /** Don't wait the 5 minutes: end the round and close the process; open rewrites it as a login notice when opening a session. */
  #onLoginRequired(): void {
    this.#loginRequired = true;
    const turn = this.#turn;
    if (turn) {
      this.#finish({ type: "end", outcome: "failed", text: turn.segment, error: englishText(LOGIN_REQUIRED), errorText: LOGIN_REQUIRED });
    }
    void this.close();
  }

  #onUpdate(payload: AntigravityUpdate): void {
    if (payload.sessionId !== this.#sessionId) return;
    const update = payload.update;
    const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
    if (kind === "usage_update") {
      // For example {"used":11324,"size":1048576}: tokens in context and the context limit.
      const used = finiteNumber(update.used);
      const size = finiteNumber(update.size);
      if (used !== null && size !== null && size > 0) {
        this.#onContext(this.#sessionId, Math.max(0, Math.min(100, used / size * 100)));
      }
      return;
    }
    const turn = this.#turn;
    if (!turn) return;
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

  /** The same command may need approval twice in a row within a round (the model retries after picking the wrong directory); each is handled independently. */
  #onPermission(request: AntigravityPermissionRequest): void {
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
    const settle = (outcome: AntigravityPermissionOutcome) => {
      // A withdrawn approval was already answered cancelled by whoever withdrew it; a late web answer is no longer written back.
      if (this.#approvals.get(request.rpcId) !== controller) return;
      this.#approvals.delete(request.rpcId);
      this.#client.respondPermission(request.rpcId, outcome);
    };
    this.#options.requestApproval({
      ...(tool.toolKey ? { toolName: tool.toolName, toolKey: tool.toolKey } : { toolName: tool.toolName }),
      detail: [tool.detail, workingDirectory(request.toolCall)].filter(Boolean).join("\n"),
    }, controller.signal).then(
      (answer) => settle(permissionOutcome(request, answer)),
      () => settle({ outcome: "cancelled" }),
    );
  }

  /** Withdraw the approvals on the web page and tell the still-running Server those requests were cancelled. */
  #cancelApprovals(): void {
    for (const [rpcId, controller] of this.#approvals) {
      this.#approvals.delete(rpcId);
      controller.abort();
      this.#client.respondPermission(rpcId, { outcome: "cancelled" });
    }
  }
}

/**
 * Picks the one-time allow or reject by kind only, without hard-coding optionId: execute has three options, edit has only two.
 * Never picks allow_always.
 */
function permissionOutcome(request: AntigravityPermissionRequest, answer: ApprovalAnswer): AntigravityPermissionOutcome {
  const kind = answer.decision === "allow" ? "allow_once" : "reject_once";
  const option = request.options.find((candidate) => candidate.kind === kind);
  return option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
}

type SelectChoice = { value: string; name: string; description: string };
type ConfigSelect = { id: string; currentValue: string; choices: SelectChoice[] };

/**
 * ACP Server 1.5.2 groups thinking-level variants into model families and reports `thinking_level` only for the active model.
 * Switching models is local in-memory (the agent is rebuilt on the next turn), so probing each model in the catalog session reads
 * its supported levels and default effort. When a probe changes the active thinking level, the initial selection is restored before
 * probing the next model so each model's default effort matches opening a session with no effort chosen.
 */
async function readModels(client: AntigravityAcpClient, config: AntigravitySessionConfig): Promise<ModelOption[]> {
  const model = modelSelect(config.configOptions);
  if (!model) return [];
  const choices: SelectChoice[] = [];
  const seen = new Set<string>();
  for (const choice of model.choices) {
    if (seen.has(choice.value)) continue;
    seen.add(choice.value);
    choices.push(choice);
  }
  if (choices.length === 0) return [];

  const initialModel = model.currentValue;
  const canRestoreInitial = Boolean(initialModel) && choices.some((choice) => choice.value === initialModel);
  const initialEffort = thinkingSelect(config.configOptions)?.currentValue ?? "";
  let currentModel = initialModel;
  let currentEffort = initialEffort;
  const models: ModelOption[] = [];

  const restoreInitial = async (): Promise<void> => {
    if (!canRestoreInitial || currentModel === initialModel) return;
    let restored = await client.sessionSetConfigOption(config.sessionId, model.id, initialModel);
    const restoredThinking = thinkingSelect(restored);
    if (
      initialEffort
      && restoredThinking
      && restoredThinking.currentValue !== initialEffort
      && restoredThinking.choices.some((item) => item.value === initialEffort)
    ) {
      restored = await client.sessionSetConfigOption(config.sessionId, restoredThinking.id, initialEffort);
    }
    currentModel = initialModel;
    currentEffort = thinkingSelect(restored)?.currentValue ?? "";
  };

  for (const choice of choices) {
    if (choice.value === initialModel) {
      models.push(modelOption(choice, config.configOptions));
      continue;
    }
    if (currentModel !== initialModel && currentEffort !== initialEffort) {
      await restoreInitial();
    }
    const updated = await client.sessionSetConfigOption(config.sessionId, model.id, choice.value);
    currentModel = choice.value;
    currentEffort = thinkingSelect(updated)?.currentValue ?? "";
    models.push(modelOption(choice, updated));
  }
  // Leave the resident catalog session on its initial selection so a later warm session/resume starts from the same defaults.
  await restoreInitial();
  return models;
}

const MONTH_INDEX: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/**
 * Parses Gemini quota windows from ACP Server's `/usage` markdown reply.
 * Only buckets under the Gemini model group are kept; Claude/GPT quotas and other sections are ignored.
 * Timed windows are sorted shortest first so five-hour limits appear before weekly limits.
 */
export function parseAntigravityQuota(markdown: string): UsagePart[] {
  const parts: Extract<UsagePart, { kind: "quota" }>[] = [];
  let inQuotaSection = false;
  let inGeminiGroup = false;

  for (const rawLine of markdown.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    const heading = trimmed.match(/^#{1,6}\s+(.+)$/u);
    if (heading) {
      inQuotaSection = heading[1]!.trim().toLowerCase() === "quota limits";
      inGeminiGroup = false;
      continue;
    }
    if (!inQuotaSection) continue;

    const topBullet = rawLine.match(/^-\s+(.+)$/u);
    if (topBullet) {
      const groupName = topBullet[1]!.replaceAll("**", "").trim();
      inGeminiGroup = /\bgemini\b/iu.test(groupName);
      continue;
    }
    if (!inGeminiGroup) continue;

    const bucket = rawLine.match(/^\s+-\s+\*\*(.+?)\*\*\s*(.*)$/u);
    if (!bucket) continue;
    const label = bucket[1]!.replace(/:$/u, "").trim();
    const value = bucket[2]!.replace(/^:\s*/u, "").trim();
    const quota = value.match(/^(\d+(?:\.\d+)?)%\s+remaining(?:\s*\(resets\s+(.+?)\))?/iu);
    if (!quota) continue;
    const remaining = Number(quota[1]);
    if (!Number.isFinite(remaining)) continue;
    const resetsAt = quota[2] ? parseQuotaResetTime(quota[2]) : undefined;
    parts.push({
      kind: "quota",
      window: parseQuotaWindow(label),
      left: Math.max(0, Math.min(100, remaining)),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }

  parts.sort((a, b) => {
    const aMin = a.window.minutes;
    const bMin = b.window.minutes;
    if (aMin !== undefined && bMin !== undefined) return aMin - bMin;
    if (aMin !== undefined) return -1;
    if (bMin !== undefined) return 1;
    return 0;
  });
  return parts;
}

function parseQuotaWindow(label: string): UsageWindow {
  const cleaned = label
    .replace(/\b(?:limit|quota|remaining|usage)\b/giu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const normalized = cleaned.toLowerCase();
  if (normalized === "five hour" || normalized === "5 hour" || normalized === "5-hour" || normalized === "5h") {
    return { minutes: 300 };
  }
  if (normalized === "weekly" || normalized === "7 day" || normalized === "7-day" || normalized === "7d") {
    return { minutes: 10_080 };
  }
  if (normalized === "daily" || normalized === "24 hour" || normalized === "24-hour" || normalized === "1 day" || normalized === "1-day") {
    return { minutes: 1_440 };
  }
  if (normalized === "hourly" || normalized === "1 hour" || normalized === "1-hour" || normalized === "1h") {
    return { minutes: 60 };
  }
  const duration = normalized.match(/^(\d+)\s*-?\s*(minute|min|hour|hr|day|week)s?$/u);
  if (duration) {
    const count = Number(duration[1]);
    const unit = duration[2];
    if (Number.isFinite(count) && count > 0) {
      const multiplier = unit === "week" ? 10_080
        : unit === "day" ? 1_440
          : unit === "hour" || unit === "hr" ? 60
            : 1;
      return { minutes: count * multiplier };
    }
  }
  return { name: cleaned || label };
}

/** Parses ACP Server's `%b %d, %Y, %H:%M UTC` reset timestamp or an ISO-8601 fallback into an ISO UTC string. */
function parseQuotaResetTime(raw: string): string | undefined {
  const trimmed = raw.trim();
  const utc = trimmed.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4}),\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s+UTC$/iu);
  if (utc) {
    const month = MONTH_INDEX[utc[1]!.toLowerCase()];
    const day = Number(utc[2]);
    const year = Number(utc[3]);
    const hour = Number(utc[4]);
    const minute = Number(utc[5]);
    const second = utc[6] ? Number(utc[6]) : 0;
    if (month === undefined) return undefined;
    const date = new Date(Date.UTC(year, month, day, hour, minute, second));
    if (
      date.getUTCFullYear() !== year
      || date.getUTCMonth() !== month
      || date.getUTCDate() !== day
      || date.getUTCHours() !== hour
      || date.getUTCMinutes() !== minute
      || date.getUTCSeconds() !== second
    ) {
      return undefined;
    }
    return date.toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/u.test(trimmed)) {
    const date = new Date(trimmed);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return undefined;
}

/**
 * Applies the group's model and thinking-level settings to an opened or resumed session.
 * A model or thinking level the session doesn't offer fails the session instead of quietly running another one.
 */
async function applyModelSettings(
  client: AntigravityAcpClient,
  config: AntigravitySessionConfig,
  settings: AgentSettings,
): Promise<void> {
  if (!settings.model) return;
  const model = modelSelect(config.configOptions);
  if (!model || !model.choices.some((choice) => choice.value === settings.model)) {
    throw unavailableModelError(settings);
  }
  const activeConfig = settings.model === model.currentValue
    ? config.configOptions
    : await client.sessionSetConfigOption(config.sessionId, model.id, settings.model);
  if (!settings.effort) return;
  const thinking = thinkingSelect(activeConfig);
  if (!thinking || !thinking.choices.some((choice) => choice.value === settings.effort)) {
    throw unavailableModelError(settings);
  }
  if (settings.effort !== thinking.currentValue) {
    await client.sessionSetConfigOption(config.sessionId, thinking.id, settings.effort);
  }
}

function unavailableModelError(settings: AgentSettings): Error {
  return new Error(`Antigravity doesn't offer the model ${settings.model}${settings.effort ? ` (${settings.effort})` : ""} in this session.`);
}

function modelOption(choice: SelectChoice, configOptions: unknown[]): ModelOption {
  const thinking = thinkingSelect(configOptions);
  const efforts = thinking ? [...new Set(thinking.choices.map((item) => item.value))] : [];
  const defaultEffort = thinking && efforts.includes(thinking.currentValue) ? thinking.currentValue : "";
  return {
    id: choice.value,
    label: choice.name || choice.value,
    description: choice.description,
    efforts,
    ...(defaultEffort ? { defaultEffort } : {}),
  };
}

function modelSelect(configOptions: unknown[]): ConfigSelect | null {
  return selectOption(configOptions, "model", "model");
}

function thinkingSelect(configOptions: unknown[]): ConfigSelect | null {
  return selectOption(configOptions, "thinking_level", "thought_level");
}

function selectOption(configOptions: unknown[], id: string, category: string): ConfigSelect | null {
  const entries = configOptions.map(objectField);
  const entry = entries.find((candidate) => candidate.id === id)
    ?? entries.find((candidate) => candidate.category === category);
  if (!entry || typeof entry.id !== "string" || !entry.id) return null;
  const rawOptions = Array.isArray(entry.options)
    ? entry.options.map(objectField).flatMap((item) => Array.isArray(item.options) ? item.options.map(objectField) : [item])
    : [];
  const choices = rawOptions.flatMap((option) =>
    typeof option.value === "string" && option.value
      ? [{
        value: option.value,
        name: typeof option.name === "string" ? option.name.trim() : "",
        description: typeof option.description === "string" ? option.description : "",
      }]
      : []);
  return { id: entry.id, currentValue: typeof entry.currentValue === "string" ? entry.currentValue : "", choices };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isAuthRequired(error: unknown): boolean {
  return error instanceof AntigravityRpcError && error.code === AUTH_REQUIRED_CODE;
}

/**
 * Condenses an ACP tool_call into one line of progress info. For execute, the title is the command, the tool name is always bash, and the command goes into the details;
 * for edit and read, the title is a description like "Run create_file?" and the path is in rawInput or locations.
 */
export function toolActivity(toolCall: Record<string, unknown>): { kind: "tool"; detail: string } & ToolName {
  const toolKind = typeof toolCall.kind === "string" ? toolCall.kind : "";
  const title = typeof toolCall.title === "string" ? toolCall.title.trim() : "";
  const input = objectField(toolCall.rawInput);
  const locations = Array.isArray(toolCall.locations) ? toolCall.locations : [];
  const detail = [
    ...["CommandLine", "TargetFile", "absolute_path", "file_path", "path"].map((key) => input[key]),
    objectField(locations[0]).path,
  ].find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? "";
  if (toolKind === "execute") {
    return { kind: "tool", toolName: "bash", detail: (detail || title).replaceAll(/\s+/gu, " ").trim().slice(0, 240) };
  }
  return {
    kind: "tool",
    ...toolNameOr(title || toolKind, "tool.generic"),
    detail: detail.trim() === title ? "" : detail.replaceAll(/\s+/gu, " ").trim().slice(0, 240),
  };
}

/** Execute approvals carry the command's working directory. The model may fill in a directory outside the workspace; it is shown as-is, not blocked separately. */
function workingDirectory(toolCall: Record<string, unknown>): string {
  const cwd = objectField(toolCall.rawInput).Cwd;
  return typeof cwd === "string" && cwd.trim() ? `Working directory: ${cwd.trim()}` : "";
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
 * The CLI has no use for the web login token; keeping it would only give every tool subprocess control of the web side.
 * Claude's long-lived OAuth token isn't handed to other CLIs or their tool subprocesses either.
 * TERM and BROWSER are removed: with them the Server may try to open a browser or print web content to stdout; probing removes them too.
 */
function childEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child = { ...environment };
  delete child.ACCESS_TOKEN;
  delete child.CLAUDE_CODE_OAUTH_TOKEN;
  delete child.TERM;
  delete child.BROWSER;
  return child;
}
