import { attachmentBlock, attachmentNote } from "../attachments/prompt.ts";
import { deliveryMessage } from "../deliveries/message.ts";
import type { TranscriptEntry } from "./types.ts";

/**
 * Assembles the group chat content an AI hasn't seen yet into one user message.
 *
 * - Its own replies aren't included; their delivery results arrive as platform messages.
 * - Interrupted or failed replies and group notices aren't forwarded to others; they stay in the chat record for the group owner.
 * - Each message is wrapped in the speaker's tag; tags are flat, never nested.
 * - Attachments from the group owner go only to the AIs called that round; other AIs only see a one-line attachment note with the name and path.
 *
 * Returns an empty string when there is nothing new.
 */
export function assembleMessage(
  entries: readonly TranscriptEntry[],
  self: string,
  username: string,
): string {
  const blocks: string[] = [];
  for (const entry of entries) {
    let tag: string;
    if (entry.from.role === "notice") continue;
    if (entry.from.role === "host") {
      tag = username;
    } else {
      if (entry.from.agent === self) {
        if (entry.deliveries?.length) blocks.push(deliveryMessage(self, entry.deliveries));
        continue;
      }
      if (entry.status !== "completed") continue;
      tag = entry.from.agent;
    }
    let body = entry.text;
    const attachments = entry.from.role === "host" ? entry.attachments ?? [] : [];
    if (attachments.length > 0) {
      const extra = entry.recipients?.includes(self)
        ? attachmentBlock(attachments)
        : attachments.map((attachment) => attachmentNote(username, attachment)).join("\n");
      body = body.trim() ? `${body}\n\n${extra}` : extra;
    }
    blocks.push(`<${tag}>\n${body}\n</${tag}>`);
    if (entry.from.role === "agent" && entry.deliveries?.length) {
      blocks.push(deliveryMessage(entry.from.agent, entry.deliveries));
    }
  }
  return blocks.join("\n\n");
}
