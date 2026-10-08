import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openViewableFile } from "./files.ts";
import {
  buildViewableRoots,
  ensurePreviewRoot,
  resolvePreviewRoot,
} from "./viewable-roots.ts";

test("builds an independent deduplicated viewable-root list", () => {
  const baseRoots = ["/projects", "/companion"];
  const roots = buildViewableRoots(baseRoots, ["/companion", "/preview"]);

  assert.deepEqual(roots, ["/projects", "/companion", "/preview"]);
  assert.notStrictEqual(roots, baseRoots);
  assert.deepEqual(buildViewableRoots(baseRoots), baseRoots);
});

test("creates the preview root and makes its files viewable despite a missing base root", async (t) => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), "lanting-viewable-roots-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const previewDirectory = resolvePreviewRoot(temp);
  const resolvedPreview = await ensurePreviewRoot(previewDirectory);
  const note = path.join(resolvedPreview, "note.md");
  await writeFile(note, "# preview");

  const roots = buildViewableRoots([path.join(temp, "missing")], [resolvedPreview]);
  const opened = await openViewableFile(roots, note);
  assert.ok(opened);
  assert.equal(await opened.handle.readFile("utf8"), "# preview");
  await opened.handle.close();
});

test("reports a preview-root preparation failure", async (t) => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), "lanting-viewable-roots-error-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const occupied = path.join(temp, "occupied");
  await writeFile(occupied, "not a directory");

  await assert.rejects(ensurePreviewRoot(occupied), /无法准备文件预览目录/u);
});
