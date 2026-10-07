import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { writeJsonAtomically } from "./atomic-json.ts";

test("a failed write preserves the old file and removes its temporary file", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-atomic-json-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "state.json");

  await writeJsonAtomically(filePath, { version: 1 });
  await assert.rejects(() => writeJsonAtomically(filePath, { unserializable: 1n }));

  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), { version: 1 });
  assert.deepEqual(await readdir(directory), ["state.json"]);
});
