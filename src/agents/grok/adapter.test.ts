import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentEvent, ApprovalAsk, SessionOptions } from "../types.ts";
import { GrokAdapter } from "./adapter.ts";

/** 假的 `grok agent stdio`：一轮里先说一句过渡的话、调一个要审批的工具，再给最终回答。 */
const FAKE_GROK = `#!/usr/bin/env node
import { createInterface } from "node:readline";
const send = (message) => console.log(JSON.stringify({ jsonrpc: "2.0", ...message }));
let rules = null;
let promptId = null;
const update = (u) => send({ method: "session/update", params: { sessionId: "grok-1", update: u } });
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  const p = m.params ?? {};
  if (m.method === "initialize") send({ id: m.id, result: {} });
  else if (m.method === "session/new") { rules = p._meta.rules; send({ id: m.id, result: { sessionId: "grok-1" } }); }
  else if (m.method === "session/resume") send({ id: m.id, result: {} });
  else if (m.method === "session/close") send({ id: m.id, result: {} });
  else if (m.method === "session/prompt") {
    promptId = m.id;
    if (p.prompt[0].text === "hang") return;
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Let me look" } });
    update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Run", kind: "execute", rawInput: { command: "ls" } });
    send({ id: "perm-1", method: "session/request_permission", params: { sessionId: "grok-1",
      toolCall: { title: "Run", kind: "execute", rawInput: { command: "ls" } },
      options: [
        { optionId: "allow-always", name: "Always", kind: "allow_always" },
        { optionId: "allow-once", name: "Allow", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ] } });
  } else if (m.id === "perm-1") {
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: m.result.outcome.optionId + "|" + rules } });
    send({ id: promptId, result: { stopReason: "end_turn" } });
  } else if (m.method === "session/cancel") {
    send({ id: promptId, result: { stopReason: "cancelled" } });
  }
});
`;

async function setup(t: test.TestContext, decision: "allow" | "deny" = "allow") {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-grok-adapter-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "grok");
  await writeFile(executable, FAKE_GROK);
  await chmod(executable, 0o700);
  const asks: ApprovalAsk[] = [];
  const options: SessionOptions = {
    cwd: directory,
    systemPrompt: "group rules",
    requestApproval: async (ask) => {
      asks.push(ask);
      return { decision, message: "" };
    },
  };
  return { adapter: new GrokAdapter({ executable }), options, asks };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

test("a Grok turn streams text, records tool activity, picks one-time options, and ends with the last segment", async (t) => {
  const { adapter, options, asks } = await setup(t);
  const session = await adapter.startSession(options);
  t.after(() => session.close());
  assert.equal(session.nativeId, "grok-1");

  const events = await collect(session.send("hello"));
  assert.deepEqual(events.filter((event) => event.type === "activity").map((event) => event.activity), [
    { kind: "note", text: "Let me look" },
    { kind: "tool", toolName: "Run", detail: "ls" },
  ]);
  assert.deepEqual(asks, [{ toolName: "Run", detail: "ls" }]);
  assert.deepEqual(events.at(-1), { type: "end", outcome: "completed", text: "allow-once|group rules" });
});

test("a denied Grok permission selects the one-time reject option", async (t) => {
  const { adapter, options } = await setup(t, "deny");
  const session = await adapter.startSession(options);
  t.after(() => session.close());
  const events = await collect(session.send("hello"));
  assert.deepEqual(events.at(-1), { type: "end", outcome: "completed", text: "reject-once|group rules" });
});

test("interrupting a Grok turn ends it as interrupted and close stops the process", async (t) => {
  const { adapter, options } = await setup(t);
  const session = await adapter.resumeSession("grok-1", options);
  const collected = collect(session.send("hang"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await session.interrupt();
  assert.deepEqual((await collected).at(-1), { type: "end", outcome: "interrupted", text: "" });
  await session.close();
  assert.equal(session.alive, false);
});
