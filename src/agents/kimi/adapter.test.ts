import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { englishText, localText } from "../../i18n/text.ts";
import type { AgentEvent, AgentSession, ApprovalAnswer, ApprovalAsk, SessionOptions } from "../types.ts";
import {
  firstMessage,
  KIMI_PERMISSIONS,
  KimiAdapter,
  LOGIN_REQUIRED,
  modelOptions,
  toolActivity,
} from "./adapter.ts";

const FAKE_KIMI = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
if (process.argv[2] !== "acp") process.exit(2);
const storePath = process.cwd() + "/sessions.json";
const load = () => { try { return JSON.parse(readFileSync(storePath, "utf8")); } catch { return {}; } };
const save = (store) => writeFileSync(storePath, JSON.stringify(store));
const out = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const reply = (id, result) => out({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => out({ jsonrpc: "2.0", id, error: { code, message } });
const options = () => [
  { type: "select", id: "model", currentValue: "kimi-code/default", options: [
    { value: "kimi-code/default", name: "K2.8 Preview" },
    { value: "kimi-code/k3", name: "K3", description: "Kimi K3" },
  ] },
  { type: "select", id: "thinking", currentValue: "max", options: [
    { value: "low", name: "Thinking Low" }, { value: "high", name: "Thinking High" }, { value: "max", name: "Thinking Max" },
  ] },
  { type: "select", id: "mode", currentValue: "default", options: [{ value: "default", name: "Default" }] },
];
let session = null;
let promptId = null;
let settings = {};
let waiting = new Map();
let nextServerId = 100;
let buffer = "";
const update = (update) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: session, update } });
const say = (text) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const end = (reason = "end_turn") => { reply(promptId, { stopReason: reason }); promptId = null; };
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
function ask(params, next) {
  const id = nextServerId++; waiting.set(id, next);
  out({ jsonrpc: "2.0", id, method: "session/request_permission", params });
}
function handle(message) {
  if (message.method === undefined) {
    const next = waiting.get(message.id); if (next) { waiting.delete(message.id); next(message.result.outcome); }
    return;
  }
  const { id, method, params } = message;
  switch (method) {
    case "initialize": return reply(id, { protocolVersion: 1 });
    case "session/new": {
      if (process.env.FAKE_AUTH === "1") return fail(id, -32000, "Authentication required");
      session = "s-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      const store = load(); store[session] = []; save(store);
      return reply(id, { sessionId: session, configOptions: options(), modes: { currentModeId: "default" } });
    }
    case "session/resume": {
      const store = load(); if (!store[params.sessionId]) return fail(id, -32002, "Session not found");
      session = params.sessionId;
      return reply(id, { configOptions: options(), modes: { currentModeId: "default" } });
    }
    case "session/set_config_option":
      settings[params.configId] = params.value;
      return reply(id, { configOptions: options() });
    case "session/delete": {
      const store = load();
      if (!store[params.sessionId]) return fail(id, -32602, "Session not found");
      delete store[params.sessionId]; save(store); return reply(id, {});
    }
    case "session/cancel":
      if (promptId !== null) end("cancelled");
      return;
    case "session/prompt": return prompt(id, params.prompt[0].text);
    default: return fail(id, -32601, "unknown");
  }
}
const permissionOptions = [
  { optionId: "approve_once", name: "Approve once", kind: "allow_once" },
  { optionId: "approve_always", name: "Approve for this session", kind: "allow_always" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];
function prompt(id, text) {
  promptId = id;
  const store = load(); store[session].push(text); save(store);
  const command = text.split("\\n").at(-1);
  if (command === "state") { say(JSON.stringify({ session, settings, prompts: store[session] })); return end(); }
  if (command === "tool") {
    update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Need a command" } });
    say("Let me check");
    update({ sessionUpdate: "tool_call", toolCallId: "t-1", title: "Bash", kind: "execute", status: "pending" });
    update({ sessionUpdate: "tool_call_update", toolCallId: "t-1", status: "in_progress", content: [{ type: "content", content: { type: "text", text: '{"command":"pwd"}' } }] });
    ask({ sessionId: session, toolCall: { toolCallId: "t-1", title: "Bash", content: [{ type: "content", content: { type: "text", text: "Requesting approval to Running: pwd" } }] }, options: permissionOptions }, (outcome) => {
      update({ sessionUpdate: "tool_call_update", toolCallId: "t-1", status: outcome.outcome === "selected" ? "completed" : "failed" });
      say(outcome.outcome === "selected" ? outcome.optionId : "cancelled");
      update({ sessionUpdate: "usage_update", used: 262144, size: 1048576 });
      end();
    });
    return;
  }
  if (command === "question") {
    ask({ sessionId: session, toolCall: { toolCallId: "q-1", title: "AskUserQuestion" }, options: [
      { optionId: "answer-a", name: "Choose A", kind: "allow_once" },
      { optionId: "answer-b", name: "Choose B", kind: "allow_once" },
      { optionId: "skip", name: "Skip", kind: "reject_once" },
    ] }, (outcome) => { say(outcome.outcome); end(); });
    return;
  }
  if (command === "hold") return say("working");
  if (command === "unauthorized") { promptId = null; return fail(id, -32000, "Authentication required"); }
  if (command === "refuse") { say("half"); return end("refusal"); }
  if (command === "crash") { say("before crash"); return process.exit(3); }
  say("echo:" + text); end();
}
`;

type Approval = { ask: ApprovalAsk; signal: AbortSignal | undefined; resolve: (answer: ApprovalAnswer) => void };

async function setup(t: test.TestContext, env: Record<string, string> = {}): Promise<{ adapter: KimiAdapter; cwd: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "lanting-kimi-adapter-"));
  const executable = path.join(cwd, "fake-kimi.mjs");
  await writeFile(executable, FAKE_KIMI, "utf8");
  await chmod(executable, 0o700);
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) { saved.set(key, process.env[key]); process.env[key] = value; }
  t.after(async () => {
    for (const [key, value] of saved) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(cwd, { recursive: true, force: true });
  });
  return { adapter: new KimiAdapter({ executable }), cwd };
}

function options(cwd: string, settings = { model: null, effort: null, permission: null } as SessionOptions["settings"], approvals: Approval[] = []): SessionOptions {
  return {
    cwd,
    systemPrompt: "GROUP RULES",
    settings,
    requestApproval: (ask, signal) => new Promise((resolve) => approvals.push({ ask, signal, resolve })),
  };
}

async function drain(session: AgentSession, text: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of session.send(text)) events.push(event);
  return events;
}

function endOf(events: AgentEvent[]): Extract<AgentEvent, { type: "end" }> {
  const event = events.at(-1);
  assert.equal(event?.type, "end");
  return event as Extract<AgentEvent, { type: "end" }>;
}

async function waitFor(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 10));
}

test("catalog maps Kimi models and thinking levels without leaving its probe session", async (t) => {
  const { adapter, cwd } = await setup(t);
  assert.equal(adapter.kind, "kimi");
  assert.equal(adapter.closeAfterTurn, true);
  assert.deepEqual(Object.keys(adapter.features), ["models", "permissions", "usage", "deleteSession"]);
  assert.deepEqual(await adapter.features.models!(cwd), [
    { id: "kimi-code/default", label: "K2.8 Preview", description: "", efforts: ["low", "high", "max"], defaultEffort: "max" },
    { id: "kimi-code/k3", label: "K3", description: "Kimi K3", efforts: ["low", "high", "max"], defaultEffort: "max" },
  ]);
  assert.deepEqual(await adapter.features.permissions!(cwd), [...KIMI_PERMISSIONS]);
  assert.deepEqual(JSON.parse(await readFile(path.join(cwd, "sessions.json"), "utf8")), {});
});

test("new and resumed sessions apply settings and send group rules only once", async (t) => {
  const { adapter, cwd } = await setup(t);
  const settings = { model: "kimi-code/k3", effort: "high", permission: "ask" };
  const session = await adapter.startSession(options(cwd, settings));
  t.after(() => session.close());
  const id = session.nativeId!;
  const first = endOf(await drain(session, "hello"));
  assert.equal(first.text, `echo:${firstMessage("GROUP RULES", "hello")}`);
  const state = JSON.parse(endOf(await drain(session, "state")).text);
  assert.deepEqual(state.settings, { mode: "default", model: "kimi-code/k3", thinking: "high" });
  assert.equal(state.prompts.filter((prompt: string) => prompt.includes("GROUP RULES")).length, 1);
  await session.close();

  const resumed = await adapter.resumeSession(id, options(cwd, settings));
  t.after(() => resumed.close());
  const after = JSON.parse(endOf(await drain(resumed, "state")).text);
  assert.equal(after.session, id);
  assert.equal(after.prompts.filter((prompt: string) => prompt.includes("GROUP RULES")).length, 1);
});

test("drops thought chunks, streams text and tool activity, asks once, and records context usage", async (t) => {
  const { adapter, cwd } = await setup(t);
  const approvals: Approval[] = [];
  const session = await adapter.startSession(options(cwd, { model: null, effort: null, permission: "ask" }, approvals));
  t.after(() => session.close());
  const turn = drain(session, "tool");
  await waitFor(() => approvals.length === 1);
  assert.deepEqual(approvals[0]!.ask, { toolName: "bash", detail: "pwd" });
  approvals[0]!.resolve({ decision: "allow", message: "" });
  const events = await turn;
  assert.deepEqual(events.filter((event) => event.type === "activity").map((event) => event.activity), [
    { kind: "note", text: "Let me check" },
    { kind: "tool", toolName: "bash", detail: "", toolCallId: "t-1" },
  ]);
  assert.deepEqual(events.filter((event) => event.type === "activity.update"), [{
    type: "activity.update", toolCallId: "t-1", activity: { kind: "tool", toolName: "bash", detail: "pwd", toolCallId: "t-1" },
  }]);
  assert.equal(endOf(events).text, "approve_once");
  assert.deepEqual(await adapter.features.usage!({ nativeId: session.nativeId!, cwd, reason: "turn", session: async () => null }), [
    { kind: "context", percent: 25 },
  ]);
});

test("always approve and denial both select one-time options", async (t) => {
  const { adapter, cwd } = await setup(t);
  const auto = await adapter.startSession(options(cwd, { model: null, effort: null, permission: "always-approve" }));
  t.after(() => auto.close());
  assert.equal(endOf(await drain(auto, "tool")).text, "approve_once");

  const approvals: Approval[] = [];
  const ask = await adapter.startSession(options(cwd, { model: null, effort: null, permission: "ask" }, approvals));
  t.after(() => ask.close());
  const turn = drain(ask, "tool");
  await waitFor(() => approvals.length === 1);
  approvals[0]!.resolve({ decision: "deny", message: "no" });
  assert.equal(endOf(await turn).text, "reject");
});

test("cancels AskUserQuestion without showing approval or choosing an answer", async (t) => {
  const { adapter, cwd } = await setup(t);
  for (const permission of ["ask", "always-approve"]) {
    const approvals: Approval[] = [];
    const session = await adapter.startSession(options(cwd, { model: null, effort: null, permission }, approvals));
    t.after(() => session.close());
    const events = await drain(session, "question");
    assert.equal(endOf(events).text, "cancelled");
    assert.equal(approvals.length, 0);
    assert.deepEqual(events.filter((event) => event.type === "activity").map((event) => event.activity), [{
      kind: "denied",
      toolName: "Question",
      toolKey: "tool.question",
      message: "In the group chat, AIs don't ask you questions directly; questions go in the reply.",
      messageText: localText("denied.askInReply"),
    }]);
    await session.close();
  }
});

test("interrupts a turn and maps auth, early stops and crashes", async (t) => {
  const { adapter, cwd } = await setup(t);
  const session = await adapter.startSession(options(cwd));
  t.after(() => session.close());
  const held = drain(session, "hold");
  await new Promise((resolve) => setTimeout(resolve, 50));
  await session.interrupt();
  assert.deepEqual(endOf(await held), { type: "end", outcome: "interrupted", text: "working" });
  const unauthorized = endOf(await drain(session, "unauthorized"));
  assert.equal(unauthorized.error, englishText(LOGIN_REQUIRED));
  assert.deepEqual(unauthorized.errorText, LOGIN_REQUIRED);
  assert.equal(endOf(await drain(session, "refuse")).outcome, "failed");
  assert.equal(endOf(await drain(session, "crash")).error, "The Kimi process exited.");
});

test("deletes native sessions and rewrites login failure while opening", async (t) => {
  const { adapter, cwd } = await setup(t);
  const session = await adapter.startSession(options(cwd));
  const id = session.nativeId!;
  await session.close();
  await adapter.features.deleteSession!(id, cwd);
  await adapter.features.deleteSession!(id, cwd);
  assert.deepEqual(JSON.parse(await readFile(path.join(cwd, "sessions.json"), "utf8")), {});

  process.env.FAKE_AUTH = "1";
  t.after(() => delete process.env.FAKE_AUTH);
  await assert.rejects(adapter.startSession(options(cwd)), new RegExp(englishText(LOGIN_REQUIRED).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("model and tool helpers tolerate incomplete ACP records", () => {
  assert.deepEqual(modelOptions({ sessionId: "s", configOptions: [], modes: {} }), []);
  assert.deepEqual(toolActivity({ title: "Read", rawInput: { path: "/x" } }), {
    kind: "tool", toolName: "Read", detail: "/x",
  });
});


test("tool details include search patterns and their scope", () => {
  assert.deepEqual(toolActivity({ title: "Grep", rawInput: { pattern: "tool_call", path: "src" } }), {
    kind: "tool", toolName: "Grep", detail: "tool_call · src",
  });
  assert.deepEqual(toolActivity({ title: "Glob", rawInput: { glob: "**/*.ts" } }), {
    kind: "tool", toolName: "Glob", detail: "**/*.ts",
  });
});
