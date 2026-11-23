import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { groupExists } from "../../platform/process-group.ts";
import {
  AUTH_REQUIRED_CODE,
  OpenCodeAcpClient,
  OpenCodeRpcError,
  type OpenCodePermissionRequest,
  type OpenCodeUpdate,
} from "./acp-client.ts";

const FAKE_OPENCODE = `#!/usr/bin/env node
import { spawn } from "node:child_process";
const out = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const reply = (id, result) => out({ jsonrpc: "2.0", id, result });
const update = (update) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-1", update } });
let buffer = "";
let held = null;
const answers = [];
if (process.argv[2] !== "acp") process.exit(2);
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
process.stdin.on("end", () => {
  if (process.env.FAKE_IGNORE_EOF !== "1") process.exit(0);
});
if (process.env.FAKE_IGNORE_EOF === "1") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}
function handle(message) {
  if (message.method === undefined || message.id === undefined) {
    answers.push(message);
    return;
  }
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      return reply(id, { protocolVersion: 1, echo: params });
    case "session/new":
      return reply(id, params.cwd === "/no-id" ? {} : {
        sessionId: "s-1",
        configOptions: [{ id: "model", currentValue: "opencode/big-pickle" }],
        modes: { currentModeId: "default" },
      });
    case "session/resume":
      return reply(id, { configOptions: [{ id: "effort", currentValue: "max" }], modes: { currentModeId: "default" } });
    case "session/set_config_option":
      return reply(id, { configOptions: [{ id: params.configId, currentValue: params.value }] });
    case "session/delete":
      return reply(id, {});
    case "session/prompt":
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: params.prompt[0].text } });
      return reply(id, { stopReason: "end_turn" });
    case "split": {
      const text = JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-1", update: { text: "a\\u2028b\\u2029c" } } });
      process.stdout.write(text.slice(0, 10));
      setTimeout(() => process.stdout.write(text.slice(10, 30)), 20);
      setTimeout(() => { process.stdout.write(text.slice(30) + "\\r\\n"); reply(id, {}); }, 40);
      return;
    }
    case "slow":
      held = id;
      return;
    case "fast":
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
      reply(id, { order: "fast" });
      reply(held, { order: "slow" });
      return;
    case "route":
      out({ jsonrpc: "2.0", id: 901, method: "session/request_permission", params: {
        sessionId: "s-1",
        toolCall: { toolCallId: "child-1:t-1", title: "Shell", _meta: { "opencode/child-session": { id: "child-1", parentID: "s-1" } } },
        options: [
          { optionId: "approve_once", name: "Approve once", kind: "allow_once" },
          { optionId: "approve_always", name: "Approve for this session", kind: "allow_always" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
          { name: "broken" },
        ],
      } });
      out({ jsonrpc: "2.0", id: "q-1", method: "fs/read_text_file", params: { path: "/x" } });
      out({ jsonrpc: "2.0", method: "opencode/something_new", params: {} });
      return reply(id, {});
    case "answers":
      return reply(id, answers);
    case "noise":
      process.stdout.write("not json\\n");
      process.stdout.write("[1,2]\\n");
      process.stderr.write("something on stderr\\n");
      reply(4242, {});
      out({ jsonrpc: "2.0", id, error: { code: -32000, message: "Authentication required", data: { action: "login" } } });
      return;
    case "crash":
      process.stderr.write("fatal: opencode exploded\\n");
      process.exit(3);
      return;
    case "spawn_child": {
      const child = spawn("sleep", ["30"], { stdio: "ignore" });
      return reply(id, { pid: child.pid });
    }
    case "hang":
      return;
    case "disconnect":
      process.stdout.end();
      setInterval(() => {}, 1000);
      return;
    default:
      return reply(id, {});
  }
}
`;

async function setup(t: test.TestContext, env: Record<string, string> = {}): Promise<OpenCodeAcpClient> {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-opencode-acp-"));
  const executable = path.join(directory, "fake-opencode.mjs");
  await writeFile(executable, FAKE_OPENCODE, "utf8");
  await chmod(executable, 0o700);
  const client = new OpenCodeAcpClient({ executable, cwd: directory, env: { ...process.env, ...env } });
  t.after(async () => {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  });
  return client;
}

function collect<T>(client: OpenCodeAcpClient, name: string): T[] {
  const items: T[] = [];
  client.on(name, (item: T) => items.push(item));
  return items;
}

test("runs OpenCode's ACP session methods and exposes session configuration", async (t) => {
  const client = await setup(t);
  const updates = collect<OpenCodeUpdate>(client, "update");
  const init = await client.initialize();
  assert.deepEqual((init.echo as Record<string, unknown>).clientCapabilities, {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  });
  assert.deepEqual(await client.sessionNew("/work"), {
    sessionId: "s-1",
    configOptions: [{ id: "model", currentValue: "opencode/big-pickle" }],
    modes: { currentModeId: "default" },
  });
  assert.deepEqual(await client.sessionResume("s-1", "/work"), {
    sessionId: "s-1",
    configOptions: [{ id: "effort", currentValue: "max" }],
    modes: { currentModeId: "default" },
  });
  assert.deepEqual(await client.sessionSetConfigOption("s-1", "effort", "low"), {
    configOptions: [{ id: "effort", currentValue: "low" }],
  });
  assert.deepEqual(await client.sessionPrompt("s-1", "hello"), { stopReason: "end_turn" });
  assert.equal(updates.at(-1)?.update.sessionUpdate, "agent_message_chunk");
  await client.sessionDelete("s-1");
});

