import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { cursorModule } from "./index.ts";

test("validates the Cursor executable when creating its adapter", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-cursor-module-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "agent");
  await writeFile(executable, "#!/bin/sh\n", { mode: 0o700 });

  assert.equal((await cursorModule.create({ executable }, "agents.cursor")).kind, "cursor");
  await assert.rejects(cursorModule.create({}, "agents.cursor"), /must be a non-empty string/u);
  await assert.rejects(cursorModule.create({ executable: "agent" }, "agents.cursor"), /must be an absolute path/u);
  await chmod(executable, 0o600);
  await assert.rejects(cursorModule.create({ executable }, "agents.cursor"), /does not exist or is not executable/u);
});
