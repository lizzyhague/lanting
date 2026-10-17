import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Merges the base view roots computed per project with service-level extra view roots.
 * Inputs should already be resolved to real absolute paths; this only forms a separate, deduplicated allowlist.
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
    throw new Error(`Cannot prepare the file preview directory: ${directory}`, { cause: error });
  }
}
