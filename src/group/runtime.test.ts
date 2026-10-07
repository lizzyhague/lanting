import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { FakeAdapter } from "../agents/fake-adapter.test-support.ts";
import { AgentRegistry } from "../agents/registry.ts";
import { GroupStore } from "../state/group-store.ts";
import { GroupError, GroupRuntime, type GroupEvent } from "./runtime.ts";

async function setup(t: test.TestContext, members = ["claude", "codex", "grok"]) {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const adapters = Object.fromEntries(members.map((id) => [id, new FakeAdapter(id)]));
  const store = await GroupStore.open(directory);
  const runtime = new GroupRuntime({ store, agents: new AgentRegistry(Object.values(adapters)) });
  t.after(() => runtime.shutdown());
  const events: GroupEvent[] = [];
  runtime.onEvent((event) => events.push(event));
  const group = await store.create({ title: "demo", cwd: "/work/demo", username: "host", members });
  return { directory, adapters, store, runtime, events, groupId: group.id };
}

function texts(store: GroupStore, groupId: string): string[] {
  return store.transcript(groupId).map((entry) =>
    `${entry.from.role === "host" ? "host" : entry.from.agent}:${entry.status ?? "-"}:${entry.text}`
  );
}

test("agents speak in call order and later speakers see earlier replies", async (t) => {
  const { adapters, store, runtime, groupId } = await setup(t);
  const outcome = await runtime.startRound(groupId, "question", ["grok", "claude"]).done;

  assert.equal(outcome, "completed");
  assert.deepEqual(texts(store, groupId), [
    "host:-:question",
    "grok:completed:grok reply 1",
    "claude:completed:claude reply 1",
  ]);
  assert.deepEqual(adapters.grok!.received, ["<host>\nquestion\n</host>"]);
  assert.deepEqual(adapters.claude!.received, [
    "<host>\nquestion\n</host>\n\n<grok>\ngrok reply 1\n</grok>",
  ]);
  assert.deepEqual(adapters.codex!.received, []);
  assert.deepEqual(store.get(groupId)?.callOrder, ["grok", "claude"]);
});

test("an agent called for the first time receives everything since the group was created", async (t) => {
  const { adapters, runtime, groupId } = await setup(t);
  await runtime.startRound(groupId, "round 1", ["claude", "codex"]).done;
  await runtime.startRound(groupId, "round 2", ["claude"]).done;
  await runtime.startRound(groupId, "round 3", ["grok"]).done;

  assert.deepEqual(adapters.grok!.received, [[
    "<host>\nround 1\n</host>",
    "<claude>\nclaude reply 1\n</claude>",
    "<codex>\ncodex reply 1\n</codex>",
    "<host>\nround 2\n</host>",
    "<claude>\nclaude reply 2\n</claude>",
    "<host>\nround 3\n</host>",
  ].join("\n\n")]);
  // claude 第二次只收到上次发言之后的新内容，不含自己的回复。
  assert.deepEqual(adapters.claude!.received[1], [
    "<codex>\ncodex reply 1\n</codex>",
    "<host>\nround 2\n</host>",
  ].join("\n\n"));
});

test("interrupting ends the round and later agents do not speak", async (t) => {
  const { adapters, store, runtime, events, groupId } = await setup(t);
  adapters.claude!.script = () => "hang";
  const round = runtime.startRound(groupId, "question", ["claude", "codex"]);
  while (!events.some((event) => event.type === "agent.text")) await new Promise((r) => setImmediate(r));
  assert.equal(runtime.isBusy(groupId), true);

  assert.equal(await runtime.interrupt(groupId), true);
  assert.equal(await round.done, "interrupted");
  assert.equal(runtime.isBusy(groupId), false);
  assert.deepEqual(texts(store, groupId), ["host:-:question", "claude:interrupted:partial"]);
  assert.deepEqual(adapters.codex!.received, []);
  assert.equal(events.at(-1)?.type, "round.ended");
  assert.equal(await runtime.interrupt(groupId), false);
});

test("an interrupted reply is not forwarded to other agents", async (t) => {
  const { adapters, runtime, events, groupId } = await setup(t);
  adapters.claude!.script = (_, call) => call === 1 ? "hang" : [
    { type: "end", outcome: "completed", text: "ok" },
  ];
  const round = runtime.startRound(groupId, "q1", ["claude"]);
  while (!events.some((event) => event.type === "agent.text")) await new Promise((r) => setImmediate(r));
  await runtime.interrupt(groupId);
  await round.done;

  await runtime.startRound(groupId, "q2", ["codex"]).done;
  assert.deepEqual(adapters.codex!.received, ["<host>\nq1\n</host>\n\n<host>\nq2\n</host>"]);
});

