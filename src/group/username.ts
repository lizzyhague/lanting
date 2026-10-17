const MAX_USERNAME_LENGTH = 16;

/**
 * Validates the username against the spec, returning an explanation (which rule failed) when invalid, or null when valid.
 * - Only English letters and digits, 1-16 characters long;
 * - Must not exactly match any AI name, case-insensitively.
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
