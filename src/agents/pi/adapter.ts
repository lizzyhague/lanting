import type { AgentFeatures } from "../../features/index.ts";
import { localText } from "../../i18n/text.ts";
import { CatalogCache } from "../catalog-cache.ts";
import { EventChannel } from "../event-channel.ts";
import {
  type AgentAdapter,
  type AgentCatalog,
  type AgentEvent,
  type AgentSession,
  localizedPermission,
  type ModelOption,
  type PermissionOption,
  type SessionOptions,
  type ToolName,
  toolNameOr,
} from "../types.ts";
import { PiRpcClient, type PiEvent, type PiUiRequest } from "./rpc-client.ts";

export type PiAdapterOptions = {
  executable: string;
};

/** If the round hasn't settled this long after abort, the Pi process is closed outright. */
const INTERRUPT_TIMEOUT_MS = 10_000;

/**
 * Approvals are handled by the pi-minimal-permission-system extension, which only covers read, edit, write and bash;
 * its rules live in Pi's own user config. always-approve doesn't use the extension's yolo; instead lanting
 * answers "allow" on behalf of the group owner, so deny rules still apply.
 */
export const PI_PERMISSIONS: readonly PermissionOption[] = [
  localizedPermission({
    id: "ask",
    label: localText("permission.ask"),
    description: localText("permission.pi.ask"),
  }),
  localizedPermission({
    id: "always-approve",
    label: "Always approve",
    description: localText("permission.pi.alwaysApprove"),
    danger: true,
  }),
];

const ALWAYS_APPROVE = "always-approve";

