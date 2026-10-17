import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { groupExists } from "../../platform/process-group.ts";
import {
  CursorAcpClient,
  type CursorBlockingRequest,
  type CursorNotice,
  type CursorPermissionRequest,
  type CursorUpdate,
} from "./acp-client.ts";

/** Fake `agent acp`: reads LF-delimited JSON-RPC; behavior depends on the request method. */
const FAKE_CURSOR = `#!/usr/bin/env node
import { spawn } from "node:child_process";
const out = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const reply = (id, result) => out({ jsonrpc: "2.0", id, result });
const update = (update) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-1", update } });
let buffer = "";
let held = null;
const answers = [];
if (!process.argv.includes("acp")) {
  process.stderr.write("missing acp argument\\n");
  process.exit(2);
}
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
  if (message.method === undefined) {
    // The client's reply to a server request.
    answers.push(message);
    return;
  }
  if (message.id === undefined) {
    answers.push(message);
    return;
  }
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      return reply(id, { protocolVersion: 1, echo: params });
    case "authenticate":
      return reply(id, { echo: params });
    case "session/new":
      return reply(id, params.cwd === "/no-id" ? {} : { sessionId: "s-1", echo: params });
    case "session/load":
      update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "old" } });
      return reply(id, { modes: { currentModeId: "agent" }, echo: params });
    case "session/prompt":
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: params.prompt[0].text } });
      return reply(id, { stopReason: "end_turn" });
    case "split": {
      // One record written in three pieces, with U+2028, U+2029 in the text and a CRLF ending.
      const text = JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-1", update: { text: "a\\u2028b\\u2029c" } } });
      process.stdout.write(text.slice(0, 10));
      setTimeout(() => process.stdout.write(text.slice(10, 30)), 20);
      setTimeout(() => {
        process.stdout.write(text.slice(30) + "\\r\\n");
        reply(id, {});
      }, 40);
      return;
    }
    case "slow":
      held = id;
      return;
    case "fast":
      update({ sessionUpdate: "agent_thought_chunk" });
      reply(id, { order: "fast" });
      reply(held, { order: "slow" });
      return;
    case "route":
      out({ jsonrpc: "2.0", id: 901, method: "session/request_permission", params: {
        sessionId: "s-1",
        toolCall: { toolCallId: "t-1", title: "touch x" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          { name: "broken" },
        ],
      } });
      out({ jsonrpc: "2.0", id: "q-1", method: "cursor/ask_question", params: { question: "Which?" } });
      out({ jsonrpc: "2.0", id: 903, method: "cursor/create_plan", params: { name: "Plan" } });
      out({ jsonrpc: "2.0", id: 904, method: "cursor/unknown_request", params: {} });
      out({ jsonrpc: "2.0", method: "cursor/update_todos", params: { todos: [] } });
      out({ jsonrpc: "2.0", method: "cursor/task", params: { id: "k" } });
      out({ jsonrpc: "2.0", method: "cursor/something_new", params: {} });
      return reply(id, {});
    case "answers":
      return reply(id, answers);
    case "noise":
      process.stdout.write("not json\\n");
      process.stdout.write("[1,2]\\n");
      process.stderr.write("something on stderr\\n");
      reply(4242, {});
      out({ jsonrpc: "2.0", id, error: { code: -32000, message: "Upstream refused" } });
      return;
    case "crash":
      process.stderr.write("fatal: cursor exploded\\n");
      process.exit(3);
      return;
    case "spawn_child": {
      const child = spawn("sleep", ["30"], { stdio: "ignore" });
      return reply(id, { pid: child.pid });
    }
    case "hang":
      return;
    default:
      return reply(id, {});
  }
}
`;

async function setup(t: test.TestContext, env: Record<string, string> = {}): Promise<CursorAcpClient> {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-cursor-acp-"));
  const executable = path.join(directory, "fake-cursor.mjs");
  await writeFile(executable, FAKE_CURSOR, "utf8");
  await chmod(executable, 0o700);
  const client = new CursorAcpClient({ executable, cwd: directory, env: { ...process.env, ...env } });
  t.after(async () => {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  });
  return client;
}

function collect<T>(client: CursorAcpClient, name: string): T[] {
  const items: T[] = [];
  client.on(name, (item: T) => items.push(item));
  return items;
}

test("runs the handshake with Cursor's own methods", async (t) => {
  const client = await setup(t);
  const updates = collect<CursorUpdate>(client, "update");
  const init = await client.initialize();
  assert.deepEqual((init.echo as Record<string, unknown>).clientCapabilities, {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  });
  await client.authenticate();
  assert.equal(await client.sessionNew("/work"), "s-1");
  const loaded = await client.sessionLoad("s-1", "/work");
  assert.deepEqual(loaded.echo, { sessionId: "s-1", cwd: "/work", mcpServers: [] });
  assert.deepEqual(await client.sessionPrompt("s-1", "hello"), { stopReason: "end_turn" });
  assert.deepEqual(updates.map((item) => item.update.sessionUpdate), ["user_message_chunk", "agent_message_chunk"]);
  assert.equal(updates[0]?.sessionId, "s-1");
});

test("rejects a session/new result without a session id", async (t) => {
  const client = await setup(t);
  await assert.rejects(client.sessionNew("/no-id"), /Cursor returned no session id/);
});

