import { readFile } from "node:fs/promises";
import path from "node:path";

import { proxyEnvironment } from "../proxy.ts";
import type { AgentFeatures, UsagePart } from "../../features/index.ts";
import { englishText, localText, LocalizedError } from "../../i18n/text.ts";
import { ensurePrivateDirectory, isMissingFile, writeJsonAtomically } from "../../state/atomic-json.ts";
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

export type AntigravityAdapterOptions = {
  executable: string;
  /** Holds the catalog session's id; it is also that session's working directory. */
  stateDirectory: string;
  /** Extra workspace roots passed to group sessions on both session/new and session/resume. */
  additionalDirectories?: readonly string[];
};

/** Stores the id of the one session used only to read the model list. */
const CATALOG_SESSION_FILE = "catalog-session.json";

/** ACP resource_not_found: session/resume found no saved session with that id (server.py `_restore_session`, 1.5.2). */
const SESSION_NOT_FOUND_CODE = -32002;

type UsageListener = (sessionId: string, usage: UsagePart[]) => void;

/** If the round hasn't ended this long after session/cancel, the Antigravity process is closed outright. */
const INTERRUPT_TIMEOUT_MS = 10_000;

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
 * When credentials expire and can't be refreshed silently, the Server doesn't error; it prints this authorization URL line on stderr and waits up to 5 minutes for a browser callback.
 * The callback must reach the server machine itself, which the group owner on the web page can't complete, so the round ends when this line appears.
 */
const LOGIN_PROMPT = "Open the following link to authenticate the ACP server";

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
   * The ACP Server has no model-list request and no way to delete a session; the list only comes with `session/new` and `session/resume`.
   * So models come from one catalog session that is created once, its id saved in the state directory, and resumed for each lookup.
   * The model and thinking-level choices don't persist across processes, so they are set again with `session/set_config_option` every time a session opens.
   * usage is the context share from the Server's `usage_update`, kept in memory per session; there is no data before a session's first round.
   * deleteSession and compact aren't implemented: the ACP Server has no delete-session or compaction API.
   */
  readonly features: AgentFeatures = {
    models: async (_cwd, useProxy) => (await this.#catalog(useProxy)).models,
    permissions: async () => [...ANTIGRAVITY_PERMISSIONS],
    usage: async ({ nativeId }) => this.#usage.get(nativeId) ?? null,
  };
  readonly #options: AntigravityAdapterOptions;
  readonly #catalogCache = new CatalogCache();
  readonly #usage = new Map<string, UsagePart[]>();
  /** Catalog lookups run one at a time, so concurrent lookups never create two catalog sessions. */
  #catalogQueue: Promise<unknown> = Promise.resolve();

  constructor(options: AntigravityAdapterOptions) {
    this.#options = options;
  }

  startSession(options: SessionOptions): Promise<AgentSession> {
    return AntigravitySession.open(null, options, this.#options, (id, usage) => this.#usage.set(id, usage));
  }

  resumeSession(nativeId: string, options: SessionOptions): Promise<AgentSession> {
    return AntigravitySession.open(nativeId, options, this.#options, (id, usage) => this.#usage.set(id, usage));
  }

  /** The model list doesn't depend on the group's directory; only the proxy choice changes how the Server is reached. */
  #catalog(useProxy?: boolean): Promise<AgentCatalog> {
    return this.#catalogCache.get(String(useProxy), () => {
      const next = this.#catalogQueue.then(() => this.#readCatalog(useProxy));
      this.#catalogQueue = next.catch(() => {});
      return next;
    });
  }

  async #readCatalog(useProxy?: boolean): Promise<AgentCatalog> {
    const directory = this.#options.stateDirectory;
    await ensurePrivateDirectory(directory);
    const file = path.join(directory, CATALOG_SESSION_FILE);
    const stored = await readCatalogSessionId(file);
    const client = new AntigravityAcpClient({
      executable: this.#options.executable,
      cwd: directory,
      env: childEnvironment(proxyEnvironment(useProxy)),
    });
    let loginRequired = false;
    client.on("diagnostic", () => {
      if (loginRequired || !client.stderrTail.includes(LOGIN_PROMPT)) return;
      // Don't wait out the 5-minute login; closing rejects the pending request.
      loginRequired = true;
      void client.close();
    });
    try {
      await client.initialize();
      let config: AntigravitySessionConfig | null = null;
      if (stored) {
        try {
          config = await client.sessionResume(stored, directory);
        } catch (error) {
          // Only a session the Server confirms is gone is replaced. Any other failure keeps the saved id and fails this lookup,
          // so a passing error never leaves an unreachable empty session behind.
          if (!(error instanceof AntigravityRpcError) || error.code !== SESSION_NOT_FOUND_CODE) throw error;
        }
      }
      if (!config) {
        config = await client.sessionNew(directory);
        await writeJsonAtomically(file, { sessionId: config.sessionId });
      }
      const models = await readModels(client, config);
      // The Server leaves the list out when it can't list models; failing keeps the empty result out of the cache.
      if (models.length === 0) throw new Error("Antigravity returned no model list.");
      return { models, permissions: [...ANTIGRAVITY_PERMISSIONS] };
    } catch (error) {
      if (client.stderrTail.trim()) console.error(`Antigravity stderr: ${client.stderrTail.trim()}`);
      throw loginRequired || isAuthRequired(error) ? new LocalizedError(LOGIN_REQUIRED) : error;
    } finally {
      await client.close();
    }
  }
}