/** Pi's thinking levels, in the same order as Pi's EXTENDED_THINKING_LEVELS. */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export class PiAdapter implements AgentAdapter {
  readonly kind = "pi";
  /** Closes the RPC process after every round and resumes from the session file next time, same as Codex and Grok. */
  readonly closeAfterTurn = true;
  readonly features: AgentFeatures = {
    compact: (session) => asOwnSession(session).compact(),
    models: async (cwd) => (await this.#catalog(cwd)).models,
    permissions: async (cwd) => (await this.#catalog(cwd)).permissions,
  };
  readonly #options: PiAdapterOptions;
  readonly #catalogs = new CatalogCache();

  constructor(options: PiAdapterOptions) {
    this.#options = options;
  }

  /** Starts a short-lived RPC process that saves no session to query the model list; Pi only returns models with credentials. */
  #catalog(cwd: string): Promise<AgentCatalog> {
    return this.#catalogs.get("", async () => {
      const client = new PiRpcClient({
        executable: this.#options.executable,
        args: ["--no-session"],
        cwd,
        env: childEnvironment(process.env),
      });
      try {
        return { models: modelOptions(await client.getAvailableModels()), permissions: [...PI_PERMISSIONS] };
      } finally {
        await client.close();
      }
    });
  }

  startSession(options: SessionOptions): Promise<AgentSession> {
    return PiSession.open(null, options, this.#options);
  }

  resumeSession(nativeId: string, options: SessionOptions): Promise<AgentSession> {
    return PiSession.open(nativeId, options, this.#options);
  }
}

function asOwnSession(session: AgentSession): PiSession {
  if (!(session instanceof PiSession)) throw new Error("The session does not belong to Pi.");
  return session;
}

type Turn = {
  channel: EventChannel<AgentEvent>;
  /** The current assistant text segment; becomes progress info when a tool call or new assistant message appears. */
  segment: string;
  /** The last completed assistant message, which wins at agent_settled. */
  last: Record<string, unknown> | null;
  /** An assistant message has started and not yet ended. */
  streaming: boolean;
  /** The group owner has asked to interrupt; the round that ends afterwards counts as interrupted. */
  interrupted: boolean;
};

/**
 * One separate `pi --mode rpc` subprocess (in its own process group) per native session.
 * nativeId is the path of Pi's session file, loaded with switch_session on resume.
 */
class PiSession implements AgentSession {
  readonly #client: PiRpcClient;
  readonly #options: SessionOptions;
  /** Approvals not yet answered on the web page, keyed by Pi's UI request id. */
  readonly #approvals = new Map<string, AbortController>();
  #sessionFile = "";
  #turn: Turn | null = null;

  private constructor(client: PiRpcClient, options: SessionOptions) {
    this.#client = client;
    this.#options = options;
    client.on("event", (event: PiEvent) => this.#onEvent(event));
    client.on("ui", (request: PiUiRequest) => this.#onUi(request));
    client.on("exit", () => {
      this.#cancelApprovals();
      const turn = this.#turn;
      if (!turn) return;
      this.#finish(turn.interrupted
        ? { type: "end", outcome: "interrupted", text: lastText(turn) }
        : { type: "end", outcome: "failed", text: lastText(turn), error: "The Pi process exited." });
    });
  }

  static async open(
    sessionFile: string | null,
    options: SessionOptions,
    adapter: PiAdapterOptions,
  ): Promise<PiSession> {
    // The group chat system prompt isn't stored in Pi's session file, so it is passed on both create and resume.
    const client = new PiRpcClient({
      executable: adapter.executable,
      args: ["--append-system-prompt", options.systemPrompt],
      cwd: options.cwd,
      env: childEnvironment(process.env),
    });
    const session = new PiSession(client, options);
    try {
      if (sessionFile) {
        const { cancelled } = await client.switchSession(sessionFile);
        if (cancelled) throw new Error("A Pi extension refused to resume the session.");
      }
      const state = await client.getState();
      if (typeof state.sessionFile !== "string" || !state.sessionFile) {
        throw new Error("Pi returned no session file path.");
      }
      session.#sessionFile = state.sessionFile;
      const { model, effort } = options.settings;
      const modelChanged = Boolean(model) && model !== currentModelId(state);
      if (model && modelChanged) {
        const { provider, modelId } = splitModelId(model);
        await client.setModel(provider, modelId);
      }
      if (effort && (modelChanged || state.thinkingLevel !== effort)) {
        await client.setThinkingLevel(effort);
      }
      return session;
    } catch (error) {
      if (client.stderrTail.trim()) console.error(`Pi stderr：${client.stderrTail.trim()}`);
      await session.close();
      throw error;
    }
  }

  get nativeId(): string | null {
    return this.#sessionFile || null;
  }

  get alive(): boolean {
    return this.#client.alive;
  }

  async *send(text: string): AsyncIterable<AgentEvent> {
    if (!this.alive) throw new Error("The Pi process is closed.");
    if (this.#turn) throw new Error("Pi is still handling the previous round.");
    const turn: Turn = { channel: new EventChannel<AgentEvent>(), segment: "", last: null, streaming: false, interrupted: false };
    this.#turn = turn;
    // Event listeners are installed before prompt; prompt succeeding only means it was accepted, and the round ends at agent_settled.
    void this.#client.prompt(text).then(
      (result) => {
        // handled: Pi consumed it as an extension command, so there will be no run and no agent_settled.
        if (result.disposition === "handled" && this.#turn === turn) {
          this.#finish({ type: "end", outcome: "completed", text: "" });
        }
      },
      (error: unknown) => {
        this.#finish({
          type: "end",
          outcome: turn.interrupted ? "interrupted" : "failed",
          text: lastText(turn),
          ...(turn.interrupted ? {} : { error: error instanceof Error ? error.message : String(error) }),
        });
      },
    );
    yield* turn.channel;
  }

  async compact(): Promise<void> {
    if (!this.alive) throw new Error("The Pi process is closed.");
    if (this.#turn) throw new Error("Pi is still handling the previous round.");
    await this.#client.compact();
  }

  async interrupt(): Promise<void> {
    const turn = this.#turn;
    if (!turn) return;
    turn.interrupted = true;
    this.#cancelApprovals();
    await this.#client.abort().catch(() => {});
    const ended = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), INTERRUPT_TIMEOUT_MS);
      void (async () => {
        while (this.#turn === turn && this.alive) await new Promise((r) => setTimeout(r, 50));
        clearTimeout(timer);
        resolve(true);
      })();
    });
    if (!ended) {
      this.#finish({ type: "end", outcome: "interrupted", text: lastText(turn) });
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

  #note(turn: Turn, text: string): void {
    turn.channel.push({ type: "activity", activity: { kind: "note", text } });
  }

  /** Moves the text streamed so far into progress info; the text starts over with the next segment. */
  #flushSegment(turn: Turn): void {
    if (turn.segment.trim()) this.#note(turn, turn.segment);
    turn.segment = "";
  }

  #onEvent(event: PiEvent): void {
    const turn = this.#turn;
    if (!turn) return;
    switch (event.type) {
      case "message_start":
        if (objectField(event.message).role === "assistant") {
          this.#flushSegment(turn);
          turn.streaming = true;
        }
        return;
      case "message_update": {
        const update = objectField(event.assistantMessageEvent);
        if (update.type === "text_delta" && typeof update.delta === "string" && update.delta) {
          turn.segment += update.delta;
          turn.channel.push({ type: "text", delta: update.delta });
        }
        return;
      }
      case "message_end": {
        const message = objectField(event.message);
        if (message.role === "assistant") {
          turn.last = message;
          turn.streaming = false;
        }
        return;
      }
      case "tool_execution_start":
        this.#flushSegment(turn);
        turn.channel.push({ type: "activity", activity: toolActivity(event) });
        return;
      case "auto_retry_start":
        this.#note(turn, `Pi is retrying (${event.attempt}/${event.maxAttempts}): ${stringField(event.errorMessage)}`);
        return;
      case "compaction_start":
        this.#note(turn, "Pi is compacting its context.");
        return;
      case "compaction_end":
        if (typeof event.errorMessage === "string") this.#note(turn, `Pi context compaction failed: ${event.errorMessage}`);
        return;
      case "extension_error":
        this.#note(turn, `Pi extension error: ${stringField(event.error)}`);
        return;
      case "agent_settled":
        this.#settle(turn, event.aborted === true);
        return;
    }
  }

  #settle(turn: Turn, aborted: boolean): void {
    const last = turn.last;
    const text = lastText(turn);
    if (turn.interrupted || aborted || last?.stopReason === "aborted") {
      this.#finish({ type: "end", outcome: "interrupted", text });
    } else if (last?.stopReason === "error") {
      this.#finish({ type: "end", outcome: "failed", text, error: stringField(last.errorMessage) || "Pi's model call failed." });
    } else if (!text.trim()) {
      this.#finish({ type: "end", outcome: "failed", text, error: "Pi gave no final reply." });
    } else {
      this.#finish({ type: "end", outcome: "completed", text });
    }
  }

  #onUi(request: PiUiRequest): void {
    const { id, method } = request;
    if (method === "confirm") {
      this.#confirm(request);
      return;
    }
    if (method === "select" || method === "input" || method === "editor") {
      // lanting only handles confirm; other dialogs left unanswered would make Pi wait forever.
      this.#client.respondUi(id, { cancelled: true });
      const turn = this.#turn;
      if (turn) {
        turn.channel.push({
          type: "activity",
          activity: { kind: "denied", toolName: stringField(request.title) || method, message: "lanting 不支持这类 Pi 扩展对话框。" },
        });
      }
      return;
    }
    if (method === "notify" && this.#turn && typeof request.message === "string") {
      this.#note(this.#turn, request.message);
    }
  }

  #confirm(request: PiUiRequest): void {
    const { id } = request;
    const turn = this.#turn;
    if (!turn || turn.interrupted) {
      this.#client.respondUi(id, { cancelled: true });
      return;
    }
    if (this.#options.settings.permission === ALWAYS_APPROVE) {
      this.#client.respondUi(id, { confirmed: true });
      return;
    }
    const controller = new AbortController();
    this.#approvals.set(id, controller);
    this.#options.requestApproval({
      toolName: stringField(request.title) || "Pi",
      detail: stringField(request.message),
    }, controller.signal).then(
      (answer) => {
        if (this.#approvals.get(id) !== controller) return;
        this.#approvals.delete(id);
        this.#client.respondUi(id, { confirmed: answer.decision === "allow" });
      },
      () => {
        if (this.#approvals.get(id) !== controller) return;
        this.#approvals.delete(id);
        this.#client.respondUi(id, { cancelled: true });
      },
    );
  }

  /** Withdraw the approvals on the web page and tell the still-running Pi those dialogs were cancelled. */
  #cancelApprovals(): void {
    for (const [id, controller] of this.#approvals) {
      this.#approvals.delete(id);
      controller.abort();
      this.#client.respondUi(id, { cancelled: true });
    }
  }
}