test("rejects a session result without a session id", async (t) => {
  const client = await setup(t);
  await assert.rejects(client.sessionNew("/no-id"), /OpenCode session\/new returned no session id/);
});

test("splits stdout only on LF and matches responses by id", async (t) => {
  const client = await setup(t);
  const updates = collect<OpenCodeUpdate>(client, "update");
  await client.request("split", {});
  assert.deepEqual(updates, [{ sessionId: "s-1", update: { text: "a b c" } }]);
  const slow = client.request("slow", {});
  const fast = client.request("fast", {});
  assert.deepEqual(await fast, { order: "fast" });
  assert.deepEqual(await slow, { order: "slow" });
});

test("routes permissions and rejects unsupported reverse requests", async (t) => {
  const client = await setup(t);
  const permissions = collect<OpenCodePermissionRequest>(client, "permission");
  const diagnostics = collect<string>(client, "diagnostic");
  await client.request("route", {});
  assert.deepEqual(permissions[0]?.toolCall._meta, { "opencode/child-session": { id: "child-1", parentID: "s-1" } });
  assert.deepEqual(permissions[0]?.options.map(({ optionId, kind }) => ({ optionId, kind })), [
    { optionId: "approve_once", kind: "allow_once" },
    { optionId: "approve_always", kind: "allow_always" },
    { optionId: "reject", kind: "reject_once" },
  ]);
  client.respondPermission(901, { outcome: "selected", optionId: "approve_once" });
  assert.ok(diagnostics.some((text) => text.includes("Unhandled OpenCode notification") && text.includes("opencode/something_new")));
  const answers = await client.request("answers", {}) as Array<Record<string, unknown>>;
  assert.deepEqual(answers, [
    { jsonrpc: "2.0", id: "q-1", error: { code: -32601, message: "Method not found: fs/read_text_file" } },
    { jsonrpc: "2.0", id: 901, result: { outcome: { outcome: "selected", optionId: "approve_once" } } },
  ]);
});

test("sends session/cancel as a notification", async (t) => {
  const client = await setup(t);
  client.sessionCancel("s-1");
  assert.deepEqual(await client.request("answers", {}), [
    { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s-1" } },
  ]);
});

test("keeps error details and reports malformed protocol output", async (t) => {
  const client = await setup(t);
  const diagnostics = collect<string>(client, "diagnostic");
  const rejected = assert.rejects(client.request("noise", {}), (error: unknown) => {
    assert.ok(error instanceof OpenCodeRpcError);
    assert.equal(error.code, AUTH_REQUIRED_CODE);
    assert.deepEqual(error.data, { action: "login" });
    return true;
  });
  await rejected;
  assert.ok(diagnostics.some((text) => text.includes("OpenCode stdout is not JSON: not json")));
  assert.ok(diagnostics.some((text) => text.includes("OpenCode stdout is not a JSON object: [1,2]")));
  assert.ok(diagnostics.some((text) => text.includes("OpenCode response matches no request") && text.includes("4242")));
  while (!diagnostics.some((text) => text.includes("OpenCode stderr: something on stderr"))) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
});

test("rejects pending requests when OpenCode exits", async (t) => {
  const client = await setup(t);
  const pending = assert.rejects(client.request("hang", {}), /The OpenCode process exited \(3\): fatal: opencode exploded/);
  await assert.rejects(client.request("crash", {}), /The OpenCode process exited \(3\): fatal: opencode exploded/);
  await pending;
  while (client.alive) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(client.alive, false);
});

test("rejects pending and subsequent requests if stdout closes while the process remains alive", async (t) => {
  const client = await setup(t);
  await assert.rejects(client.request("disconnect", {}), /OpenCode stdout closed/);
  await assert.rejects(client.request("ping", {}), /closed or disconnected/);
});

test("reports a missing executable", async () => {
  const client = new OpenCodeAcpClient({ executable: "/nonexistent/opencode", cwd: tmpdir() });
  await assert.rejects(client.initialize(), /Cannot start OpenCode/);
  await client.close();
});

test("close rejects pending work and reaps the process group", async (t) => {
  const client = await setup(t);
  const { pid: childPid } = await client.request("spawn_child", {}) as { pid: number };
  const pending = assert.rejects(client.request("hang", {}), /OpenCode is closed/);
  const groupId = client.pid!;
  await client.close();
  await pending;
  assert.equal(client.alive, false);
  assert.equal(groupExists(groupId), false);
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
});

test("close escalates when OpenCode ignores stdin EOF", async (t) => {
  const client = await setup(t, { FAKE_IGNORE_EOF: "1" });
  await client.request("ping", {});
  const groupId = client.pid!;
  await client.close();
  assert.equal(client.alive, false);
  assert.equal(groupExists(groupId), false);
});
