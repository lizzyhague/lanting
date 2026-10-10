import assert from "node:assert/strict";
import test from "node:test";

import { MAX_BROWSER_MESSAGE_BYTES, parseBrowserRequest, ProtocolError } from "./protocol.ts";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_AGENT_ID = "22222222-2222-4222-8222-222222222222";

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
    parseBrowserRequest(JSON.stringify({ type: "agent.catalog", requestId: "r1", groupId, agent: "my_codex-2" })),
    { type: "agent.catalog", requestId: "r1", groupId, agent: "my_codex-2" },
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

test("settings records and group creation use internal UUIDs", () => {
  assert.deepEqual(
    parseBrowserRequest(JSON.stringify({ type: "settings.catalog", requestId: "r1", agentId: AGENT_ID })),
    { type: "settings.catalog", requestId: "r1", agentId: AGENT_ID },
  );
  assert.deepEqual(
    parseBrowserRequest(JSON.stringify({
      type: "settings.defaults",
      requestId: "r2",
      agentId: AGENT_ID,
      model: null,
      effort: null,
      permission: null,
    })),
    {
      type: "settings.defaults",
      requestId: "r2",
      agentId: AGENT_ID,
      model: null,
      effort: null,
      permission: null,
    },
  );
  assert.deepEqual(
    parseBrowserRequest(JSON.stringify({
      type: "group.create",
      requestId: "r3",
      directory: "demo",
      members: [AGENT_ID, OTHER_AGENT_ID],
      title: "",
    })),
    {
      type: "group.create",
      requestId: "r3",
      directory: "demo",
      members: [AGENT_ID, OTHER_AGENT_ID],
      title: "",
    },
  );
  rejectsWith(JSON.stringify({ type: "settings.catalog", requestId: "r4", agentId: "claude" }), "invalid_field", "r4");
  rejectsWith(JSON.stringify({
    type: "settings.defaults",
    requestId: "r5",
    agentId: "claude",
    model: null,
    effort: null,
    permission: null,
  }), "invalid_field", "r5");
  rejectsWith(JSON.stringify({
    type: "group.create",
    requestId: "r6",
    directory: "demo",
    members: ["claude"],
    title: "",
  }), "invalid_field", "r6");
});

test("parses settings AI list mutations and ignores obsolete add fields", () => {
  assert.deepEqual(
    parseBrowserRequest(JSON.stringify({ type: "settings.agent.add", requestId: "r0" })),
    { type: "settings.agent.add", requestId: "r0" },
  );
  assert.deepEqual(
    parseBrowserRequest(JSON.stringify({
      type: "settings.agent.add",
      requestId: "r1",
      name: "Bad Name",
      kind: "future-cli",
      color: null,
    })),
    { type: "settings.agent.add", requestId: "r1" },
  );
  assert.deepEqual(
    parseBrowserRequest(JSON.stringify({
      type: "settings.agent.update",
      requestId: "r2",
      agentId: AGENT_ID,
      color: "orange",
    })),
    { type: "settings.agent.update", requestId: "r2", agentId: AGENT_ID, color: "orange" },
  );
  assert.deepEqual(
    parseBrowserRequest(JSON.stringify({ type: "settings.agent.remove", requestId: "r3", agentId: AGENT_ID })),
    { type: "settings.agent.remove", requestId: "r3", agentId: AGENT_ID },
  );
  assert.deepEqual(
    parseBrowserRequest(JSON.stringify({
      type: "settings.agent.reorder",
      requestId: "r4",
      order: [OTHER_AGENT_ID, AGENT_ID],
    })),
    { type: "settings.agent.reorder", requestId: "r4", order: [OTHER_AGENT_ID, AGENT_ID] },
  );
  rejectsWith(JSON.stringify({
    type: "settings.agent.update",
    requestId: "r5",
    agentId: AGENT_ID,
  }), "invalid_field", "r5");
});

test("parses rename and trash requests", () => {
  const groupId = "00000000-0000-4000-8000-000000000000";
  assert.deepEqual(
    parseBrowserRequest(JSON.stringify({ type: "group.rename", requestId: "r1", groupId, title: "plan" })),
    { type: "group.rename", requestId: "r1", groupId, title: "plan" },
  );
  assert.deepEqual(
    parseBrowserRequest(JSON.stringify({ type: "group.pin", requestId: "r2", groupId, pinned: true })),
    { type: "group.pin", requestId: "r2", groupId, pinned: true },
  );
  for (const type of ["groups.trash", "groups.restore", "groups.purge"]) {
    assert.deepEqual(
      parseBrowserRequest(JSON.stringify({ type, requestId: "r2", groupIds: [groupId] })),
      { type, requestId: "r2", groupIds: [groupId] },
    );
  }
  rejectsWith(JSON.stringify({ type: "groups.trash", requestId: "r3", groupIds: [] }), "invalid_field", "r3");
  rejectsWith(JSON.stringify({ type: "groups.purge", requestId: "r4", groupIds: ["x"] }), "invalid_field", "r4");
  rejectsWith(JSON.stringify({ type: "group.rename", requestId: "r5", groupId, title: "" }), "invalid_field", "r5");
  rejectsWith(JSON.stringify({ type: "group.pin", requestId: "r6", groupId, pinned: 1 }), "invalid_field", "r6");
});

test("usage requests carry a member tag or null", () => {
  const groupId = "00000000-0000-4000-8000-000000000001";
  assert.deepEqual(
    parseBrowserRequest(JSON.stringify({ type: "group.usage", requestId: "r1", groupId, agent: "claude" })),
    { type: "group.usage", requestId: "r1", groupId, agent: "claude" },
  );
  assert.deepEqual(
    parseBrowserRequest(JSON.stringify({ type: "group.usage", requestId: "r2", groupId, agent: null })),
    { type: "group.usage", requestId: "r2", groupId, agent: null },
  );
  assert.deepEqual(
    parseBrowserRequest(JSON.stringify({ type: "group.usage.refresh", requestId: "r3", groupId })),
    { type: "group.usage.refresh", requestId: "r3", groupId },
  );
  rejectsWith(JSON.stringify({ type: "group.usage", requestId: "r4", groupId }), "invalid_field", "r4");
  rejectsWith(JSON.stringify({ type: "group.usage", requestId: "r5", groupId, agent: "Bad" }), "invalid_field", "r5");
  rejectsWith(JSON.stringify({ type: "group.usage.refresh", requestId: "r6", groupId: "x" }), "invalid_field", "r6");
});
