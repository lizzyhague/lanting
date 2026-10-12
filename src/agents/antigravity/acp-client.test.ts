import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { groupExists } from "../../platform/process-group.ts";
import {
  AntigravityAcpClient,
  AntigravityRpcError,
  AUTH_REQUIRED_CODE,
  type AntigravityPermissionRequest,
  type AntigravityUpdate,
} from "./acp-client.ts";

/** 假的 `agy_acp_server.par`：按 LF 读 JSON-RPC，行为由请求方法决定。 */
const FAKE_SERVER = `#!/usr/bin/env node
import { spawn } from "node:child_process";
const out = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const reply = (id, result) => out({ jsonrpc: "2.0", id, result });
const update = (update) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-1", update } });
let buffer = "";
let held = null;
const answers = [];
if (!process.argv.includes("--uid=")) {
  process.stderr.write("Group nobody not found\\n");
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
    // 客户端对服务端请求的回复。
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
    case "session/new":
      return reply(id, params.cwd === "/no-id" ? {} : { sessionId: "s-1", echo: params });
    case "session/resume":
      return reply(id, { modes: { currentModeId: "default" }, echo: params });
    case "session/prompt":
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: params.prompt[0].text } });
      return reply(id, { stopReason: "end_turn" });
    case "split": {
      // 一条记录分三次写出，正文里带 U+2028、U+2029 和 CRLF 结尾。
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
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
          { name: "broken" },
        ],
      } });
      out({ jsonrpc: "2.0", id: "q-1", method: "fs/read_text_file", params: { path: "/x" } });
      out({ jsonrpc: "2.0", method: "_antigravity/something_new", params: {} });
      return reply(id, {});
    case "answers":
      return reply(id, answers);
    case "noise":
      process.stdout.write("not json\\n");
      process.stdout.write("[1,2]\\n");
      process.stderr.write("something on stderr\\n");
      reply(4242, {});
      out({ jsonrpc: "2.0", id, error: { code: -32000, message: "Authentication required", data: { message: "sign in" } } });
      return;
    case "crash":
      process.stderr.write("fatal: server exploded\\n");
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

async function setup(t: test.TestContext, env: Record<string, string> = {}): Promise<AntigravityAcpClient> {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-antigravity-acp-"));
  const executable = path.join(directory, "fake-antigravity.mjs");
  await writeFile(executable, FAKE_SERVER, "utf8");
  await chmod(executable, 0o700);
  const client = new AntigravityAcpClient({ executable, cwd: directory, env: { ...process.env, ...env } });
  t.after(async () => {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  });
  return client;
}

function collect<T>(client: AntigravityAcpClient, name: string): T[] {
  const items: T[] = [];
  client.on(name, (item: T) => items.push(item));
  return items;
}

test("starts with --uid= and runs the handshake without authenticate", async (t) => {
  const client = await setup(t);
  const updates = collect<AntigravityUpdate>(client, "update");
  const init = await client.initialize();
  assert.deepEqual((init.echo as Record<string, unknown>).clientCapabilities, {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  });
  assert.equal(await client.sessionNew("/work"), "s-1");
  const resumed = await client.sessionResume("s-1", "/work");
  assert.deepEqual(resumed.echo, { sessionId: "s-1", cwd: "/work", mcpServers: [] });
  await client.sessionSetMode("s-1", "default");
  assert.deepEqual(await client.sessionPrompt("s-1", "hello"), { stopReason: "end_turn" });
  assert.deepEqual(updates.map((item) => item.update.sessionUpdate), ["agent_message_chunk"]);
  assert.equal(updates[0]?.sessionId, "s-1");
});

test("rejects a session/new result without a session id", async (t) => {
  const client = await setup(t);
  await assert.rejects(client.sessionNew("/no-id"), /Antigravity 没有返回 session id/);
});

test("splits stdout only on LF and reassembles chunked records", async (t) => {
  const client = await setup(t);
  const updates = collect<AntigravityUpdate>(client, "update");
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

test("routes permission requests and answers unknown methods", async (t) => {
  const client = await setup(t);
  const permissions = collect<AntigravityPermissionRequest>(client, "permission");
  const updates = collect<AntigravityUpdate>(client, "update");
  const diagnostics = collect<string>(client, "diagnostic");
  await client.request("route", {});

  assert.equal(permissions.length, 1);
  assert.equal(permissions[0]?.rpcId, 901);
  assert.equal(permissions[0]?.sessionId, "s-1");
  assert.deepEqual(permissions[0]?.toolCall, { toolCallId: "t-1", title: "touch x" });
  assert.deepEqual(permissions[0]?.options.map((option) => option.optionId), ["allow", "deny"]);
  client.respondPermission(901, { outcome: "selected", optionId: "allow" });

  assert.deepEqual(updates, []);
  assert.ok(diagnostics.some((text) => text.includes("Antigravity 通知未处理") && text.includes("_antigravity/something_new")));

  const answers = await client.request("answers", {}) as Array<Record<string, unknown>>;
  assert.deepEqual(answers, [
    { jsonrpc: "2.0", id: "q-1", error: { code: -32601, message: "Method not found: fs/read_text_file" } },
    { jsonrpc: "2.0", id: 901, result: { outcome: { outcome: "selected", optionId: "allow" } } },
  ]);
});

test("sends session/cancel as a notification", async (t) => {
  const client = await setup(t);
  client.sessionCancel("s-1");
  const answers = await client.request("answers", {});
  assert.deepEqual(answers, [{ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s-1" } }]);
});

test("reports non-JSON stdout, stderr, stray responses and errors with their code", async (t) => {
  const client = await setup(t);
  const diagnostics = collect<string>(client, "diagnostic");
  await assert.rejects(client.request("noise", {}), (error: unknown) => {
    assert.ok(error instanceof AntigravityRpcError);
    assert.equal(error.message, "Antigravity noise 失败：Authentication required");
    assert.equal(error.code, AUTH_REQUIRED_CODE);
    assert.deepEqual(error.data, { message: "sign in" });
    return true;
  });
  assert.ok(diagnostics.some((text) => text.includes("Antigravity stdout 不是 JSON：not json")));
  assert.ok(diagnostics.some((text) => text.includes("Antigravity stdout 不是 JSON 对象：[1,2]")));
  assert.ok(diagnostics.some((text) => text.includes("Antigravity 响应对不上请求") && text.includes("4242")));
  // stderr 和 stdout 是两条管道，到达顺序不保证。
  while (!diagnostics.some((text) => text.includes("Antigravity stderr：something on stderr"))) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
});

test("rejects pending requests with the exit status and stderr on crash", async (t) => {
  const client = await setup(t);
  const exits = collect<unknown>(client, "exit");
  const pending = client.request("hang", {});
  const pendingRejected = assert.rejects(pending, /Antigravity 进程已退出（3）/);
  await assert.rejects(client.request("crash", {}), /Antigravity 进程已退出（3）：fatal: server exploded/);
  await pendingRejected;
  assert.equal(client.alive, false);
  assert.deepEqual(exits, [{ code: 3, signal: null }]);
  await assert.rejects(client.request("ping", {}), /Antigravity 进程已退出/);
});

test("reports a missing executable instead of throwing", async () => {
  const client = new AntigravityAcpClient({ executable: "/nonexistent/agy_acp_server.par", cwd: tmpdir() });
  await assert.rejects(client.initialize(), /无法启动 Antigravity/);
  await client.close();
  assert.equal(client.alive, false);
});

test("close ends pending requests and reaps the whole process group", async (t) => {
  const client = await setup(t);
  const { pid: childPid } = await client.request("spawn_child", {}) as { pid: number };
  const pending = assert.rejects(client.request("hang", {}), /Antigravity 已经关闭/);
  const groupId = client.pid!;
  await client.close();
  await pending;
  assert.equal(client.alive, false);
  assert.equal(groupExists(groupId), false);
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
  await assert.rejects(client.request("ping", {}), /Antigravity 已经关闭/);
});

test("close escalates to signals when the server ignores stdin EOF", async (t) => {
  const client = await setup(t, { FAKE_IGNORE_EOF: "1" });
  await client.request("ping", {});
  const groupId = client.pid!;
  await client.close();
  assert.equal(client.alive, false);
  assert.equal(groupExists(groupId), false);
});
