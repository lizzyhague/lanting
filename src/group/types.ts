import type { AgentKind } from "../agents/kinds.ts";
import type { PaletteId } from "../agents/palette.ts";
import type { AgentSettings } from "../agents/types.ts";
import type { StoredAttachment } from "../attachments/prompt.ts";
import type { LocalText } from "../i18n/text.ts";

export type AgentState = {
  /** CLI kind frozen when the group was created. */
  kind: AgentKind;
  /** Primary color frozen when the group was created. */
  color: PaletteId;
  /** The CLI's native session id; null before a session has been opened. */
  nativeSessionId: string | null;
  /**
   * Which chat record entry (seq) this AI has seen up to. 0 means it has seen nothing
   * and will receive everything since the group was created the first time it is called on.
   */
  cursor: number;
  /** Model, reasoning effort and permission chosen for it in this group; affects this group only. */
  settings: AgentSettings;
};

export type Group = {
  id: string;
  title: string;
  /** Working directory of every AI in the group, as an absolute path. */
  cwd: string;
  /** Username at group creation; never changes afterwards. */
  username: string;
  /** Frozen tags: copied from the AI names at group creation and unchanged afterwards; in the settings order at creation time. */
  members: string[];
  /** The previous call order. */
  callOrder: string[];
  agents: Record<string, AgentState>;
  createdAt: string;
  /** Last activity time, used to put recently active groups first. */
  updatedAt: number;
  /** Whether the group is pinned to the top of recent groups. */
  pinned: boolean;
  /** Whether the group has been moved from recent groups to the archive. */
  archived: boolean;
  /** Which member the usage row under the title bar shows; null means off. */
  usageAgent: string | null;
  /** When the group was moved to trash; null when it isn't in trash. The expiry time is derived from it and not stored separately. */
  trashedAt: string | null;
  /**
   * When permanent deletion started. Kept if deletion fails halfway; deletion continues at service startup and on the next scan.
   * Meanwhile the group can't be restored or used for anything else.
   */
  deletingAt: string | null;
};

export type Speaker =
  | { role: "host" }
  | { role: "agent"; agent: string }
  /** Group notice (e.g. whose context was compacted), visible only to the group owner and never forwarded to any AI. */
  | { role: "notice"; agent: string };

export type ReplyStatus = "completed" | "interrupted" | "failed";

export type TranscriptEntry = {
  /** Starts at 1 and increases in append order. */
  seq: number;
  at: string;
  from: Speaker;
  text: string;
  /** Only present on AI replies. Only completed replies are forwarded to other AIs. */
  status?: ReplyStatus;
  /** English; errorText, when present, is lanting's own wording, shown in the browser's language. */
  error?: string;
  errorText?: LocalText;
  /** On notices: lanting's own wording of text, shown in the browser's language. */
  noticeText?: LocalText;
  /** Progress info for this reply (tool calls, etc.), visible only to the group owner and not forwarded to other AIs. */
  activities?: Activity[];
  /** Attachments on this message from the group owner. Paths stay on the backend only. */
  attachments?: StoredAttachment[];
  /**
   * Who was called in the round with the attachments. These AIs receive the attachments themselves; AIs called later only see a one-line attachment note.
   */
  recipients?: string[];
};

/** Content is decided by each adapter; carries at least kind. */
export type Activity = Record<string, unknown> & { kind: string };
