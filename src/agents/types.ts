import type { AgentKind } from "./kinds.ts";
import type { AgentFeatures } from "../features/index.ts";
import { englishText, localText, type LocalText } from "../i18n/text.ts";

/**
 * Shared interface for AI integrations. The group core only knows these types and doesn't care which CLI is on the other side.
 * To add a new CLI kind, register its module in agents/index.ts; features that need CLI support are defined in features/index.ts.
 *
 * Native session names aren't changed: the group owner only looks for groups in lanting, and native sessions are deleted along with a permanent delete.
 */

/**
 * An AI's model, reasoning effort and permission in a given group. null means unspecified, following the CLI's own default.
 * Values are ids each adapter provides in AgentCatalog; the group core doesn't interpret them.
 */
export type AgentSettings = {
  model: string | null;
  /** Only meaningful when a model is specified; must be one of the levels that model supports. */
  effort: string | null;
  permission: string | null;
};

export const DEFAULT_AGENT_SETTINGS: Readonly<AgentSettings> = Object.freeze({
  model: null,
  effort: null,
  permission: null,
});

export type ModelOption = {
  id: string;
  label: string;
  description: string;
  /** Reasoning efforts this model supports; an empty array means none can be chosen. */
  efforts: string[];
  /** The CLI's default effort for this model, shown after the description. */
  defaultEffort?: string;
};

/** label and description are English; labelText and descriptionText, when present, are lanting's own wording. */
export type PermissionOption = {
  id: string;
  label: string;
  description: string;
  labelText?: LocalText;
  descriptionText?: LocalText;
  /** A more permissive level; the web page shows a warning. */
  danger?: boolean;
};

/** The name of a tool: toolKey is set when it is lanting's generic name, shown in the browser's language. */
export type ToolName = { toolName: string; toolKey?: string };

/** lanting's generic name for a tool, e.g. "command"; toolName holds the English form. */
export function genericTool(key: string): ToolName {
  return { toolName: englishText(localText(key)), toolKey: key };
}

/** The CLI's own tool name, clipped, or lanting's generic name when the CLI gave none. */
export function toolNameOr(name: string, key: string): ToolName {
  return name ? { toolName: name.slice(0, 120) } : genericTool(key);
}

/** A permission whose label or description is lanting's own text, translated in the browser. */
export function localizedPermission(option: {
  id: string;
  label: string | LocalText;
  description: string | LocalText;
  danger?: boolean;
}): PermissionOption {
  const { label, description, ...rest } = option;
  return {
    ...rest,
    label: typeof label === "string" ? label : englishText(label),
    description: typeof description === "string" ? description : englishText(description),
    ...(typeof label === "string" ? {} : { labelText: label }),
    ...(typeof description === "string" ? {} : { descriptionText: description }),
  };
}

/** Models and permissions selectable in the member panel, queried by each adapter from its own CLI. */
export type AgentCatalog = {
  models: ModelOption[];
  permissions: PermissionOption[];
};

export type ApprovalAsk = {
  toolName: string;
  /** Set when toolName is lanting's generic name for the tool; the browser shows this key's text instead. */
  toolKey?: string;
  /** One-line summary, such as a command or file path. */
  detail: string;
};

export type ApprovalAnswer = {
  decision: "allow" | "deny";
  /** Explanation given to the AI on rejection. */
  message: string;
};

export type SessionOptions = {
  cwd: string;
  /** Appended after the CLI's own system prompt; see group/system-prompt.ts for the content. */
  systemPrompt: string;
  /** Applied when opening or resuming a session; if settings change later, the group core closes the session and resumes it with the new settings. */
  settings: AgentSettings;
  /**
   * Called when the AI wants to use a tool that needs confirmation; the group owner approves or rejects it on the web page.
   * When the CLI withdraws the request itself, the adapter uses signal to remove the approval from the web page.
   */
  requestApproval: (ask: ApprovalAsk, signal?: AbortSignal) => Promise<ApprovalAnswer>;
};

export type AgentEvent =
  /** Reply text delta, used only for streaming display on the page. */
  | { type: "text"; delta: string }
  /** Progress info such as thinking and tool calls: shown only to the group owner, kept out of the chat record and not sent to other AIs. */
  | { type: "activity"; activity: Record<string, unknown> }
  /**
   * This reply has ended; must be the last event. text is the complete plain reply and is what gets written to the chat record.
   * If iteration finishes or throws without an end, the group core treats it as failed.
   */
  | {
    type: "end";
    outcome: "completed" | "interrupted" | "failed";
    text: string;
    error?: string;
  };

export interface AgentSession {
  /** The CLI's own session id. Some CLIs only know it after the first message; null until then. */
  readonly nativeId: string | null;
  /** false once the CLI process has exited; the group core drops it and resumes with the native session id next time. */
  readonly alive: boolean;
  /** Sends a user message into the native session; only one send runs per session at a time. */
  send(text: string): AsyncIterable<AgentEvent>;
  /** Interrupts the reply in progress; send's iteration should then end with interrupted. */
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface AgentAdapter {
  /** The CLI kind this adapter integrates. */
  readonly kind: AgentKind;
  /**
   * When true the CLI process is closed after every reply and the session resumed on the next call;
   * when false the process stays for reuse and closes only after being idle for a while. Chosen to match each CLI's reference project.
   */
  readonly closeAfterTurn: boolean;
  readonly features: AgentFeatures;
  /** Starts resident resources the adapter holds once the backend is listening; must not block service startup. */
  start?(): void;
  /** Closes resident resources the adapter holds when the backend exits. */
  close?(): Promise<void>;
  startSession(options: SessionOptions): Promise<AgentSession>;
  resumeSession(nativeId: string, options: SessionOptions): Promise<AgentSession>;
}