test("an error ends the round, later agents do not speak, and the failed agent gets the content again", async (t) => {
  const { adapters, store, runtime, groupId } = await setup(t);
  adapters.claude!.script = (_, call) => call === 1 ? new Error("CLI crashed") : [
    { type: "end", outcome: "completed", text: "recovered" },
  ];
  assert.equal(await runtime.startRound(groupId, "q1", ["claude", "codex"]).done, "failed");
  const failed = store.transcript(groupId).at(-1);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.error, "CLI crashed");
  assert.deepEqual(adapters.codex!.received, []);
  assert.equal(store.get(groupId)?.agents.claude?.cursor, 0);

  assert.equal(await runtime.startRound(groupId, "q2", ["claude"]).done, "completed");
  assert.equal(adapters.claude!.received[1], "<host>\nq1\n</host>\n\n<host>\nq2\n</host>");
  // 出错后丢掉缓存的会话，下次用记下的原生会话 id 恢复。
  assert.deepEqual(adapters.claude!.calls.map((call) => call.kind), ["start", "resume"]);
});

test("a reply stream that ends without an end event counts as failed", async (t) => {
  const { adapters, store, runtime, groupId } = await setup(t);
  adapters.claude!.script = () => [{ type: "text", delta: "cut off" }];
  assert.equal(await runtime.startRound(groupId, "q", ["claude", "codex"]).done, "failed");
  assert.deepEqual(texts(store, groupId).at(-1), "claude:failed:cut off");
  assert.deepEqual(adapters.codex!.received, []);
});

test("rejects invalid rounds synchronously and only one round runs at a time", async (t) => {
  const { adapters, runtime, events, groupId } = await setup(t, ["claude", "codex"]);
  const rejects = (fn: () => unknown, code: string) =>
    assert.throws(fn, (error: unknown) => error instanceof GroupError && error.code === code);
  rejects(() => runtime.startRound("missing", "q", ["claude"]), "group_not_found");
  rejects(() => runtime.startRound(groupId, "  ", ["claude"]), "empty_message");
  rejects(() => runtime.startRound(groupId, "q", []), "no_speaker");
  rejects(() => runtime.startRound(groupId, "q", ["claude", "claude"]), "invalid_order");
  rejects(() => runtime.startRound(groupId, "q", ["grok"]), "invalid_order");

  adapters.claude!.script = () => "hang";
  const round = runtime.startRound(groupId, "q", ["claude"]);
  rejects(() => runtime.startRound(groupId, "q", ["codex"]), "busy");
  while (!events.some((event) => event.type === "agent.text")) await new Promise((r) => setImmediate(r));
  await runtime.interrupt(groupId);
  await round.done;
});

test("system prompts list the host and the other members, not the agent itself", async (t) => {
  const { adapters, runtime, groupId } = await setup(t);
  await runtime.startRound(groupId, "q", ["codex"]).done;
  const prompt = adapters.codex!.calls[0]!.options.systemPrompt;
  assert.match(prompt, /- <host>: the host, i\.e\. the user\.\n- <claude>: Claude\n- <grok>: Grok\n/u);
  assert.doesNotMatch(prompt, /<codex>/u);
  assert.equal(adapters.codex!.calls[0]!.options.cwd, "/work/demo");
});

test("after a restart the group is still there and agents resume their native sessions", async (t) => {
  const { directory, adapters, runtime, groupId } = await setup(t, ["claude", "codex"]);
  await runtime.startRound(groupId, "before restart", ["claude"]).done;
  await runtime.shutdown();

  const store = await GroupStore.open(directory);
  const fresh = { claude: new FakeAdapter("claude"), codex: new FakeAdapter("codex") };
  const restarted = new GroupRuntime({ store, agents: new AgentRegistry(Object.values(fresh)) });
  t.after(() => restarted.shutdown());

  assert.equal(store.get(groupId)?.agents.claude?.nativeSessionId, "claude-session-1");
  await restarted.startRound(groupId, "after restart", ["claude", "codex"]).done;
  assert.deepEqual(fresh.claude.calls.map((call) => [call.kind, call.nativeId]), [["resume", "claude-session-1"]]);
  assert.deepEqual(fresh.claude.received, ["<host>\nafter restart\n</host>"]);
  assert.deepEqual(fresh.codex.received, [[
    "<host>\nbefore restart\n</host>",
    "<claude>\nclaude reply 1\n</claude>",
    "<host>\nafter restart\n</host>",
    "<claude>\nclaude reply 1\n</claude>",
  ].join("\n\n")]);
  assert.equal(adapters.claude!.received.length, 1);
});

