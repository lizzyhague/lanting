import type { LocalText } from "../i18n/text.ts";
import { AGENT_NAME_PATTERN, MAX_AGENTS, MAX_COLLABORATION_LENGTH } from "../state/settings-store.ts";

export const MAX_BROWSER_MESSAGE_BYTES = 2_097_152;
const MAX_MESSAGE_TEXT_LENGTH = 524_288;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** Model, reasoning effort and permission ids come from each CLI; only their length is limited here. */
const MAX_SETTING_LENGTH = 200;
/** Maximum number of groups one bulk operation handles. */
const MAX_BATCH_GROUPS = 1_000;

export type BrowserRequest =
  | { type: "connection.ready"; requestId: string }
  | { type: "app.state"; requestId: string }
  | { type: "group.create"; requestId: string; directory: string; members: string[]; title: string }
  | { type: "group.subscribe"; requestId: string; groupId: string }
  | { type: "group.unsubscribe"; requestId: string; groupId: string }
  | { type: "group.callOrder"; requestId: string; groupId: string; order: string[] }
  | {
    type: "round.start";
    requestId: string;
    groupId: string;
    text: string;
    order: string[];
    attachmentIds: string[];
  }
  | { type: "round.interrupt"; requestId: string; groupId: string }
  | { type: "approval.respond"; requestId: string; approvalId: string; decision: "allow" | "deny" }
  | { type: "agent.catalog"; requestId: string; groupId: string; agent: string }
  | {
    type: "agent.settings";
    requestId: string;
    groupId: string;
    agent: string;
    model: string | null;
    effort: string | null;
    permission: string | null;
  }
  | { type: "group.compact"; requestId: string; groupId: string; agents: string[] }
  | { type: "group.rename"; requestId: string; groupId: string; title: string }
  | { type: "group.pin"; requestId: string; groupId: string; pinned: boolean }
  | { type: "group.usage"; requestId: string; groupId: string; agent: string | null }
  | { type: "group.usage.refresh"; requestId: string; groupId: string }
  | {
    type: "attachment.ticket";
    requestId: string;
    groupId: string;
    originalName: string;
    declaredMime: string;
    expectedSize: number;
  }
  | { type: "settings.username"; requestId: string; username: string }
  | { type: "settings.collaboration"; requestId: string; collaboration: string }
  | { type: "settings.agent.add"; requestId: string }
  | {
    type: "settings.agent.update";
    requestId: string;
    agentId: string;
    name?: string;
    kind?: string | null;
    color?: string | null;
  }
  | { type: "settings.agent.remove"; requestId: string; agentId: string }
  | { type: "settings.agent.reorder"; requestId: string; order: string[] }
  | { type: "settings.catalog"; requestId: string; agentId: string }
  | {
    type: "settings.defaults";
    requestId: string;
    agentId: string;
    model: string | null;
    effort: string | null;
    permission: string | null;
  }
  | {
    type: "groups.archive" | "groups.unarchive" | "groups.trash" | "groups.restore" | "groups.purge";
    requestId: string;
    groupIds: string[];
  };

export type BrowserEvent = Record<string, unknown> & { type: string };

export type BrowserMessage =
  | { type: "response"; requestId: string; ok: true; data: unknown }
  | {
    type: "response";
    requestId: string;
    ok: false;
    error: { code: string; message: string; text?: LocalText; details?: Record<string, string> };
  }
  | { type: "event"; event: BrowserEvent }
  | { type: "error"; requestId: string | null; error: { code: string; message: string } };

export class ProtocolError extends Error {
  readonly code: string;
  readonly requestId: string | null;

  constructor(code: string, message: string, requestId: string | null = null) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.requestId = requestId;
  }
}

