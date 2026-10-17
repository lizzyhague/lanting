import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentEvent, ApprovalAsk, SessionOptions } from "../types.ts";
import { GrokAdapter, toolActivity } from "./adapter.ts";

/** 假的 `grok agent stdio`：一轮里先说一句过渡的话、调一个要审批的工具，再给最终回答。 */
const FAKE_GROK = `#!/usr/bin/env node
import { createInterface } from "node:readline";
const send = (message) => console.log(JSON.stringify({ jsonrpc: "2.0", ...message }));
let rules = null;
let promptId = null;
const state = { yolo: null, model: null, effort: null, compacted: 0 };
const update = (u) => send({ method: "session/update", params: { sessionId: "grok-1", update: u } });
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  const p = m.params ?? {};
  if (m.method === "initialize") send({ id: m.id, result: { _meta: { modelState: { availableModels: [
    { modelId: "grok-fast", name: "Grok Fast", _meta: { reasoningEfforts: [{ id: "low" }, { id: "high", default: true }] } },
    { modelId: "grok-plain" },
  ] } } } });
  else if (m.method === "session/new") {
    rules = p._meta.rules; state.yolo = p._meta.yoloMode; send({ id: m.id, result: { sessionId: "grok-1" } });
  }
  else if (m.method === "session/resume") { state.yolo = p._meta.yoloMode; send({ id: m.id, result: {} }); }
  else if (m.method === "session/set_model") {
    state.model = p.modelId; state.effort = p._meta?.reasoningEffort ?? null; send({ id: m.id, result: {} });
  }
  else if (m.method === "_x.ai/compact_conversation") { state.compacted += 1; send({ id: m.id, result: {} }); }
  else if (m.method === "session/close") send({ id: m.id, result: {} });
  else if (m.method === "session/prompt") {
    promptId = m.id;
    if (p.prompt[0].text === "hang") return;
    if (p.prompt[0].text === "state") {
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(state) } });
      send({ id: promptId, result: { stopReason: "end_turn" } });
      return;
    }
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
    settings: { model: null, effort: null, permission: null },
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
  t.after(() => session.close());
  const collected = collect(session.send("hang"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await session.interrupt();
  assert.deepEqual((await collected).at(-1), { type: "end", outcome: "interrupted", text: "" });
  await session.close();
  assert.equal(session.alive, false);
});

test("the Grok catalog lists models from initialize and the two permission modes", async (t) => {
  const { adapter, options } = await setup(t);
  const catalog = {
    models: await adapter.features.models!(options.cwd),
    permissions: await adapter.features.permissions!(options.cwd),
  };
  assert.deepEqual(catalog.models.map((model) => [model.id, model.label, model.efforts]), [
    ["grok-fast", "Grok Fast", ["low", "high"]],
    ["grok-plain", "grok-plain", []],
  ]);
  assert.deepEqual(catalog.permissions.map((item) => item.id), ["ask", "always-approve"]);
});

test("Grok settings are applied when the session opens, and always-approve answers permissions itself", async (t) => {
  const { adapter, options, asks } = await setup(t);
  const settings = { model: "grok-fast", effort: "low", permission: "always-approve" };
  const session = await adapter.resumeSession("grok-1", { ...options, settings });
  t.after(() => session.close());
  const state = await collect(session.send("state"));
  assert.deepEqual(JSON.parse((state.at(-1) as { text: string }).text),
    { yolo: true, model: "grok-fast", effort: "low", compacted: 0 });

  const events = await collect(session.send("hello"));
  assert.deepEqual(asks, []);
  assert.match((events.at(-1) as { text: string }).text, /^allow-once\|/u);

  await adapter.features.compact!(session);
  const after = await collect(session.send("state"));
  assert.equal(JSON.parse((after.at(-1) as { text: string }).text).compacted, 1);
});

test("deleting a Grok session removes its directory under any session group", async (t) => {
  const grokHome = await mkdtemp(path.join(tmpdir(), "lanting-grok-home-"));
  t.after(() => rm(grokHome, { recursive: true, force: true }));
  const sessionDir = path.join(grokHome, "sessions", "some-group", "grok-1");
  const otherDir = path.join(grokHome, "sessions", "some-group", "grok-2");
  await mkdir(sessionDir, { recursive: true });
  await mkdir(otherDir, { recursive: true });
  await writeFile(path.join(sessionDir, "updates.jsonl"), "{}\n");
  const adapter = new GrokAdapter({ executable: "/nonexistent/grok", grokHome });

  await adapter.features.deleteSession!("grok-1", grokHome);
  await assert.rejects(stat(sessionDir), { code: "ENOENT" });
  assert.ok((await stat(otherDir)).isDirectory());
  await adapter.features.deleteSession!("grok-1", grokHome);
  await assert.rejects(adapter.features.deleteSession!("../grok-2", grokHome), /格式不对/u);
  assert.ok((await stat(otherDir)).isDirectory());
});

test("Grok tool activity shows the path for read_file, list_dir and grep", () => {
  assert.deepEqual(toolActivity({ title: "read_file", kind: "read", rawInput: { target_file: "/w/a.md" } }), {
    kind: "tool",
    toolName: "read_file",
    detail: "/w/a.md",
  });
  assert.deepEqual(toolActivity({ title: "list_dir", kind: "read", rawInput: { target_directory: "/w" } }), {
    kind: "tool",
    toolName: "list_dir",
    detail: "/w",
  });
  assert.deepEqual(toolActivity({ title: "grep", kind: "search", rawInput: { pattern: "todo", path: "/w" } }), {
    kind: "tool",
    toolName: "grep",
    detail: "/w",
  });
});
