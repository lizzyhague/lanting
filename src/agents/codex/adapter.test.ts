import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentEvent, ApprovalAsk, SessionOptions } from "../types.ts";
import { CodexAdapter } from "./adapter.ts";

/** 假的 codex app-server：一轮里先说一句过渡的话、跑一条要审批的命令，再给最终回答。 */
const FAKE_APP_SERVER = `#!/usr/bin/env node
import { appendFileSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createInterface } from "node:readline";
const directory = path.dirname(fileURLToPath(import.meta.url));
appendFileSync(path.join(directory, "starts"), "x");
const send = (message) => console.log(JSON.stringify(message));
let instructions = null;
let turn = 0;
const settings = [];
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  const p = m.params ?? {};
  if (m.method === "initialize") {
    send({ id: m.id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" } });
  } else if (m.method === "thread/start") {
    instructions = p.developerInstructions;
    send({ id: m.id, result: { thread: { id: "thread-1" } } });
  } else if (m.method === "thread/resume") {
    instructions = p.developerInstructions;
    send({ id: m.id, result: { thread: { id: p.threadId } } });
  } else if (m.method === "thread/delete") {
    if (p.threadId === "gone") send({ id: m.id, error: { code: -32600, message: "no rollout found for thread id gone" } });
    else if (p.threadId === "broken") send({ id: m.id, error: { code: -32603, message: "disk error" } });
    else send({ id: m.id, result: {} });
  } else if (m.method === "thread/settings/update") {
    settings.push(p);
    send({ id: m.id, result: {} });
  } else if (m.method === "model/list") {
    const crash = path.join(directory, "crash-on-model-list");
    if (existsSync(crash)) {
      unlinkSync(crash);
      process.exit(1);
    }
    send({ id: m.id, result: { nextCursor: null, data: [
      { id: "gpt-a", displayName: "GPT A", description: "fast", hidden: false, defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }, { reasoningEffort: "medium", description: "" }] },
      { id: "gpt-hidden", displayName: "Hidden", description: "", hidden: true, supportedReasoningEfforts: [] },
    ] } });
  } else if (m.method === "permissionProfile/list") {
    send({ id: m.id, result: { nextCursor: null, data: [
      { id: ":read-only", description: null, allowed: true },
      { id: ":workspace", description: "project only", allowed: true },
      { id: ":danger-full-access", description: null, allowed: true },
      { id: ":locked", description: null, allowed: false },
    ] } });
  } else if (m.method === "thread/compact/start") {
    turn += 1;
    const turnId = "turn-" + turn;
    send({ id: m.id, result: {} });
    send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: turnId } } });
    send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId, status: "completed", error: null } } });
  } else if (m.method === "turn/start" && p.input[0].text === "settings") {
    turn += 1;
    const turnId = "turn-" + turn;
    send({ id: m.id, result: { turn: { id: turnId } } });
    const text = JSON.stringify(settings);
    send({ method: "item/completed", params: { threadId: "thread-1", turnId, item: { type: "agentMessage", id: "s", text } } });
    send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId, status: "completed", error: null } } });
  } else if (m.method === "turn/start") {
    turn += 1;
    const turnId = "turn-" + turn;
    const text = p.input[0].text;
    send({ id: m.id, result: { turn: { id: turnId } } });
    const n = (method, params) => send({ method, params: { threadId: "thread-1", turnId, ...params } });
    n("turn/started", { turn: { id: turnId } });
    if (text === "hang") return;
    n("item/agentMessage/delta", { itemId: "m1", delta: "Let me check" });
    n("item/completed", { item: { type: "agentMessage", id: "m1", text: "Let me check" } });
    n("item/started", { item: { type: "commandExecution", id: "c1", command: "ls -la" } });
    send({ id: "approval-1", method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId, itemId: "c1", startedAtMs: 1, command: "ls -la", reason: null } });
    globalThis.pendingTurn = turnId;
  } else if (m.id === "approval-1") {
    const turnId = globalThis.pendingTurn;
    const n = (method, params) => send({ method, params: { threadId: "thread-1", turnId, ...params } });
    const answer = m.result.decision + "|" + instructions;
    n("item/agentMessage/delta", { itemId: "m2", delta: answer });
    n("item/completed", { item: { type: "agentMessage", id: "m2", text: answer } });
    n("turn/completed", { turn: { id: turnId, status: "completed", error: null } });
  } else if (m.method === "turn/interrupt") {
    send({ id: m.id, result: {} });
    send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: p.turnId, status: "interrupted", error: null } } });
  }
});
`;

