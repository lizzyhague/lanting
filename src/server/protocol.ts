import { AGENT_NAME_PATTERN, MAX_AGENTS } from "../state/settings-store.ts";

export const MAX_BROWSER_MESSAGE_BYTES = 2_097_152;
const MAX_MESSAGE_TEXT_LENGTH = 524_288;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** 模型、思考强度、权限的 id 由各家 CLI 给出，这里只限制长度。 */
const MAX_SETTING_LENGTH = 200;
/** 一次多选操作最多处理的群数。 */
const MAX_BATCH_GROUPS = 500;

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
  | {
    type: "attachment.ticket";
    requestId: string;
    groupId: string;
    originalName: string;
    declaredMime: string;
    expectedSize: number;
  }
  | { type: "settings.username"; requestId: string; username: string }
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
  | { type: "groups.trash" | "groups.restore" | "groups.purge"; requestId: string; groupIds: string[] };

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
        members: requireAgentIdList(value.members, "成员", requestId),
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
        order: requireTagList(value.order, "点名", requestId),
      };
    case "round.start": {
      // 带附件时消息可以为空。
      const attachmentIds = value.attachmentIds === undefined ? [] : value.attachmentIds;
      if (!Array.isArray(attachmentIds) || attachmentIds.length > 100) {
        throw new ProtocolError("invalid_field", "附件格式不对或过多。", requestId);
      }
      return {
        type: "round.start",
        requestId,
        groupId: requireUuid(value.groupId, "群 ID", requestId),
        text: attachmentIds.length > 0
          ? optionalString(value.text, "消息", requestId, MAX_MESSAGE_TEXT_LENGTH) ?? ""
          : requireString(value.text, "消息", requestId, MAX_MESSAGE_TEXT_LENGTH),
        order: requireTagList(value.order, "点名", requestId),
        attachmentIds: attachmentIds.map((id) => requireUuid(id, "附件 ID", requestId)),
      };
    }
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
    case "agent.catalog":
      return {
        type: "agent.catalog",
        requestId,
        groupId: requireUuid(value.groupId, "群 ID", requestId),
        agent: requireTag(value.agent, requestId),
      };
    case "agent.settings":
      return {
        type: "agent.settings",
        requestId,
        groupId: requireUuid(value.groupId, "群 ID", requestId),
        agent: requireTag(value.agent, requestId),
        model: nullableSetting(value.model, "模型", requestId),
        effort: nullableSetting(value.effort, "思考强度", requestId),
        permission: nullableSetting(value.permission, "权限", requestId),
      };
    case "group.compact":
      return {
        type: "group.compact",
        requestId,
        groupId: requireUuid(value.groupId, "群 ID", requestId),
        agents: requireTagList(value.agents, "要压缩的 AI", requestId),
      };
    case "group.rename":
      return {
        type: "group.rename",
        requestId,
        groupId: requireUuid(value.groupId, "群 ID", requestId),
        title: requireString(value.title, "群名", requestId, 200),
      };
    case "attachment.ticket": {
      const size = value.expectedSize;
      if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
        throw new ProtocolError("invalid_field", "文件大小不对。", requestId);
      }
      return {
        type: "attachment.ticket",
        requestId,
        groupId: requireUuid(value.groupId, "群 ID", requestId),
        originalName: requireString(value.originalName, "文件名", requestId, 1_024),
        declaredMime: optionalString(value.declaredMime, "文件类型", requestId, 255) ?? "",
        expectedSize: size,
      };
    }
    case "settings.username":
      // 空字符串也要交给后端，按规格给出“不能为空”的说明。
      if (typeof value.username !== "string" || value.username.length > 200) {
        throw new ProtocolError("invalid_field", "用户名格式不对。", requestId);
      }
      return { type: "settings.username", requestId, username: value.username };
    case "settings.agent.add":
      return { type: "settings.agent.add", requestId };
    case "settings.agent.update": {
      if (!("name" in value) && !("kind" in value) && !("color" in value)) {
        throw new ProtocolError("invalid_field", "至少要修改一个 AI 字段。", requestId);
      }
      return {
        type: "settings.agent.update",
        requestId,
        agentId: requireAgentId(value.agentId, requestId),
        ...("name" in value ? { name: looseString(value.name, "AI 名字", requestId, 200) } : {}),
        ...("kind" in value ? { kind: looseNullableString(value.kind, "CLI 种类", requestId, 32) } : {}),
        ...("color" in value ? { color: looseNullableString(value.color, "主色", requestId, 32) } : {}),
      };
    }
    case "settings.agent.remove":
      return { type: "settings.agent.remove", requestId, agentId: requireAgentId(value.agentId, requestId) };
    case "settings.agent.reorder":
      return {
        type: "settings.agent.reorder",
        requestId,
        order: requireAgentIdList(value.order, "AI 顺序", requestId),
      };
    case "settings.catalog":
      return { type: "settings.catalog", requestId, agentId: requireAgentId(value.agentId, requestId) };
    case "settings.defaults":
      return {
        type: "settings.defaults",
        requestId,
        agentId: requireAgentId(value.agentId, requestId),
        model: nullableSetting(value.model, "模型", requestId),
        effort: nullableSetting(value.effort, "思考强度", requestId),
        permission: nullableSetting(value.permission, "权限", requestId),
      };
    case "groups.trash":
    case "groups.restore":
    case "groups.purge": {
      const ids = value.groupIds;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BATCH_GROUPS) {
        throw new ProtocolError("invalid_field", "要处理的群不能为空或过多。", requestId);
      }
      return {
        type: value.type,
        requestId,
        groupIds: ids.map((id) => requireUuid(id, "群 ID", requestId)),
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

function requireTag(value: unknown, requestId: string): string {
  if (typeof value !== "string" || !AGENT_NAME_PATTERN.test(value)) {
    throw new ProtocolError("invalid_field", "AI 格式不对。", requestId);
  }
  return value;
}

function requireAgentId(value: unknown, requestId: string): string {
  return requireUuid(value, "AI 内部 ID", requestId);
}

/** 具体名字、种类和颜色规则由设置存储校验，以便错误能落到对应字段。 */
function looseString(value: unknown, label: string, requestId: string, maxLength: number): string {
  if (typeof value !== "string" || value.length > maxLength) {
    throw new ProtocolError("invalid_field", `${label}格式不对或过长。`, requestId);
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

/** null 表示跟随 CLI 的默认值；空字符串不接受。 */
function nullableSetting(value: unknown, label: string, requestId: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value || value.length > MAX_SETTING_LENGTH) {
    throw new ProtocolError("invalid_field", `${label}格式不对。`, requestId);
  }
  return value;
}

function requireTagList(value: unknown, label: string, requestId: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_AGENTS ||
      !value.every((item) => typeof item === "string" && AGENT_NAME_PATTERN.test(item))) {
    throw new ProtocolError("invalid_field", `${label}格式不对。`, requestId);
  }
  return [...value];
}

function requireAgentIdList(value: unknown, label: string, requestId: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_AGENTS) {
    throw new ProtocolError("invalid_field", `${label}格式不对。`, requestId);
  }
  return value.map((item) => requireUuid(item, label, requestId));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
