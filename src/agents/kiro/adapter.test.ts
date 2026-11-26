import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { englishText, localText } from "../../i18n/text.ts";
import type { AgentEvent, AgentSession, ApprovalAnswer, ApprovalAsk, SessionOptions } from "../types.ts";
import {
  firstMessage,
  KIRO_PERMISSIONS,
  KiroAdapter,
  LOGIN_REQUIRED,
  modelOptions,
  toolActivity,
} from "./adapter.ts";

const FAKE_KIRO = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
if (process.argv.slice(2).join(" ") !== "acp --agent-engine v3") process.exit(2);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const storePath = process.cwd() + "/sessions.json";
const load = () => { try { return JSON.parse(readFileSync(storePath, "utf8")); } catch { return {}; } };
const save = (store) => writeFileSync(storePath, JSON.stringify(store));
const out = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const reply = (id, result) => out({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => out({ jsonrpc: "2.0", id, error: { code, message } });
const options = () => [
  { type: "select", id: "model", currentValue: "auto", options: [
    { value: "auto", name: "Auto" },
    { value: "test-model", name: "Test Model", description: "Test model", _meta: { kiro: { hasEffort: true, effortLevels: ["low", "high", "max"], defaultEffortLevel: "high" } } },
  ] },
  { type: "select", id: "effortLevel", currentValue: "max", options: [
    { value: "low", name: "Thinking Low" }, { value: "high", name: "Thinking High" }, { value: "max", name: "Thinking Max" },
  ] },
  { type: "select", id: "mode", currentValue: "vibe", options: [{ value: "vibe", name: "Default" }] },
];
let session = null;
let promptId = null;
let settings = {};
let modelReady = false;
let waiting = new Map();
let nextServerId = 100;
let buffer = "";
const update = (update) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: session, update } });
const openingReply = (id, result, percent) => {
  const response = { jsonrpc: "2.0", id, result };
  if (process.env.FAKE_OPENING_USAGE !== "1") return out(response);
  const usage = (sessionId, usagePercentage) => ({ jsonrpc: "2.0", method: "session/update", params: {
    sessionId, update: { sessionUpdate: "session_info_update", _meta: { kiro: { contextUsage: { usagePercentage } } } },
  } });
  process.stdout.write([usage(session, percent / 2), response, usage(session, percent), usage("unrelated-session", 99)]
    .map(message => JSON.stringify(message) + "\\n").join(""));
};
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
    case "initialize": {
      appendFileSync(path.join(scriptDir, "starts"), "start\\n");
      if (existsSync(path.join(scriptDir, "spawn-child"))) {
        const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        writeFileSync(path.join(scriptDir, "server.pid"), String(process.pid));
        writeFileSync(path.join(scriptDir, "child.pid"), String(helper.pid));
      }
      if (existsSync(path.join(scriptDir, "init-hang"))) {
        rmSync(path.join(scriptDir, "init-hang"));
        process.stdin.removeAllListeners("end");
        process.on("SIGTERM", () => {});
        return;
      }
      return reply(id, { protocolVersion: 1 });
    }
    case "_kiro/account/getUsage": {
      if (process.env.FAKE_ACCOUNT_USAGE === "hang" || existsSync(path.join(scriptDir, "usage-hang"))) {
        writeFileSync(path.join(scriptDir, "usage-reads"), "h", { flag: "a" });
        // Ignore stdin closing and SIGTERM so only the process-group kill ends this read.
        process.stdin.removeAllListeners("end");
        process.on("SIGTERM", () => {});
        return;
      }
      if (existsSync(path.join(scriptDir, "crash-on-usage"))) {
        rmSync(path.join(scriptDir, "crash-on-usage"));
        process.exit(3);
      }
      if (existsSync(path.join(scriptDir, "usage-auth-error"))) {
        return fail(id, -32000, "Authentication required");
      }
      if (process.env.FAKE_ACCOUNT_USAGE !== "1") return fail(id, -32601, "Method not found");
      writeFileSync(path.join(scriptDir, "usage-reads"), "x", { flag: "a" });
      appendFileSync(path.join(scriptDir, "usage-proxy"), (process.env.HTTPS_PROXY ?? "direct") + "\\n");
      return setTimeout(() => reply(id, { success: true, data: {
        planName: "KIRO PRO+", billingCycleReset: "2026-12-01",
        usageBreakdowns: [
          { resourceType: "CREDIT", displayName: "Credits", used: 82.5, limit: 1100, hasLimit: true },
          { resourceType: "OTHER", displayName: "Unlimited", used: 3, limit: 0, hasLimit: false },
        ],
        bonusCredits: [
          { name: "Trial credits", used: 0, total: 500, daysUntilExpiry: 364 },
          { name: "Spent bonus", used: 50, total: 50, daysUntilExpiry: 3 },
        ],
        addOnCredits: [{ name: "Add-on pack", used: 12.255, total: 100 }],
      } }), 100);
    }
    case "session/new": {
      if (process.env.FAKE_AUTH === "1") return fail(id, -32000, "Authentication required");
      session = "s-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      const store = load(); store[session] = []; save(store);
      const config = options();
      openingReply(id, { sessionId: session, configOptions: config.filter(option => option.id !== "model"), modes: { currentModeId: "vibe" } }, 0.9);
      setTimeout(() => { modelReady = true; update({ sessionUpdate: "config_option_update", configOptions: config }); }, 20);
      return;
    }
    case "session/load": {
      const store = load(); if (!store[params.sessionId]) return fail(id, -32002, "Session not found");
      if (params.noReplay !== true) process.exit(4);
      session = params.sessionId;
      modelReady = true;
      say("old reply replay");
      return openingReply(id, { configOptions: options(), modes: { currentModeId: "vibe" } }, 1.4);
    }
    case "session/set_config_option":
      if ((params.configId === "model" || params.configId === "effortLevel") && !modelReady) return fail(id, -32602, "Model catalog not ready");
      settings[params.configId] = params.value;
      return reply(id, { configOptions: options() });
    case "session/delete": {
      const store = load();
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
  update({ sessionUpdate: "session_info_update", _meta: { kiro: { turn_end: true } } });
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
      update({ sessionUpdate: "session_info_update", _meta: { kiro: { contextUsage: { usagePercentage: 0.9 } } } });
      end();
    });
    return;
  }
  if (command === "subagent") {
    const parent = { kind: "agent-subtask", agentSubtaskId: "sub-1" };
    const inside = { agentSubtaskId: "sub-1" };
    say("Delegating");
    update({ sessionUpdate: "tool_call", toolCallId: "sa-1", title: "Sub-agent: introspect", kind: "other", status: "pending", rawInput: { name: "introspect", prompt: "look it up" }, _meta: { kiro: parent } });
    update({ sessionUpdate: "session_info_update", _meta: { kiro: { ...inside, contextUsage: { usagePercentage: 42 } } } });
    update({ sessionUpdate: "tool_call", toolCallId: "in-1", title: "Bash", kind: "execute", status: "pending", rawInput: { command: "curl example.com" }, _meta: { kiro: inside } });
    ask({ sessionId: session, toolCall: { toolCallId: "in-1", title: "Bash" }, options: permissionOptions }, () => {
      update({ sessionUpdate: "tool_call_update", toolCallId: "in-1", status: "completed", _meta: { kiro: inside } });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Sub-agent report" }, _meta: { kiro: inside } });
      update({ sessionUpdate: "tool_call_update", toolCallId: "sa-1", status: "completed", rawOutput: "Sub-agent report", _meta: { kiro: parent } });
      update({ sessionUpdate: "session_info_update", _meta: { kiro: { contextUsage: { usagePercentage: 3 } } } });
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
  if (command === "other-error") { promptId = null; return fail(id, -32000, "Something else failed"); }
  if (command === "environment") { say(JSON.stringify({ accessToken: !!process.env.ACCESS_TOKEN, oauthToken: !!process.env.CLAUDE_CODE_OAUTH_TOKEN })); return end(); }
  if (command === "unauthorized") { promptId = null; return fail(id, -32000, "Authentication required"); }
  if (command === "refuse") { say("half"); return end("refusal"); }
  if (command === "crash") { say("before crash"); return process.exit(3); }
  say("echo:" + text); end();
}
`;

type Approval = { ask: ApprovalAsk; signal: AbortSignal | undefined; resolve: (answer: ApprovalAnswer) => void };

async function setup(
  t: test.TestContext,
  env: Record<string, string> = {},
  adapterOptions: { usageTimeoutMs?: number; startupTimeoutMs?: number } = {},
): Promise<{ adapter: KiroAdapter; cwd: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "lanting-kiro-adapter-"));
  const executable = path.join(cwd, "fake-kiro.mjs");
  await writeFile(executable, FAKE_KIRO, "utf8");
  await chmod(executable, 0o700);
  const previousDirectory = process.cwd();
  process.chdir(cwd);
  const saved = new Map<string, string | undefined>();
  const environment = { HTTP_PROXY: undefined, HTTPS_PROXY: undefined, ALL_PROXY: undefined, http_proxy: undefined, https_proxy: undefined, all_proxy: undefined, ...env };
  for (const [key, value] of Object.entries(environment)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const adapter = new KiroAdapter({ executable, ...adapterOptions });
  t.after(async () => {
    await adapter.close();
    process.chdir(previousDirectory);
    for (const [key, value] of saved) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(cwd, { recursive: true, force: true });
  });
  return { adapter, cwd };
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

/** Whether any fake Kiro started from this test directory is still running. */
function fakeKiroRunning(cwd: string): boolean {
  const result = spawnSync("pgrep", ["-f", path.join(cwd, "fake-kiro.mjs")], { encoding: "utf8" });
  return result.stdout.trim() !== "";
}

test("catalog maps Kiro models and thinking levels without leaving its probe session", async (t) => {
  const { adapter, cwd } = await setup(t);
  assert.equal(adapter.kind, "kiro");
  assert.equal(adapter.closeAfterTurn, true);
  assert.deepEqual(Object.keys(adapter.features), ["models", "permissions", "usage", "deleteSession"]);
  assert.deepEqual(await adapter.features.models!(cwd), [
    { id: "auto", label: "Auto", description: "", efforts: [] },
    { id: "test-model", label: "Test Model", description: "Test model", efforts: ["low", "high", "max"], defaultEffort: "high" },
  ]);
  assert.deepEqual(await adapter.features.permissions!(cwd), [...KIRO_PERMISSIONS]);
  assert.deepEqual(JSON.parse(await readFile(path.join(cwd, "sessions.json"), "utf8")), {});
});

test("without a proxy, Kiro shares catalog caches across proxy choices while retaining working-directory boundaries", async (t) => {
  const { adapter, cwd } = await setup(t);
  const [models, proxied, direct, permissions] = await Promise.all([
    adapter.features.models!(cwd),
    adapter.features.models!(cwd, true),
    adapter.features.models!(cwd, false),
    adapter.features.permissions!(cwd, false),
  ]);
  assert.equal(models.length, 2);
  assert.deepEqual(models, proxied);
  assert.deepEqual(models, direct);
  assert.deepEqual(permissions, [...KIRO_PERMISSIONS]);
  assert.equal(await countLines(path.join(cwd, "starts")), 1);
  assert.deepEqual(await adapter.features.models!(cwd, false), models);
  assert.equal(await countLines(path.join(cwd, "starts")), 1);

  const otherDirectory = path.join(cwd, "other");
  await mkdir(otherDirectory);
  assert.deepEqual(await adapter.features.models!(otherDirectory, false), models);
  assert.equal(await countLines(path.join(cwd, "starts")), 2);
});

test("with a proxy, Kiro keeps default and direct catalog caches separate", async (t) => {
  const { adapter, cwd } = await setup(t, { HTTPS_PROXY: "http://proxy.invalid:8080" });
  const models = await adapter.features.models!(cwd);
  assert.deepEqual(await adapter.features.models!(cwd, true), models);
  assert.equal(await countLines(path.join(cwd, "starts")), 1);
  assert.deepEqual(await adapter.features.models!(cwd, false), models);
  assert.equal(await countLines(path.join(cwd, "starts")), 2);
  assert.deepEqual(await adapter.features.permissions!(cwd, false), [...KIRO_PERMISSIONS]);
  assert.equal(await countLines(path.join(cwd, "starts")), 2);
});

test("new and resumed sessions apply settings and send group rules only once", async (t) => {
  const { adapter, cwd } = await setup(t);
  const settings = { model: "test-model", effort: "high", permission: "ask" };
  const session = await adapter.startSession(options(cwd, settings));
  t.after(() => session.close());
  const id = session.nativeId!;
  const first = endOf(await drain(session, "hello"));
  assert.equal(first.text, `echo:${firstMessage("GROUP RULES", "hello")}`);
  const state = JSON.parse(endOf(await drain(session, "state")).text);
  assert.deepEqual(state.settings, { mode: "vibe", autopilot: "off", contentCollection: "disabled", model: "test-model", effortLevel: "high" });
  assert.equal(state.prompts.filter((prompt: string) => prompt.includes("GROUP RULES")).length, 1);
  await session.close();

  const resumed = await adapter.resumeSession(id, options(cwd, settings));
  t.after(() => resumed.close());
  const after = JSON.parse(endOf(await drain(resumed, "state")).text);
  assert.equal(after.session, id);
  assert.deepEqual(after.settings, state.settings);
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
    { kind: "context", percent: 0.9 },
    { kind: "unavailable" },
  ]);
});

test("shows only the sub-agent call, keeps its approvals, and keeps its report out of the reply", async (t) => {
  const { adapter, cwd } = await setup(t);
  const approvals: Approval[] = [];
  const session = await adapter.startSession(options(cwd, { model: null, effort: null, permission: "ask" }, approvals));
  t.after(() => session.close());
  const turn = drain(session, "subagent");
  await waitFor(() => approvals.length === 1);
  assert.deepEqual(approvals[0]!.ask, { toolName: "bash", detail: "curl example.com" });
  approvals[0]!.resolve({ decision: "allow", message: "" });
  const events = await turn;
  assert.deepEqual(events.filter((event) => event.type === "activity").map((event) => event.activity), [
    { kind: "note", text: "Delegating" },
    { ...toolActivity({ title: "Sub-agent: introspect", kind: "other" }), toolCallId: "sa-1" },
  ]);
  assert.deepEqual(events.filter((event) => event.type === "activity.update"), []);
  assert.deepEqual(events.filter((event) => event.type === "text").map((event) => event.delta), ["Delegating"]);
  assert.equal(endOf(events).text, "");
  assert.deepEqual(await adapter.features.usage!({ nativeId: session.nativeId!, cwd, reason: "turn", session: async () => null }), [
    { kind: "context", percent: 3 },
    { kind: "unavailable" },
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
  const other = endOf(await drain(session, "other-error"));
  assert.match(other.error!, /Something else failed/u);
  assert.equal(other.errorText, undefined);
  assert.equal(unauthorized.error, englishText(LOGIN_REQUIRED));
  assert.deepEqual(unauthorized.errorText, LOGIN_REQUIRED);
  assert.equal(endOf(await drain(session, "refuse")).outcome, "failed");
  assert.equal(endOf(await drain(session, "crash")).error, "The Kiro process exited.");
});

test("deletes native sessions and rewrites login failure while opening", async (t) => {
  const { adapter, cwd } = await setup(t);
  const session = await adapter.startSession(options(cwd, { model: null, effort: null, permission: "always-approve" }));
  const id = session.nativeId!;
  await drain(session, "tool");
  await session.close();
  await adapter.features.deleteSession!(id, cwd);
  assert.deepEqual(await adapter.features.usage!({ nativeId: id, cwd, reason: "turn", session: async () => null }), [
    { kind: "context", percent: null },
    { kind: "unavailable" },
  ]);
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


test("interrupt withdraws a pending approval", async (t) => {
  const { adapter, cwd } = await setup(t);
  const approvals: Approval[] = [];
  const session = await adapter.startSession(options(cwd, { model: null, effort: null, permission: "ask" }, approvals));
  t.after(() => session.close());
  const turn = drain(session, "tool");
  await waitFor(() => approvals.length === 1);
  await session.interrupt();
  assert.equal(approvals[0]!.signal!.aborted, true);
  assert.equal(endOf(await turn).outcome, "interrupted");
});


test("strips host credentials and keeps the default model when none is selected", async (t) => {
  const { adapter, cwd } = await setup(t, { ACCESS_TOKEN: "fake-host-secret", CLAUDE_CODE_OAUTH_TOKEN: "fake-oauth-secret" });
  const session = await adapter.startSession(options(cwd));
  t.after(() => session.close());
  assert.deepEqual(JSON.parse(endOf(await drain(session, "environment")).text), { accessToken: false, oauthToken: false });
  const state = JSON.parse(endOf(await drain(session, "state")).text);
  assert.deepEqual(state.settings, { mode: "vibe", autopilot: "off", contentCollection: "disabled" });
});


test("retains opening usage batched with new and loaded session responses", async (t) => {
  const { adapter, cwd } = await setup(t, { FAKE_OPENING_USAGE: "1" });
  const session = await adapter.startSession(options(cwd));
  t.after(() => session.close());
  const id = session.nativeId!;
  const usage = () => adapter.features.usage!({ nativeId: id, cwd, reason: "turn", session: async () => null });
  assert.deepEqual(await usage(), [{ kind: "context", percent: 0.9 }, { kind: "unavailable" }]);
  await session.close();
  const resumed = await adapter.resumeSession(id, options(cwd));
  t.after(() => resumed.close());
  assert.deepEqual(await usage(), [{ kind: "context", percent: 1.4 }, { kind: "unavailable" }]);
});

async function countLines(file: string): Promise<number> {
  try {
    return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const EXPECTED_CREDITS = [
  { kind: "credits", name: "Credits", left: 1017.5, total: 1100, resetsOn: "2026-12-01" },
  { kind: "credits", name: "Trial credits", left: 500, total: 500, expiresInDays: 364 },
  { kind: "credits", name: "Add-on pack", left: 87.745, total: 100 },
];

test("reads account usage once for concurrent calls and reuses one resident process warmed by start()", async (t) => {
  const { adapter, cwd } = await setup(t, { FAKE_ACCOUNT_USAGE: "1" });
  adapter.start();
  const usage = () => adapter.features.usage!({ nativeId: "s-unknown", cwd, reason: "view", session: async () => null });
  const [first, second] = await Promise.all([usage(), usage()]);
  const expected = [{ kind: "context", percent: null }, ...EXPECTED_CREDITS];
  assert.deepEqual(first, expected);
  assert.deepEqual(second, expected);
  assert.equal(await readFile(path.join(cwd, "usage-reads"), "utf8"), "x");
  assert.deepEqual(await usage(), expected);
  assert.equal(await readFile(path.join(cwd, "usage-reads"), "utf8"), "xx");
  assert.equal(await countLines(path.join(cwd, "starts")), 1);
});

test("without a proxy, all Kiro proxy choices reuse the warmed resident and coalesce account usage reads", async (t) => {
  const { adapter, cwd } = await setup(t, { FAKE_ACCOUNT_USAGE: "1", NO_PROXY: "localhost", HTTPS_PROXY: " " });
  adapter.start();
  const request = { nativeId: "s-unknown", cwd, reason: "view" as const, session: async () => null };
  const results = await Promise.all([
    adapter.features.usage!(request),
    adapter.features.usage!({ ...request, useProxy: true }),
    adapter.features.usage!({ ...request, nativeId: "s-other", useProxy: false }),
  ]);
  for (const parts of results) assert.deepEqual(parts, [{ kind: "context", percent: null }, ...EXPECTED_CREDITS]);
  assert.equal(await readFile(path.join(cwd, "usage-reads"), "utf8"), "x");
  await adapter.features.usage!({ ...request, useProxy: false });
  assert.equal(await readFile(path.join(cwd, "usage-reads"), "utf8"), "xx");
  await adapter.close();
  assert.deepEqual(await adapter.features.usage!({ ...request, useProxy: false }), [{ kind: "context", percent: null }, { kind: "unavailable" }]);
  assert.equal(await countLines(path.join(cwd, "starts")), 1);
  assert.equal(fakeKiroRunning(cwd), false);
});

test("a stuck account usage read times out, shows unavailable, closes its process, and the next read starts fresh", async (t) => {
  const { adapter, cwd } = await setup(t, { FAKE_ACCOUNT_USAGE: "hang" }, { usageTimeoutMs: 300 });
  const usage = () => adapter.features.usage!({ nativeId: "s-unknown", cwd, reason: "view", session: async () => null });
  const started = Date.now();
  assert.deepEqual(await usage(), [{ kind: "context", percent: null }, { kind: "unavailable" }]);
  assert.ok(Date.now() - started < 2_000);
  assert.deepEqual(await usage(), [{ kind: "context", percent: null }, { kind: "unavailable" }]);
  assert.equal(await readFile(path.join(cwd, "usage-reads"), "utf8"), "hh");
  assert.equal(await countLines(path.join(cwd, "starts")), 2);
  // Both stuck processes are killed by their own closing, which ignores SIGTERM and stdin closing here.
  await waitFor(() => !fakeKiroRunning(cwd));
});

test("a hung resident initialization times out promptly and the next account usage read recovers", async (t) => {
  const { adapter, cwd } = await setup(t, { FAKE_ACCOUNT_USAGE: "1" }, { usageTimeoutMs: 250 });
  await writeFile(path.join(cwd, "init-hang"), "");
  const usage = () => adapter.features.usage!({ nativeId: "s-unknown", cwd, reason: "view", session: async () => null });
  const started = Date.now();
  assert.deepEqual(await usage(), [{ kind: "context", percent: null }, { kind: "unavailable" }]);
  assert.ok(Date.now() - started < 2_000);
  assert.deepEqual(await usage(), [{ kind: "context", percent: null }, ...EXPECTED_CREDITS]);
  assert.equal(await countLines(path.join(cwd, "starts")), 2);
});

test("resets the resident server after an auth error and restarts cleanly on the next read", async (t) => {
  const { adapter, cwd } = await setup(t, { FAKE_ACCOUNT_USAGE: "1" });
  const usage = () => adapter.features.usage!({ nativeId: "s-unknown", cwd, reason: "view", session: async () => null });
  assert.deepEqual(await usage(), [{ kind: "context", percent: null }, ...EXPECTED_CREDITS]);
  assert.equal(await countLines(path.join(cwd, "starts")), 1);

  const authError = path.join(cwd, "usage-auth-error");
  await writeFile(authError, "");
  assert.deepEqual(await usage(), [{ kind: "context", percent: null }, { kind: "unavailable" }]);
  await rm(authError);

  assert.deepEqual(await usage(), [{ kind: "context", percent: null }, ...EXPECTED_CREDITS]);
  assert.equal(await countLines(path.join(cwd, "starts")), 2);
});

test("does not restart the resident server after close", async (t) => {
  const { adapter, cwd } = await setup(t, { FAKE_ACCOUNT_USAGE: "1" });
  const usage = () => adapter.features.usage!({ nativeId: "s-unknown", cwd, reason: "view", session: async () => null });
  assert.deepEqual(await usage(), [{ kind: "context", percent: null }, ...EXPECTED_CREDITS]);
  assert.equal(await countLines(path.join(cwd, "starts")), 1);

  await adapter.close();
  assert.deepEqual(await usage(), [{ kind: "context", percent: null }, { kind: "unavailable" }]);
  assert.equal(await countLines(path.join(cwd, "starts")), 1);
  assert.equal(fakeKiroRunning(cwd), false);
});

test("with a proxy, Kiro starts a separate direct resident on demand and coalesces reads per resident", async (t) => {
  const { adapter, cwd } = await setup(t, { FAKE_ACCOUNT_USAGE: "1", HTTPS_PROXY: "http://proxy.invalid:8080" });
  adapter.start();
  const request = (useProxy?: boolean) => ({
    nativeId: "s-unknown",
    cwd,
    ...(useProxy === undefined ? {} : { useProxy }),
    reason: "view" as const,
    session: async () => null,
  });
  assert.deepEqual(await adapter.features.usage!(request(undefined)), [{ kind: "context", percent: null }, ...EXPECTED_CREDITS]);
  assert.equal(await countLines(path.join(cwd, "starts")), 1);
  const results = await Promise.all([
    adapter.features.usage!(request(undefined)),
    adapter.features.usage!(request(true)),
    adapter.features.usage!(request(false)),
    adapter.features.usage!(request(false)),
  ]);
  for (const parts of results) assert.deepEqual(parts, [{ kind: "context", percent: null }, ...EXPECTED_CREDITS]);
  assert.equal(await countLines(path.join(cwd, "starts")), 2);
  assert.deepEqual((await readFile(path.join(cwd, "usage-proxy"), "utf8")).trim().split("\n"), [
    "http://proxy.invalid:8080",
    "http://proxy.invalid:8080",
    "direct",
  ]);
});

test("cleans up child processes in the resident process group after an unexpected exit", async (t) => {
  const { adapter, cwd } = await setup(t, { FAKE_ACCOUNT_USAGE: "1" });
  await writeFile(path.join(cwd, "spawn-child"), "");
  const usage = () => adapter.features.usage!({ nativeId: "s-unknown", cwd, reason: "view", session: async () => null });
  const readPid = async (name: string) => Number((await readFile(path.join(cwd, name), "utf8")).trim());
  const cleanupPid = (pid: number) => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already exited.
    }
  };

  // Case 1: unexpected exit during a request cleans up its child process and restarts on the next read.
  assert.deepEqual(await usage(), [{ kind: "context", percent: null }, ...EXPECTED_CREDITS]);
  const firstChild = await readPid("child.pid");
  t.after(() => cleanupPid(firstChild));
  assert.equal(processExists(firstChild), true);

  await writeFile(path.join(cwd, "crash-on-usage"), "");
  assert.deepEqual(await usage(), [{ kind: "context", percent: null }, { kind: "unavailable" }]);
  assert.equal(processExists(firstChild), false);

  // Case 2: unexpected exit while idle still tears down the whole process group and close() waits for it.
  assert.deepEqual(await usage(), [{ kind: "context", percent: null }, ...EXPECTED_CREDITS]);
  assert.equal(await countLines(path.join(cwd, "starts")), 2);
  const secondServer = await readPid("server.pid");
  const secondChild = await readPid("child.pid");
  t.after(() => cleanupPid(secondChild));
  assert.equal(processExists(secondChild), true);

  process.kill(secondServer, "SIGKILL");
  await waitFor(() => !processExists(secondServer));
  await adapter.close();
  assert.equal(processExists(secondChild), false);
});
