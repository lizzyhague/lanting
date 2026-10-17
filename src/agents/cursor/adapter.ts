import type { AgentFeatures } from "../../features/index.ts";
import { localText } from "../../i18n/text.ts";
import { EventChannel } from "../event-channel.ts";
import {
  type AgentAdapter,
  type AgentEvent,
  type AgentSession,
  type ApprovalAnswer,
  genericTool,
  localizedPermission,
  type PermissionOption,
  type SessionOptions,
  type ToolName,
  toolNameOr,
} from "../types.ts";
import {
  CursorAcpClient,
  type CursorBlockingRequest,
  type CursorPermissionOutcome,
  type CursorPermissionRequest,
  type CursorUpdate,
} from "./acp-client.ts";

export type CursorAdapterOptions = {
  executable: string;
};

/** If the round hasn't ended this long after session/cancel, the Cursor process is closed outright. */
const INTERRUPT_TIMEOUT_MS = 10_000;

/**
 * always-approve doesn't use `--force`; instead lanting picks a one-time allow for every approval Cursor sends,
 * so deny rules in Cursor's config still apply; operations Cursor allows itself never show an approval.
 */
export const CURSOR_PERMISSIONS: readonly PermissionOption[] = [
  localizedPermission({
    id: "ask",
    label: localText("permission.ask"),
    description: localText("permission.cursor.ask"),
  }),
  localizedPermission({
    id: "always-approve",
    label: "Always approve",
    description: localText("permission.cursor.alwaysApprove"),
    danger: true,
  }),
];

const ALWAYS_APPROVE = "always-approve";

/** plan and ask enter plan approval or read-only Q&A, so the group chat always uses agent. */
const AGENT_MODE = "agent";

