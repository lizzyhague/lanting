import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentEvent, AgentSession, ApprovalAnswer, ApprovalAsk, SessionOptions } from "../types.ts";
import {
  ANTIGRAVITY_PERMISSIONS,
  AntigravityAdapter,
  firstMessage,
  LOGIN_REQUIRED_MESSAGE,
  toolActivity,
} from "./adapter.ts";

/**
 * Fake ACP Server: the prompt text decides how the round goes; session records are stored in cwd, so they can be resumed across processes.
 * With `login-on-new` in cwd, session/new prints an authorization URL as if credentials expired, then waits forever;
 * with `auth-required`, session/new returns auth_required.
 */
const FAKE_SERVER = `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
if (!process.argv.includes("--uid=")) process.exit(2);
const storePath = process.cwd() + "/sessions.json";
const load = () => { try { return JSON.parse(readFileSync(storePath, "utf8")); } catch { return {}; } };
const save = (store) => writeFileSync(storePath, JSON.stringify(store));
const out = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const reply = (id, result) => out({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => out({ jsonrpc: "2.0", id, error: { code, message } });
const loginPrompt = () => process.stderr.write("Open the following link to authenticate the ACP server: https://accounts.example/o/oauth2/auth?x=1\\n");
let session = null;
let mode = null;
let calls = [];
let promptId = null;
let ignoreEof = false;
const waiting = new Map();
let nextServerId = 100;
const update = (update) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: session, update } });
const say = (text) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const end = (stopReason = "end_turn") => { reply(promptId, { stopReason }); promptId = null; };
const ask = (method, params, next) => {
  const id = nextServerId++;
  waiting.set(id, next);
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
process.stdin.on("end", () => { if (!ignoreEof) process.exit(0); });
process.on("SIGTERM", () => {
  process.stderr.write("Fatal Python error from unexpected signum: 15\\n");
  process.exit(1);
});
function handle(message) {
  if (message.method === undefined) {
    const next = waiting.get(message.id);
    if (next) { waiting.delete(message.id); next(message); }
    return;
  }
  const { id, method, params } = message;
  calls.push(method);
  switch (method) {
    case "initialize": return reply(id, { protocolVersion: 1 });
    case "session/new": {
      if (existsSync(process.cwd() + "/login-on-new")) { ignoreEof = true; loginPrompt(); setInterval(() => {}, 1000); return; }
      if (existsSync(process.cwd() + "/auth-required")) return fail(id, -32000, "Authentication required");
      session = "s-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      const store = load();
      store[session] = [];
      save(store);
      return reply(id, { sessionId: session });
    }
    case "session/resume": {
      const store = load();
      if (!store[params.sessionId]) return fail(id, -32002, "Session not found");
      session = params.sessionId;
      return reply(id, { modes: { currentModeId: "default" } });
    }
    case "session/set_mode":
      mode = params.modeId;
      return reply(id, {});
    case "session/cancel":
      // Pending approvals are answered cancelled by the client, and the round ends then.
      if (waiting.size === 0 && promptId !== null) end("cancelled");
      return;
    case "session/prompt": return prompt(id, params.prompt[0].text);
    default: return fail(id, -32601, "nope");
  }
}
const EXECUTE_OPTIONS = [
  { optionId: "allow_always", name: "Allow Always (risky)", kind: "allow_always" },
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];
const EDIT_OPTIONS = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];
function execute(toolCallId, cwd, next) {
  const toolCall = { toolCallId, title: "touch x.txt", kind: "execute", status: "pending", rawInput: { CommandLine: "touch x.txt", Cwd: cwd, WaitMsBeforeAsync: 5000 } };
  update({ sessionUpdate: "tool_call", ...toolCall });
  ask("session/request_permission", { sessionId: session, toolCall, options: EXECUTE_OPTIONS }, (response) => next(response.result.outcome));
}
const picked = (outcome) => outcome.outcome === "selected" ? outcome.optionId : "cancelled";
function prompt(id, text) {
  promptId = id;
  const store = load();
  store[session].push(text);
  save(store);
  const command = text.split("\\n").at(-1);
  if (command === "state") {
    const env = Object.fromEntries(["TERM", "BROWSER", "ACCESS_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"].map((key) => [key, key in process.env]));
    say(JSON.stringify({ session, mode, calls, prompts: store[session], env }));
    return end();
  }
  if (command === "tool") {
    say("Let me run it.");
    execute("t-1", process.cwd(), (outcome) => {
      if (outcome.outcome === "cancelled") { say("partial"); return end("cancelled"); }
      update({ sessionUpdate: "tool_call_update", toolCallId: "t-1", status: "completed" });
      say("done:" + picked(outcome));
      end();
    });
    return;
  }
  if (command === "retry") {
    // The first time the working directory is wrong and execution fails; the model retries and the same command needs approval again.
    execute("t-1", "/nonexistent/skills", (first) => {
      update({ sessionUpdate: "tool_call_update", toolCallId: "t-1", status: "failed" });
      execute("t-2", process.cwd(), (second) => {
        say("done:" + picked(first) + "," + picked(second));
        end();
      });
    });
    return;
  }
  if (command === "edit") {
    const toolCall = { toolCallId: "e-1", title: "Run create_file?", kind: "edit", status: "pending", locations: [{ path: "/w/edit.txt" }], rawInput: { CodeContent: "world", TargetFile: "/w/edit.txt", Overwrite: true } };
    update({ sessionUpdate: "tool_call", ...toolCall });
    ask("session/request_permission", { sessionId: session, toolCall, options: EDIT_OPTIONS }, (response) => {
      say("edit:" + picked(response.result.outcome));
      end();
    });
    return;
  }
  if (command === "login") { ignoreEof = true; setInterval(() => {}, 1000); say("thinking"); return loginPrompt(); }
  if (command === "stubborn") { ignoreEof = true; setInterval(() => {}, 1000); say("working"); return; }
  if (command === "refuse") { say("half"); return end("refusal"); }
  if (command === "error") { promptId = null; return fail(id, -32603, "Upstream refused"); }
  if (command === "unauthorized") { promptId = null; return fail(id, -32000, "Authentication required"); }
  if (command === "crash") { say("before crash"); process.exit(3); }
  say("echo:" + text);
  end();
}
`;

