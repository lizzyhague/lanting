import assert from "node:assert/strict";
import test from "node:test";

import { ApprovalRegistry, type ApprovalEvent } from "./registry.ts";

test("the first response wins and both events are emitted", async () => {
  const registry = new ApprovalRegistry();
  const events: ApprovalEvent[] = [];
  registry.onEvent((event) => events.push(event));

  const answer = registry.request("g1", "claude", { toolName: "Bash", detail: "command: ls" });
  const [requested] = events;
  assert.equal(requested?.type, "approval.requested");
  const id = requested!.approval.approvalId;
  assert.deepEqual(registry.pending("g1").map((request) => request.approvalId), [id]);

  assert.equal(registry.respond(id, "allow"), true);
  assert.equal(registry.respond(id, "deny"), false);
  assert.deepEqual(await answer, { decision: "allow", message: "" });
  assert.equal(events[1]?.type, "approval.settled");
  assert.equal(registry.pending("g1").length, 0);
});

test("unanswered requests are denied after the timeout", async () => {
  const registry = new ApprovalRegistry(10);
  const answer = await registry.request("g1", "claude", { toolName: "Bash", detail: "" });
  assert.equal(answer.decision, "deny");
  assert.match(answer.message, /denied automatically/u);
});

test("cancel denies only the matching group and agent", async () => {
  const registry = new ApprovalRegistry();
  const a = registry.request("g1", "claude", { toolName: "Bash", detail: "" });
  const b = registry.request("g1", "codex", { toolName: "Bash", detail: "" });
  const c = registry.request("g2", "claude", { toolName: "Bash", detail: "" });

  registry.cancel("g1", "claude");
  assert.equal((await a).decision, "deny");
  assert.deepEqual(registry.pending("g1").map((request) => request.agent), ["codex"]);

  registry.cancel("g1");
  assert.equal((await b).decision, "deny");
  assert.equal(registry.pending("g2").length, 1);
  registry.cancel("g2");
  await c;
});

test("an aborted signal withdraws the request", async () => {
  const registry = new ApprovalRegistry();
  const controller = new AbortController();
  const answer = registry.request("g1", "codex", { toolName: "命令", detail: "" }, controller.signal);
  controller.abort();
  assert.equal((await answer).decision, "deny");
  assert.equal(registry.pending("g1").length, 0);
});
