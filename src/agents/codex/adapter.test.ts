import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentEvent, ApprovalAsk, SessionOptions } from "../types.ts";
import { CodexAdapter } from "./adapter.ts";

/** 假的 codex app-server：一轮里先说一句过渡的话、跑一条要审批的命令，再给最终回答。 */
const FAKE_APP_SERVER = `#!/usr/bin/env node
import { createInterface } from "node:readline";
const send = (message) => console.log(JSON.stringify(message));
let instructions = null;
let turn = 0;
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
    requestApproval: async (ask) => {
      asks.push(ask);
      return { decision: "allow", message: "" };
    },
  };
  return { adapter: new CodexAdapter({ executable }), options, asks };
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