type Approval = { ask: ApprovalAsk; signal: AbortSignal | undefined; resolve: (answer: ApprovalAnswer) => void };

async function setup(t: test.TestContext): Promise<{ adapter: AntigravityAdapter; cwd: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "lanting-antigravity-adapter-"));
  const executable = path.join(cwd, "fake-antigravity.mjs");
  await writeFile(executable, FAKE_SERVER, "utf8");
  await chmod(executable, 0o700);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { adapter: new AntigravityAdapter({ executable }), cwd };
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
  const adapter = new AntigravityAdapter({ executable: "/unused" });
  assert.equal(adapter.kind, "antigravity");
  assert.equal(adapter.closeAfterTurn, true);
  assert.deepEqual(Object.keys(adapter.features), ["permissions"]);
  assert.deepEqual(await adapter.features.permissions!("/tmp"), [...ANTIGRAVITY_PERMISSIONS]);
  assert.equal(ANTIGRAVITY_PERMISSIONS.find((option) => option.id === "always-approve")?.danger, true);
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
  assert.equal(state.mode, "default");
  assert.deepEqual(state.calls, ["initialize", "session/new", "session/set_mode", "session/prompt", "session/prompt"]);
  await session.close();
  assert.equal(session.alive, false);

  const resumed = await adapter.resumeSession(nativeId, sessionOptions(cwd));
  t.after(() => resumed.close());
  assert.equal(resumed.nativeId, nativeId);
  const events = await drain(resumed, "state");
  assert.equal(events.length, 2);
  const after = JSON.parse(endOf(events).text) as Record<string, unknown>;
  assert.equal(after.session, nativeId);
  assert.equal(after.mode, "default");
  assert.deepEqual(after.calls, ["initialize", "session/resume", "session/set_mode", "session/prompt"]);
  const prompts = after.prompts as string[];
  assert.equal(prompts.filter((prompt) => prompt.includes("GROUP RULES")).length, 1);
  assert.equal(prompts.at(-1), "state");
  await resumed.close();
});

