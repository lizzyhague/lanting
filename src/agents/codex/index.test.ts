import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { codexModule } from "./index.ts";

test("validates the Codex executable when creating its adapter", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-codex-module-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "codex");
  await writeFile(executable, "#!/bin/sh\n", { mode: 0o700 });

  assert.equal((await codexModule.create({ executable }, "agents.codex")).kind, "codex");
  await assert.rejects(codexModule.create({}, "agents.codex"), /必须是非空字符串/u);
  await assert.rejects(codexModule.create({ executable: "codex" }, "agents.codex"), /必须是绝对路径/u);
  await chmod(executable, 0o600);
  await assert.rejects(codexModule.create({ executable }, "agents.codex"), /不存在或不可执行/u);
});
