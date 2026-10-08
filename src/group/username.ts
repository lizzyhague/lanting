const MAX_USERNAME_LENGTH = 16;

/**
 * 按规格校验用户名，不合规时返回说明（不符合哪一条），合规返回 null。
 * - 只能用英文字母和数字，长度 1～16 位；
 * - 不能与任一 AI 名字完全相同，不区分大小写。
 */
export function usernameProblem(username: string, agentNames: readonly string[]): string | null {
  if (username.length === 0) return "用户名不能为空。";
  if (username.length > MAX_USERNAME_LENGTH) {
    return `用户名最多 ${MAX_USERNAME_LENGTH} 位，现在是 ${username.length} 位。`;
  }
  if (!/^[A-Za-z0-9]+$/u.test(username)) return "用户名只能用英文字母和数字，不能有空格、符号或中文。";
  const lower = username.toLowerCase();
  const clash = agentNames.find((name) => name.toLowerCase() === lower);
  if (clash) return `用户名不能和 AI 名字相同（不区分大小写）：“${clash}”。`;
  return null;
}
