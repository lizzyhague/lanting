import assert from "node:assert/strict";
import test from "node:test";

import { toggleMember } from "./call-order.js";

test("follows the worked example step by step", () => {
  // 1. 上一轮是 claude → grok，这一轮默认还是 claude → grok。
  let order = ["claude", "grok"];
  // 2. 去掉 claude、点名 codex：grok → codex。
  order = toggleMember(order, "claude", false);
  order = toggleMember(order, "codex", true);
  assert.deepEqual(order, ["grok", "codex"]);
  // 3. 去掉 grok 再点名：codex → grok。
  order = toggleMember(order, "grok", false);
  order = toggleMember(order, "grok", true);
  assert.deepEqual(order, ["codex", "grok"]);
});
