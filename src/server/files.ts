import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";

const TYPES: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

// 比较真实目录身份，兼容 macOS 上同时存在的大小写敏感与不敏感卷。
async function insideRoot(root: string, candidate: string): Promise<boolean> {
  const rootInfo = await stat(root);
  let parent = path.dirname(candidate);
  for (;;) {
    const info = await stat(parent);
    if (info.dev === rootInfo.dev && info.ino === rootInfo.ino) return true;
    const next = path.dirname(parent);
    if (next === parent) return false;
    parent = next;
  }
}

async function insideRootSafe(root: string, candidate: string): Promise<boolean> {
  try {
    return await insideRoot(root, candidate);
  } catch {
    return false;
  }
}

async function insideAnyRoot(roots: readonly string[], candidate: string): Promise<boolean> {
  for (const root of roots) {
    if (await insideRootSafe(root, candidate)) return true;
  }
  return false;
}

export async function openViewableFile(roots: readonly string[], input: string): Promise<{
  handle: FileHandle;
  size: number;
  contentType: string;
} | null> {
  const contentType = TYPES[path.extname(input).toLowerCase()];
  if (!input || input.includes("\0") || !path.isAbsolute(input) || !contentType) return null;
  let handle: FileHandle | undefined;
  try {
    const resolved = await realpath(input);
    const allowed = await insideAnyRoot(roots, resolved);
    // 白名单后缀的软链接也不能借目标文件的其他后缀绕过类型限制。
    if (!allowed || TYPES[path.extname(resolved).toLowerCase()] !== contentType) return null;
    handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    const currentResolved = await realpath(resolved);
    const current = await stat(currentResolved);
    const stillAllowed = await insideAnyRoot(roots, currentResolved);
    if (!info.isFile() || info.dev !== current.dev || info.ino !== current.ino ||
        !stillAllowed) {
      await handle.close();
      return null;
    }
    return { handle, size: info.size, contentType };
  } catch {
    await handle?.close();
    return null;
  }
}
