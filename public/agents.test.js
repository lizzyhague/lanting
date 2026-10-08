import assert from "node:assert/strict";
import test from "node:test";

import {
  colorChoices,
  createCandidates,
  effectiveCreateMembers,
  kindOptions,
  moveAgent,
  paletteColor,
  selectionAfterRemove,
  settingsCatalogKey,
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
