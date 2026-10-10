import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { grokModule } from "./index.ts";

test("validates the Grok executable when creating its adapter", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-grok-module-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "grok");
  await writeFile(executable, "#!/bin/sh\n", { mode: 0o700 });

  assert.equal((await grokModule.create({ executable }, "agents.grok")).kind, "grok");
  await assert.rejects(grokModule.create({}, "agents.grok"), /必须是非空字符串/u);
  await assert.rejects(grokModule.create({ executable: "grok" }, "agents.grok"), /必须是绝对路径/u);
  await chmod(executable, 0o600);
  await assert.rejects(grokModule.create({ executable }, "agents.grok"), /不存在或不可执行/u);
});
