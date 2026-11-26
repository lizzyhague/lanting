import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentEvent, ApprovalAsk, SessionOptions } from "../types.ts";
import type { UsagePart, UsageRequest } from "../../features/index.ts";
import { GrokAdapter, toolActivity, usageParts } from "./adapter.ts";

/** Fake `grok agent stdio`: in one round it says an interim line, calls a tool needing approval, then gives the final answer. */
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
  await assert.rejects(adapter.features.deleteSession!("../grok-2", grokHome), /Malformed/u);
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

const WEEK = {
  type: "USAGE_PERIOD_TYPE_WEEKLY",
  start: "2026-06-01T00:00:00+00:00",
  end: "2026-06-08T00:00:00+00:00",
};

function weeklyQuota(left: number | null): UsagePart[] {
  return [{ kind: "quota", window: { minutes: 10080 }, left, resetsAt: "2026-06-08T00:00:00.000Z" }];
}

test("Grok billing uses the explicit percentage, including zero, ahead of legacy amounts", () => {
  for (const [used, left] of [[2, 98], [0, 100], [100, 0], [120, 0], [-5, 100]] as const) {
    assert.deepEqual(usageParts({ config: {
      creditUsagePercent: used, currentPeriod: WEEK, monthlyLimit: { val: 100 }, used: { val: 50 },
    } }), weeklyQuota(left));
  }
});

test("a Grok period without a valid percentage keeps usage unknown", () => {
  for (const used of [undefined, null, "2", NaN, Infinity]) {
    assert.deepEqual(usageParts({ config: { currentPeriod: WEEK, creditUsagePercent: used } }), weeklyQuota(null));
  }
  assert.deepEqual(usageParts({ config: { billingPeriodEnd: WEEK.end } }), [{
    kind: "quota", window: { name: "Grok" }, left: null, resetsAt: "2026-06-08T00:00:00.000Z",
  }]);
});

test("Grok billing falls back to legacy monthly usage and period bounds", () => {
  const config = {
    monthlyLimit: { val: 10000 }, used: { val: 2500 },
    billingPeriodStart: "2026-06-01T00:00:00Z", billingPeriodEnd: "2026-07-01T00:00:00Z",
  };
  assert.deepEqual(usageParts({ config }), [{
    kind: "quota", window: { minutes: 43200 }, left: 75, resetsAt: "2026-07-01T00:00:00.000Z",
  }]);
  assert.deepEqual(usageParts({ config: { ...config, currentPeriod: WEEK } }), weeklyQuota(75));
  assert.deepEqual(usageParts({ config: { ...config, used: { val: 0 }, currentPeriod: WEEK } }), weeklyQuota(100));
  for (const limit of [0, -1, "10000", Infinity]) {
    assert.deepEqual(usageParts({ config: { ...config, monthlyLimit: { val: limit }, currentPeriod: WEEK } }), weeklyQuota(null));
  }
});

test("Grok billing selects window labels without inventing reset dates", () => {
  assert.deepEqual(usageParts({ config: {
    creditUsagePercent: 20, currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY" },
  } }), [{ kind: "quota", window: { name: "Monthly" }, left: 80 }]);
  assert.deepEqual(usageParts({ config: {
    creditUsagePercent: 20, currentPeriod: { start: "2026-06-01T00:00:00Z", end: "2026-06-01T05:00:00Z" },
  } }), [{ kind: "quota", window: { minutes: 300 }, left: 80, resetsAt: "2026-06-01T05:00:00.000Z" }]);
  assert.deepEqual(usageParts({ config: {
    creditUsagePercent: 20, currentPeriod: { start: WEEK.end, end: "invalid" }, billingPeriodEnd: WEEK.start,
  } }), [{ kind: "quota", window: { name: "Grok" }, left: 80, resetsAt: "2026-06-01T00:00:00.000Z" }]);
});

test("missing or malformed Grok billing data is unavailable", () => {
  for (const billing of [
    null, [], {}, { config: null }, { config: [] }, { config: "invalid" }, { config: {} },
    { config: { currentPeriod: { type: "INVALID", start: "invalid", end: "invalid" } } },
    { config: { monthlyLimit: { val: 0 }, used: { val: 0 } } },
    { config: { creditUsagePercent: "2" } },
  ]) assert.deepEqual(usageParts(billing), [{ kind: "unavailable" }]);
});

/** Account-only ACP fixture: unexpected session or prompt calls fail rather than touching a real CLI. */
const FAKE_BILLING_GROK = `#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
assert.deepEqual(process.argv.slice(2), ["agent", "--no-leader", "stdio"]);
appendFileSync("starts", JSON.stringify({ pid: process.pid }) + "\\n");
const mode = readFileSync("mode", "utf8");
const send = (message) => console.log(JSON.stringify({ jsonrpc: "2.0", ...message }));
let initialized = false;
let helper;
process.on("SIGTERM", () => {
  if (helper && helper.exitCode === null && helper.signalCode === null) helper.once("exit", () => process.exit(0));
  else process.exit(0);
});
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  appendFileSync("requests", JSON.stringify({ pid: process.pid, method: m.method, params: m.params }) + "\\n");
  if (m.method === "initialize") {
    if (mode === "init-hang") { setInterval(() => {}, 1000); return; }
    initialized = true;
    send({ id: m.id, result: {} });
  } else if (m.method === "_x.ai/billing") {
    assert.equal(initialized, true);
    assert.deepEqual(m.params, {});
    if (mode === "error") { send({ id: m.id, error: { code: -32601, message: "Method not found" } }); return; }
    if (mode === "exit") { process.exit(1); }
    if (mode === "hang") {
      helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      writeFileSync("helper.pid", String(helper.pid));
      setInterval(() => {}, 1000);
      return;
    }
    setTimeout(() => send({ id: m.id, result: JSON.parse(readFileSync("billing.json", "utf8")) }), 30);
  } else send({ id: m.id, error: { code: -32601, message: "Unexpected method" } });
});
`;

