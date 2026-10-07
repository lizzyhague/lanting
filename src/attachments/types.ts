export const MAX_UPLOAD_BYTES = 25 * 1_048_576;
export const MAX_MESSAGE_ATTACHMENTS = 100;
export const ATTACHMENT_LEASE_RENEW_INTERVAL_MS = 5 * 60_000;

/** ai-remote-upload 里 lanting 的调用方名。整个群共用，附件才能发给群里任意一个 AI。 */
export const UPLOAD_CALLER = "lanting";

export type AttachmentBinding = {
  caller: typeof UPLOAD_CALLER;
  projectId: string;
  sessionId: string;
};

export type PublicAttachment = AttachmentBinding & {
  id: string;
  originalName: string;
  declaredMime: string;
  detectedMime: string;
  kind: "image" | "file";
  size: number;
  sha256: string;
  createdAtMs: number;
  expiresAtMs: number;
};

/** 只允许留在 lanting 后端；绝不能进入浏览器协议或公开日志。 */
export type ResolvedAttachment = PublicAttachment & { path: string };

export type UploadTicket = {
  ticket: string;
  expiresAtMs: number;
  attachment: Pick<
    PublicAttachment,
    "caller" | "projectId" | "sessionId" | "originalName" | "declaredMime"
  > & { expectedSize: number };
};

export type AttachmentLease = {
  leaseId: string;
  ownerId: string;
  expiresAtMs: number;
  attachments: ResolvedAttachment[];
};

export class SharedUploadError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "SharedUploadError";
    this.code = code;
    this.status = status;
  }
}