test("keeps tokens, TERM and BROWSER out of the server environment", async (t) => {
  const { adapter, cwd } = await setup(t);
  const saved = { TERM: process.env.TERM, BROWSER: process.env.BROWSER, ACCESS_TOKEN: process.env.ACCESS_TOKEN };
  Object.assign(process.env, { TERM: "xterm", BROWSER: "firefox", ACCESS_TOKEN: "secret" });
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const session = await adapter.startSession(sessionOptions(cwd));
  t.after(() => session.close());
  const state = JSON.parse(endOf(await drain(session, "state")).text) as { env: Record<string, boolean> };
  assert.deepEqual(state.env, { TERM: false, BROWSER: false, ACCESS_TOKEN: false, CLAUDE_CODE_OAUTH_TOKEN: false });
  await session.close();
});

test("fails to resume a session the server does not know", async (t) => {
  const { adapter, cwd } = await setup(t);
  await assert.rejects(adapter.resumeSession("missing", sessionOptions(cwd)), /Antigravity session\/resume failed: Session not found/);
});

test("asks the host and picks one-time options for commands", async (t) => {
  const { adapter, cwd } = await setup(t);
  const approvals: Approval[] = [];
  const session = await adapter.startSession(sessionOptions(cwd, "ask", approvals));
  t.after(() => session.close());
  await drain(session, "warm up");

  for (const [decision, expected] of [["allow", "done:allow"], ["deny", "done:deny"]] as const) {
    const events = await drain(session, "tool", (event) => {
      if (event.type === "activity" && event.activity.kind === "tool") {
        void waitFor(() => approvals.length > 0).then(() => approvals.shift()!.resolve({ decision, message: "" }));
      }
    });
    assert.deepEqual(endOf(events), { type: "end", outcome: "completed", text: expected });
    assert.deepEqual(events.filter((event) => event.type === "activity").map((event) => event.activity), [
      { kind: "note", text: "Let me run it." },
      { kind: "tool", toolName: "bash", detail: "touch x.txt" },
    ]);
  }
  await session.close();
});

test("shows the command and its working directory on the approval card", async (t) => {
  const { adapter, cwd } = await setup(t);
  const approvals: Approval[] = [];
  const session = await adapter.startSession(sessionOptions(cwd, "ask", approvals));
  t.after(() => session.close());
  const turn = drain(session, "tool");
  await waitFor(() => approvals.length > 0);
  assert.deepEqual(approvals[0]!.ask, { toolName: "bash", detail: `touch x.txt\nWorking directory: ${cwd}` });
  approvals[0]!.resolve({ decision: "allow", message: "" });
  await turn;
  await session.close();
});

test("handles edit approvals with only two options", async (t) => {
  const { adapter, cwd } = await setup(t);
  const approvals: Approval[] = [];
  const session = await adapter.startSession(sessionOptions(cwd, "ask", approvals));
  t.after(() => session.close());
  for (const [decision, expected] of [["allow", "edit:allow"], ["deny", "edit:deny"]] as const) {
    const turn = drain(session, "edit");
    await waitFor(() => approvals.length > 0);
    assert.deepEqual(approvals[0]!.ask, { toolName: "Run create_file?", detail: "/w/edit.txt" });
    approvals.shift()!.resolve({ decision, message: "" });
    assert.equal(endOf(await turn).text, expected);
  }
  await session.close();
});

test("handles two approvals for the same command in one turn", async (t) => {
  const { adapter, cwd } = await setup(t);
  const approvals: Approval[] = [];
  const session = await adapter.startSession(sessionOptions(cwd, "ask", approvals));
  t.after(() => session.close());
  const turn = drain(session, "retry");
  await waitFor(() => approvals.length > 0);
  assert.equal(approvals[0]!.ask.detail, "touch x.txt\nWorking directory: /nonexistent/skills");
  approvals.shift()!.resolve({ decision: "allow", message: "" });
  await waitFor(() => approvals.length > 0);
  assert.equal(approvals[0]!.ask.detail, `touch x.txt\nWorking directory: ${cwd}`);
  approvals.shift()!.resolve({ decision: "allow", message: "" });
  assert.equal(endOf(await turn).text, "done:allow,allow");
  await session.close();
});