async function readStarts(cwd: string): Promise<Array<{ pid: number }>> {
  const text = await readFile(path.join(cwd, "starts"), "utf8").catch(() => "");
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function setupBilling(t: test.TestContext, mode = "success", usageTimeoutMs = 2000) {
  const cwd = await mkdtemp(path.join(tmpdir(), "lanting-grok-billing-"));
  t.after(async () => {
    for (const { pid } of await readStarts(cwd)) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* Already closed. */ }
    }
    await rm(cwd, { recursive: true, force: true });
  });
  const executable = path.join(cwd, "grok");
  await writeFile(executable, FAKE_BILLING_GROK);
  await chmod(executable, 0o700);
  await writeFile(path.join(cwd, "mode"), mode);
  await writeFile(path.join(cwd, "billing.json"), JSON.stringify({ config: { creditUsagePercent: 2, currentPeriod: WEEK } }));
  const adapter = new GrokAdapter({ executable, usageTimeoutMs });
  const usage = (useProxy?: boolean) => adapter.features.usage!({
    nativeId: "existing-chat", cwd, reason: "view", ...(useProxy === undefined ? {} : { useProxy }),
    session: async () => { throw new Error("Billing must not open a chat session."); },
  } satisfies UsageRequest);
  return { adapter, cwd, usage };
}

test("Grok account usage initializes ACP, reads billing, and closes without opening a session", async (t) => {
  const { cwd, usage } = await setupBilling(t);
  assert.deepEqual(await usage(), weeklyQuota(98));
  const requests = (await readFile(path.join(cwd, "requests"), "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(requests.map((request) => request.method), ["initialize", "_x.ai/billing"]);
  const starts = await readStarts(cwd);
  assert.equal(starts.length, 1);
  assert.equal(processExists(starts[0]!.pid), false);
  await writeFile(path.join(cwd, "billing.json"), JSON.stringify({ config: { currentPeriod: WEEK } }));
  assert.deepEqual(await usage(), weeklyQuota(null));
  assert.equal((await readStarts(cwd)).length, 2);
});

test("concurrent Grok account queries merge by proxy channel, with fresh reads after completion", async (t) => {
  const { cwd, usage } = await setupBilling(t);
  assert.deepEqual(await Promise.all([usage(), usage(true), usage(false), usage(false)]),
    [weeklyQuota(98), weeklyQuota(98), weeklyQuota(98), weeklyQuota(98)]);
  assert.equal((await readStarts(cwd)).length, 2);
  await writeFile(path.join(cwd, "billing.json"), JSON.stringify({ config: { creditUsagePercent: 25, currentPeriod: WEEK } }));
  assert.deepEqual(await usage(), weeklyQuota(75));
  assert.equal((await readStarts(cwd)).length, 3);
});

test("Grok billing RPC errors and early exits are unavailable and allow the next query to recover", async (t) => {
  const { cwd, usage } = await setupBilling(t, "error");
  assert.deepEqual(await usage(), [{ kind: "unavailable" }]);
  await writeFile(path.join(cwd, "mode"), "exit");
  assert.deepEqual(await usage(), [{ kind: "unavailable" }]);
  await writeFile(path.join(cwd, "mode"), "success");
  assert.deepEqual(await usage(), weeklyQuota(98));
  const starts = await readStarts(cwd);
  assert.equal(starts.length, 3);
  assert.ok(starts.every(({ pid }) => !processExists(pid)));
});

test("a hung Grok billing query times out, reaps its process group, and permits a fresh query", async (t) => {
  const { cwd, usage } = await setupBilling(t, "hang", 500);
  const started = Date.now();
  assert.deepEqual(await usage(), [{ kind: "unavailable" }]);
  assert.ok(Date.now() - started < 3000);
  const helperPid = Number(await readFile(path.join(cwd, "helper.pid"), "utf8"));
  assert.equal(processExists(helperPid), false);
  assert.ok((await readStarts(cwd)).every(({ pid }) => !processExists(pid)));
  await writeFile(path.join(cwd, "mode"), "success");
  assert.deepEqual(await usage(), weeklyQuota(98));
});

test("the Grok quota deadline also covers initialization", async (t) => {
  const { cwd, usage } = await setupBilling(t, "init-hang", 500);
  const started = Date.now();
  assert.deepEqual(await usage(), [{ kind: "unavailable" }]);
  assert.ok(Date.now() - started < 3000);
  assert.ok((await readStarts(cwd)).every(({ pid }) => !processExists(pid)));
});

test("a missing Grok executable is unavailable rather than leaving a pending query", async (t) => {
  const { adapter, options } = await setup(t);
  await rm(path.join(options.cwd, "grok"));
  assert.deepEqual(await adapter.features.usage!({
    nativeId: "existing-chat", cwd: options.cwd, reason: "view", session: async () => null,
  }), [{ kind: "unavailable" }]);
});
