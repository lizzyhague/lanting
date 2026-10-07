export const MAX_BROWSER_MESSAGE_BYTES = 2_097_152;
const MAX_MESSAGE_TEXT_LENGTH = 524_288;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const AGENT_ID_PATTERN = /^[a-z][a-z0-9]{0,15}$/u;

export type BrowserRequest =
  | { type: "connection.ready"; requestId: string }
  | { type: "app.state"; requestId: string }
  | { type: "group.create"; requestId: string; directory: string; members: string[]; title: string }
  | { type: "group.subscribe"; requestId: string; groupId: string }
  | { type: "group.unsubscribe"; requestId: string; groupId: string }
  | { type: "group.callOrder"; requestId: string; groupId: string; order: string[] }
  | { type: "round.start"; requestId: string; groupId: string; text: string; order: string[] }
  | { type: "round.interrupt"; requestId: string; groupId: string }
  | { type: "approval.respond"; requestId: string; approvalId: string; decision: "allow" | "deny" };

export type BrowserEvent = Record<string, unknown> & { type: string };

export type BrowserMessage =
  | { type: "response"; requestId: string; ok: true; data: unknown }
  | {
    type: "response";
    requestId: string;
    ok: false;
    error: { code: string; message: string; details?: Record<string, string> };
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
    throw new ProtocolError("message_too_large", "消息太大。上限是 2 MiB。");
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new ProtocolError("invalid_json", "消息不是有效的 JSON。");
  }
  if (!isObject(value)) throw new ProtocolError("invalid_message", "消息必须是 JSON 对象。");

  const requestId = requireString(value.requestId, "请求 ID", null, 128);
  if (typeof value.type !== "string") {
    throw new ProtocolError("invalid_message", "消息缺少类型。", requestId);
  }

  switch (value.type) {
    case "connection.ready":
    case "app.state":
      return { type: value.type, requestId };
    case "group.create":
      return {
        type: "group.create",
        requestId,
        directory: requireString(value.directory, "工作目录", requestId, 255),
        members: requireAgentList(value.members, "成员", requestId),
        title: optionalString(value.title, "群名", requestId, 200) ?? "",
      };
    case "group.subscribe":
    case "group.unsubscribe":
    case "round.interrupt":
      return { type: value.type, requestId, groupId: requireUuid(value.groupId, "群 ID", requestId) };
    case "group.callOrder":
      return {
        type: "group.callOrder",
        requestId,
        groupId: requireUuid(value.groupId, "群 ID", requestId),
        order: requireAgentList(value.order, "点名", requestId),
      };
    case "round.start":
      return {
        type: "round.start",
        requestId,
        groupId: requireUuid(value.groupId, "群 ID", requestId),
        text: requireString(value.text, "消息", requestId, MAX_MESSAGE_TEXT_LENGTH),
        order: requireAgentList(value.order, "点名", requestId),
      };
    case "approval.respond": {
      if (value.decision !== "allow" && value.decision !== "deny") {
        throw new ProtocolError("invalid_field", "审批结果只能是 allow 或 deny。", requestId);
      }
      return {
        type: "approval.respond",
        requestId,
        approvalId: requireUuid(value.approvalId, "审批 ID", requestId),
        decision: value.decision,
      };
    }
    default:
      throw new ProtocolError("unknown_type", `不认识的消息类型：${value.type}`, requestId);
  }
}

function requireString(
  value: unknown,
  label: string,
  requestId: string | null,
  maxLength: number,
): string {
  if (typeof value !== "string" || !value || value.length > maxLength) {
    throw new ProtocolError("invalid_field", `${label}不能为空或过长。`, requestId);
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
    throw new ProtocolError("invalid_field", `${label}格式不对或过长。`, requestId);
  }
  return value;
}

function requireUuid(value: unknown, label: string, requestId: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new ProtocolError("invalid_field", `${label}格式不对。`, requestId);
  }
  return value;
}

function requireAgentList(value: unknown, label: string, requestId: string): string[] {
  if (!Array.isArray(value) || value.length > 16 ||
      !value.every((item) => typeof item === "string" && AGENT_ID_PATTERN.test(item))) {
    throw new ProtocolError("invalid_field", `${label}格式不对。`, requestId);
  }
  return [...value];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
