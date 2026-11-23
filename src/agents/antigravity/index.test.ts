import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { antigravityModule, resolveAdditionalDirectories } from "./index.ts";

test("validates the Antigravity executable when creating its adapter", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-antigravity-module-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "agy_acp_server.par");
  await writeFile(executable, "#!/bin/sh\n", { mode: 0o700 });

  assert.equal((await antigravityModule.create({ executable }, "agents.antigravity", { stateDirectory: directory })).kind, "antigravity");
  await assert.rejects(antigravityModule.create({}, "agents.antigravity", { stateDirectory: directory }), /must be a non-empty string/u);
  await assert.rejects(antigravityModule.create({ executable: "agy_acp_server.par" }, "agents.antigravity", { stateDirectory: directory }), /must be an absolute path/u);
  await chmod(executable, 0o600);
  await assert.rejects(antigravityModule.create({ executable }, "agents.antigravity", { stateDirectory: directory }), /does not exist or is not executable/u);
});

test("merges default and configured additionalDirectories while validating configured entries", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-antigravity-dirs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "agy_acp_server.par");
  const extraDir = path.join(directory, "refs");
  const defaultDir = path.join(directory, "projects");
  const missingDefault = path.join(directory, "blobs-not-yet-created");
  const regularFile = path.join(directory, "note.txt");
  await writeFile(executable, "#!/bin/sh\n", { mode: 0o700 });
  await mkdir(extraDir);
  await mkdir(defaultDir);
  await writeFile(regularFile, "hi");

  const resolved = await resolveAdditionalDirectories(
    [defaultDir, missingDefault, "/"],
    [extraDir, defaultDir],
    "agents.antigravity.additionalDirectories",
  );
  assert.deepEqual(resolved, [await realpath(defaultDir), path.resolve(missingDefault), await realpath(extraDir)]);

  assert.equal(
    (await antigravityModule.create(
      { executable, additionalDirectories: [extraDir] },
      "agents.antigravity",
      { stateDirectory: directory, defaultAdditionalDirectories: [defaultDir, missingDefault] },
    )).kind,
    "antigravity",
  );

  for (const [bad, pattern] of [
    ["not-an-array", /must be an array/u],
    [[""], /must be a non-empty string/u],
    [["relative/dir"], /must be an absolute path/u],
    [["/"], /must not be the filesystem root/u],
    [[path.join(directory, "missing")], /does not exist/u],
    [[regularFile], /is not a directory/u],
  ] as const) {
    await assert.rejects(
      antigravityModule.create({ executable, additionalDirectories: bad }, "agents.antigravity", { stateDirectory: directory }),
      pattern,
    );
  }
});
