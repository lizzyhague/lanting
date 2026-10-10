import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { claudeModule } from "./index.ts";

test("validates the Claude executable when creating its adapter", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-claude-module-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "claude");
  await writeFile(executable, "#!/bin/sh\n", { mode: 0o700 });

  assert.equal((await claudeModule.create({ executable }, "agents.claude")).kind, "claude");
  await assert.rejects(claudeModule.create({}, "agents.claude"), /必须是非空字符串/u);
  await assert.rejects(claudeModule.create({ executable: "claude" }, "agents.claude"), /必须是绝对路径/u);
  await chmod(executable, 0o600);
  await assert.rejects(claudeModule.create({ executable }, "agents.claude"), /不存在或不可执行/u);
});
