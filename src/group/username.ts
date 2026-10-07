const MAX_USERNAME_LENGTH = 16;

/**
 * 按规格校验用户名，不合规时返回说明（不符合哪一条），合规返回 null。
 * - 只能用英文字母和数字，长度 1～16 位；
 * - 不能包含任何 AI 的标签名，不区分大小写，名字中间出现也不行（比如 aclaude、MyCodex）。
 *   接入的 AI 由调用方传入，以后接入新的 AI 自动加进排除范围。
 */
export function usernameProblem(username: string, agentTags: readonly string[]): string | null {
  if (username.length === 0) return "用户名不能为空。";
  if (username.length > MAX_USERNAME_LENGTH) {
    return `用户名最多 ${MAX_USERNAME_LENGTH} 位，现在是 ${username.length} 位。`;
  }
  if (!/^[A-Za-z0-9]+$/u.test(username)) return "用户名只能用英文字母和数字，不能有空格、符号或中文。";
  const lower = username.toLowerCase();
  const clash = agentTags.find((tag) => lower.includes(tag.toLowerCase()));
  if (clash) return `用户名不能包含 AI 的标签名（不区分大小写）：里面有“${clash}”。`;
  return null;
}