test("always-approve picks allow_once every time without asking", async (t) => {
  const { adapter, cwd } = await setup(t);
  const approvals: Approval[] = [];
  const session = await adapter.startSession(sessionOptions(cwd, "always-approve", approvals));
  t.after(() => session.close());
  assert.equal(endOf(await drain(session, "tool")).text, "done:allow");
  assert.equal(endOf(await drain(session, "retry")).text, "done:allow,allow");
  assert.equal(endOf(await drain(session, "edit")).text, "edit:allow");
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

test("does not report the SIGTERM stderr as the failure reason", async (t) => {
  const { adapter, cwd } = await setup(t);
  const session = await adapter.startSession(sessionOptions(cwd));
  t.after(() => session.close());
  let started = false;
  const turn = drain(session, "stubborn", (event) => {
    if (event.type === "text") started = true;
  });
  await waitFor(() => started);
  // The fake Server ignores stdin EOF and only exits on SIGTERM, printing a Fatal Python error on stderr first.
  await session.close();
  const end = endOf(await turn);
  assert.equal(end.outcome, "failed");
  assert.doesNotMatch(end.error ?? "", /Fatal Python error/);
  assert.equal(session.alive, false);
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
    error: "Antigravity ended the round early (refusal).",
  });
  const error = endOf(await drain(session, "error"));
  assert.equal(error.outcome, "failed");
  assert.match(error.error ?? "", /Upstream refused/);
  const crash = endOf(await drain(session, "crash"));
  assert.deepEqual(crash, { type: "end", outcome: "failed", text: "before crash", error: "The Antigravity process exited." });
  assert.equal(session.alive, false);
  await session.close();
});

test("rewrites auth_required into the login hint", async (t) => {
  const { adapter, cwd } = await setup(t);
  const session = await adapter.startSession(sessionOptions(cwd));
  t.after(() => session.close());
  assert.deepEqual(endOf(await drain(session, "unauthorized")), {
    type: "end",
    outcome: "failed",
    text: "",
    error: LOGIN_REQUIRED_MESSAGE,
  });
  await session.close();
  await writeFile(path.join(cwd, "auth-required"), "");
  await assert.rejects(adapter.startSession(sessionOptions(cwd)), { message: LOGIN_REQUIRED_MESSAGE });
});

test("ends the turn at once when the server starts a browser login", async (t) => {
  const { adapter, cwd } = await setup(t);
  const session = await adapter.startSession(sessionOptions(cwd));
  t.after(() => session.close());
  const end = endOf(await drain(session, "login"));
  assert.deepEqual(end, { type: "end", outcome: "failed", text: "thinking", error: LOGIN_REQUIRED_MESSAGE });
  await waitFor(() => !session.alive);
  await session.close();
});

test("fails to open a session when the server starts a browser login", async (t) => {
  const { adapter, cwd } = await setup(t);
  await writeFile(path.join(cwd, "login-on-new"), "");
  await assert.rejects(adapter.startSession(sessionOptions(cwd)), { message: LOGIN_REQUIRED_MESSAGE });
});

test("reports a missing executable when opening a session", async () => {
  const adapter = new AntigravityAdapter({ executable: "/nonexistent/agy_acp_server.par" });
  await assert.rejects(adapter.startSession(sessionOptions(tmpdir())), /Cannot start Antigravity/);
});

test("toolActivity labels commands as bash and shows the command or the file path", () => {
  assert.deepEqual(toolActivity({ title: "ls -la", kind: "execute", rawInput: { CommandLine: "ls -la", Cwd: "/w" } }), {
    kind: "tool",
    toolName: "bash",
    detail: "ls -la",
  });
  assert.deepEqual(toolActivity({ title: "Running view_file", kind: "read", rawInput: { absolute_path: "/w/a.md" } }), {
    kind: "tool",
    toolName: "Running view_file",
    detail: "/w/a.md",
  });
  assert.deepEqual(toolActivity({ title: "Running edit_file", kind: "edit", locations: [{ path: "/w/b.txt" }] }), {
    kind: "tool",
    toolName: "Running edit_file",
    detail: "/w/b.txt",
  });
  assert.deepEqual(toolActivity({}), { kind: "tool", toolName: "Tool", toolKey: "tool.generic", detail: "" });
});
