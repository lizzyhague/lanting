import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export async function requireExecutable(value: unknown, label: string): Promise<string> {
  const executable = expandHome(requireString(value, label));
  if (!path.isAbsolute(executable)) throw new Error(`${label} must be an absolute path or start with ~/.`);
  await access(executable, constants.X_OK).catch((error: unknown) => {
    throw new Error(`${label} does not exist or is not executable: ${executable}`, { cause: error });
  });
  return executable;
}

export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}
