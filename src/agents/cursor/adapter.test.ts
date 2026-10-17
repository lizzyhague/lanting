import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentEvent, AgentSession, ApprovalAnswer, ApprovalAsk, SessionOptions } from "../types.ts";
import { CURSOR_PERMISSIONS, CursorAdapter, firstMessage, toolActivity } from "./adapter.ts";

/** Fake `agent acp`: the prompt text decides how the round goes; session records are stored in cwd, so they can be loaded across processes. */
const FAKE_CURSOR = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const storePath = process.cwd() + "/sessions.json";
const load = () => { try { return JSON.parse(readFileSync(storePath, "utf8")); } catch { return {}; } };
const save = (store) => writeFileSync(storePath, JSON.stringify(store));
const out = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const reply = (id, result) => out({ jsonrpc: "2.0", id, result });
let session = null;
let mode = null;
let calls = [];
let promptId = null;
let waiting = null;
let nextServerId = 100;
const update = (update) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: session, update } });
const say = (text) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const end = (stopReason = "end_turn") => { reply(promptId, { stopReason }); promptId = null; };
const ask = (method, params, next) => {
  const id = nextServerId++;
  waiting = { id, next };
  out({ jsonrpc: "2.0", id, method, params });
};
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
function handle(message) {
  if (message.method === undefined) {
    if (waiting && waiting.id === message.id) { const next = waiting.next; waiting = null; next(message); }
    return;
  }
  const { id, method, params } = message;
  calls.push(method);
  switch (method) {
    case "initialize": return reply(id, { protocolVersion: 1 });
    case "authenticate": return reply(id, {});
    case "session/new": {
      session = "s-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      const store = load();
      store[session] = [];
      save(store);
      return reply(id, { sessionId: session });
    }
    case "session/load": {
      const store = load();
      if (!store[params.sessionId]) return out({ jsonrpc: "2.0", id, error: { code: -32002, message: "Session not found" } });
      session = params.sessionId;
      for (const text of store[session]) {
        update({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
        say("replayed answer");
      }
      return reply(id, { modes: { currentModeId: "agent" } });
    }
    case "session/set_mode":
      mode = params.modeId;
      return reply(id, {});
    case "session/cancel":
      // Pending approvals are answered cancelled by the client, and the round ends then.
      if (!waiting && promptId !== null) end("cancelled");
      return;
    case "session/prompt": return prompt(id, params.prompt[0].text);
    default: return out({ jsonrpc: "2.0", id, error: { code: -32601, message: "nope" } });
  }
}
function prompt(id, text) {
  promptId = id;
  const store = load();
  store[session].push(text);
  save(store);
  const command = text.split("\\n").at(-1);
  if (command === "state") {
    say(JSON.stringify({ session, mode, calls, prompts: store[session] }));
    return end();
  }
  if (command === "tool") {
    say("Let me run it.");
    const toolCall = { toolCallId: "t-1", title: "\`touch x.txt\`", kind: "execute", status: "pending", rawInput: { command: "touch x.txt" } };
    update({ sessionUpdate: "tool_call", ...toolCall });
    ask("session/request_permission", {
      sessionId: session,
      toolCall: { ...toolCall, content: [{ type: "content", content: { type: "text", text: "Not in allowlist: touch" } }] },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    }, (response) => {
      const outcome = response.result.outcome;
      if (outcome.outcome === "cancelled") { say("partial"); return end("cancelled"); }
      update({ sessionUpdate: "tool_call_update", toolCallId: "t-1", status: "completed" });
      say("done:" + (outcome.outcome === "selected" ? outcome.optionId : "cancelled"));
      end();
    });
    return;
  }
  if (command === "question" || command === "plan") {
    const method = command === "question" ? "cursor/ask_question" : "cursor/create_plan";
    ask(method, { question: "Which?" }, (response) => {
      say("after:" + JSON.stringify(response.result));
      end();
    });
    return;
  }
  if (command === "refuse") { say("half"); return end("refusal"); }
  if (command === "error") { promptId = null; return out({ jsonrpc: "2.0", id, error: { code: -32000, message: "Upstream refused" } }); }
  if (command === "crash") { say("before crash"); process.exit(3); }
  say("echo:" + text);
  end();
}
`;

type Approval = { ask: ApprovalAsk; signal: AbortSignal | undefined; resolve: (answer: ApprovalAnswer) => void };

async function setup(t: test.TestContext): Promise<{ adapter: CursorAdapter; cwd: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "lanting-cursor-adapter-"));
  const executable = path.join(cwd, "fake-cursor.mjs");
  await writeFile(executable, FAKE_CURSOR, "utf8");
  await chmod(executable, 0o700);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { adapter: new CursorAdapter({ executable }), cwd };
}

function sessionOptions(
  cwd: string,
  permission: string | null = null,
  approvals: Approval[] = [],
): SessionOptions {
  return {
    cwd,
    systemPrompt: "GROUP RULES",
    settings: { model: null, effort: null, permission },
    requestApproval: (ask, signal) => new Promise((resolve) => approvals.push({ ask, signal, resolve })),
  };
}

async function drain(session: AgentSession, text: string, onEvent?: (event: AgentEvent) => void): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of session.send(text)) {
    events.push(event);
    onEvent?.(event);
  }
  return events;
}

function endOf(events: AgentEvent[]): Extract<AgentEvent, { type: "end" }> {
  const last = events.at(-1);
  assert.equal(last?.type, "end");
  return last as Extract<AgentEvent, { type: "end" }>;
}

async function waitFor(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 10));
}

test("declares only the permission catalog", async () => {
  const adapter = new CursorAdapter({ executable: "/unused" });
  assert.equal(adapter.kind, "cursor");
  assert.equal(adapter.closeAfterTurn, true);
  assert.deepEqual(Object.keys(adapter.features), ["permissions"]);
  assert.deepEqual(await adapter.features.permissions!("/tmp"), [...CURSOR_PERMISSIONS]);
  assert.equal(CURSOR_PERMISSIONS.find((option) => option.id === "always-approve")?.danger, true);
});

test("sends the group rules once in a new session and not after resume", async (t) => {
  const { adapter, cwd } = await setup(t);
  const session = await adapter.startSession(sessionOptions(cwd));
  t.after(() => session.close());
  const nativeId = session.nativeId;
  assert.ok(nativeId);

  const first = await drain(session, "<lizzy>hi</lizzy>");
  assert.deepEqual(endOf(first), { type: "end", outcome: "completed", text: `echo:${firstMessage("GROUP RULES", "<lizzy>hi</lizzy>")}` });
  assert.deepEqual(first.filter((event) => event.type === "text").map((event) => event.delta), [endOf(first).text]);

  const state = JSON.parse(endOf(await drain(session, "state")).text) as Record<string, unknown>;
  assert.equal(state.mode, "agent");
  assert.deepEqual(state.calls, ["initialize", "authenticate", "session/new", "session/set_mode", "session/prompt", "session/prompt"]);
  await session.close();
  assert.equal(session.alive, false);

  // Resume: history replayed by Cursor stays out of this round, and the rules aren't prepended again.
  const resumed = await adapter.resumeSession(nativeId, sessionOptions(cwd));
  t.after(() => resumed.close());
  assert.equal(resumed.nativeId, nativeId);
  const events = await drain(resumed, "state");
  assert.equal(events.length, 2);
  const after = JSON.parse(endOf(events).text) as Record<string, unknown>;
  assert.equal(after.session, nativeId);
  assert.equal(after.mode, "agent");
  assert.deepEqual(after.calls, ["initialize", "authenticate", "session/load", "session/set_mode", "session/prompt"]);
  const prompts = after.prompts as string[];
  assert.equal(prompts.filter((prompt) => prompt.includes("GROUP RULES")).length, 1);
  assert.equal(prompts.at(-1), "state");
  await resumed.close();
});

test("fails to resume a session Cursor does not know", async (t) => {
  const { adapter, cwd } = await setup(t);
  await assert.rejects(adapter.resumeSession("missing", sessionOptions(cwd)), /Cursor session\/load failed: Session not found/);
});

test("asks the host and picks one-time options", async (t) => {
  const { adapter, cwd } = await setup(t);
  const approvals: Approval[] = [];
  const session = await adapter.startSession(sessionOptions(cwd, "ask", approvals));
  t.after(() => session.close());
  await drain(session, "warm up");

  for (const [decision, expected] of [["allow", "done:allow-once"], ["deny", "done:reject-once"]] as const) {
    const events = await drain(session, "tool", (event) => {
      if (event.type === "activity" && event.activity.kind === "tool") {
        void waitFor(() => approvals.length > 0).then(() => approvals.shift()!.resolve({ decision, message: "" }));
      }
    });
    assert.deepEqual(endOf(events), { type: "end", outcome: "completed", text: expected });
    assert.deepEqual(events.filter((event) => event.type === "activity").map((event) => event.activity), [
      { kind: "note", text: "Let me run it." },
      { kind: "tool", toolName: "touch x.txt", detail: "" },
    ]);
  }
  await session.close();
});

test("passes the tool and Cursor's reason to the approval card", async (t) => {
  const { adapter, cwd } = await setup(t);
  const approvals: Approval[] = [];
  const session = await adapter.startSession(sessionOptions(cwd, "ask", approvals));
  t.after(() => session.close());
  await drain(session, "warm up");
  const turn = drain(session, "tool");
  await waitFor(() => approvals.length > 0);
  assert.deepEqual(approvals[0]!.ask, { toolName: "touch x.txt", detail: "Not in allowlist: touch" });
  approvals[0]!.resolve({ decision: "allow", message: "" });
  await turn;
  await session.close();
});

test("always-approve picks allow-once without asking", async (t) => {
  const { adapter, cwd } = await setup(t);
  const approvals: Approval[] = [];
  const session = await adapter.startSession(sessionOptions(cwd, "always-approve", approvals));
  t.after(() => session.close());
  await drain(session, "warm up");
  assert.equal(endOf(await drain(session, "tool")).text, "done:allow-once");
  assert.equal(approvals.length, 0);
  await session.close();
});

test("interrupt withdraws the approval and ends the turn as interrupted", async (t) => {
  const { adapter, cwd } = await setup(t);
  const approvals: Approval[] = [];
  const session = await adapter.startSession(sessionOptions(cwd, "ask", approvals));
  t.after(() => session.close());
  await drain(session, "warm up");
  const turn = drain(session, "tool");
  await waitFor(() => approvals.length > 0);
  await session.interrupt();
  assert.equal(approvals[0]!.signal?.aborted, true);
  const events = await turn;
  assert.deepEqual(endOf(events), { type: "end", outcome: "interrupted", text: "partial" });
  // A late web answer is no longer written back.
  approvals[0]!.resolve({ decision: "allow", message: "" });
  assert.equal(endOf(await drain(session, "after")).outcome, "completed");
  await session.close();
});

test("close withdraws a pending approval and fails the turn", async (t) => {
  const { adapter, cwd } = await setup(t);
  const approvals: Approval[] = [];
  const session = await adapter.startSession(sessionOptions(cwd, "ask", approvals));
  t.after(() => session.close());
  await drain(session, "warm up");
  const turn = drain(session, "tool");
  await waitFor(() => approvals.length > 0);
  await session.close();
  assert.equal(approvals[0]!.signal?.aborted, true);
  assert.equal(session.alive, false);
  assert.equal(endOf(await turn).outcome, "failed");
});

test("question and plan requests are cancelled without blocking the turn", async (t) => {
  const { adapter, cwd } = await setup(t);
  const session = await adapter.startSession(sessionOptions(cwd));
  t.after(() => session.close());
  await drain(session, "warm up");
  for (const [command, toolKey] of [["question", "tool.question"], ["plan", "tool.confirmPlan"]] as const) {
    const events = await drain(session, command);
    assert.deepEqual(endOf(events), { type: "end", outcome: "completed", text: `after:{"outcome":"cancelled"}` });
    const denied = events.find((event) => event.type === "activity" && event.activity.kind === "denied");
    assert.equal(denied?.type === "activity" && denied.activity.toolKey, toolKey);
  }
  await session.close();
});

test("maps other stop reasons, errors and crashes to failed", async (t) => {
  const { adapter, cwd } = await setup(t);
  const session = await adapter.startSession(sessionOptions(cwd));
  t.after(() => session.close());
  await drain(session, "warm up");
  assert.deepEqual(endOf(await drain(session, "refuse")), {
    type: "end",
    outcome: "failed",
    text: "half",
    error: "Cursor ended the round early (refusal).",
  });
  const error = endOf(await drain(session, "error"));
  assert.equal(error.outcome, "failed");
  assert.match(error.error ?? "", /Upstream refused/);
  const crash = endOf(await drain(session, "crash"));
  assert.deepEqual(crash, { type: "end", outcome: "failed", text: "before crash", error: "The Cursor process exited." });
  assert.equal(session.alive, false);
  await session.close();
});

test("reports a missing executable when opening a session", async () => {
  const adapter = new CursorAdapter({ executable: "/nonexistent/agent" });
  await assert.rejects(adapter.startSession(sessionOptions(tmpdir())), /Cannot start Cursor/);
});

test("toolActivity strips Cursor's backticked titles", () => {
  assert.deepEqual(toolActivity({ title: "`ls -la`", kind: "execute", rawInput: { command: "ls -la" } }), {
    kind: "tool",
    toolName: "ls -la",
    detail: "",
  });
  assert.deepEqual(toolActivity({ title: "Read file", kind: "read", rawInput: { path: "/a/b.ts" } }), {
    kind: "tool",
    toolName: "Read file",
    detail: "/a/b.ts",
  });
  assert.deepEqual(toolActivity({}), { kind: "tool", toolName: "Tool", toolKey: "tool.generic", detail: "" });
});
