import type { TranscriptEntry } from "./types.ts";

/**
 * 把某个 AI 还没看到的群聊内容拼成一条 user 消息。
 *
 * - 它自己的发言不拼进去：那些已经是它原生会话里的 assistant 消息。
 * - 被打断或出错的回复不转给别人，只留在群聊记录里给群主看。
 * - 每段话用发言者的标签包起来，标签平级，不嵌套。
 *
 * 返回空字符串表示没有新内容。
 */
export function assembleMessage(
  entries: readonly TranscriptEntry[],
  self: string,
  username: string,
): string {
  const blocks: string[] = [];
  for (const entry of entries) {
    let tag: string;
    if (entry.from.role === "host") {
      tag = username;
    } else {
      if (entry.from.agent === self || entry.status !== "completed") continue;
      tag = entry.from.agent;
    }
    blocks.push(`<${tag}>\n${entry.text}\n</${tag}>`);
  }
  return blocks.join("\n\n");
}
