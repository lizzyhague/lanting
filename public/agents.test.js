import assert from "node:assert/strict";
import test from "node:test";
import "./i18n.test-support.js";

import {
  colorChoices,
  createCandidates,
  effectiveCreateMembers,
  kindSupports,
  formatLocalTime,
  kindOptions,
  lastReplyAt,
  memberSupports,
  moveAgent,
  paletteColor,
  selectionAfterRemove,
  settingsCatalogKey,
  usageCandidates,
  usageTexts,
  visibleUsageAgent,
} from "./agents.js";

const SETTINGS = {
  agents: [
    { id: "a", complete: true },
    { id: "b", complete: false },
    { id: "c", complete: true },
  ],
};

test("create candidates stay in settings order and omit incomplete records", () => {
  assert.deepEqual(createCandidates(SETTINGS).map((agent) => agent.id), ["a", "c"]);
  assert.deepEqual(effectiveCreateMembers(null, SETTINGS), ["a", "c"]);
  assert.deepEqual(effectiveCreateMembers(["c", "b", "missing"], SETTINGS), ["c"]);
});

test("an incomplete member can stay selected until it becomes complete again", () => {
  const selected = ["b"];
  assert.deepEqual(effectiveCreateMembers(selected, SETTINGS), []);
  assert.deepEqual(effectiveCreateMembers(selected, {
    agents: SETTINGS.agents.map((agent) => agent.id === "b" ? { ...agent, complete: true } : agent),
  }), ["b"]);
});

test("colors used by other records are disabled but the current color stays available", () => {
  const palette = [{ id: "orange", color: "#f00" }, { id: "blue", color: "#00f" }];
  const agents = [{ id: "a", color: "orange" }, { id: "b", color: "blue" }];
  assert.deepEqual(colorChoices(palette, agents, "a"), [
    { id: "orange", color: "#f00", disabled: false },
    { id: "blue", color: "#00f", disabled: true },
  ]);
  assert.equal(paletteColor(palette, "blue"), "#00f");
  assert.equal(paletteColor(palette, null), null);
});

test("all CLI kinds stay visible and unavailable ones are disabled", () => {
  assert.deepEqual(kindOptions([
    { kind: "claude", displayName: "Claude Code", configured: true },
    { kind: "grok", displayName: "Grok Build", configured: false },
  ], "grok"), [
    { value: "", label: "", disabled: false, selected: false },
    { value: "claude", label: "Claude Code", disabled: false, selected: false },
    { value: "grok", label: "Grok Build", disabled: true, selected: true },
  ]);
});

test("moving and removing records preserve the intended selection", () => {
  assert.deepEqual(moveAgent(["a", "b", "c"], "b", -1), ["b", "a", "c"]);
  assert.deepEqual(moveAgent(["a", "b", "c"], "a", -1), ["a", "b", "c"]);
  assert.deepEqual(moveAgent(["a", "b", "c"], "c", 1), ["a", "b", "c"]);
  assert.equal(selectionAfterRemove(["a", "b", "c"], "b"), "c");
  assert.equal(selectionAfterRemove(["a", "b", "c"], "c"), "b");
  assert.equal(selectionAfterRemove(["a"], "a"), null);
});

test("settings catalogs are separated by record and CLI kind", () => {
  assert.equal(settingsCatalogKey("a", "claude"), "a:claude");
  assert.equal(settingsCatalogKey("a", "codex"), "a:codex");
});

test("feature support comes from the group member or CLI kind", () => {
  const group = { features: { alice: ["compact"], bob: [] } };
  assert.equal(memberSupports(group, "alice", "compact"), true);
  assert.equal(memberSupports(group, "alice", "models"), false);
  assert.equal(memberSupports(group, "bob", "compact"), false);

  const kinds = [
    { kind: "claude", features: ["models", "permissions"] },
    { kind: "codex", features: [] },
  ];
  assert.equal(kindSupports(kinds, "claude", "models"), true);
  assert.equal(kindSupports(kinds, "codex", "models"), false);
  assert.equal(kindSupports(kinds, "missing", "models"), false);
});

test("usage members must be available and support usage", () => {
  const group = {
    members: ["alice", "bob", "carol"],
    unavailable: ["carol"],
    features: { alice: ["usage"], bob: [], carol: [] },
    usageAgent: "alice",
  };
  assert.deepEqual(usageCandidates(group), ["alice"]);
  assert.equal(visibleUsageAgent(group), "alice");
  assert.equal(visibleUsageAgent({ ...group, usageAgent: "bob" }), null);
  assert.equal(visibleUsageAgent({ ...group, usageAgent: null }), null);
  assert.equal(visibleUsageAgent({ ...group, unavailable: ["alice"] }), null);
});

test("the last reply time counts only completed and interrupted replies", () => {
  const transcript = [
    { from: { role: "agent", agent: "alice" }, status: "completed", at: "2026-10-10T01:00:00Z" },
    { from: { role: "agent", agent: "alice" }, status: "interrupted", at: "2026-10-10T02:00:00Z" },
    { from: { role: "agent", agent: "bob" }, status: "completed", at: "2026-10-10T03:00:00Z" },
    { from: { role: "agent", agent: "alice" }, status: "failed", at: "2026-10-10T04:00:00Z" },
    { from: { role: "notice", agent: "alice" }, at: "2026-10-10T05:00:00Z" },
  ];
  assert.equal(lastReplyAt(transcript, "alice"), "2026-10-10T02:00:00Z");
  assert.equal(lastReplyAt(transcript, "carol"), null);
});

test("usage text fills local times, shows only 未启动 before a session, and ends with the last reply", () => {
  const time = "2026-10-10T12:34:00Z";
  const local = formatLocalTime(time);
  assert.match(local, /^\d{2}-\d{2} \d{2}:\d{2}$/u);
  assert.deepEqual(usageTexts({ status: "not_started" }, time), ["未启动"]);
  assert.deepEqual(
    usageTexts({ status: "ok", parts: [{ text: "上下文 1.0%" }, { text: "5 小时剩余 9.0%，{time} 重置", time }] }, time),
    ["上下文 1.0%", `5 小时剩余 9.0%，${local} 重置`, `最后回复时间 ${local}`],
  );
  assert.deepEqual(usageTexts({ status: "unavailable" }, null), ["额度查询不可用", "最后回复时间不可用"]);
  assert.deepEqual(usageTexts(null, null), ["额度查询不可用", "最后回复时间不可用"]);
});
