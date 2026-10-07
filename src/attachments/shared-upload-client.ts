import { request as httpRequest, type IncomingMessage } from "node:http";
import { homedir } from "node:os";
import path from "node:path";

import {
  type AttachmentBinding,
  type AttachmentLease,
  type PublicAttachment,
  SharedUploadError,
  type UploadTicket,
} from "./types.ts";

const MAX_RESPONSE_BYTES = 1_048_576;

/**
 * ai-remote-upload 的薄客户端，搬自 Relayu `src/attachments/shared-upload-client.ts`。
 * 存储、票据、租约和清理逻辑全部由 ai-remote-upload 持有。
 */
export class SharedUploadClient {
  readonly #socketPath: string;

  constructor(socketPath = defaultSocketPath()) {
    this.#socketPath = socketPath;
  }

  createTicket(input: AttachmentBinding & {
    originalName: string;
    declaredMime: string;
    expectedSize: number;
  }): Promise<UploadTicket> {
    return this.#jsonRequest("POST", "/v1/tickets", input);
  }

  async upload(
    ticket: string,
    contentLength: number,
    source: IncomingMessage,
  ): Promise<PublicAttachment> {
    const response = await this.#streamRequest<{ attachment: PublicAttachment }>(
      "/v1/uploads",
      ticket,
      contentLength,
      source,
    );
    return response.attachment;
  }

  async createLease(
    binding: AttachmentBinding,
    ownerId: string,
    attachmentIds: string[],
  ): Promise<AttachmentLease> {
    const response = await this.#jsonRequest<{ lease: AttachmentLease }>(
      "POST",
      "/v1/leases",
      { ...binding, ownerId, attachmentIds },
    );
    return response.lease;
  }

  renewLease(leaseId: string, ownerId: string): Promise<{ leaseId: string; expiresAtMs: number }> {
    return this.#jsonRequest(
      "POST",
      `/v1/leases/${encodeURIComponent(leaseId)}/renew`,
      { ownerId },
    );
  }

  async releaseLease(leaseId: string, ownerId: string): Promise<void> {
    await this.#jsonRequest(
      "POST",
      `/v1/leases/${encodeURIComponent(leaseId)}/release`,
      { ownerId },
    );
  }

  #jsonRequest<Result>(method: string, route: string, value: unknown): Promise<Result> {
    const body = value === undefined ? null : Buffer.from(JSON.stringify(value));
    return new Promise((resolve, reject) => {
      const request = httpRequest({
        socketPath: this.#socketPath,
        path: route,
        method,
        headers: body
          ? { "content-type": "application/json", "content-length": body.byteLength }
          : undefined,
      }, (response) => void collectResponse<Result>(response).then(resolve, reject));
      request.once("error", (error) => reject(connectionError(error)));
      request.setTimeout(30_000, () => request.destroy(new Error("共享上传服务请求超时。")));
      request.end(body ?? undefined);
    });
  }

  #streamRequest<Result>(
    route: string,
    ticket: string,
    contentLength: number,
    source: IncomingMessage,
  ): Promise<Result> {
    return new Promise((resolve, reject) => {
      const request = httpRequest({
        socketPath: this.#socketPath,
        path: route,
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": contentLength,
          "x-upload-ticket": ticket,
        },
      }, (response) => void collectResponse<Result>(response).then(resolve, reject));
      request.once("error", (error) => reject(connectionError(error)));
      source.once("aborted", () => request.destroy(new Error("浏览器中断了上传。")));
      source.once("error", (error) => request.destroy(error));
      source.pipe(request);
    });
  }
}

function defaultSocketPath(): string {
  const configured = process.env.AI_REMOTE_UPLOAD_SOCKET?.trim();
  if (!configured) {
    return path.join(homedir(), ".local", "share", "ai-remote", "upload.sock");
  }
  const expanded = configured === "~"
    ? homedir()
    : configured.startsWith("~/")
    ? path.join(homedir(), configured.slice(2))
    : configured;
  return path.resolve(expanded);
}

async function collectResponse<Result>(response: IncomingMessage): Promise<Result> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const raw of response) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    length += chunk.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      throw new SharedUploadError("response_too_large", "共享上传服务返回了过大的响应。", 502);
    }
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new SharedUploadError("invalid_response", "共享上传服务返回了无效响应。", 502);
  }
  const object = isObject(value) ? value : null;
  if ((response.statusCode ?? 500) >= 400) {
    const error = isObject(object?.error) ? object.error : null;
    throw new SharedUploadError(
      typeof error?.code === "string" ? error.code : "upload_service_error",
      typeof error?.message === "string" ? error.message : "共享上传服务拒绝了请求。",
      response.statusCode ?? 502,
    );
  }
  if (!object) throw new SharedUploadError("invalid_response", "共享上传服务返回了无效响应。", 502);
  return object as Result;
}

function connectionError(error: Error): SharedUploadError {
  console.error(`无法连接共享上传服务：${error.message}`);
  return new SharedUploadError("upload_service_unavailable", "共享上传服务暂时不可用。", 503);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