export function parseBrowserRequest(source: string): BrowserRequest {
  if (Buffer.byteLength(source, "utf8") > MAX_BROWSER_MESSAGE_BYTES) {
    throw new ProtocolError("message_too_large", "The message is too large; the limit is 2 MiB.");
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new ProtocolError("invalid_json", "The message is not valid JSON.");
  }
  if (!isObject(value)) throw new ProtocolError("invalid_message", "The message must be a JSON object.");

  const requestId = requireString(value.requestId, "Request ID", null, 128);
  if (typeof value.type !== "string") {
    throw new ProtocolError("invalid_message", "The message has no type.", requestId);
  }

  switch (value.type) {
    case "connection.ready":
    case "app.state":
      return { type: value.type, requestId };
    case "group.create":
      return {
        type: "group.create",
        requestId,
        directory: requireString(value.directory, "Directory", requestId, 255),
        members: requireAgentIdList(value.members, "Members", requestId),
        title: optionalString(value.title, "Title", requestId, 200) ?? "",
      };
    case "group.subscribe":
    case "group.unsubscribe":
    case "group.usage.refresh":
    case "round.interrupt":
      return { type: value.type, requestId, groupId: requireUuid(value.groupId, "Group ID", requestId) };
    case "group.callOrder":
      return {
        type: "group.callOrder",
        requestId,
        groupId: requireUuid(value.groupId, "Group ID", requestId),
        order: requireTagList(value.order, "Order", requestId),
      };
    case "round.start": {
      // With attachments the message may be empty.
      const attachmentIds = value.attachmentIds === undefined ? [] : value.attachmentIds;
      if (!Array.isArray(attachmentIds) || attachmentIds.length > 100) {
        throw new ProtocolError("invalid_field", "Attachments are malformed or too many.", requestId);
      }
      return {
        type: "round.start",
        requestId,
        groupId: requireUuid(value.groupId, "Group ID", requestId),
        text: attachmentIds.length > 0
          ? optionalString(value.text, "Text", requestId, MAX_MESSAGE_TEXT_LENGTH) ?? ""
          : requireString(value.text, "Text", requestId, MAX_MESSAGE_TEXT_LENGTH),
        order: requireTagList(value.order, "Order", requestId),
        attachmentIds: attachmentIds.map((id) => requireUuid(id, "Attachment ID", requestId)),
      };
    }
    case "approval.respond": {
      if (value.decision !== "allow" && value.decision !== "deny") {
        throw new ProtocolError("invalid_field", "The approval decision must be allow or deny.", requestId);
      }
      return {
        type: "approval.respond",
        requestId,
        approvalId: requireUuid(value.approvalId, "Approval ID", requestId),
        decision: value.decision,
      };
    }
    case "agent.catalog":
      return {
        type: "agent.catalog",
        requestId,
        groupId: requireUuid(value.groupId, "Group ID", requestId),
        agent: requireTag(value.agent, requestId),
      };
    case "agent.settings":
      return {
        type: "agent.settings",
        requestId,
        groupId: requireUuid(value.groupId, "Group ID", requestId),
        agent: requireTag(value.agent, requestId),
        model: nullableSetting(value.model, "Model", requestId),
        effort: nullableSetting(value.effort, "Effort", requestId),
        permission: nullableSetting(value.permission, "Permission", requestId),
      };
    case "group.compact":
      return {
        type: "group.compact",
        requestId,
        groupId: requireUuid(value.groupId, "Group ID", requestId),
        agents: requireTagList(value.agents, "Agents to compact", requestId),
      };
    case "group.rename":
      return {
        type: "group.rename",
        requestId,
        groupId: requireUuid(value.groupId, "Group ID", requestId),
        title: requireString(value.title, "Title", requestId, 200),
      };
    case "group.pin":
      if (typeof value.pinned !== "boolean") {
        throw new ProtocolError("invalid_field", "Pinned must be a boolean.", requestId);
      }
      return {
        type: "group.pin",
        requestId,
        groupId: requireUuid(value.groupId, "Group ID", requestId),
        pinned: value.pinned,
      };
    case "group.usage":
      return {
        type: "group.usage",
        requestId,
        groupId: requireUuid(value.groupId, "Group ID", requestId),
        agent: value.agent === null ? null : requireTag(value.agent, requestId),
      };
    case "attachment.ticket": {
      const size = value.expectedSize;
      if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
        throw new ProtocolError("invalid_field", "The file size is invalid.", requestId);
      }
      return {
        type: "attachment.ticket",
        requestId,
        groupId: requireUuid(value.groupId, "Group ID", requestId),
        originalName: requireString(value.originalName, "File name", requestId, 1_024),
        declaredMime: optionalString(value.declaredMime, "Declared MIME type", requestId, 255) ?? "",
        expectedSize: size,
      };
    }
    case "settings.username":
      // Empty strings also go to the backend, which gives the "can't be empty" explanation per the spec.
      if (typeof value.username !== "string" || value.username.length > 200) {
        throw new ProtocolError("invalid_field", "The username is malformed.", requestId);
      }
      return { type: "settings.username", requestId, username: value.username };
    case "settings.collaboration":
      if (typeof value.collaboration !== "string" || value.collaboration.length > MAX_COLLABORATION_LENGTH) {
        throw new ProtocolError(
          "invalid_field",
          `Collaboration rules must be a string of at most ${MAX_COLLABORATION_LENGTH} characters.`,
          requestId,
        );
      }
      return { type: "settings.collaboration", requestId, collaboration: value.collaboration };
    case "settings.agent.add":
      return { type: "settings.agent.add", requestId };
    case "settings.agent.update": {
      if (!("name" in value) && !("kind" in value) && !("color" in value)) {
        throw new ProtocolError("invalid_field", "At least one AI field must change.", requestId);
      }
      return {
        type: "settings.agent.update",
        requestId,
        agentId: requireAgentId(value.agentId, requestId),
        ...("name" in value ? { name: looseString(value.name, "AI name", requestId, 200) } : {}),
        ...("kind" in value ? { kind: looseNullableString(value.kind, "CLI kind", requestId, 32) } : {}),
        ...("color" in value ? { color: looseNullableString(value.color, "Color", requestId, 32) } : {}),
      };
    }
    case "settings.agent.remove":
      return { type: "settings.agent.remove", requestId, agentId: requireAgentId(value.agentId, requestId) };
    case "settings.agent.reorder":
      return {
        type: "settings.agent.reorder",
        requestId,
        order: requireAgentIdList(value.order, "AI order", requestId),
      };
    case "settings.catalog":
      return { type: "settings.catalog", requestId, agentId: requireAgentId(value.agentId, requestId) };
    case "settings.defaults":
      return {
        type: "settings.defaults",
        requestId,
        agentId: requireAgentId(value.agentId, requestId),
        model: nullableSetting(value.model, "Model", requestId),
        effort: nullableSetting(value.effort, "Effort", requestId),
        permission: nullableSetting(value.permission, "Permission", requestId),
      };
    case "groups.archive":
    case "groups.unarchive":
    case "groups.trash":
    case "groups.restore":
    case "groups.purge": {
      const ids = value.groupIds;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BATCH_GROUPS) {
        throw new ProtocolError("invalid_field", "The group list is empty or too long.", requestId);
      }
      return {
        type: value.type,
        requestId,
        groupIds: ids.map((id) => requireUuid(id, "Group ID", requestId)),
      };
    }
    default:
      throw new ProtocolError("unknown_type", `Unknown message type: ${value.type}`, requestId);
  }
}

