import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [app, styles] = await Promise.all([
  readFile(new URL("./app.js", import.meta.url), "utf8"),
  readFile(new URL("./styles.css", import.meta.url), "utf8"),
]);

test("active groups put cross-directory pins above a divider", () => {
  const visible = app.slice(
    app.indexOf("function visibleGroups()"),
    app.indexOf("function compareGroupSummaries("),
  );
  assert.match(visible, /matching\.filter\(\(group\) => group\.pinned\)/u);
  assert.match(visible, /!group\.pinned && group\.directory === directory/u);

  const render = app.slice(
    app.indexOf("function renderGroupList()"),
    app.indexOf("function groupItem("),
  );
  assert.match(render, /group-pin-section/u);
  assert.match(render, /group-pin-divider/u);
  assert.match(styles, /\.group-pin-divider\s*\{[^}]*border-top:\s*2px solid var\(--border-strong\)/su);
});

test("group rows keep rename and pin actions outside selection and trash", () => {
  const item = app.slice(
    app.indexOf("function groupItem("),
    app.indexOf("function groupPinIcon("),
  );
  assert.match(item, /className = "group-open"/u);
  assert.match(item, /if \(!selectionBar\.isSelecting\(\) && !trash\)/u);
  assert.match(item, /className = "group-item-actions"/u);
  assert.match(item, /className = "group-rename-trigger quiet small icon-button"/u);
  assert.match(item, /className = "group-pin-trigger quiet small icon-button"/u);
  assert.ok(item.indexOf("actions.append(rename, pin)") > item.indexOf("openRenameDialog(group)"));
  assert.match(app, /request\("group\.pin"/u);
  assert.match(item, /if \(!group\.pinned\) openRenameDialog\(group\)/u);

  const icon = app.slice(
    app.indexOf("function groupPinIcon("),
    app.indexOf("async function toggleGroupPin("),
  );
  assert.match(icon, /const LOOSE = \{/u);
  assert.match(icon, /const DRIVEN = \{/u);
  assert.match(icon, /if \(pinned\) body\.setAttribute\("fill", "currentColor"\)/u);

  const menu = app.slice(app.indexOf("function renderPlusMenu()"), app.indexOf("function menuItem("));
  assert.doesNotMatch(menu, /menuItem\("重命名"/u);
});

test("opening a cross-directory pin syncs the directory before subscribing", () => {
  const open = app.slice(
    app.indexOf("async function openListedGroup("),
    app.indexOf("/** 当前的群被删了"),
  );
  assert.match(open, /state\.directories\.includes\(group\.directory\)/u);
  assert.match(open, /elements\.directorySelect\.value = group\.directory/u);
  assert.ok(open.indexOf("directorySelect.value = group.directory") < open.indexOf("await openGroup(group.id)"));
});

test("rename remembers the list row target instead of following the current group", () => {
  const rename = app.slice(app.indexOf("let renamingGroupId"), app.indexOf("/* ---------- 杂项"));
  assert.match(rename, /renamingGroupId = group\.id/u);
  assert.match(rename, /state\.groups\.get\(renamingGroupId\)/u);
  assert.match(rename, /request\("group\.rename", \{ groupId: group\.id, title \}\)/u);
  assert.match(app, /openRenameDialog\(group\)/u);
});

test("changing directory mid-switch closes the already-unsubscribed group", () => {
  const open = app.slice(
    app.indexOf("async function openGroup("),
    app.indexOf("async function openListedGroup("),
  );
  assert.match(open, /state\.openingGroupId = groupId;/u);
  assert.match(open, /if \(state\.openingGroupId === groupId\) state\.openingGroupId = null;/u);

  const change = app.slice(
    app.indexOf('elements.directorySelect.addEventListener("change"'),
    app.indexOf('elements.groupSearchInput.addEventListener("input"'),
  );
  assert.match(change, /state\.openingGroupId !== state\.currentGroupId/u);
  assert.match(change, /if \(switching \|\| state\.current\?\.group\.directory !== directory\) closeGroup\(\);/u);
});