/**
 * Cursor has no launch argument or session field for appending a system prompt, so the group chat rules can only be sent once, at the start of a new session's first
 * user message; on resume they are already in the session history and aren't sent again.
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

export class CursorAdapter implements AgentAdapter {
  readonly kind = "cursor";
  /** Closes the ACP process after every round and resumes by session id next time, same as Codex, Grok and Pi. */
  readonly closeAfterTurn = true;
  /**
   * models isn't implemented: `session/set_model` rewrites Cursor's global default model, so multiple Cursor members would affect each other;
   * it follows Cursor's current default model instead. ACP also has no compaction, delete-session or usage API.
   */
  readonly features: AgentFeatures = {
    permissions: async () => [...CURSOR_PERMISSIONS],
  };
  readonly #options: CursorAdapterOptions;

  constructor(options: CursorAdapterOptions) {
    this.#options = options;
  }

  startSession(options: SessionOptions): Promise<AgentSession> {
    return CursorSession.open(null, options, this.#options);
  }

  resumeSession(nativeId: string, options: SessionOptions): Promise<AgentSession> {
    return CursorSession.open(nativeId, options, this.#options);
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
 * One separate `agent acp` subprocess (in its own process group) per native session.
 * The plain reply is the round's last agent_message; earlier interim text becomes progress info.
 */
class CursorSession implements AgentSession {
  readonly #client: CursorAcpClient;
  readonly #options: SessionOptions;
  /** Approvals not yet answered on the web page, keyed by Cursor's JSON-RPC id. */
  readonly #approvals = new Map<number | string, AbortController>();
  #sessionId = "";
  /** The new session hasn't sent the group chat rules yet. */
  #rulesPending = false;
  #turn: Turn | null = null;

  private constructor(client: CursorAcpClient, options: SessionOptions) {
    this.#client = client;
    this.#options = options;
    client.on("update", (payload: CursorUpdate) => this.#onUpdate(payload));
    client.on("permission", (request: CursorPermissionRequest) => this.#onPermission(request));
    client.on("blocking", (request: CursorBlockingRequest) => this.#onBlocking(request));
    client.on("exit", () => {
      this.#cancelApprovals();
      const turn = this.#turn;
      if (!turn) return;
      this.#finish(turn.interrupted
        ? { type: "end", outcome: "interrupted", text: turn.segment }
        : { type: "end", outcome: "failed", text: turn.segment, error: "The Cursor process exited." });
    });
  }

  static async open(
    sessionId: string | null,
    options: SessionOptions,
    adapter: CursorAdapterOptions,
  ): Promise<CursorSession> {
    const client = new CursorAcpClient({
      executable: adapter.executable,
      cwd: options.cwd,
      env: childEnvironment(process.env),
    });
    const session = new CursorSession(client, options);
    try {
      await client.initialize();
      await client.authenticate();
      if (sessionId) {
        // On load Cursor first replays the history as session/update; there is no current round yet, so the replay stays out of the group chat.
        await client.sessionLoad(sessionId, options.cwd);
        session.#sessionId = sessionId;
      } else {
        session.#sessionId = await client.sessionNew(options.cwd);
        session.#rulesPending = true;
      }
      await client.sessionSetMode(session.#sessionId, AGENT_MODE);
      return session;
    } catch (error) {
      if (client.stderrTail.trim()) console.error(`Cursor stderr：${client.stderrTail.trim()}`);
      await session.close();
      throw error;
    }
  }

  get nativeId(): string | null {
    return this.#sessionId || null;
  }

  get alive(): boolean {
    return this.#client.alive;
  }

  async *send(text: string): AsyncIterable<AgentEvent> {
    if (!this.alive) throw new Error("The Cursor process is closed.");
    if (this.#turn) throw new Error("Cursor is still handling the previous round.");
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
          this.#finish({ type: "end", outcome: "failed", text: turn.segment, error: `Cursor ended the round early (${stop}).` });
        }
      },
      (error: unknown) => {
        this.#finish({
          type: "end",
          outcome: turn.interrupted ? "interrupted" : "failed",
          text: turn.segment,
          ...(turn.interrupted ? {} : { error: error instanceof Error ? error.message : String(error) }),
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

  #onUpdate(payload: CursorUpdate): void {
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

  #onPermission(request: CursorPermissionRequest): void {
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
    const settle = (outcome: CursorPermissionOutcome) => {
      // A withdrawn approval was already answered cancelled by whoever withdrew it; a late web answer is no longer written back.
      if (this.#approvals.get(request.rpcId) !== controller) return;
      this.#approvals.delete(request.rpcId);
      this.#client.respondPermission(request.rpcId, outcome);
    };
    this.#options.requestApproval({
      ...(tool.toolKey ? { toolName: tool.toolName, toolKey: tool.toolKey } : { toolName: tool.toolName }),
      detail: [tool.detail, permissionReason(request.toolCall)].filter(Boolean).join("\n"),
    }, controller.signal).then(
      (answer) => settle(permissionOutcome(request, answer)),
      () => settle({ outcome: "cancelled" }),
    );
  }

  /** The client has already answered cancelled; this only tells the group owner. */
  #onBlocking(request: CursorBlockingRequest): void {
    const turn = this.#turn;
    if (!turn) return;
    const tool = genericTool(request.method === "cursor/create_plan" ? "tool.confirmPlan" : "tool.question");
    turn.channel.push({
      type: "activity",
      activity: { kind: "denied", ...tool, message: "群聊里不直接向群主提问或请求确认，问题请写在回复里。" },
    });
  }

  /** Withdraw the approvals on the web page and tell the still-running Cursor those requests were cancelled. */
  #cancelApprovals(): void {
    for (const [rpcId, controller] of this.#approvals) {
      this.#approvals.delete(rpcId);
      controller.abort();
      this.#client.respondPermission(rpcId, { outcome: "cancelled" });
    }
  }
}

/** Only picks a one-time allow or reject, never allow-always, so no grant rules are written into Cursor's config. */
function permissionOutcome(request: CursorPermissionRequest, answer: ApprovalAnswer): CursorPermissionOutcome {
  const kind = answer.decision === "allow" ? "allow_once" : "reject_once";
  const option = request.options.find((candidate) => candidate.kind === kind);
  return option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
}

/** Condenses an ACP tool_call into one line of progress info. Cursor's titles are often a command wrapped in backticks. */
export function toolActivity(toolCall: Record<string, unknown>): { kind: "tool"; detail: string } & ToolName {
  const toolKind = typeof toolCall.kind === "string" ? toolCall.kind : "";
  const rawTitle = typeof toolCall.title === "string" ? toolCall.title.trim() : "";
  const title = /^`[^`]+`$/u.test(rawTitle) ? rawTitle.slice(1, -1).trim() : rawTitle;
  const input = objectField(toolCall.rawInput);
  const detail = ["command", "path", "file_path", "pattern", "query", "url"]
    .map((key) => input[key])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? "";
  return {
    kind: "tool",
    ...toolNameOr(title || toolKind, "tool.generic"),
    detail: detail.trim() === title ? "" : detail.replaceAll(/\s+/gu, " ").trim().slice(0, 240),
  };
}

/** Cursor explains the reason in the approval's tool call content, e.g. "Not in allowlist: touch". */
function permissionReason(toolCall: Record<string, unknown>): string {
  const content = Array.isArray(toolCall.content) ? toolCall.content : [];
  return content
    .map((entry) => contentText(objectField(entry).content))
    .filter(Boolean)
    .join("\n")
    .slice(0, 600);
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
 */
function childEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child = { ...environment };
  delete child.ACCESS_TOKEN;
  delete child.CLAUDE_CODE_OAUTH_TOKEN;
  return child;
}
