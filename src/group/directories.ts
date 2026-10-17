import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

/** Working directories selectable when creating a group: non-hidden top-level folders under the project root, sorted by name. */
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
 * Resolves the directory name chosen in the browser to an absolute path. Only top-level names under the root are accepted,
 * and after resolving symlinks the result must still be inside the root; otherwise returns null.
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
