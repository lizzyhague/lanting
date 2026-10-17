import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { groupExists } from "../../platform/process-group.ts";
import { PiRpcClient, type PiEvent, type PiUiRequest } from "./rpc-client.ts";

/** Fake `pi --mode rpc`: reads commands by LF; behavior depends on the command type. */
const FAKE_PI = `#!/usr/bin/env node
import { spawn } from "node:child_process";
const out = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
let buffer = "";
let held = null;
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
function handle(command) {
  switch (command.type) {
    case "split": {
      // One record written in three pieces, with U+2028, U+2029 in the text and a CRLF ending.
      const text = JSON.stringify({ type: "message_update", text: "a\\u2028b\\u2029c" });
      process.stdout.write(text.slice(0, 10));
      setTimeout(() => process.stdout.write(text.slice(10, 20)), 20);
      setTimeout(() => {
        process.stdout.write(text.slice(20) + "\\r\\n");
        out({ id: command.id, type: "response", command: "split", success: true });
      }, 40);
      return;
    }
    case "slow":
      held = command.id;
      return;
    case "fast":
      // First send a session event without an id, then answer the later command first and the earlier one last.
      out({ type: "agent_start" });
      out({ id: command.id, type: "response", command: "fast", success: true, data: { order: "fast" } });
      out({ id: held, type: "response", command: "slow", success: true, data: { order: "slow" } });
      return;
    case "ask":
      out({ type: "extension_ui_request", id: "ui-7f3", method: "confirm", title: "Permission Required", message: "Allow read?" });
      out({ id: command.id, type: "response", command: "ask", success: true });
      return;
    case "extension_ui_response":
      out({ type: "echo", received: command });
      return;
    case "noise":
      process.stdout.write("not json\\n");
      process.stderr.write("something on stderr\\n");
      out({ type: "response", command: "parse", success: false, error: "Failed to parse command" });
      out({ id: command.id, type: "response", command: "noise", success: false, error: "Model not found: x/y" });
      return;
    case "crash":
      process.stderr.write("fatal: provider exploded\\n");
      process.exit(3);
      return;
    case "spawn_child": {
      const child = spawn("sleep", ["30"], { stdio: "ignore" });
      out({ id: command.id, type: "response", command: "spawn_child", success: true, data: { pid: child.pid } });
      return;
    }
    case "hang":
      return;
    default:
      out({ id: command.id, type: "response", command: command.type, success: true, data: {} });
  }
}
`;

async function setup(t: test.TestContext, env: Record<string, string> = {}): Promise<PiRpcClient> {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-pi-rpc-"));
  const executable = path.join(directory, "fake-pi.mjs");
  await writeFile(executable, FAKE_PI, "utf8");
  await chmod(executable, 0o700);
  const client = new PiRpcClient({ executable, cwd: directory, env: { ...process.env, ...env } });
  t.after(async () => {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  });
  return client;
}

function collect<T>(client: PiRpcClient, name: string): T[] {
  const items: T[] = [];
  client.on(name, (item: T) => items.push(item));
  return items;
}

test("splits stdout only on LF and reassembles chunked records", async (t) => {
  const client = await setup(t);
  const events = collect<PiEvent>(client, "event");
  await client.request("split");
  assert.deepEqual(events, [{ type: "message_update", text: "a b c" }]);
});

test("matches responses by id and keeps session events separate", async (t) => {
  const client = await setup(t);
  const events = collect<PiEvent>(client, "event");
  const slow = client.request("slow");
  const fast = client.request("fast");
  assert.deepEqual(await fast, { order: "fast" });
  assert.deepEqual(await slow, { order: "slow" });
  assert.deepEqual(events, [{ type: "agent_start" }]);
});

test("answers an extension UI request with Pi's own id", async (t) => {
  const client = await setup(t);
  const requests = collect<PiUiRequest>(client, "ui");
  const events = collect<PiEvent>(client, "event");
  await client.request("ask");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.id, "ui-7f3");
  assert.equal(requests[0]?.method, "confirm");
  client.respondUi("ui-7f3", { confirmed: true });
  client.respondUi("ui-7f3", { cancelled: true });
  await client.request("ping");
  assert.deepEqual(events.map((event) => event.received), [
    { type: "extension_ui_response", id: "ui-7f3", confirmed: true },
    { type: "extension_ui_response", id: "ui-7f3", cancelled: true },
  ]);
});

test("reports non-JSON stdout, stderr and failed commands", async (t) => {
  const client = await setup(t);
  const diagnostics = collect<string>(client, "diagnostic");
  await assert.rejects(client.request("noise"), /Pi command noise failed: Model not found: x\/y/);
  await client.request("ping");
  assert.ok(diagnostics.some((text) => text.includes("Pi stdout is not JSON: not json")));
  assert.ok(diagnostics.some((text) => text.includes("Pi response matches no command") && text.includes("parse")));
  // stderr and stdout are two pipes; arrival order isn't guaranteed.
  while (!diagnostics.some((text) => text.includes("something on stderr"))) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
});

test("rejects pending commands with the exit status and stderr on crash", async (t) => {
  const client = await setup(t);
  const exits = collect<unknown>(client, "exit");
  const pending = client.request("hang");
  const pendingRejected = assert.rejects(pending, /The Pi process exited \(3\)/);
  await assert.rejects(client.request("crash"), /The Pi process exited \(3\): fatal: provider exploded/);
  await pendingRejected;
  assert.equal(client.alive, false);
  assert.deepEqual(exits, [{ code: 3, signal: null }]);
  await assert.rejects(client.request("ping"), /The Pi process exited/);
});

test("reports a missing executable instead of throwing", async () => {
  const client = new PiRpcClient({ executable: "/nonexistent/pi", cwd: tmpdir() });
  await assert.rejects(client.request("ping"), /Cannot start Pi/);
  await client.close();
  assert.equal(client.alive, false);
});

test("close ends pending commands and reaps the whole process group", async (t) => {
  const client = await setup(t);
  const { pid: childPid } = await client.request("spawn_child") as { pid: number };
  const pending = assert.rejects(client.request("hang"), /Pi is closed/);
  const groupId = client.pid!;
  await client.close();
  await pending;
  assert.equal(client.alive, false);
  assert.equal(groupExists(groupId), false);
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
});

test("close escalates to signals when Pi ignores stdin EOF", async (t) => {
  const client = await setup(t, { FAKE_IGNORE_EOF: "1" });
  await client.request("ping");
  const groupId = client.pid!;
  await client.close();
  assert.equal(client.alive, false);
  assert.equal(groupExists(groupId), false);
});
