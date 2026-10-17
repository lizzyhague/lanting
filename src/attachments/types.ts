import { englishText, type LocalText } from "../i18n/text.ts";

export const MAX_UPLOAD_BYTES = 25 * 1_048_576;
export const MAX_MESSAGE_ATTACHMENTS = 100;
export const ATTACHMENT_LEASE_RENEW_INTERVAL_MS = 5 * 60_000;

/** lanting's caller name in ai-remote-upload. Shared by the whole group, so attachments can be sent to any AI in the group. */
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

/** Must stay in the lanting backend only; never in the browser protocol or public logs. */
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

/**
 * text, when given, is shown in the browser's language and the message is its English form; a plain string is a
 * technical detail (or the upload service's own message) shown as is.
 */
export class SharedUploadError extends Error {
  readonly code: string;
  readonly status: number;
  readonly text: LocalText | undefined;

  constructor(code: string, text: LocalText | string, status = 400) {
    super(typeof text === "string" ? text : englishText(text));
    this.name = "SharedUploadError";
    this.code = code;
    this.status = status;
    this.text = typeof text === "string" ? undefined : text;
  }
}
