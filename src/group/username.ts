import { localText, type LocalText } from "../i18n/text.ts";

const MAX_USERNAME_LENGTH = 16;

/**
 * Validates the username against the spec, returning an explanation (which rule failed) when invalid, or null when valid.
 * - Only English letters and digits, 1-16 characters long;
 * - Must not exactly match any AI name, case-insensitively.
 */
export function usernameProblem(username: string, agentNames: readonly string[]): LocalText | null {
  if (username.length === 0) return localText("error.usernameEmpty");
  if (username.length > MAX_USERNAME_LENGTH) {
    return localText("error.usernameTooLong", { max: MAX_USERNAME_LENGTH, length: username.length });
  }
  if (!/^[A-Za-z0-9]+$/u.test(username)) return localText("error.usernameCharset");
  const lower = username.toLowerCase();
  const clash = agentNames.find((name) => name.toLowerCase() === lower);
  if (clash) return localText("error.usernameMatchesAgent", { name: clash });
  return null;
}
