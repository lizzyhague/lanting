import assert from "node:assert/strict";
import test from "node:test";

import { FakeAdapter } from "./fake-adapter.test-support.ts";
import { AgentRegistry, SUPPORTED_AGENT_KINDS } from "./registry.ts";

test("lists every supported CLI kind in its fixed order", () => {
  assert.deepEqual(SUPPORTED_AGENT_KINDS, [
    { kind: "claude", displayName: "Claude Code" },
    { kind: "codex", displayName: "Codex CLI" },
    { kind: "grok", displayName: "Grok Build" },
    { kind: "pi", displayName: "Pi" },
  ]);
});

test("registers adapters by kind and rejects a duplicate kind", () => {
  const registry = new AgentRegistry([new FakeAdapter("grok"), new FakeAdapter("claude")]);
  assert.deepEqual(registry.kinds, ["grok", "claude"]);
  assert.equal(registry.has("grok"), true);
  assert.equal(registry.has("codex"), false);
  assert.throws(
    () => new AgentRegistry([new FakeAdapter("claude"), new FakeAdapter("claude")]),
    /CLI 种类重复登记：claude/u,
  );
});
