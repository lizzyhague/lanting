import assert from "node:assert/strict";
import test from "node:test";

import { clearAll, selectAll, toggleMember } from "./call-order.js";

const MEMBERS = ["claude", "codex", "grok"];

test("follows the worked example step by step", () => {
  // 1. 上一轮是 claude → grok，这一轮默认还是 claude → grok。
  let order = ["claude", "grok"];
  // 2. 去掉 claude、勾上 codex：grok → codex。
  order = toggleMember(order, "claude", false);
  order = toggleMember(order, "codex", true);
  assert.deepEqual(order, ["grok", "codex"]);
  // 3. 去掉 grok 再勾上：codex → grok。
  order = toggleMember(order, "grok", false);
  order = toggleMember(order, "grok", true);
  assert.deepEqual(order, ["codex", "grok"]);
  // 4. 点全选：codex → grok → claude。
  order = selectAll(order, MEMBERS);
  assert.deepEqual(order, ["codex", "grok", "claude"]);
  // 5. 取消全选：清空。
  order = clearAll();
  assert.deepEqual(order, []);
  // 6. 勾上 codex，再点全选：codex → claude → grok。
  order = toggleMember(order, "codex", true);
  order = selectAll(order, MEMBERS);
  assert.deepEqual(order, ["codex", "claude", "grok"]);
});