function requireString(
  value: unknown,
  label: string,
  requestId: string | null,
  maxLength: number,
): string {
  if (typeof value !== "string" || !value || value.length > maxLength) {
    throw new ProtocolError("invalid_field", `${label} is empty or too long.`, requestId);
  }
  return value;
}

function optionalString(
  value: unknown,
  label: string,
  requestId: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new ProtocolError("invalid_field", `${label} is malformed or too long.`, requestId);
  }
  return value;
}

function requireUuid(value: unknown, label: string, requestId: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ProtocolError("invalid_field", `${label} is malformed.`, requestId);
  }
  return value;
}

function requireTag(value: unknown, requestId: string): string {
  if (typeof value !== "string" || !AGENT_NAME_PATTERN.test(value)) {
    throw new ProtocolError("invalid_field", "AI is malformed.", requestId);
  }
  return value;
}

function requireAgentId(value: unknown, requestId: string): string {
  return requireUuid(value, "AI internal ID", requestId);
}

/** Specific name, kind and color rules are validated by the settings store, so errors land on the right field. */
function looseString(value: unknown, label: string, requestId: string, maxLength: number): string {
  if (typeof value !== "string" || value.length > maxLength) {
    throw new ProtocolError("invalid_field", `${label} is malformed or too long.`, requestId);
  }
  return value;
}

function looseNullableString(
  value: unknown,
  label: string,
  requestId: string,
  maxLength: number,
): string | null {
  if (value === null) return null;
  return looseString(value, label, requestId, maxLength);
}

/** null means follow the CLI's default; empty strings aren't accepted. */
function nullableSetting(value: unknown, label: string, requestId: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value || value.length > MAX_SETTING_LENGTH) {
    throw new ProtocolError("invalid_field", `${label} is malformed.`, requestId);
  }
  return value;
}

function requireTagList(value: unknown, label: string, requestId: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_AGENTS ||
      !value.every((item) => typeof item === "string" && AGENT_NAME_PATTERN.test(item))) {
    throw new ProtocolError("invalid_field", `${label} is malformed.`, requestId);
  }
  return [...value];
}

function requireAgentIdList(value: unknown, label: string, requestId: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_AGENTS) {
    throw new ProtocolError("invalid_field", `${label} is malformed.`, requestId);
  }
  return value.map((item) => requireUuid(item, label, requestId));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
