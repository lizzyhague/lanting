import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openViewableFile } from "./files.ts";

test("file boundary accepts documents and images, rejects traversal and symlink escapes", async (t) => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), "lanting-viewable-files-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "root");
  const sibling = path.join(temp, "root-other");
  await mkdir(root);
  await mkdir(sibling);
  await mkdir(path.join(root, "directory.md"));
  await writeFile(path.join(sibling, "outside.md"), "outside");
  await writeFile(path.join(root, ".env"), "private");
  await writeFile(path.join(root, "source.ts"), "code");
  await writeFile(path.join(root, "中文 # ? %.md"), "# 文档");
  await symlink(sibling, path.join(root, "escape"));
  await symlink(path.join(root, ".env"), path.join(root, "secret.md"));
  await symlink(path.join(root, "中文 # ? %.md"), path.join(root, "alias.md"));

  for (const input of [
    "",
    "relative.md",
    path.join(root, "missing.md"),
    path.join(root, ".env"),
    path.join(root, "source.ts"),
    path.join(root, "directory.md"),
    path.join(root, "secret.md"),
    path.join(sibling, "outside.md"),
    path.join(root, "escape", "outside.md"),
    path.join(root, "bad\0.md"),
  ]) {
    assert.equal(await openViewableFile([root], input), null, input);
  }
  for (const input of [
    path.join(root, "中文 # ? %.md"),
    path.join(root, "alias.md"),
  ]) {
    const file = await openViewableFile([root], input);
    assert.ok(file, input);
    try {
      assert.equal(file.contentType, "text/markdown; charset=utf-8");
      assert.equal(await file.handle.readFile("utf8"), "# 文档");
    } finally {
      await file.handle.close();
    }
  }
  for (const suffix of ["svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "PNG"]) {
    const image = path.join(root, "image." + suffix);
    await writeFile(image, "image");
    const file = await openViewableFile([root], image);
    assert.ok(file, suffix);
    assert.match(file.contentType, /^image\//u);
    await file.handle.close();
  }
});

test("directory identity respects the filesystem's case behavior", async (t) => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), "lanting-viewable-file-case-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "Root");
  await mkdir(root);
  await writeFile(path.join(root, "note.md"), "inside");
  const alternate = path.join(temp, "root");
  let insensitive = false;
  try {
    insensitive = await realpath(alternate) === await realpath(root);
  } catch {
    // 大小写敏感卷上这是另一个尚不存在的目录。
  }
  if (!insensitive) {
    await mkdir(alternate);
    await writeFile(path.join(alternate, "note.md"), "outside");
  }
  const file = await openViewableFile([root], path.join(alternate, "note.md"));
  if (insensitive) {
    assert.ok(file);
    assert.equal(await file.handle.readFile("utf8"), "inside");
    await file.handle.close();
  } else {
    assert.equal(file, null);
  }
});

test("absolute paths may use any allowed root; missing roots are skipped", async (t) => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), "lanting-viewable-file-roots-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const functional = path.join(temp, "functional");
  const companion = path.join(temp, "companion");
  const outside = path.join(temp, "outside");
  await mkdir(functional);
  await mkdir(companion);
  await mkdir(outside);
  await writeFile(path.join(functional, "note.md"), "functional");
  await writeFile(path.join(companion, "note.md"), "companion");
  await writeFile(path.join(companion, "图片.png"), "image");
  await writeFile(path.join(outside, "note.md"), "outside");
  await symlink(path.join(outside, "note.md"), path.join(companion, "escape.md"));
  const roots = [functional, path.join(temp, "missing"), companion];

  assert.equal(await openViewableFile(roots, "note.md"), null);

  const functionalFile = await openViewableFile(roots, path.join(functional, "note.md"));
  assert.ok(functionalFile);
  assert.equal(await functionalFile.handle.readFile("utf8"), "functional");
  await functionalFile.handle.close();

  const companionFile = await openViewableFile(roots, path.join(companion, "note.md"));
  assert.ok(companionFile);
  assert.equal(await companionFile.handle.readFile("utf8"), "companion");
  await companionFile.handle.close();

  const image = await openViewableFile(roots, path.join(companion, "图片.png"));
  assert.ok(image);
  assert.equal(image.contentType, "image/png");
  await image.handle.close();

  assert.equal(await openViewableFile(roots, path.join(outside, "note.md")), null);
  assert.equal(await openViewableFile(roots, path.join(companion, "escape.md")), null);
  assert.equal(await openViewableFile([functional], path.join(companion, "note.md")), null);
  assert.equal(await openViewableFile([], path.join(functional, "note.md")), null);
});
