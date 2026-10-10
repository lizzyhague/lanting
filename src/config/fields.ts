import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export async function requireExecutable(value: unknown, label: string): Promise<string> {
  const executable = expandHome(requireString(value, label));
  if (!path.isAbsolute(executable)) throw new Error(`${label} 必须是绝对路径或 ~/ 开头的路径。`);
  await access(executable, constants.X_OK).catch((error: unknown) => {
    throw new Error(`${label} 不存在或不可执行：${executable}`, { cause: error });
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
    throw new Error(`${label} 必须是非空字符串。`);
  }
  return value.trim();
}
