import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { piModule } from "./index.ts";

test("validates the Pi executable when creating its adapter", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-pi-module-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "pi");
  await writeFile(executable, "#!/bin/sh\n", { mode: 0o700 });

  assert.equal((await piModule.create({ executable }, "agents.pi")).kind, "pi");
  await assert.rejects(piModule.create({}, "agents.pi"), /must be a non-empty string/u);
  await assert.rejects(piModule.create({ executable: "pi" }, "agents.pi"), /must be an absolute path/u);
  await chmod(executable, 0o600);
  await assert.rejects(piModule.create({ executable }, "agents.pi"), /does not exist or is not executable/u);
});
