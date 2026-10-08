import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { FakeAdapter } from "../agents/fake-adapter.test-support.ts";
import { AGENT_KINDS, type AgentKind } from "../agents/kinds.ts";
import { PALETTE } from "../agents/palette.ts";
import { AgentRegistry } from "../agents/registry.ts";
import { DEFAULT_AGENT_SETTINGS } from "../agents/types.ts";
import { GroupStore } from "../state/group-store.ts";
import { GroupError, GroupRuntime, type GroupEvent } from "./runtime.ts";

type TestMember = { tag: string; kind: AgentKind };

async function setup(
  t: test.TestContext,
  input: readonly (AgentKind | TestMember)[] = AGENT_KINDS,
  configured?: readonly AgentKind[],
) {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const members = input.map((member): TestMember =>
    typeof member === "string" ? { tag: member, kind: member } : member
  );
  const configuredKinds = configured ?? [...new Set(members.map((member) => member.kind))];
  const adapters: Partial<Record<AgentKind, FakeAdapter>> = {};
  for (const kind of configuredKinds) adapters[kind] = new FakeAdapter(kind);
  const store = await GroupStore.open(directory);
  const runtime = new GroupRuntime({ store, agents: new AgentRegistry(Object.values(adapters)) });
  t.after(() => runtime.shutdown());
  const events: GroupEvent[] = [];
  runtime.onEvent((event) => events.push(event));
  const group = await store.create({
    title: "demo",
    cwd: "/work/demo",
    username: "host",
    members: members.map((member, index) => ({
      tag: member.tag,
      kind: member.kind,
      color: PALETTE[index]!.id,
      settings: { ...DEFAULT_AGENT_SETTINGS },
    })),
  });
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
  assert.match(prompt, /- <host>: the host, i\.e\. the user\.\n- <claude>\n- <grok>\n/u);
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

test("agents that close after each turn are resumed for every call", async (t) => {
  const { adapters, runtime, groupId } = await setup(t, ["codex"]);
  adapters.codex!.closeAfterTurn = true;
  await runtime.startRound(groupId, "q1", ["codex"]).done;
  assert.equal(adapters.codex!.sessions[0]!.closed, true);
  await runtime.startRound(groupId, "q2", ["codex"]).done;
  assert.deepEqual(adapters.codex!.calls.map((call) => [call.kind, call.nativeId]), [
    ["start", null],
    ["resume", "codex-session-1"],
  ]);
  assert.equal(adapters.codex!.sessions[1]!.closed, true);
});

test("changed settings take effect on the agent's next call by reopening its session", async (t) => {
  const { adapters, store, runtime, groupId } = await setup(t, ["claude", "codex"]);
  await runtime.startRound(groupId, "q1", ["claude"]).done;
  assert.deepEqual(adapters.claude!.calls[0]!.options.settings, { model: null, effort: null, permission: null });

  // 第二轮里 claude 说完之后、codex 发言之前改 codex 的设置：codex 这一轮就用上新设置。
  adapters.claude!.script = (_, call) => [{ type: "end", outcome: "completed", text: `claude ${call}` }];
  runtime.onEvent((event) => {
    if (event.type === "entry.appended" && event.entry.from.role === "agent" && event.entry.from.agent === "claude") {
      void store.update(groupId, (group) => {
        group.agents.codex!.settings = { model: "large", effort: "high", permission: "yolo" };
      });
    }
  });
  await runtime.startRound(groupId, "q2", ["claude", "codex"]).done;
  assert.deepEqual(adapters.codex!.calls[0]!.options.settings, { model: "large", effort: "high", permission: "yolo" });

  // claude 的设置没变，会话接着用；变了以后关掉旧会话，用新设置恢复。
  assert.equal(adapters.claude!.calls.length, 1);
  await store.update(groupId, (group) => {
    group.agents.claude!.settings = { model: "small", effort: null, permission: null };
  });
  await runtime.startRound(groupId, "q3", ["claude"]).done;
  assert.equal(adapters.claude!.sessions[0]!.closed, true);
  assert.deepEqual(adapters.claude!.calls.map((call) => [call.kind, call.nativeId, call.options.settings.model]), [
    ["start", null, null],
    ["resume", "claude-session-1", "small"],
  ]);
});

test("compaction runs agents in order, skips agents without a session, and only notifies the host", async (t) => {
  const { adapters, store, runtime, events, groupId } = await setup(t);
  adapters.codex!.closeAfterTurn = true;
  await runtime.startRound(groupId, "q1", ["claude", "codex"]).done;

  const compaction = runtime.compact(groupId, ["codex", "grok", "claude"]);
  assert.equal(runtime.isBusy(groupId), true);
  assert.deepEqual(runtime.compaction(groupId)?.agents, ["codex", "grok", "claude"]);
  assert.throws(() => runtime.startRound(groupId, "q", ["claude"]), /正在压缩/u);
  assert.throws(() => runtime.compact(groupId, ["claude"]), /正忙/u);
  await compaction.done;

  assert.equal(runtime.isBusy(groupId), false);
  assert.deepEqual(adapters.codex!.compacted, ["codex-session-1"]);
  assert.deepEqual(adapters.claude!.compacted, ["claude-session-1"]);
  assert.deepEqual(adapters.grok!.calls, []);
  // codex 每次用完就关进程，压缩也一样；claude 的会话留着复用。
  assert.equal(adapters.codex!.sessions.at(-1)!.closed, true);
  assert.equal(adapters.claude!.sessions.length, 1);
  assert.deepEqual(store.transcript(groupId).slice(-3).map((entry) => [entry.from, entry.text]), [
    [{ role: "notice", agent: "codex" }, "已压缩 codex 的上下文。"],
    [{ role: "notice", agent: "grok" }, "grok 还没有发过言，没有可压缩的上下文。"],
    [{ role: "notice", agent: "claude" }, "已压缩 claude 的上下文。"],
  ]);
  assert.deepEqual(events.filter((event) => event.type.startsWith("compact.")).map((event) => event.type), [
    "compact.started",
    "compact.progress",
    "compact.progress",
    "compact.progress",
    "compact.ended",
  ]);

  // 提示不转给任何 AI。
  await runtime.startRound(groupId, "q2", ["grok"]).done;
  assert.ok(!adapters.grok!.received[0]!.includes("压缩"));
});

test("a failed compaction is reported and the session is reopened next time", async (t) => {
  const { adapters, store, runtime, groupId } = await setup(t, ["claude"]);
  await runtime.startRound(groupId, "q1", ["claude"]).done;
  adapters.claude!.compactError = new Error("context too small");
  await runtime.compact(groupId, ["claude"]).done;
  assert.equal(store.transcript(groupId).at(-1)?.text, "claude 的上下文没有压缩成功：context too small");
  assert.equal(adapters.claude!.sessions[0]!.closed, true);
  await runtime.startRound(groupId, "q2", ["claude"]).done;
  assert.equal(adapters.claude!.calls.at(-1)?.kind, "resume");
});

test("compaction rejects agents outside the group", async (t) => {
  const { runtime, groupId } = await setup(t, ["claude"]);
  assert.throws(() => runtime.compact(groupId, []), /至少要选一个/u);
  assert.throws(() => runtime.compact(groupId, ["codex"]), /不是这个群的成员/u);
});

test("two members sharing one CLI keep distinct native sessions across resumes", async (t) => {
  const { adapters, store, runtime, groupId } = await setup(t, [
    { tag: "alice", kind: "codex" },
    { tag: "bob", kind: "codex" },
  ]);
  const adapter = adapters.codex!;
  adapter.closeAfterTurn = true;

  await runtime.startRound(groupId, "first", ["alice", "bob"]).done;
  assert.deepEqual(adapter.calls.map((call) => [call.kind, call.nativeId]), [
    ["start", null],
    ["start", null],
  ]);
  assert.equal(store.get(groupId)?.agents.alice?.nativeSessionId, "codex-session-1");
  assert.equal(store.get(groupId)?.agents.bob?.nativeSessionId, "codex-session-2");

  await runtime.startRound(groupId, "alice again", ["alice"]).done;
  await runtime.startRound(groupId, "bob again", ["bob"]).done;
  assert.deepEqual(adapter.calls.slice(2).map((call) => [call.kind, call.nativeId]), [
    ["resume", "codex-session-1"],
    ["resume", "codex-session-2"],
  ]);
});

test("members sharing one CLI keep approvals and interruption tied to their tags", async (t) => {
  const { adapters, runtime, events, groupId } = await setup(t, [
    { tag: "alice", kind: "codex" },
    { tag: "bob", kind: "codex" },
  ]);
  const adapter = adapters.codex!;
  const approvals: string[] = [];
  adapter.script = () => [
    { type: "ask", toolName: "Bash" },
    { type: "end", outcome: "completed", text: "done" },
  ];
  runtime.approvals.onEvent((event) => {
    if (event.type !== "approval.requested") return;
    approvals.push(event.approval.agent);
    runtime.approvals.respond(event.approval.approvalId, "allow");
  });
  await runtime.startRound(groupId, "approve", ["alice", "bob"]).done;
  assert.deepEqual(approvals, ["alice", "bob"]);

  adapter.script = () => "hang";
  const round = runtime.startRound(groupId, "stop alice", ["alice"]);
  while (!events.some((event) => event.type === "agent.text" && event.agent === "alice")) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await runtime.interrupt(groupId);
  assert.equal(await round.done, "interrupted");

  adapter.script = () => [{ type: "end", outcome: "completed", text: "bob is fine" }];
  assert.equal(await runtime.startRound(groupId, "call bob", ["bob"]).done, "completed");
  assert.equal(adapter.sessions.at(-1)?.nativeId, "codex-session-2");
});

test("members sharing one CLI compact their own sessions", async (t) => {
  const { adapters, store, runtime, groupId } = await setup(t, [
    { tag: "alice", kind: "codex" },
    { tag: "bob", kind: "codex" },
  ]);
  const adapter = adapters.codex!;
  await runtime.startRound(groupId, "open", ["alice", "bob"]).done;
  await runtime.compact(groupId, ["bob", "alice"]).done;

  assert.deepEqual(adapter.compacted, ["codex-session-2", "codex-session-1"]);
  assert.deepEqual(store.transcript(groupId).slice(-2).map((entry) => entry.text), [
    "已压缩 bob 的上下文。",
    "已压缩 alice 的上下文。",
  ]);
});

test("an unavailable frozen kind fails when its turn arrives", async (t) => {
  const { adapters, store, runtime, groupId } = await setup(t, [
    { tag: "helper", kind: "claude" },
    { tag: "alice", kind: "codex" },
  ], ["claude"]);

  assert.equal(await runtime.startRound(groupId, "question", ["helper", "alice"]).done, "failed");
  assert.equal(adapters.claude!.received.length, 1);
  assert.match(adapters.claude!.calls[0]!.options.systemPrompt, /- <alice>/u);
  const failed = store.transcript(groupId).at(-1)!;
  assert.deepEqual(failed.from, { role: "agent", agent: "alice" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "alice 使用的 Codex CLI 没有在 config.json 中配置。");
});

test("compaction records an unavailable kind and continues with later members", async (t) => {
  const { adapters, store, runtime, groupId } = await setup(t, [
    { tag: "alice", kind: "codex" },
    { tag: "helper", kind: "claude" },
  ], ["claude"]);
  await runtime.startRound(groupId, "open helper", ["helper"]).done;
  await store.update(groupId, (group) => {
    group.agents.alice!.nativeSessionId = "orphan-codex-session";
  });

  await runtime.compact(groupId, ["alice", "helper"]).done;
  assert.deepEqual(store.transcript(groupId).slice(-2).map((entry) => entry.text), [
    "alice 的上下文没有压缩成功：alice 使用的 Codex CLI 没有在 config.json 中配置。",
    "已压缩 helper 的上下文。",
  ]);
  assert.deepEqual(adapters.claude!.compacted, ["claude-session-1"]);
});
