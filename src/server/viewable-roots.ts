import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * 合并项目各自计算出的基础查看根与服务级额外查看根。
 * 输入应当已经解析成真实绝对路径；这里仅负责形成独立、去重的白名单。
 */
export function buildViewableRoots(
  baseRoots: readonly string[],
  additionalRoots: readonly string[] = [],
): string[] {
  return [...new Set([...baseRoots, ...additionalRoots])];
}

export function resolvePreviewRoot(homeDirectory: string = homedir()): string {
  return path.join(homeDirectory, "preview");
}

export async function ensurePreviewRoot(
  directory: string = resolvePreviewRoot(),
): Promise<string> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return await realpath(directory);
  } catch (error) {
    throw new Error(`无法准备文件预览目录：${directory}`, { cause: error });
  }
}
