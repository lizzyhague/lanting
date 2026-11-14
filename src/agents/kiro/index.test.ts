import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { kiroModule } from "./index.ts";

test("validates the Kiro executable when creating its adapter", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-kiro-module-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "kiro");
  await writeFile(executable, "#!/bin/sh\n", { mode: 0o700 });

  assert.equal((await kiroModule.create({ executable }, "agents.kiro")).kind, "kiro");
  await assert.rejects(kiroModule.create({}, "agents.kiro"), /must be a non-empty string/u);
  await assert.rejects(kiroModule.create({ executable: "kiro" }, "agents.kiro"), /must be an absolute path/u);
  await chmod(executable, 0o600);
  await assert.rejects(kiroModule.create({ executable }, "agents.kiro"), /does not exist or is not executable/u);
});
