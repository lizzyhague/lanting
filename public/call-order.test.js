import assert from "node:assert/strict";
import test from "node:test";

import { toggleMember } from "./call-order.js";

test("follows the worked example step by step", () => {
  // 1. Last round was claude → grok; this round defaults to claude → grok.
  let order = ["claude", "grok"];
  // 2. Remove claude, call codex: grok → codex.
  order = toggleMember(order, "claude", false);
  order = toggleMember(order, "codex", true);
  assert.deepEqual(order, ["grok", "codex"]);
  // 3. Remove grok and call it again: codex → grok.
  order = toggleMember(order, "grok", false);
  order = toggleMember(order, "grok", true);
  assert.deepEqual(order, ["codex", "grok"]);
});
