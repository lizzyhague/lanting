import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

/** 新建群时可选的工作目录：项目根目录下第一层的非隐藏文件夹，按名字排序。 */
export async function listDirectories(projectRoot: string): Promise<string[]> {
  const entries = await readdir(projectRoot, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      names.push(entry.name);
    } else if (entry.isSymbolicLink() && await resolveDirectory(projectRoot, entry.name)) {
      names.push(entry.name);
    }
  }
  return names.sort((a, b) => a.localeCompare(b));
}

/**
 * 把浏览器选的目录名解析成绝对路径。只接受根目录下第一层的名字，
 * 解析符号链接后仍须落在根目录之内；不符合时返回 null。
 */
export async function resolveDirectory(projectRoot: string, name: string): Promise<string | null> {
  if (!name || name.startsWith(".") || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    return null;
  }
  try {
    const root = await realpath(projectRoot);
    const resolved = await realpath(path.join(root, name));
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return (await stat(resolved)).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}
