import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentEvent, ApprovalAnswer, ApprovalAsk, SessionOptions } from "../types.ts";
import { PiAdapter, splitModelId } from "./adapter.ts";

/** 假的 `pi --mode rpc`：prompt 的正文决定这一轮怎么走。 */
const FAKE_PI = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const state = {
  rules: flag("--append-system-prompt"),
  noSession: args.includes("--no-session"),
  sessionFile: "/fake/sessions/new.jsonl",
  model: null,
  thinking: null,
  modelSets: 0,
  thinkingSets: 0,
  compacted: 0,
  uiResponses: [],
};
const metaPath = (sessionFile) => path.join(process.cwd(), Buffer.from(sessionFile).toString("base64url") + ".meta");
const persist = () => writeFileSync(metaPath(state.sessionFile), JSON.stringify({ model: state.model, thinking: state.thinking }));
const restore = (sessionFile) => {
  try { return JSON.parse(readFileSync(metaPath(sessionFile), "utf8")); }
  catch { return {}; }
};
const snapshot = () => {
  const data = { sessionFile: state.sessionFile, sessionId: "s1" };
  if (state.model) {
    const bar = state.model.indexOf("|");
    data.model = { provider: state.model.slice(0, bar), id: state.model.slice(bar + 1) };
  }
  if (state.thinking) data.thinkingLevel = state.thinking;
  return data;
};
const out = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
const ok = (command, data) => out({ id: command.id, type: "response", command: command.type, success: true, data });
const assistant = (text, extra = {}) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", ...extra });
const say = (text, extra = {}) => {
  out({ type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } });
  if (text) out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
  out({ type: "message_end", message: assistant(text, extra) });
};
const settle = (aborted = false) => {
  out({ type: "agent_end", messages: [], willRetry: false });
  out({ type: "agent_settled", aborted });
};
let waiting = null;
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
function handle(command) {
  switch (command.type) {
    case "get_state": return ok(command, snapshot());
    case "switch_session":
      if (command.sessionPath === "/fake/sessions/locked.jsonl") return ok(command, { cancelled: true });
      state.sessionFile = command.sessionPath;
      Object.assign(state, restore(command.sessionPath));
      return ok(command, { cancelled: false });
    case "set_model":
      state.model = command.provider + "|" + command.modelId;
      state.modelSets += 1;
      persist();
      return ok(command, {});
    case "set_thinking_level":
      state.thinking = command.level;
      state.thinkingSets += 1;
      persist();
      return ok(command);
    case "compact": state.compacted += 1; return ok(command, { summary: "s" });
    case "get_available_models": return ok(command, { models: [
      { id: "deepseek-flash", name: "DeepSeek V4.1 Flash", provider: "deepseek", reasoning: true,
        thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" } },
      { id: "vendor/plain-v1", provider: "router", reasoning: false },
    ] });
    case "extension_ui_response":
      state.uiResponses.push(command);
      if (waiting && waiting.id === command.id) { const next = waiting.next; waiting = null; next(command); }
      return;
    case "abort":
      ok(command);
      if (waiting) {
        // Pi 的 abort 让对话框按默认值结束，客户端收不到通知。
        waiting = null;
      }
      out({ type: "message_end", message: assistant("partial", { stopReason: "aborted" }) });
      return settle(true);
    case "prompt": return prompt(command);
    default: return out({ id: command.id, type: "response", command: command.type, success: false, error: "unknown" });
  }
}
function prompt(command) {
  const text = command.message;
  if (text === "handled") return ok(command, { disposition: "handled" });
  ok(command, { disposition: "started" });
  out({ type: "agent_start" });
  if (text === "state") { say(JSON.stringify(state)); return settle(); }
  if (text === "hello") {
    say("Let me look", { stopReason: "toolUse" });
    out({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "package.json" } });
    out({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Permission Required", message: "Allow read on 'package.json'?" });
    waiting = { id: "ui-1", next: (response) => {
      out({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: {}, isError: !response.confirmed });
      say("done:" + JSON.stringify(response.confirmed ?? "cancelled") + "|" + state.rules);
      settle();
    } };
    return;
  }
  if (text === "retry") {
    // agent_end 之后还有自动重试，不能在第一个 agent_end 就结束。
    say("", { stopReason: "error", errorMessage: "529 overloaded" });
    out({ type: "agent_end", messages: [], willRetry: true });
    out({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "529 overloaded" });
    setTimeout(() => {
      out({ type: "agent_start" });
      say("recovered");
      out({ type: "auto_retry_end", success: true, attempt: 2 });
      settle();
    }, 50);
    return;
  }
  if (text === "fail") { say("", { stopReason: "error", errorMessage: "429 rate limited" }); return settle(); }
  if (text === "empty") { say(""); return settle(); }
  if (text === "crash") {
    out({ type: "message_start", message: { role: "assistant", content: [] } });
    out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "half" } });
    setTimeout(() => process.exit(2), 20);
    return;
  }
  if (text === "hang") {
    out({ type: "message_start", message: { role: "assistant", content: [] } });
    out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial" } });
    return;
  }
  if (text === "hang_confirm") {
    out({ type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args: { command: "ls -la" } });
    out({ type: "extension_ui_request", id: "ui-2", method: "confirm", title: "Permission Required", message: "Allow bash?" });
    waiting = { id: "ui-2", next: () => {} };
    return;
  }
  if (text === "dialogs") {
    out({ type: "extension_ui_request", id: "ui-3", method: "select", title: "Pick one", options: ["a", "b"] });
    out({ type: "extension_ui_request", id: "ui-4", method: "notify", message: "heads up", notifyType: "info" });
    out({ type: "extension_ui_request", id: "ui-5", method: "setStatus", statusKey: "x", statusText: "busy" });
    waiting = { id: "ui-3", next: (response) => { say("select:" + JSON.stringify(response)); settle(); } };
    return;
  }
}
`;

type Approver = (ask: ApprovalAsk, signal?: AbortSignal) => Promise<ApprovalAnswer>;

async function setup(t: test.TestContext, approver?: Approver) {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-pi-adapter-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "pi");
  await writeFile(executable, FAKE_PI);
  await chmod(executable, 0o700);
  const asks: ApprovalAsk[] = [];
  const options: SessionOptions = {
    cwd: directory,
    systemPrompt: "group rules",
    settings: { model: null, effort: null, permission: null },
    requestApproval: async (ask, signal) => {
      asks.push(ask);
      return approver ? approver(ask, signal) : { decision: "allow", message: "" };
    },
  };
  return { adapter: new PiAdapter({ executable }), options, asks };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

async function stateOf(session: { send(text: string): AsyncIterable<AgentEvent> }): Promise<Record<string, unknown>> {
  const events = await collect(session.send("state"));
  return JSON.parse((events.at(-1) as { text: string }).text) as Record<string, unknown>;
}

function activities(events: AgentEvent[]): Record<string, unknown>[] {
  return events.flatMap((event) => event.type === "activity" ? [event.activity] : []);
}

test("a new Pi session saves its session file and appends the group prompt", async (t) => {
  const { adapter, options } = await setup(t);
  const session = await adapter.startSession(options);
  t.after(() => session.close());
  assert.equal(session.nativeId, "/fake/sessions/new.jsonl");
  const state = await stateOf(session);
  assert.equal(state.rules, "group rules");
  assert.equal(state.noSession, false);
});

test("resuming loads the saved session file and still appends the group prompt", async (t) => {
  const { adapter, options } = await setup(t);
  const session = await adapter.resumeSession("/fake/sessions/old.jsonl", options);
  t.after(() => session.close());
  assert.equal(session.nativeId, "/fake/sessions/old.jsonl");
  assert.equal((await stateOf(session)).rules, "group rules");
  await assert.rejects(adapter.resumeSession("/fake/sessions/locked.jsonl", options), /拒绝了恢复会话/u);
});

test("model and thinking settings are applied when the session opens", async (t) => {
  const { adapter, options } = await setup(t);
  const settings = { model: "router/vendor/plain-v1", effort: "off", permission: "ask" };
  const session = await adapter.startSession({ ...options, settings });
  t.after(() => session.close());
  const state = await stateOf(session);
  assert.equal(state.model, "router|vendor/plain-v1");
  assert.equal(state.thinking, "off");
  assert.equal(state.modelSets, 1);
  assert.equal(state.thinkingSets, 1);
  assert.deepEqual(splitModelId("deepseek/deepseek-flash"), { provider: "deepseek", modelId: "deepseek-flash" });
  assert.throws(() => splitModelId("no-provider"), /格式不对/u);
});

test("resuming skips set_model when the model and thinking already match", async (t) => {
  const { adapter, options } = await setup(t);
  const settings = { model: "router/vendor/plain-v1", effort: "off", permission: "ask" };
  const first = await adapter.startSession({ ...options, settings });
  const nativeId = first.nativeId;
  await first.close();
  const second = await adapter.resumeSession(nativeId!, { ...options, settings });
  t.after(() => second.close());
  const state = await stateOf(second);
  assert.equal(state.model, "router|vendor/plain-v1");
  assert.equal(state.thinking, "off");
  assert.equal(state.modelSets, 0);
  assert.equal(state.thinkingSets, 0);
});

test("resuming still sets the model when it changed", async (t) => {
  const { adapter, options } = await setup(t);
  const first = await adapter.startSession({
    ...options,
    settings: { model: "router/vendor/plain-v1", effort: "off", permission: "ask" },
  });
  const nativeId = first.nativeId;
  await first.close();
  const second = await adapter.resumeSession(nativeId!, {
    ...options,
    settings: { model: "deepseek/deepseek-flash", effort: "off", permission: "ask" },
  });
  t.after(() => second.close());
  const state = await stateOf(second);
  assert.equal(state.model, "deepseek|deepseek-flash");
  assert.equal(state.thinking, "off");
  assert.equal(state.modelSets, 1);
  assert.equal(state.thinkingSets, 1);
});

test("a Pi turn streams text, records the tool, asks for approval and ends with the final message", async (t) => {
  const { adapter, options, asks } = await setup(t);
  const session = await adapter.startSession(options);
  t.after(() => session.close());
  const events = await collect(session.send("hello"));
  assert.deepEqual(events.filter((event) => event.type === "text").map((event) => event.delta), [
    "Let me look",
    "done:true|group rules",
  ]);
  assert.deepEqual(activities(events), [
    { kind: "note", text: "Let me look" },
    { kind: "tool", toolName: "read", detail: "package.json" },
  ]);
  assert.deepEqual(asks, [{ toolName: "Permission Required", detail: "Allow read on 'package.json'?" }]);
  assert.deepEqual(events.at(-1), { type: "end", outcome: "completed", text: "done:true|group rules" });
});

test("always-approve answers Pi's confirm itself without asking the web", async (t) => {
  const { adapter, options, asks } = await setup(t, async () => ({ decision: "deny", message: "no" }));
  const settings = { model: null, effort: null, permission: "always-approve" };
  const session = await adapter.startSession({ ...options, settings });
  t.after(() => session.close());
  const events = await collect(session.send("hello"));
  assert.deepEqual(asks, []);
  assert.deepEqual(events.at(-1), { type: "end", outcome: "completed", text: "done:true|group rules" });
});

test("a denied approval answers confirmed false", async (t) => {
  const { adapter, options } = await setup(t, async () => ({ decision: "deny", message: "no" }));
  const session = await adapter.startSession(options);
  t.after(() => session.close());
  const events = await collect(session.send("hello"));
  assert.deepEqual(events.at(-1), { type: "end", outcome: "completed", text: "done:false|group rules" });
});

test("a failed approval request answers cancelled", async (t) => {
  const { adapter, options } = await setup(t, async () => {
    throw new Error("approval store gone");
  });
  const session = await adapter.startSession(options);
  t.after(() => session.close());
  const events = await collect(session.send("hello"));
  assert.deepEqual(events.at(-1), { type: "end", outcome: "completed", text: "done:\"cancelled\"|group rules" });
});

test("the turn waits for agent_settled across automatic retries", async (t) => {
  const { adapter, options } = await setup(t);
  const session = await adapter.startSession(options);
  t.after(() => session.close());
  const events = await collect(session.send("retry"));
  assert.deepEqual(activities(events), [{ kind: "note", text: "Pi 自动重试（1/3）：529 overloaded" }]);
  assert.deepEqual(events.at(-1), { type: "end", outcome: "completed", text: "recovered" });
});

test("provider errors, empty replies and crashes end as failed", async (t) => {
  const { adapter, options } = await setup(t);
  const session = await adapter.startSession(options);
  t.after(() => session.close());
  assert.deepEqual((await collect(session.send("fail"))).at(-1),
    { type: "end", outcome: "failed", text: "", error: "429 rate limited" });
  assert.deepEqual((await collect(session.send("empty"))).at(-1),
    { type: "end", outcome: "failed", text: "", error: "Pi 没有给出最终回复。" });
  assert.deepEqual((await collect(session.send("crash"))).at(-1),
    { type: "end", outcome: "failed", text: "half", error: "Pi 进程已退出。" });
  assert.equal(session.alive, false);
});

test("a handled prompt ends without waiting for a run", async (t) => {
  const { adapter, options } = await setup(t);
  const session = await adapter.startSession(options);
  t.after(() => session.close());
  assert.deepEqual((await collect(session.send("handled"))).at(-1), { type: "end", outcome: "completed", text: "" });
});

test("interrupting aborts the turn and keeps the streamed text", async (t) => {
  const { adapter, options } = await setup(t);
  const session = await adapter.startSession(options);
  t.after(() => session.close());
  const collected = collect(session.send("hang"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await session.interrupt();
  assert.deepEqual((await collected).at(-1), { type: "end", outcome: "interrupted", text: "partial" });
  assert.equal(session.alive, true);
});

/** 网页上一直不回答，直到被撤下。 */
function pendingApprover(aborted: string[]): Approver {
  return (ask, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => {
      aborted.push(ask.detail);
      reject(new Error("withdrawn"));
    }, { once: true });
  });
}

test("interrupting withdraws the web approval and cancels Pi's dialog", async (t) => {
  const aborted: string[] = [];
  const { adapter, options } = await setup(t, pendingApprover(aborted));
  const session = await adapter.startSession(options);
  t.after(() => session.close());
  const collected = collect(session.send("hang_confirm"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await session.interrupt();
  assert.equal((await collected).at(-1)?.type, "end");
  assert.deepEqual(aborted, ["Allow bash?"]);
  assert.deepEqual((await stateOf(session)).uiResponses, [
    { type: "extension_ui_response", id: "ui-2", cancelled: true },
  ]);
});

test("closing withdraws the web approval and stops the process", async (t) => {
  const aborted: string[] = [];
  const { adapter, options } = await setup(t, pendingApprover(aborted));
  const session = await adapter.startSession(options);
  const collected = collect(session.send("hang_confirm"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await session.close();
  assert.deepEqual(aborted, ["Allow bash?"]);
  assert.equal(session.alive, false);
  assert.deepEqual((await collected).at(-1), { type: "end", outcome: "failed", text: "", error: "Pi 进程已退出。" });
});

test("unsupported dialogs are cancelled and notifications become notes", async (t) => {
  const { adapter, options, asks } = await setup(t);
  const session = await adapter.startSession(options);
  t.after(() => session.close());
  const events = await collect(session.send("dialogs"));
  assert.deepEqual(asks, []);
  assert.deepEqual(activities(events), [
    { kind: "denied", toolName: "Pick one", message: "lanting 不支持这类 Pi 扩展对话框。" },
    { kind: "note", text: "heads up" },
  ]);
  assert.deepEqual(events.at(-1), {
    type: "end",
    outcome: "completed",
    text: "select:" + JSON.stringify({ type: "extension_ui_response", id: "ui-3", cancelled: true }),
  });
});

test("the catalog lists provider/model ids with thinking levels and both permission options", async (t) => {
  const { adapter, options } = await setup(t);
  const models = await adapter.features.models!(options.cwd);
  assert.deepEqual(models.map((model) => [model.id, model.label, model.efforts]), [
    ["deepseek/deepseek-flash", "DeepSeek V4.1 Flash", ["off", "low", "high", "max"]],
    ["router/vendor/plain-v1", "vendor/plain-v1", []],
  ]);
  assert.deepEqual((await adapter.features.permissions!(options.cwd)).map((item) => [item.id, item.danger ?? false]), [
    ["ask", false],
    ["always-approve", true],
  ]);
});

test("compact calls Pi's compact command", async (t) => {
  const { adapter, options } = await setup(t);
  const session = await adapter.startSession(options);
  t.after(() => session.close());
  await adapter.features.compact!(session);
  assert.equal((await stateOf(session)).compacted, 1);
});
