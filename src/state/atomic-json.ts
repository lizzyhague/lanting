import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

/** Chat records and session mappings both contain conversation content, so only the owner may read and write them. */
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIRECTORY_MODE = 0o700;

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
}

/** Write a temp file → fsync → rename over. After a crash the content is either the old version or the complete new one. */
export async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await ensurePrivateDirectory(directory);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );

  const handle = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
  let committed = false;
  try {
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, filePath);
    committed = true;
  } finally {
    // If any of serialize, write, fsync, close or rename fails, no fragments may pile up in the data directory.
    if (!committed) await rm(temporaryPath, { force: true });
  }
}

/** Returns null when the file doesn't exist; throws on corrupt content, leaving the caller to decide whether to stay not ready. */
export async function readJsonIfPresent(filePath: string): Promise<unknown | null> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`State file is not valid JSON: ${filePath}`, { cause: error });
  }
}

export function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}
