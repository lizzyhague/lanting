import type { AgentSession, ModelOption, PermissionOption } from "../agents/types.ts";

/**
 * One segment of the usage row as data; the web page words it in its own language. resetsAt is always an ISO
 * string, converted by the module itself, and shown in the browser's local time.
 */
export type UsagePart =
  | { kind: "context"; percent: number | null; approximate?: boolean }
  | { kind: "unavailable" }
  | { kind: "quota"; window: UsageWindow; left: number | null; resetsAt?: string };

/** A quota window: a model or limit name, a duration, or both (in parentheses when parenthesized). */
export type UsageWindow = { name?: string; minutes?: number; parenthesized?: boolean };

export type UsageRequest = {
  nativeId: string;
  cwd: string;
  /** view: a group was opened or the member switched; turn: this member just finished a reply or compaction; visible: the page returned to the foreground. */
  reason: "view" | "turn" | "visible";
  /**
   * Gets the session lanting opened for this member. With open false, returns only an already-running session, or null if none, without starting a process.
   * Always returns null while this member is replying or compacting. Only modules that need a running CLI use it.
   */
  session: (open: boolean) => Promise<AgentSession | null>;
};

export type AgentFeatures = {
  /** Compacts this session's context. session is the session lanting opened for this member, of the module's own session type. */
  compact?: (session: AgentSession) => Promise<void>;
  /** Permanently deletes the native session. A session that no longer exists also counts as success. */
  deleteSession?: (nativeId: string, cwd: string) => Promise<void>;
  /** Selectable models, each with its selectable reasoning efforts. */
  models?: (cwd: string) => Promise<ModelOption[]>;
  /** Selectable permission levels. */
  permissions?: (cwd: string) => Promise<PermissionOption[]>;
  /** Context and quota segments, in display order. Returning null means no new data this time, and lanting keeps the previous result. */
  usage?: (request: UsageRequest) => Promise<UsagePart[] | null>;
};

export type AgentFeatureId = keyof AgentFeatures;

const AGENT_FEATURE_IDS: readonly AgentFeatureId[] = [
  "compact",
  "deleteSession",
  "models",
  "permissions",
  "usage",
];

/** Which sub-features this adapter implements. Implementing one counts as support, with no separate declaration that could drift from the implementation. */
export function featureIds(features: AgentFeatures): AgentFeatureId[] {
  return AGENT_FEATURE_IDS.filter((id) => typeof features[id] === "function");
}