async function setup(t: test.TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-codex-adapter-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "codex");
  await writeFile(executable, FAKE_APP_SERVER);
  await chmod(executable, 0o700);
  const asks: ApprovalAsk[] = [];
  const options: SessionOptions = {
    cwd: directory,
    systemPrompt: "group rules",
    settings: { model: null, effort: null, permission: null },
    requestApproval: async (ask) => {
      asks.push(ask);
      return { decision: "allow", message: "" };
    },
  };
  const adapter = new CodexAdapter({ executable });
  t.after(() => adapter.close());
  return {
    adapter,
    options,
    asks,
    starts: path.join(directory, "starts"),
    crashOnModelList: path.join(directory, "crash-on-model-list"),
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

test("a Codex turn streams text, records tool activity, asks for approval, and ends with the last message", async (t) => {
  const { adapter, options, asks } = await setup(t);
  const session = await adapter.startSession(options);
  t.after(() => session.close());
  assert.equal(session.nativeId, "thread-1");

  const events = await collect(session.send("hello"));
  assert.deepEqual(events.filter((event) => event.type === "activity").map((event) => event.activity), [
    { kind: "note", text: "Let me check" },
    { kind: "tool", toolName: "命令", detail: "ls -la" },
  ]);
  assert.deepEqual(asks, [{ toolName: "命令", detail: "ls -la" }]);
  assert.deepEqual(events.at(-1), { type: "end", outcome: "completed", text: "accept|group rules" });
});

test("interrupting a Codex turn ends it as interrupted, and resume keeps the thread id", async (t) => {
  const { adapter, options } = await setup(t);
  const session = await adapter.resumeSession("thread-1", options);
  t.after(() => session.close());
  const events = session.send("hang");
  const collected = collect(events);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await session.interrupt();
  const seen = await collected;
  assert.deepEqual(seen.at(-1), { type: "end", outcome: "interrupted", text: "" });
  assert.equal(session.alive, true);
  await session.close();
  assert.equal(session.alive, false);
});

test("the Codex catalog lists visible models and the allowed permission profiles", async (t) => {
  const { adapter, options, starts } = await setup(t);
  adapter.start();
  const catalog = {
    models: await adapter.features.models!(options.cwd),
    permissions: await adapter.features.permissions!(options.cwd),
  };
  assert.deepEqual(catalog.models.map((model) => [model.id, model.label, model.efforts]), [
    ["gpt-a", "GPT A", ["low", "medium"]],
  ]);
  assert.deepEqual(catalog.permissions.map((item) => [item.id, item.label, item.danger ?? false]), [
    [":read-only", "只读", false],
    [":workspace", "自动（可修改项目）", false],
    [":danger-full-access", "完全访问", true],
  ]);
  assert.equal((await readFile(starts, "utf8")).length, 1, "模型和权限共用同一个常驻进程");
});

test("the resident Codex process restarts on the next catalog request after it exits", async (t) => {
  const { adapter, options, starts, crashOnModelList } = await setup(t);
  await adapter.features.permissions!(options.cwd);
  await writeFile(crashOnModelList, "");
  await assert.rejects(adapter.features.models!(options.cwd), /退出/u);
  await adapter.features.models!(options.cwd);
  assert.equal((await readFile(starts, "utf8")).length, 2);
});

test("a closed Codex adapter does not restart its resident process", async (t) => {
  const { adapter, options, starts } = await setup(t);
  await adapter.features.models!(options.cwd);
  await adapter.close();
  await assert.rejects(adapter.features.models!(options.cwd), /已关闭/u);
  assert.equal((await readFile(starts, "utf8")).length, 1);
});

test("Codex settings are applied after the thread opens, and compaction waits for its turn to finish", async (t) => {
  const { adapter, options } = await setup(t);
  const settings = { model: "gpt-a", effort: "low", permission: ":workspace" };
  const session = await adapter.resumeSession("thread-1", { ...options, settings });
  t.after(() => session.close());
  await adapter.features.compact!(session);
  const events = await collect(session.send("settings"));
  assert.deepEqual(JSON.parse((events.at(-1) as { text: string }).text), [
    { threadId: "thread-1", model: "gpt-a", effort: "low", permissions: ":workspace" },
  ]);
});

test("a Codex session with default settings sends no settings update", async (t) => {
  const { adapter, options } = await setup(t);
  const session = await adapter.startSession(options);
  t.after(() => session.close());
  const events = await collect(session.send("settings"));
  assert.equal((events.at(-1) as { text: string }).text, "[]");
});

test("deleting a Codex thread treats an already missing thread as deleted", async (t) => {
  const { adapter, options } = await setup(t);
  await adapter.features.deleteSession!("thread-1", options.cwd);
  await adapter.features.deleteSession!("gone", options.cwd);
  await assert.rejects(adapter.features.deleteSession!("broken", options.cwd), /disk error/u);
});