test("splits stdout only on LF and reassembles chunked records", async (t) => {
  const client = await setup(t);
  const updates = collect<CursorUpdate>(client, "update");
  await client.request("split", {});
  assert.deepEqual(updates, [{ sessionId: "s-1", update: { text: "a b c" } }]);
});

test("matches responses by id regardless of order", async (t) => {
  const client = await setup(t);
  const slow = client.request("slow", {});
  const fast = client.request("fast", {});
  assert.deepEqual(await fast, { order: "fast" });
  assert.deepEqual(await slow, { order: "slow" });
});

test("routes permission, blocking requests, notices and unknown methods", async (t) => {
  const client = await setup(t);
  const permissions = collect<CursorPermissionRequest>(client, "permission");
  const blocking = collect<CursorBlockingRequest>(client, "blocking");
  const notices = collect<CursorNotice>(client, "notice");
  const updates = collect<CursorUpdate>(client, "update");
  const diagnostics = collect<string>(client, "diagnostic");
  await client.request("route", {});

  assert.equal(permissions.length, 1);
  assert.equal(permissions[0]?.rpcId, 901);
  assert.equal(permissions[0]?.sessionId, "s-1");
  assert.deepEqual(permissions[0]?.toolCall, { toolCallId: "t-1", title: "touch x" });
  assert.deepEqual(permissions[0]?.options.map((option) => option.optionId), ["allow-once", "reject-once"]);
  client.respondPermission(901, { outcome: "selected", optionId: "allow-once" });

  assert.deepEqual(blocking, [
    { method: "cursor/ask_question", params: { question: "Which?" } },
    { method: "cursor/create_plan", params: { name: "Plan" } },
  ]);
  assert.deepEqual(notices, [
    { method: "cursor/update_todos", params: { todos: [] } },
    { method: "cursor/task", params: { id: "k" } },
  ]);
  assert.deepEqual(updates, []);
  assert.ok(diagnostics.some((text) => text.includes("Unhandled Cursor notification") && text.includes("cursor/something_new")));

  const answers = await client.request("answers", {}) as Array<Record<string, unknown>>;
  assert.deepEqual(answers, [
    { jsonrpc: "2.0", id: "q-1", result: { outcome: "cancelled" } },
    { jsonrpc: "2.0", id: 903, result: { outcome: "cancelled" } },
    { jsonrpc: "2.0", id: 904, error: { code: -32601, message: "Method not found: cursor/unknown_request" } },
    { jsonrpc: "2.0", id: 901, result: { outcome: { outcome: "selected", optionId: "allow-once" } } },
  ]);
});

test("sends session/cancel as a notification", async (t) => {
  const client = await setup(t);
  client.sessionCancel("s-1");
  const answers = await client.request("answers", {});
  assert.deepEqual(answers, [{ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s-1" } }]);
});

test("reports non-JSON stdout, stderr, stray responses and errors", async (t) => {
  const client = await setup(t);
  const diagnostics = collect<string>(client, "diagnostic");
  await assert.rejects(client.request("noise", {}), /Cursor noise failed: Upstream refused/);
  assert.ok(diagnostics.some((text) => text.includes("Cursor stdout is not JSON: not json")));
  assert.ok(diagnostics.some((text) => text.includes("Cursor stdout is not a JSON object: [1,2]")));
  assert.ok(diagnostics.some((text) => text.includes("Cursor response matches no request") && text.includes("4242")));
  // stderr and stdout are two pipes; arrival order isn't guaranteed.
  while (!diagnostics.some((text) => text.includes("Cursor stderr：something on stderr"))) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
});

test("rejects pending requests with the exit status and stderr on crash", async (t) => {
  const client = await setup(t);
  const exits = collect<unknown>(client, "exit");
  const pending = client.request("hang", {});
  const pendingRejected = assert.rejects(pending, /The Cursor process exited \(3\)/);
  await assert.rejects(client.request("crash", {}), /The Cursor process exited \(3\): fatal: cursor exploded/);
  await pendingRejected;
  assert.equal(client.alive, false);
  assert.deepEqual(exits, [{ code: 3, signal: null }]);
  await assert.rejects(client.request("ping", {}), /The Cursor process exited/);
});

test("reports a missing executable instead of throwing", async () => {
  const client = new CursorAcpClient({ executable: "/nonexistent/agent", cwd: tmpdir() });
  await assert.rejects(client.initialize(), /Cannot start Cursor/);
  await client.close();
  assert.equal(client.alive, false);
});

test("close ends pending requests and reaps the whole process group", async (t) => {
  const client = await setup(t);
  const { pid: childPid } = await client.request("spawn_child", {}) as { pid: number };
  const pending = assert.rejects(client.request("hang", {}), /Cursor is closed/);
  const groupId = client.pid!;
  await client.close();
  await pending;
  assert.equal(client.alive, false);
  assert.equal(groupExists(groupId), false);
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
  await assert.rejects(client.request("ping", {}), /Cursor is closed/);
});

test("close escalates to signals when Cursor ignores stdin EOF", async (t) => {
  const client = await setup(t, { FAKE_IGNORE_EOF: "1" });
  await client.request("ping", {});
  const groupId = client.pid!;
  await client.close();
  assert.equal(client.alive, false);
  assert.equal(groupExists(groupId), false);
});
