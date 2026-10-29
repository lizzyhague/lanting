import { constants, type BigIntStats } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { findDeliveryLinks } from "../../public/markdown.js";
import type { SharedUploadClient } from "../attachments/shared-upload-client.ts";
import { MAX_UPLOAD_BYTES, type AttachmentBinding } from "../attachments/types.ts";
import { hasSensitiveFileName } from "../security/sensitive-files.ts";
import { insideRoot } from "../server/files.ts";

export type DeliveryFailure = "interrupted" | "too_many" | "invalid_path" | "outside_root" |
  "not_file" | "sensitive_file" | "too_large" | "file_changed" | "unavailable" | "upload_failed";

export type DeliveryResult = { path: string; name: string } & (
  { status: "failed"; reason: DeliveryFailure } |
  { status: "available"; attachmentId: string; size: number; expiresAtMs: number; binding: AttachmentBinding }
);

type UploadClient = Pick<SharedUploadClient, "createTicket" | "uploadStream">;

class DeliveryError extends Error {
  readonly reason: DeliveryFailure;
  constructor(reason: DeliveryFailure) { super(reason); this.reason = reason; }
}

export function interruptedDeliveries(source: string): DeliveryResult[] {
  return [...new Set(findDeliveryLinks(source).map((link) => link.path))].map((filePath) => ({
    path: filePath, name: path.basename(filePath), status: "failed", reason: "interrupted",
  }));
}

/** Results are immutable once the reply is saved. Cancellation invalidates the entire batch. */
export async function prepareDeliveries(options: {
  source: string; root: string; binding: AttachmentBinding; client: UploadClient; signal: AbortSignal;
}): Promise<DeliveryResult[]> {
  const paths = [...new Set(findDeliveryLinks(options.source).map((link) => link.path))];
  const results: DeliveryResult[] = [];
  for (const [index, filePath] of paths.entries()) {
    if (options.signal.aborted) return interruptedDeliveries(options.source);
    const base = { path: filePath, name: path.basename(filePath) };
    if (index >= 100) {
      results.push({ ...base, status: "failed", reason: "too_many" });
      continue;
    }
    let handle: FileHandle | undefined;
    try {
      if (!path.isAbsolute(filePath) || filePath.includes("\0")) throw new DeliveryError("invalid_path");
      const resolved = await realpath(filePath);
      if (!await insideRoot(await realpath(options.root), resolved)) throw new DeliveryError("outside_root");
      const beforeOpen = await stat(resolved, { bigint: true });
      handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await handle.stat({ bigint: true });
      if (before.dev !== beforeOpen.dev || before.ino !== beforeOpen.ino) throw new DeliveryError("file_changed");
      if (!before.isFile()) throw new DeliveryError("not_file");
      if (hasSensitiveFileName(filePath) || hasSensitiveFileName(resolved)) throw new DeliveryError("sensitive_file");
      if (before.size > BigInt(MAX_UPLOAD_BYTES)) throw new DeliveryError("too_large");
      options.signal.throwIfAborted();
      const ticket = await options.client.createTicket({
        ...options.binding, originalName: base.name, declaredMime: "", expectedSize: Number(before.size),
      });
      options.signal.throwIfAborted();
      // Empty uploads have no final chunk to withhold.
      if (before.size === 0n) assertUnchanged(before, await handle.stat({ bigint: true }));
      const attachment = await options.client.uploadStream(
        ticket.ticket, Number(before.size), checkedChunks(handle, before, options.signal), options.signal,
      );
      results.push({ ...base, status: "available", attachmentId: attachment.id,
        size: attachment.size, expiresAtMs: attachment.expiresAtMs, binding: { ...options.binding } });
    } catch (error) {
      if (options.signal.aborted) return interruptedDeliveries(options.source);
      const reason = error instanceof DeliveryError ? error.reason :
        error instanceof Error && "code" in error && ["ENOENT", "EACCES", "ENOTDIR", "ELOOP"].includes(String(error.code))
          ? "unavailable" : "upload_failed";
      results.push({ ...base, status: "failed", reason });
    } finally {
      await handle?.close();
    }
  }
  return options.signal.aborted ? interruptedDeliveries(options.source) : results;
}

function assertUnchanged(before: BigIntStats, after: BigIntStats): void {
  if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
    throw new DeliveryError("file_changed");
  }
}

async function* checkedChunks(handle: FileHandle, before: BigIntStats, signal: AbortSignal): AsyncIterable<Uint8Array> {
  let position = 0;
  const size = Number(before.size);
  while (position < size) {
    signal.throwIfAborted();
    const buffer = Buffer.alloc(Math.min(64 * 1_024, size - position));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) throw new DeliveryError("file_changed");
    position += bytesRead;
    if (position === size) assertUnchanged(before, await handle.stat({ bigint: true }));
    signal.throwIfAborted();
    yield buffer.subarray(0, bytesRead);
  }
}
