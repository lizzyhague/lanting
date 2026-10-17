import type { AgentFeatures } from "../../features/index.ts";
import { englishText, localText, LocalizedError } from "../../i18n/text.ts";
import { EventChannel } from "../event-channel.ts";
import {
  type AgentAdapter,
  type AgentEvent,
  type AgentSession,
  type ApprovalAnswer,
  localizedPermission,
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
  type AntigravityUpdate,
} from "./acp-client.ts";

export type AntigravityAdapterOptions = {
  executable: string;
};

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
   * models isn't implemented: the model list only comes in the `session/new` response, so fetching it leaves an empty session behind;
   * the model choice also doesn't persist across processes and must be reset with `session/set_config_option` on every resume.
   * usage isn't implemented: the Server sends `usage_update` (context used and limit) every round, but the first version doesn't use it.
   * deleteSession and compact aren't implemented: the ACP Server has no delete-session or compaction API.
   */
  readonly features: AgentFeatures = {
    permissions: async () => [...ANTIGRAVITY_PERMISSIONS],
  };
  readonly #options: AntigravityAdapterOptions;

  constructor(options: AntigravityAdapterOptions) {
    this.#options = options;
  }

  startSession(options: SessionOptions): Promise<AgentSession> {
    return AntigravitySession.open(null, options, this.#options);
  }

  resumeSession(nativeId: string, options: SessionOptions): Promise<AgentSession> {
    return AntigravitySession.open(nativeId, options, this.#options);
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
  /** Approvals not yet answered on the web page, keyed by the Server's JSON-RPC id. */
  readonly #approvals = new Map<number | string, AbortController>();
  #sessionId = "";
  /** The new session hasn't sent the group chat rules yet. */
  #rulesPending = false;
  /** The Server is already waiting for a browser login; the process is closed right away. */
  #loginRequired = false;
  #turn: Turn | null = null;

  private constructor(client: AntigravityAcpClient, options: SessionOptions) {
    this.#client = client;
    this.#options = options;
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
  ): Promise<AntigravitySession> {
    const client = new AntigravityAcpClient({
      executable: adapter.executable,
      cwd: options.cwd,
      env: childEnvironment(process.env),
    });
    const session = new AntigravitySession(client, options);
    try {
      await client.initialize();
      if (sessionId) {
        // resume doesn't replay history, and context is still kept.
        await client.sessionResume(sessionId, options.cwd);
        session.#sessionId = sessionId;
      } else {
        session.#sessionId = await client.sessionNew(options.cwd);
        session.#rulesPending = true;
      }
      await client.sessionSetMode(session.#sessionId, DEFAULT_MODE);
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
    const turn = this.#turn;
    if (!turn || payload.sessionId !== this.#sessionId) return;
    const update = payload.update;
    const kind = typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";
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
