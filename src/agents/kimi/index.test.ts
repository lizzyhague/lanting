import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { kimiModule } from "./index.ts";

test("validates the Kimi executable when creating its adapter", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-kimi-module-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "kimi");
  await writeFile(executable, "#!/bin/sh\n", { mode: 0o700 });

  assert.equal((await kimiModule.create({ executable }, "agents.kimi")).kind, "kimi");
  await assert.rejects(kimiModule.create({}, "agents.kimi"), /must be a non-empty string/u);
  await assert.rejects(kimiModule.create({ executable: "kimi" }, "agents.kimi"), /must be an absolute path/u);
  await chmod(executable, 0o600);
  await assert.rejects(kimiModule.create({ executable }, "agents.kimi"), /does not exist or is not executable/u);
});
