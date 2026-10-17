import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("./app.js", import.meta.url), "utf8");

function body(start, end) {
  return app.slice(app.indexOf(start), app.indexOf(end));
}

test("unavailable selected members are removed from call order and saved once", () => {
  const render = body("function renderCallPicks()", "/** Every call order change");
  assert.match(render, /state\.callOrder\.filter\(\(member\) => !group\.unavailable\.includes\(member\)\)/u);
  assert.match(render, /availableOrder\.length !== state\.callOrder\.length/u);
  assert.match(render, /state\.callOrder = availableOrder/u);
  assert.match(render, /if \(state\.skipUnavailableOrderSave\) state\.skipUnavailableOrderSave = false/u);
  assert.match(render, /saveCallOrder\(availableOrder, true\)/u);
  assert.match(render, /pick\.disabled = state\.savingOrder \|\| unavailable/u);
  assert.match(render, /\$\{member\}（未接入）/u);
  assert.match(render, /agentPick\(member, memberColor\(group, member\)/u);
});

test("member menus distinguish unavailable and unsupported while all sends every member", () => {
  const menu = body("function renderPlusMenu()", "function menuItem(");
  assert.match(menu, /group\.unavailable\.includes\(member\)/u);
  assert.match(menu, /memberSupports\(group, member, "compact"\)/u);
  assert.match(menu, /（未接入）/u);
  assert.match(menu, /（不支持）/u);
  assert.match(menu, /void compact\(\[\.\.\.group\.members\]\)/u);
});

test("member controls disable unavailable or unsupported actions with an explicit option", () => {
  const member = body("function memberRow(", "/** Model, reasoning effort and permission selects");
  assert.match(member, /压缩（未接入）/u);
  assert.match(member, /压缩（不支持）/u);
  assert.match(member, /memberSupports\(group, agent, "models"\)/u);
  assert.match(member, /memberSupports\(group, agent, "permissions"\)/u);

  const controls = body("function settingControls(", "/** The first option shows \"default\"");
  assert.match(controls, /unavailable \? "（未接入）"/u);
  assert.match(controls, /supports\.model \? "默认" : "（不支持）"/u);
  assert.match(controls, /supports\.permission \? "默认" : "（不支持）"/u);
  assert.match(controls, /locked \|\| !supports\.model/u);
  assert.match(controls, /locked \|\| !supports\.permission/u);

  const settings = body("function settingsAgentRow(", "function colorPicker(");
  assert.match(settings, /kindSupports\(state\.agentKinds, agent\.kind, "models"\)/u);
  assert.match(settings, /kindSupports\(state\.agentKinds, agent\.kind, "permissions"\)/u);
});

test("the usage menu lists usable members, marks the choice, and keeps an off item", () => {
  const menu = body("function renderPlusMenu()", "function menuItem(");
  assert.match(menu, /const usageMembers = usageCandidates\(group\)/u);
  assert.match(menu, /usageMembers\.length > 0/u);
  assert.match(menu, /"AI usage"/u);
  assert.match(menu, /elements\.plusMenu\.replaceChildren/u);
  assert.match(menu, /elements\.plusSubmenu\.replaceChildren/u);
  assert.match(menu, /setUsageAgent\(selected \? null : member\)/u);
  assert.match(menu, /aria-checked", String\(selected\)/u);
  assert.match(menu, /menuItem\("关闭"/u);
  assert.match(menu, /aria-checked", String\(group\.usageAgent === null\)/u);
});

test("header flowers toggle usage or explain why they cannot", () => {
  const flower = body("function memberFlower(", "/** Usage row");
  assert.match(flower, /aria-pressed", String\(group\.usageAgent === member\)/u);
  assert.match(flower, /\$\{member\} 未接入/u);
  assert.match(flower, /\$\{member\} 不支持 usage/u);
  assert.match(flower, /setUsageAgent\(group\.usageAgent === member \? null : member\)/u);
  assert.doesNotMatch(app, /group-meta|groupMeta/u);
});

test("usage refreshes when the page comes back and follows only the chosen member", () => {
  assert.match(app, /request\("group\.usage\.refresh"/u);
  assert.match(app, /if \(event\.agent !== current\.group\.usageAgent\) return;/u);
  assert.match(app, /state\.current\.group\.usageAgent !== event\.group\.usageAgent\) state\.current\.usage = null/u);
});
