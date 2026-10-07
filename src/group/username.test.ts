import assert from "node:assert/strict";
import test from "node:test";

import { usernameProblem } from "./username.ts";

const TAGS = ["claude", "codex", "grok"];

test("valid usernames pass", () => {
  for (const name of ["host", "Lizzy", "a", "abc123", "X".repeat(16)]) assert.equal(usernameProblem(name, TAGS), null, name);
});

test("each rule gives its own message", () => {
  assert.match(usernameProblem("", TAGS)!, /不能为空/u);
  assert.match(usernameProblem("x".repeat(17), TAGS)!, /最多 16 位，现在是 17 位/u);
  for (const name of ["my name", "名字", "a-b", "a_b", "host!"]) {
    assert.match(usernameProblem(name, TAGS)!, /只能用英文字母和数字/u, name);
  }
  assert.match(usernameProblem("aclaude", TAGS)!, /“claude”/u);
  assert.match(usernameProblem("MyCodex", TAGS)!, /“codex”/u);
  assert.match(usernameProblem("GROK", TAGS)!, /“grok”/u);
});

test("tags of newly connected AIs are excluded too", () => {
  assert.equal(usernameProblem("gemini1", TAGS), null);
  assert.match(usernameProblem("gemini1", [...TAGS, "gemini"])!, /“gemini”/u);
});
