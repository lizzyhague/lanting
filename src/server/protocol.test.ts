import assert from "node:assert/strict";
import test from "node:test";

import { MAX_BROWSER_MESSAGE_BYTES, parseBrowserRequest, ProtocolError } from "./protocol.ts";

function rejectsWith(source: string, code: string, requestId: string | null): void {
  assert.throws(() => parseBrowserRequest(source), (error: unknown) => {
    assert.ok(error instanceof ProtocolError);
    assert.equal(error.code, code);
    assert.equal(error.requestId, requestId);
    return true;
  });
}

test("parses connection.ready", () => {
  assert.deepEqual(
    parseBrowserRequest(JSON.stringify({ type: "connection.ready", requestId: "r1", extra: 1 })),
    { type: "connection.ready", requestId: "r1" },
  );
});

test("rejects malformed messages and keeps the request id when it is known", () => {
  rejectsWith("{", "invalid_json", null);
  rejectsWith("[]", "invalid_message", null);
  rejectsWith(JSON.stringify({ type: "connection.ready" }), "invalid_field", null);
  rejectsWith(JSON.stringify({ requestId: "x".repeat(129), type: "connection.ready" }), "invalid_field", null);
  rejectsWith(JSON.stringify({ requestId: "r2" }), "invalid_message", "r2");
  rejectsWith(JSON.stringify({ requestId: "r3", type: "nope" }), "unknown_type", "r3");
  rejectsWith(" ".repeat(MAX_BROWSER_MESSAGE_BYTES + 1), "message_too_large", null);
});

test("parses member settings, catalog and compaction requests", () => {
  const groupId = "00000000-0000-4000-8000-000000000000";
  assert.deepEqual(
    parseBrowserRequest(JSON.stringify({ type: "agent.catalog", requestId: "r1", groupId, agent: "codex" })),
    { type: "agent.catalog", requestId: "r1", groupId, agent: "codex" },
  );
  assert.deepEqual(
    parseBrowserRequest(JSON.stringify({
      type: "agent.settings", requestId: "r2", groupId, agent: "claude", model: "opus", effort: null, permission: "plan",
    })),
    { type: "agent.settings", requestId: "r2", groupId, agent: "claude", model: "opus", effort: null, permission: "plan" },
  );
  assert.deepEqual(
    parseBrowserRequest(JSON.stringify({ type: "group.compact", requestId: "r3", groupId, agents: ["claude", "grok"] })),
    { type: "group.compact", requestId: "r3", groupId, agents: ["claude", "grok"] },
  );
  rejectsWith(JSON.stringify({ type: "agent.settings", requestId: "r4", groupId, agent: "claude", model: "" }), "invalid_field", "r4");
  rejectsWith(JSON.stringify({
    type: "agent.settings", requestId: "r5", groupId, agent: "claude", model: null, effort: null,
  }), "invalid_field", "r5");
  rejectsWith(JSON.stringify({ type: "agent.catalog", requestId: "r6", groupId, agent: "Claude" }), "invalid_field", "r6");
});
