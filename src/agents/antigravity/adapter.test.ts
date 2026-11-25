import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { englishText } from "../../i18n/text.ts";
import type { AgentEvent, AgentSession, AgentSettings, ApprovalAnswer, ApprovalAsk, SessionOptions } from "../types.ts";
import {
  ANTIGRAVITY_PERMISSIONS,
  AntigravityAdapter,
  firstMessage,
  LOGIN_REQUIRED,
  parseAntigravityQuota,
  toolActivity,
} from "./adapter.ts";

/** Models as ACP Server 1.5.2 exposes them: families with separate thinking_level options plus a single-variant model. */
const MODELS = [
  { value: "gemini-4-neon", name: "Gemini 4 Neon", efforts: ["low", "medium", "high", "xhigh"], firstEffort: "high" },
  { value: "solo-preview", name: "Solo Preview (Experimental)", description: "solo-preview", efforts: [] },
  { value: "gemini-3.1-pro", name: "Gemini 3.1 Pro", efforts: ["low", "high"], firstEffort: "high" },
  { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"], firstEffort: "high" },
];
const DEFAULT_MODEL = "gemini-4-neon";
const DEFAULT_EFFORT = "medium";

const EXPECTED_QUOTA = [
  { kind: "quota", window: { minutes: 300 }, left: 88, resetsAt: "2026-11-25T13:03:00.000Z" },
  { kind: "quota", window: { minutes: 10080 }, left: 72, resetsAt: "2026-12-01T00:23:00.000Z" },
];

/**
 * Fake ACP Server: the prompt text decides how the round goes; session records are stored in cwd, so they can be resumed across processes.
 * Each process starts on the default model and thinking level; session/new and session/resume both return configOptions.
 * With `login-on-new` in cwd, session/new prints an authorization URL as if credentials expired, then waits forever;
 * with `auth-required`, session/new returns auth_required.
 */
const FAKE_SERVER = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
const MODELS = ${JSON.stringify(MODELS)};
const DEFAULT_MODEL = ${JSON.stringify(DEFAULT_MODEL)};
const DEFAULT_EFFORT = ${JSON.stringify(DEFAULT_EFFORT)};
const LEVEL_ORDER = ["minimal", "low", "medium", "high", "xhigh", "extra_high", "max"];
const LEVEL_NAMES = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra" };
if (process.argv.includes("--uid=") !== (process.platform === "linux")) process.exit(2);
const storePath = process.cwd() + "/sessions.json";
const load = () => { try { return JSON.parse(readFileSync(storePath, "utf8")); } catch { return {}; } };
const save = (store) => writeFileSync(storePath, JSON.stringify(store));
const out = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const reply = (id, result) => out({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => out({ jsonrpc: "2.0", id, error: { code, message } });
const loginPrompt = () => process.stderr.write("Open the following link to authenticate the ACP server: https://accounts.example/o/oauth2/auth?x=1\\n");
let session = null;
let mode = null;
let model = DEFAULT_MODEL;
let effort = DEFAULT_EFFORT;
let additionalDirectories = null;
let disabledTools = null;
const nearestEffort = (levels, wanted) => {
  if (levels.includes(wanted)) return wanted;
  const targetRank = LEVEL_ORDER.indexOf(wanted);
  return levels.slice().sort((a, b) => {
    const rankA = LEVEL_ORDER.indexOf(a);
    const rankB = LEVEL_ORDER.indexOf(b);
    return Math.abs(rankA - targetRank) - Math.abs(rankB - targetRank) || rankB - rankA;
  })[0];
};
const configOptions = () => {
  const current = MODELS.find((item) => item.value === model);
  const options = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: model,
      options: MODELS.map((item) => ({
        value: item.value,
        name: item.name,
        ...(item.description ? { description: item.description } : {}),
      })),
    },
  ];
  if (current && current.efforts.length > 0) {
    options.push({
      id: "thinking_level",
      name: "Thinking Level",
      category: "thought_level",
      type: "select",
      currentValue: effort,
      options: current.efforts.map((level) => ({ value: level, name: LEVEL_NAMES[level] ?? level })),
    });
  }
  options.push({ id: "mode", name: "Session Mode", category: "mode", type: "select", currentValue: "default", options: [] });
  return options;
};
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
    case "initialize":
      appendFileSync(process.cwd() + "/starts", "start\\n");
      if (existsSync(process.cwd() + "/spawn-child")) {
        const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        writeFileSync(process.cwd() + "/server.pid", String(process.pid));
        writeFileSync(process.cwd() + "/child.pid", String(helper.pid));
      }
      return reply(id, { protocolVersion: 1 });
    case "session/new": {
      if (existsSync(process.cwd() + "/login-on-new")) { ignoreEof = true; loginPrompt(); setInterval(() => {}, 1000); return; }
      if (existsSync(process.cwd() + "/auth-required")) return fail(id, -32000, "Authentication required");
      additionalDirectories = params.additionalDirectories ?? null;
      disabledTools = params._meta?.antigravity?.disabledTools ?? null;
      writeFileSync(process.cwd() + "/last-open.json", JSON.stringify({ method, additionalDirectories, disabledTools }));
      session = "s-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      const store = load();
      store[session] = [];
      save(store);
      return reply(id, { sessionId: session, modes: { currentModeId: "default" }, configOptions: configOptions() });
    }
    case "session/resume": {
      const store = load();
      if (existsSync(process.cwd() + "/resume-hang")) { rmSync(process.cwd() + "/resume-hang"); ignoreEof = true; setInterval(() => {}, 1000); return; }
      if (existsSync(process.cwd() + "/crash-on-resume")) { rmSync(process.cwd() + "/crash-on-resume"); process.exit(3); }
      if (existsSync(process.cwd() + "/resume-fails")) return fail(id, -32603, "Internal error");
      if (!store[params.sessionId]) return fail(id, -32002, "Session not found");
      additionalDirectories = params.additionalDirectories ?? null;
      disabledTools = params._meta?.antigravity?.disabledTools ?? null;
      writeFileSync(process.cwd() + "/last-open.json", JSON.stringify({ method, additionalDirectories, disabledTools }));
      session = params.sessionId;
      if (existsSync(process.cwd() + "/no-models")) return reply(id, { modes: { currentModeId: "default" } });
      return reply(id, { modes: { currentModeId: "default" }, configOptions: configOptions() });
    }
    case "session/set_mode":
      mode = params.modeId;
      return reply(id, {});
    case "session/set_config_option":
      if (existsSync(process.cwd() + "/config-hang")) { rmSync(process.cwd() + "/config-hang"); ignoreEof = true; setInterval(() => {}, 1000); return; }
      if (params.configId === "model") {
        const target = MODELS.find((item) => item.value === params.value);
        if (!target) return fail(id, -32602, "Invalid value");
        if (target.efforts.length === 0) {
          effort = null;
        } else if (effort !== null) {
          effort = nearestEffort(target.efforts, effort);
        } else {
          effort = target.firstEffort;
        }
        model = target.value;
        return reply(id, { configOptions: configOptions() });
      }
      if (params.configId === "thinking_level") {
        const current = MODELS.find((item) => item.value === model);
        if (!current || !current.efforts.includes(params.value)) return fail(id, -32602, "Invalid value");
        effort = params.value;
        return reply(id, { configOptions: configOptions() });
      }
      return fail(id, -32602, "Invalid value");
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
function sendQuotaReport() {
  say([
    "### Session Usage",
    "- **Session total:** data not available yet",
    "",
    "### Quota Limits",
    "- **Gemini Models**",
    "  *(Models within this group: Gemini 4 Neon, Gemini 3.8 Flash)*",
    "  - **Weekly Limit Remaining:** 72% remaining (resets Dec 01, 2026, 00:23 UTC)",
    "",
  ].join("\\n"));
  say([
    "  - **Five Hour Limit Remaining:** 88% remaining (resets Nov 25, 2026, 13:03 UTC)",
    "- **Claude and GPT models**",
    "  *(Models within this group: Claude Opus 5.5, GPT-OSS 120B)*",
    "  - **Weekly Limit Remaining:** 100% remaining",
    "  - **Five Hour Limit Remaining:** 100% remaining",
  ].join("\\n"));
  end();
}
function prompt(id, text) {
  promptId = id;
  if (text.trim() === "/usage") {
    appendFileSync(process.cwd() + "/usage-reads", "read\\n");
    if (existsSync(process.cwd() + "/usage-hang")) { ignoreEof = true; setInterval(() => {}, 1000); return; }
    if (existsSync(process.cwd() + "/usage-login")) { ignoreEof = true; loginPrompt(); setInterval(() => {}, 1000); return; }
    if (existsSync(process.cwd() + "/crash-on-usage")) { rmSync(process.cwd() + "/crash-on-usage"); process.exit(3); }
    if (existsSync(process.cwd() + "/usage-fails")) { promptId = null; return fail(id, -32603, "Quota read failed"); }
    if (existsSync(process.cwd() + "/usage-empty")) { say("### Session Usage\\n- **Session total:** data not available yet"); return end(); }
    if (existsSync(process.cwd() + "/usage-delay")) { setTimeout(sendQuotaReport, 80); return; }
    return sendQuotaReport();
  }
  const store = load();
  store[session].push(text);
  save(store);
  const command = text.split("\\n").at(-1);
  if (command === "state") {
    const env = Object.fromEntries(["TERM", "BROWSER", "ACCESS_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"].map((key) => [key, key in process.env]));
    say(JSON.stringify({ session, mode, model, effort, calls, prompts: store[session], env, additionalDirectories, disabledTools }));
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
  if (command === "usage") {
    update({ sessionUpdate: "usage_update", used: 262144, size: 1048576 });
    update({ sessionUpdate: "usage_update", used: 5, size: 0 });
    say("counted");
    return end();
  }
  if (command === "refuse") { say("half"); return end("refusal"); }
  if (command === "error") { promptId = null; return fail(id, -32603, "Upstream refused"); }
  if (command === "unauthorized") { promptId = null; return fail(id, -32000, "Authentication required"); }
  if (command === "crash") { say("before crash"); process.exit(3); }
  say("echo:" + text);
  end();
}
`;

type Approval = { ask: ApprovalAsk; signal: AbortSignal | undefined; resolve: (answer: ApprovalAnswer) => void };

async function setup(t: test.TestContext): Promise<{ adapter: AntigravityAdapter; cwd: string; executable: string; stateDirectory: string }> {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "lanting-antigravity-adapter-")));
  const executable = path.join(cwd, "fake-antigravity.mjs");
  await writeFile(executable, FAKE_SERVER, "utf8");
  await chmod(executable, 0o700);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  // Not created in advance, as at startup.
  const stateDirectory = path.join(cwd, "state", "agents", "antigravity");
  const adapter = new AntigravityAdapter({ executable, stateDirectory });
  t.after(() => adapter.close());
  return { adapter, cwd, executable, stateDirectory };
}

function sessionOptions(
  cwd: string,
  permission: string | null = null,
  approvals: Approval[] = [],
  model: Pick<AgentSettings, "model" | "effort"> = { model: null, effort: null },
): SessionOptions {
  return {
    cwd,
    systemPrompt: "GROUP RULES",
    settings: { ...model, permission },
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

async function storedSessions(directory: string): Promise<string[]> {
  return Object.keys(JSON.parse(await readFile(path.join(directory, "sessions.json"), "utf8")) as Record<string, unknown>);
}

async function catalogSessionId(stateDirectory: string): Promise<unknown> {
  return (JSON.parse(await readFile(path.join(stateDirectory, "catalog-session.json"), "utf8")) as { sessionId: unknown }).sessionId;
}

async function countLines(file: string): Promise<number> {
  try {
    return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

test("declares models, permissions and usage", async () => {
  const adapter = new AntigravityAdapter({ executable: "/unused", stateDirectory: "/unused" });
  assert.equal(adapter.kind, "antigravity");
  assert.equal(adapter.closeAfterTurn, true);
  assert.deepEqual(Object.keys(adapter.features), ["models", "permissions", "usage"]);
  assert.deepEqual(await adapter.features.permissions!("/tmp"), [...ANTIGRAVITY_PERMISSIONS]);
  assert.equal(ANTIGRAVITY_PERMISSIONS.find((option) => option.id === "always-approve")?.danger, true);
});

test("reads models and per-model thinking levels from one catalog session that later lookups and restarts resume", async (t) => {
  const { adapter, cwd, executable, stateDirectory } = await setup(t);
  const models = await adapter.features.models!(cwd);
  assert.deepEqual(models, [
    { id: "gemini-4-neon", label: "Gemini 4 Neon", description: "", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
    { id: "solo-preview", label: "Solo Preview (Experimental)", description: "solo-preview", efforts: [] },
    { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro", description: "", efforts: ["low", "high"], defaultEffort: "high" },
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", description: "", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  ]);
  const sessions = await storedSessions(stateDirectory);
  assert.equal(sessions.length, 1);
  assert.equal(await catalogSessionId(stateDirectory), sessions[0]);

  // Another proxy choice is a separate cache entry, so the Server is asked again; it resumes the same session on the resident process.
  assert.deepEqual(await adapter.features.models!(cwd, true), models);
  assert.equal(await countLines(path.join(stateDirectory, "starts")), 1);
  const restarted = new AntigravityAdapter({ executable, stateDirectory });
  t.after(() => restarted.close());
  assert.deepEqual(await restarted.features.models!("/elsewhere"), models);
  assert.deepEqual(await storedSessions(stateDirectory), sessions);
  // The catalog session lives in the state directory, never in a group's directory.
  await assert.rejects(readFile(path.join(cwd, "sessions.json")), { code: "ENOENT" });
});

test("concurrent catalog lookups create only one catalog session", async (t) => {
  const { adapter, cwd, stateDirectory } = await setup(t);
  await Promise.all([adapter.features.models!(cwd), adapter.features.models!(cwd, true), adapter.features.models!(cwd, false)]);
  assert.equal((await storedSessions(stateDirectory)).length, 1);
});

test("replaces a catalog session only when the server reports it not found", async (t) => {
  const { adapter, cwd, stateDirectory } = await setup(t);
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(path.join(stateDirectory, "catalog-session.json"), JSON.stringify({ sessionId: "missing" }));
  assert.equal((await adapter.features.models!(cwd)).length, MODELS.length);
  const sessions = await storedSessions(stateDirectory);
  assert.equal(sessions.length, 1);
  assert.equal(await catalogSessionId(stateDirectory), sessions[0]);
});

test("keeps the saved catalog session when resuming it fails for another reason", async (t) => {
  const { adapter, executable, cwd, stateDirectory } = await setup(t);
  await adapter.features.models!(cwd);
  const saved = await catalogSessionId(stateDirectory);
  await writeFile(path.join(stateDirectory, "resume-fails"), "");
  const restarted = new AntigravityAdapter({ executable, stateDirectory });
  t.after(() => restarted.close());
  await assert.rejects(restarted.features.models!(cwd), /Antigravity session\/resume failed: Internal error/u);
  assert.equal(await catalogSessionId(stateDirectory), saved);
  assert.deepEqual(await storedSessions(stateDirectory), [saved]);
});

test("leaves an unreadable catalog record in place, creates no session, and recovers once fixed", async (t) => {
  for (const record of ["not json", JSON.stringify({ other: 1 }), "[]", "null", ""]) {
    const { adapter, cwd, stateDirectory } = await setup(t);
    await mkdir(stateDirectory, { recursive: true });
    const file = path.join(stateDirectory, "catalog-session.json");
    await writeFile(file, record);
    await assert.rejects(adapter.features.models!(cwd), /State file/u);
    assert.equal(await readFile(file, "utf8"), record);
    await assert.rejects(readFile(path.join(stateDirectory, "sessions.json")), { code: "ENOENT" });
    await rm(file);
    assert.equal((await adapter.features.models!(cwd)).length, MODELS.length);
  }
});

test("does not cache an empty model list", async (t) => {
  const { adapter, cwd, stateDirectory } = await setup(t);
  await adapter.features.models!(cwd);
  await writeFile(path.join(stateDirectory, "no-models"), "");
  await assert.rejects(adapter.features.models!(cwd, true), /Antigravity returned no model list/u);
  await rm(path.join(stateDirectory, "no-models"));
  assert.equal((await adapter.features.models!(cwd, true)).length, MODELS.length);
});

test("a catalog lookup that needs a login fails with the login hint", async (t) => {
  for (const flag of ["login-on-new", "auth-required"]) {
    const { adapter, cwd, stateDirectory } = await setup(t);
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(path.join(stateDirectory, flag), "");
    await assert.rejects(adapter.features.models!(cwd), { message: englishText(LOGIN_REQUIRED), text: LOGIN_REQUIRED });
  }
});

test("sets the chosen model and thinking level every time a session opens", async (t) => {
  const { adapter, cwd } = await setup(t);
  const choice = { model: "gemini-3.8-flash", effort: "low" };
  const session = await adapter.startSession(sessionOptions(cwd, null, [], choice));
  t.after(() => session.close());
  const state = JSON.parse(endOf(await drain(session, "state")).text) as Record<string, unknown>;
  assert.equal(state.model, "gemini-3.8-flash");
  assert.equal(state.effort, "low");
  assert.deepEqual(state.calls, [
    "initialize",
    "session/new",
    "session/set_mode",
    "session/set_config_option",
    "session/set_config_option",
    "session/prompt",
  ]);
  await session.close();

  const resumed = await adapter.resumeSession(session.nativeId!, sessionOptions(cwd, null, [], choice));
  t.after(() => resumed.close());
  const after = JSON.parse(endOf(await drain(resumed, "state")).text) as Record<string, unknown>;
  assert.equal(after.model, "gemini-3.8-flash");
  assert.equal(after.effort, "low");
  assert.deepEqual(after.calls, [
    "initialize",
    "session/resume",
    "session/set_mode",
    "session/set_config_option",
    "session/set_config_option",
    "session/prompt",
  ]);
  await resumed.close();
});

test("skips config updates that already match the session state and ignores effort without a model", async (t) => {
  const { adapter, cwd } = await setup(t);
  for (const [choice, expectedModel, expectedEffort, calls] of [
    [{ model: "gemini-4-neon", effort: "xhigh" }, "gemini-4-neon", "xhigh", ["initialize", "session/new", "session/set_mode", "session/set_config_option", "session/prompt"]],
    [{ model: "gemini-4-neon", effort: "medium" }, "gemini-4-neon", "medium", ["initialize", "session/new", "session/set_mode", "session/prompt"]],
    [{ model: "gemini-4-neon", effort: null }, "gemini-4-neon", "medium", ["initialize", "session/new", "session/set_mode", "session/prompt"]],
    [{ model: "gemini-3.8-flash", effort: "medium" }, "gemini-3.8-flash", "medium", ["initialize", "session/new", "session/set_mode", "session/set_config_option", "session/prompt"]],
    [{ model: "gemini-3.1-pro", effort: null }, "gemini-3.1-pro", "high", ["initialize", "session/new", "session/set_mode", "session/set_config_option", "session/prompt"]],
    [{ model: "solo-preview", effort: null }, "solo-preview", null, ["initialize", "session/new", "session/set_mode", "session/set_config_option", "session/prompt"]],
    [{ model: null, effort: "high" }, DEFAULT_MODEL, DEFAULT_EFFORT, ["initialize", "session/new", "session/set_mode", "session/prompt"]],
  ] as const) {
    const session = await adapter.startSession(sessionOptions(cwd, null, [], choice));
    t.after(() => session.close());
    const state = JSON.parse(endOf(await drain(session, "state")).text) as Record<string, unknown>;
    assert.equal(state.model, expectedModel);
    assert.equal(state.effort, expectedEffort);
    assert.deepEqual(state.calls, calls);
    await session.close();
  }
});

test("fails to open a session with a model or thinking level the server does not offer", async (t) => {
  const { adapter, cwd } = await setup(t);
  await assert.rejects(
    adapter.startSession(sessionOptions(cwd, null, [], { model: "gemini-0-retired", effort: null })),
    /Antigravity doesn't offer the model gemini-0-retired in this session/u,
  );
  await assert.rejects(
    adapter.startSession(sessionOptions(cwd, null, [], { model: "gemini-3.1-pro", effort: "medium" })),
    /Antigravity doesn't offer the model gemini-3.1-pro \(medium\) in this session/u,
  );
  await assert.rejects(
    adapter.startSession(sessionOptions(cwd, null, [], { model: "solo-preview", effort: "low" })),
    /Antigravity doesn't offer the model solo-preview \(low\) in this session/u,
  );
});

test("reports the context share from usage updates alongside Gemini quota limits", async (t) => {
  const { adapter, cwd } = await setup(t);
  const request = (nativeId: string) => ({ nativeId, cwd, reason: "turn" as const, session: async () => null });
  assert.deepEqual(await adapter.features.usage!(request("unknown")), [{ kind: "context", percent: null }, ...EXPECTED_QUOTA]);
  const session = await adapter.startSession(sessionOptions(cwd));
  t.after(() => session.close());
  assert.equal(endOf(await drain(session, "usage")).text, "counted");
  assert.deepEqual(await adapter.features.usage!(request(session.nativeId!)), [{ kind: "context", percent: 25 }, ...EXPECTED_QUOTA]);
  await session.close();
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
    error: englishText(LOGIN_REQUIRED),
    errorText: LOGIN_REQUIRED,
  });
  await session.close();
  await writeFile(path.join(cwd, "auth-required"), "");
  await assert.rejects(adapter.startSession(sessionOptions(cwd)), { message: englishText(LOGIN_REQUIRED), text: LOGIN_REQUIRED });
});

test("ends the turn at once when the server starts a browser login", async (t) => {
  const { adapter, cwd } = await setup(t);
  const session = await adapter.startSession(sessionOptions(cwd));
  t.after(() => session.close());
  const end = endOf(await drain(session, "login"));
  assert.deepEqual(end, {
    type: "end",
    outcome: "failed",
    text: "thinking",
    error: englishText(LOGIN_REQUIRED),
    errorText: LOGIN_REQUIRED,
  });
  await waitFor(() => !session.alive);
  await session.close();
});

test("fails to open a session when the server starts a browser login", async (t) => {
  const { adapter, cwd } = await setup(t);
  await writeFile(path.join(cwd, "login-on-new"), "");
  await assert.rejects(adapter.startSession(sessionOptions(cwd)), { message: englishText(LOGIN_REQUIRED), text: LOGIN_REQUIRED });
});

test("passes disabledTools on every session open and additionalDirectories only on group sessions", async (t) => {
  const { executable, cwd, stateDirectory } = await setup(t);
  const extraDirs = [path.join(cwd, "projects"), path.join(cwd, "preview"), path.join(cwd, "blobs")];
  const adapter = new AntigravityAdapter({ executable, stateDirectory, additionalDirectories: extraDirs });
  t.after(() => adapter.close());

  await adapter.features.models!(cwd);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(stateDirectory, "last-open.json"), "utf8")),
    { method: "session/new", additionalDirectories: null, disabledTools: ["run_workflow"] },
  );

  await adapter.features.models!(cwd, true);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(stateDirectory, "last-open.json"), "utf8")),
    { method: "session/resume", additionalDirectories: null, disabledTools: ["run_workflow"] },
  );

  const session = await adapter.startSession(sessionOptions(cwd));
  t.after(() => session.close());
  const firstState = JSON.parse(endOf(await drain(session, "state")).text) as Record<string, unknown>;
  assert.deepEqual(firstState.additionalDirectories, extraDirs);
  assert.deepEqual(firstState.disabledTools, ["run_workflow"]);
  const nativeId = session.nativeId!;
  await session.close();

  const resumed = await adapter.resumeSession(nativeId, sessionOptions(cwd));
  t.after(() => resumed.close());
  const resumedState = JSON.parse(endOf(await drain(resumed, "state")).text) as Record<string, unknown>;
  assert.deepEqual(resumedState.additionalDirectories, extraDirs);
  assert.deepEqual(resumedState.disabledTools, ["run_workflow"]);
  await resumed.close();
});

test("reports a missing executable when opening a session", async () => {
  const adapter = new AntigravityAdapter({ executable: "/nonexistent/agy_acp_server.par", stateDirectory: "/unused" });
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

test("parseAntigravityQuota parses Gemini quota windows shortest-first and ignores non-Gemini groups", () => {
  const report = [
    "### Session Usage",
    "- **Session total:** data not available yet",
    "",
    "### Quota Limits",
    "- **Gemini Models**",
    "  *(Models within this group: Gemini 4 Neon, Gemini 3.8 Flash)*",
    "  - **Weekly Limit Remaining:** 72% remaining (resets Dec 01, 2026, 00:23 UTC)",
    "  - **Five Hour Limit Remaining:** 88.5% remaining (resets Nov 25, 2026, 13:03 UTC)",
    "- **Claude and GPT models**",
    "  *(Models within this group: Claude Opus 5.5, GPT-OSS 120B)*",
    "  - **Weekly Limit Remaining:** 100% remaining",
    "  - **Five Hour Limit Remaining:** 100% remaining",
    "",
    "### AI Credits",
    "- **Available:** 500",
  ].join("\n");
  assert.deepEqual(parseAntigravityQuota(report), [
    { kind: "quota", window: { minutes: 300 }, left: 88.5, resetsAt: "2026-11-25T13:03:00.000Z" },
    { kind: "quota", window: { minutes: 10080 }, left: 72, resetsAt: "2026-12-01T00:23:00.000Z" },
  ]);
});

test("parseAntigravityQuota handles ISO reset times, missing resets, zero remaining, and skips disabled buckets", () => {
  const report = [
    "### Quota Limits",
    "- **Gemini Models**",
    "  - **Monthly Limit Remaining:** 0% remaining (resets 2026-12-31T23:59:59Z)",
    "  - **Daily Limit Remaining:** 100% remaining",
    "  - **12 Hour Limit Remaining:** 50% remaining (resets invalid date)",
    "  - **Hourly Limit Remaining:** Disabled (resets Nov 25, 2026, 14:00 UTC)",
  ].join("\n");
  assert.deepEqual(parseAntigravityQuota(report), [
    { kind: "quota", window: { minutes: 720 }, left: 50 },
    { kind: "quota", window: { minutes: 1440 }, left: 100 },
    { kind: "quota", window: { name: "Monthly" }, left: 0, resetsAt: "2026-12-31T23:59:59.000Z" },
  ]);
  assert.deepEqual(parseAntigravityQuota("### Session Usage\n- **Session total:** data not available yet"), []);
  assert.deepEqual(parseAntigravityQuota("### Quota Limits\n- **Claude and GPT models**\n  - **Weekly Limit Remaining:** 100% remaining"), []);
});

test("start warms up one resident process shared by models and usage without polluting session history", async (t) => {
  const { adapter, cwd, stateDirectory } = await setup(t);
  adapter.start();
  const request = { nativeId: "s-1", cwd, reason: "view" as const, session: async () => null };
  assert.deepEqual(await adapter.features.usage!(request), [{ kind: "context", percent: null }, ...EXPECTED_QUOTA]);
  assert.equal((await adapter.features.models!(cwd)).length, MODELS.length);
  assert.equal((await adapter.features.models!(cwd, true)).length, MODELS.length);
  assert.deepEqual(await adapter.features.usage!(request), [{ kind: "context", percent: null }, ...EXPECTED_QUOTA]);
  assert.equal(await countLines(path.join(stateDirectory, "starts")), 1);
  assert.equal((await storedSessions(stateDirectory)).length, 1);
});

test("coalesces concurrent usage quota reads into one /usage prompt", async (t) => {
  const { adapter, cwd, stateDirectory } = await setup(t);
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(path.join(stateDirectory, "usage-delay"), "");
  const request = (nativeId: string) => ({ nativeId, cwd, reason: "visible" as const, session: async () => null });
  const results = await Promise.all([
    adapter.features.usage!(request("a")),
    adapter.features.usage!(request("b")),
    adapter.features.usage!(request("c")),
  ]);
  for (const parts of results) {
    assert.deepEqual(parts, [{ kind: "context", percent: null }, ...EXPECTED_QUOTA]);
  }
  assert.equal(await countLines(path.join(stateDirectory, "starts")), 1);
  assert.equal(await countLines(path.join(stateDirectory, "usage-reads")), 1);
});

test("restarts the resident server on the next request after an unexpected exit", async (t) => {
  const { adapter, cwd, stateDirectory } = await setup(t);
  const request = { nativeId: "s-1", cwd, reason: "view" as const, session: async () => null };
  assert.deepEqual(await adapter.features.usage!(request), [{ kind: "context", percent: null }, ...EXPECTED_QUOTA]);
  assert.equal(await countLines(path.join(stateDirectory, "starts")), 1);

  await writeFile(path.join(stateDirectory, "crash-on-usage"), "");
  assert.deepEqual(await adapter.features.usage!(request), [{ kind: "context", percent: null }, { kind: "unavailable" }]);

  assert.deepEqual(await adapter.features.usage!(request), [{ kind: "context", percent: null }, ...EXPECTED_QUOTA]);
  assert.equal(await countLines(path.join(stateDirectory, "starts")), 2);
});

test("does not restart the resident server after close", async (t) => {
  const { adapter, cwd, stateDirectory } = await setup(t);
  const request = { nativeId: "s-1", cwd, reason: "view" as const, session: async () => null };
  assert.deepEqual(await adapter.features.usage!(request), [{ kind: "context", percent: null }, ...EXPECTED_QUOTA]);
  assert.equal(await countLines(path.join(stateDirectory, "starts")), 1);

  await adapter.close();
  assert.deepEqual(await adapter.features.usage!(request), [{ kind: "context", percent: null }, { kind: "unavailable" }]);
  await assert.rejects(adapter.features.models!(cwd), /closed/u);
  assert.equal(await countLines(path.join(stateDirectory, "starts")), 1);
});

test("reports unavailable quota on error, empty output, login prompt, or timeout while keeping context and recovering later", async (t) => {
  const { executable, cwd, stateDirectory } = await setup(t);
  const adapter = new AntigravityAdapter({ executable, stateDirectory, usageTimeoutMs: 120 });
  t.after(() => adapter.close());

  const session = await adapter.startSession(sessionOptions(cwd));
  t.after(() => session.close());
  assert.equal(endOf(await drain(session, "usage")).text, "counted");
  const nativeId = session.nativeId!;
  await session.close();

  const request = { nativeId, cwd, reason: "turn" as const, session: async () => null };
  assert.deepEqual(await adapter.features.usage!(request), [{ kind: "context", percent: 25 }, ...EXPECTED_QUOTA]);

  for (const flag of ["usage-fails", "usage-empty", "usage-login", "usage-hang"]) {
    const flagFile = path.join(stateDirectory, flag);
    await writeFile(flagFile, "");
    assert.deepEqual(await adapter.features.usage!(request), [{ kind: "context", percent: 25 }, { kind: "unavailable" }]);
    await rm(flagFile);
    assert.deepEqual(await adapter.features.usage!(request), [{ kind: "context", percent: 25 }, ...EXPECTED_QUOTA]);
  }
});

test("uses a separate direct resident when useProxy is false while sharing the single catalog session", async (t) => {
  const { adapter, cwd, stateDirectory } = await setup(t);
  const defaultRequest = { nativeId: "s-1", cwd, reason: "view" as const, session: async () => null };
  const directRequest = { nativeId: "s-1", cwd, useProxy: false, reason: "view" as const, session: async () => null };
  assert.deepEqual(await adapter.features.usage!(defaultRequest), [{ kind: "context", percent: null }, ...EXPECTED_QUOTA]);
  assert.deepEqual(await adapter.features.usage!(directRequest), [{ kind: "context", percent: null }, ...EXPECTED_QUOTA]);
  assert.equal(await countLines(path.join(stateDirectory, "starts")), 2);
  assert.equal((await storedSessions(stateDirectory)).length, 1);
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

test("times out a hung model refresh, resets the resident server, and unblocks queued quota reads", async (t) => {
  const { executable, cwd, stateDirectory } = await setup(t);
  const adapter = new AntigravityAdapter({ executable, stateDirectory, catalogTimeoutMs: 120, usageTimeoutMs: 500 });
  t.after(() => adapter.close());

  assert.equal((await adapter.features.models!(cwd)).length, MODELS.length);
  assert.equal(await countLines(path.join(stateDirectory, "starts")), 1);

  const request = { nativeId: "s-1", cwd, reason: "view" as const, session: async () => null };
  for (const [index, flag] of (["resume-hang", "config-hang"] as const).entries()) {
    await writeFile(path.join(stateDirectory, flag), "");
    const refresh = adapter.features.models!(cwd, true);
    const quota = adapter.features.usage!(request);
    await assert.rejects(refresh, /Antigravity model lookup did not finish within/u);
    assert.deepEqual(await quota, [{ kind: "context", percent: null }, ...EXPECTED_QUOTA]);
    assert.equal(await countLines(path.join(stateDirectory, "starts")), index + 2);
  }
});

test("cleans up child processes in the resident process group after an unexpected exit", async (t) => {
  const { adapter, cwd, stateDirectory } = await setup(t);
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(path.join(stateDirectory, "spawn-child"), "");
  const request = { nativeId: "s-1", cwd, reason: "view" as const, session: async () => null };
  const readPid = async (name: string) => Number((await readFile(path.join(stateDirectory, name), "utf8")).trim());
  const cleanupPid = (pid: number) => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already exited.
    }
  };

  // Case 1: unexpected exit during a request cleans up its child process before the next restart.
  assert.deepEqual(await adapter.features.usage!(request), [{ kind: "context", percent: null }, ...EXPECTED_QUOTA]);
  const firstChild = await readPid("child.pid");
  t.after(() => cleanupPid(firstChild));
  assert.equal(processExists(firstChild), true);

  await writeFile(path.join(stateDirectory, "crash-on-usage"), "");
  assert.deepEqual(await adapter.features.usage!(request), [{ kind: "context", percent: null }, { kind: "unavailable" }]);
  assert.equal(processExists(firstChild), false);

  // Case 2: unexpected exit while idle still tears down the whole process group and close() waits for it.
  assert.deepEqual(await adapter.features.usage!(request), [{ kind: "context", percent: null }, ...EXPECTED_QUOTA]);
  const secondServer = await readPid("server.pid");
  const secondChild = await readPid("child.pid");
  t.after(() => cleanupPid(secondChild));
  assert.equal(processExists(secondChild), true);

  process.kill(secondServer, "SIGKILL");
  await waitFor(() => !processExists(secondServer));
  await adapter.close();
  assert.equal(processExists(secondChild), false);
});