/**
 * Only a missing file means there is no catalog session yet. A file that can't be read or has no session id fails the lookup
 * and is left as it is, rather than being overwritten by a new session.
 */
async function readCatalogSessionId(file: string): Promise<string | null> {
  // Reads the file itself: readJsonIfPresent also returns null for a file whose content is JSON null.
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`State file is not valid JSON: ${file}`, { cause: error });
  }
  const sessionId = typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as { sessionId?: unknown }).sessionId
    : undefined;
  if (typeof sessionId !== "string" || !sessionId) throw new Error(`State file has no session id: ${file}`);
  return sessionId;
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
  readonly #usage: UsageListener;
  /** Approvals not yet answered on the web page, keyed by the Server's JSON-RPC id. */
  readonly #approvals = new Map<number | string, AbortController>();
  #sessionId = "";
  /** The new session hasn't sent the group chat rules yet. */
  #rulesPending = false;
  /** The Server is already waiting for a browser login; the process is closed right away. */
  #loginRequired = false;
  #turn: Turn | null = null;

  private constructor(client: AntigravityAcpClient, options: SessionOptions, usage: UsageListener) {
    this.#client = client;
    this.#options = options;
    this.#usage = usage;
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
    usage: UsageListener,
  ): Promise<AntigravitySession> {
    const client = new AntigravityAcpClient({
      executable: adapter.executable,
      cwd: options.cwd,
      env: childEnvironment(proxyEnvironment(options.useProxy)),
    });
    const session = new AntigravitySession(client, options, usage);
    try {
      await client.initialize();
      const additionalDirectories = adapter.additionalDirectories ?? [];
      // resume doesn't replay history, and context is still kept; additionalDirectories must be sent again because ACP clears stored roots when omitted.
      const config = sessionId
        ? await client.sessionResume(sessionId, options.cwd, additionalDirectories)
        : await client.sessionNew(options.cwd, additionalDirectories);
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
        this.#usage(this.#sessionId, [{ kind: "context", percent: Math.max(0, Math.min(100, used / size * 100)) }]);
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

  for (const choice of choices) {
    if (choice.value === initialModel) {
      models.push(modelOption(choice, config.configOptions));
      continue;
    }
    if (canRestoreInitial && currentModel !== initialModel && currentEffort !== initialEffort) {
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
    }
    const updated = await client.sessionSetConfigOption(config.sessionId, model.id, choice.value);
    currentModel = choice.value;
    currentEffort = thinkingSelect(updated)?.currentValue ?? "";
    models.push(modelOption(choice, updated));
  }
  return models;
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
