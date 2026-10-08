import assert from "node:assert/strict";
import test from "node:test";

import { usernameProblem } from "./username.ts";

const NAMES = ["claude", "codex", "grok"];

test("valid usernames pass", () => {
  for (const name of ["host", "Lizzy", "a", "abc123", "aclaude", "MyCodex", "X".repeat(16)]) {
    assert.equal(usernameProblem(name, NAMES), null, name);
  }
});

test("each rule gives its own message", () => {
  assert.match(usernameProblem("", NAMES)!, /不能为空/u);
  assert.match(usernameProblem("x".repeat(17), NAMES)!, /最多 16 位，现在是 17 位/u);
  for (const name of ["my name", "名字", "a-b", "a_b", "host!"]) {
    assert.match(usernameProblem(name, NAMES)!, /只能用英文字母和数字/u, name);
  }
  assert.match(usernameProblem("Claude", NAMES)!, /“claude”/u);
  assert.match(usernameProblem("GROK", NAMES)!, /“grok”/u);
});

test("user-chosen AI names are compared exactly without regard to case", () => {
  assert.match(usernameProblem("Alice", [...NAMES, "alice"])!, /“alice”/u);
  assert.equal(usernameProblem("alice2", [...NAMES, "alice"]), null);
});
