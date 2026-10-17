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
  assert.deepEqual(usernameProblem("", NAMES), { key: "error.usernameEmpty" });
  assert.deepEqual(usernameProblem("x".repeat(17), NAMES), { key: "error.usernameTooLong", params: { max: 16, length: 17 } });
  for (const name of ["my name", "名字", "a-b", "a_b", "host!"]) {
    assert.deepEqual(usernameProblem(name, NAMES), { key: "error.usernameCharset" }, name);
  }
  assert.deepEqual(usernameProblem("Claude", NAMES), { key: "error.usernameMatchesAgent", params: { name: "claude" } });
  assert.deepEqual(usernameProblem("GROK", NAMES), { key: "error.usernameMatchesAgent", params: { name: "grok" } });
});

test("user-chosen AI names are compared exactly without regard to case", () => {
  assert.deepEqual(usernameProblem("Alice", [...NAMES, "alice"]), { key: "error.usernameMatchesAgent", params: { name: "alice" } });
  assert.equal(usernameProblem("alice2", [...NAMES, "alice"]), null);
});
