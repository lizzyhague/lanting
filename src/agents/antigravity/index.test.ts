import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { antigravityModule } from "./index.ts";

test("validates the Antigravity executable when creating its adapter", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-antigravity-module-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "agy_acp_server.par");
  await writeFile(executable, "#!/bin/sh\n", { mode: 0o700 });

  assert.equal((await antigravityModule.create({ executable }, "agents.antigravity")).kind, "antigravity");
  await assert.rejects(antigravityModule.create({}, "agents.antigravity"), /must be a non-empty string/u);
  await assert.rejects(antigravityModule.create({ executable: "agy_acp_server.par" }, "agents.antigravity"), /must be an absolute path/u);
  await chmod(executable, 0o600);
  await assert.rejects(antigravityModule.create({ executable }, "agents.antigravity"), /does not exist or is not executable/u);
});
