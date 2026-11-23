import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { expandHome, requireExecutable, requireString } from "../../config/fields.ts";
import type { AgentModule } from "../module.ts";
import { AntigravityAdapter } from "./adapter.ts";

export const antigravityModule: AgentModule = {
  kind: "antigravity",
  displayName: "Antigravity",
  async create(section, label, context) {
    const executable = await requireExecutable(section.executable, `${label}.executable`);
    const additionalDirectories = await resolveAdditionalDirectories(
      context.defaultAdditionalDirectories,
      section.additionalDirectories,
      `${label}.additionalDirectories`,
    );
    return new AntigravityAdapter({
      executable,
      stateDirectory: context.stateDirectory,
      additionalDirectories,
    });
  },
};

/**
 * Merges platform default roots (which may not exist yet, such as the shared upload blobs directory)
 * with validated user-configured directories, preserving order without duplicates.
 */
export async function resolveAdditionalDirectories(
  defaults: readonly string[] | undefined,
  configured: unknown,
  label: string,
): Promise<string[]> {
  const merged = new Set<string>();
  for (const entry of defaults ?? []) {
    const resolved = await resolveDefaultDirectory(entry);
    if (resolved) merged.add(resolved);
  }
  if (configured !== undefined) {
    if (!Array.isArray(configured)) {
      throw new Error(`${label} must be an array of directory paths.`);
    }
    for (let index = 0; index < configured.length; index += 1) {
      merged.add(await requireDirectory(configured[index], `${label}[${index}]`));
    }
  }
  return [...merged];
}

async function resolveDefaultDirectory(directory: string): Promise<string | null> {
  const expanded = expandHome(directory.trim());
  if (!expanded || !path.isAbsolute(expanded)) return null;
  const normalized = path.resolve(expanded);
  if (path.dirname(normalized) === normalized) return null;
  const canonical = await realpath(normalized).catch(() => normalized);
  return path.dirname(canonical) === canonical ? null : canonical;
}

async function requireDirectory(value: unknown, label: string): Promise<string> {
  const expanded = expandHome(requireString(value, label));
  if (!path.isAbsolute(expanded)) {
    throw new Error(`${label} must be an absolute path or start with ~/.`);
  }
  const normalized = path.resolve(expanded);
  if (path.dirname(normalized) === normalized) {
    throw new Error(`${label} must not be the filesystem root.`);
  }
  const canonical = await realpath(normalized).catch((error: unknown) => {
    throw new Error(`${label} does not exist: ${expanded}`, { cause: error });
  });
  if (path.dirname(canonical) === canonical) {
    throw new Error(`${label} must not be the filesystem root.`);
  }
  if (!(await stat(canonical)).isDirectory()) {
    throw new Error(`${label} is not a directory: ${expanded}`);
  }
  return canonical;
}
