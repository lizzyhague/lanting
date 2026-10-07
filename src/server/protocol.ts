export const MAX_BROWSER_MESSAGE_BYTES = 2_097_152;

export type BrowserRequest =
  | { type: "connection.ready"; requestId: string };

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
      return { type: "connection.ready", requestId };
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
