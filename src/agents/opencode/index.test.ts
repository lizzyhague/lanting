import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { opencodeModule } from "./index.ts";

test("validates the OpenCode executable when creating its adapter", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-opencode-module-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "opencode");
  await writeFile(executable, "#!/bin/sh\n", { mode: 0o700 });

  assert.equal((await opencodeModule.create({ executable }, "agents.opencode")).kind, "opencode");
  await assert.rejects(opencodeModule.create({}, "agents.opencode"), /must be a non-empty string/u);
  await assert.rejects(opencodeModule.create({ executable: "opencode" }, "agents.opencode"), /must be an absolute path/u);
  await chmod(executable, 0o600);
  await assert.rejects(opencodeModule.create({ executable }, "agents.opencode"), /does not exist or is not executable/u);
});