/** Current model from get_state, in the same format as member settings: `provider/modelId`. */
function currentModelId(state: Record<string, unknown>): string | null {
  const model = objectField(state.model);
  if (typeof model.provider !== "string" || !model.provider || typeof model.id !== "string" || !model.id) return null;
  return `${model.provider}/${model.id}`;
}

/** Model ids in lanting are `provider/modelId`; modelId itself may contain slashes. */
export function splitModelId(id: string): { provider: string; modelId: string } {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) throw new Error(`Malformed Pi model id: ${id}`);
  return { provider: id.slice(0, slash), modelId: id.slice(slash + 1) };
}

/** Converts a get_available_models model object into a member panel option. */
export function modelOptions(models: Record<string, unknown>[]): ModelOption[] {
  return models.flatMap((model) => {
    if (typeof model.provider !== "string" || !model.provider || typeof model.id !== "string" || !model.id) return [];
    const levels = supportedThinkingLevels(model);
    return [{
      id: `${model.provider}/${model.id}`,
      label: typeof model.name === "string" && model.name ? model.name : model.id,
      description: model.provider,
      efforts: levels.length > 1 ? levels : [],
    }];
  });
}

/** Follows Pi's getSupportedThinkingLevels: levels that are null in thinkingLevelMap are unsupported, and xhigh and max must be listed explicitly. */
function supportedThinkingLevels(model: Record<string, unknown>): string[] {
  if (model.reasoning !== true) return ["off"];
  const map = objectField(model.thinkingLevelMap);
  return THINKING_LEVELS.filter((level) => {
    const mapped = map[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

function toolActivity(event: PiEvent): { kind: "tool"; detail: string } & ToolName {
  const args = objectField(event.args);
  const detail = ["command", "path", "file_path", "pattern", "query", "url"]
    .map((key) => args[key])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? "";
  return {
    kind: "tool",
    ...toolNameOr(stringField(event.toolName), "tool.generic"),
    detail: detail.replaceAll(/\s+/gu, " ").trim().slice(0, 240),
  };
}

/** Text of the last assistant message; if it hasn't ended (e.g. interrupted), the segment currently streaming is used. */
function lastText(turn: Turn): string {
  if (turn.streaming || !turn.last) return turn.segment;
  const content = turn.last.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => objectField(block))
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function objectField(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * The CLI has no use for the web login token; keeping it would only give every tool subprocess control of the web side.
 * Claude's long-lived OAuth token isn't handed to other CLIs or their tool subprocesses either.
 * The permission extension's yolo and non-interactive switches aren't inherited from the environment either, or they would bypass the extension's deny rules.
 */
function childEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child = { ...environment };
  delete child.ACCESS_TOKEN;
  delete child.CLAUDE_CODE_OAUTH_TOKEN;
  delete child.PI_MINIMAL_PERMISSION_SYSTEM_YOLO;
  delete child.PI_MINIMAL_PERMISSION_SYSTEM_NONINTERACTIVE;
  return child;
}
