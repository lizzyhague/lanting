import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { listDirectories, resolveDirectory } from "./directories.ts";

test("lists first-level visible folders and resolves only names inside the root", async (t) => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "lanting-dirs-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  await mkdir(path.join(root, "beta", "nested"), { recursive: true });
  await mkdir(path.join(root, "alpha"));
  await mkdir(path.join(root, ".hidden"));
  await mkdir(outside);
  await writeFile(path.join(root, "file.txt"), "");
  await symlink(path.join(root, "alpha"), path.join(root, "linked"));
  await symlink(outside, path.join(root, "escape"));

  assert.deepEqual(await listDirectories(root), ["alpha", "beta", "linked"]);
  assert.equal(await resolveDirectory(root, "beta"), path.join(root, "beta"));
  assert.equal(await resolveDirectory(root, "linked"), path.join(root, "alpha"));
  for (const name of ["", ".hidden", "..", "beta/nested", "file.txt", "escape", "missing"]) {
    assert.equal(await resolveDirectory(root, name), null, name);
  }
});