test("approvals are tagged with the group and agent, and their outcome is recorded as activity", async (t) => {
  const { adapters, store, runtime, groupId } = await setup(t, ["claude"]);
  adapters.claude!.script = () => [
    { type: "ask", toolName: "Bash" },
    { type: "end", outcome: "completed", text: "done" },
  ];
  runtime.approvals.onEvent((event) => {
    if (event.type !== "approval.requested") return;
    assert.equal(event.approval.groupId, groupId);
    assert.equal(event.approval.agent, "claude");
    runtime.approvals.respond(event.approval.approvalId, "allow");
  });
  assert.equal(await runtime.startRound(groupId, "q", ["claude"]).done, "completed");
  assert.deepEqual(store.transcript(groupId).at(-1)?.activities, [{ kind: "approval", decision: "allow" }]);
});

test("interrupting denies the pending approval", async (t) => {
  const { adapters, store, runtime, groupId } = await setup(t, ["claude", "codex"]);
  adapters.claude!.script = () => [
    { type: "ask", toolName: "Bash" },
    { type: "end", outcome: "interrupted", text: "" },
  ];
  const round = runtime.startRound(groupId, "q", ["claude", "codex"]);
  while (runtime.approvals.pending(groupId).length === 0) await new Promise((r) => setImmediate(r));
  const snapshot = runtime.round(groupId);
  assert.equal(snapshot?.speaking, "claude");
  await runtime.interrupt(groupId);
  assert.equal(await round.done, "interrupted");
  assert.deepEqual(store.transcript(groupId).at(-1)?.activities, [{ kind: "approval", decision: "deny" }]);
  assert.equal(runtime.approvals.pending(groupId).length, 0);
  assert.equal(runtime.round(groupId), null);
});

test("the live round snapshot tracks streamed text and resets it when activity arrives", async (t) => {
  const { adapters, runtime, events, groupId } = await setup(t, ["claude"]);
  adapters.claude!.script = () => [
    { type: "text", delta: "Let me look" },
    { type: "activity", activity: { kind: "tool", toolName: "Read" } },
    { type: "text", delta: "Answer" },
    { type: "end", outcome: "completed", text: "Answer" },
  ];
  const snapshots: (string | undefined)[] = [];
  runtime.onEvent((event) => {
    if (event.type === "agent.text" || event.type === "agent.activity") snapshots.push(runtime.round(groupId)?.text);
  });
  await runtime.startRound(groupId, "q", ["claude"]).done;
  assert.deepEqual(snapshots, ["Let me look", "", "Answer"]);
  assert.ok(events.some((event) => event.type === "agent.activity"));
});

test("a dead session is replaced by resuming the native session", async (t) => {
  const { adapters, runtime, groupId } = await setup(t, ["claude"]);
  await runtime.startRound(groupId, "q1", ["claude"]).done;
  await adapters.claude!.sessions[0]!.close();
  await runtime.startRound(groupId, "q2", ["claude"]).done;
  assert.deepEqual(adapters.claude!.calls.map((call) => [call.kind, call.nativeId]), [
    ["start", null],
    ["resume", "claude-session-1"],
  ]);
});

test("idle sessions are closed and resumed on the next call", async (t) => {
  const { adapters, runtime, groupId } = await setup(t, ["claude"]);
  await runtime.startRound(groupId, "q1", ["claude"]).done;
  assert.equal(await runtime.closeIdleSessions(Date.now()), 0);
  assert.equal(await runtime.closeIdleSessions(Date.now() + 16 * 60_000), 1);
  assert.equal(adapters.claude!.sessions[0]!.closed, true);
  await runtime.startRound(groupId, "q2", ["claude"]).done;
  assert.equal(adapters.claude!.calls.at(-1)?.kind, "resume");
});
