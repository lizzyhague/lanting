import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import test from "node:test";

import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

import { ProcessGroup, groupExists } from "./process-group.ts";

/** The argument the SDK passes to `spawnClaudeCodeProcess`; tests use Node itself as the process under test. */
function spawnOptions(script: string, controller = new AbortController()): SpawnOptions {
  return {
    command: process.execPath,
    args: ["-e", script],
    env: process.env,
    signal: controller.signal,
  };
}

/** Starts a group leader that spawns its own grandchild; the grandchild pid is read back from the first line of stdout. */
const LEADER_WITH_GRANDCHILD = [
  "const { spawn } = require('node:child_process');",
  "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
  "process.stdout.write(String(child.pid) + '\\n');",
  "setTimeout(() => {}, 60000);",
].join("");

/** Same as above, but the leader exits right after printing, leaving the grandchild in the same process group. */
const LEADER_EXITS_FIRST = [
  "const { spawn } = require('node:child_process');",
  "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
  "process.stdout.write(String(child.pid) + '\\n');",
  "process.exit(0);",
].join("");

const IGNORES_SIGTERM = [
  "process.on('SIGTERM', () => {});",
  "process.stdout.write('ready\\n');",
  "setTimeout(() => {}, 60000);",
].join("");

function firstLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: stream });
    lines.once("line", (line) => {
      resolve(line);
      lines.close();
      // Nobody reads stdout once readline is closed; keep it flowing so a full pipe doesn't stall the child.
      stream.resume();
    });
    lines.once("close", () => reject(new Error("子进程没有输出任何一行。")));
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

async function waitUntil(predicate: () => boolean, budgetMs = 3_000): Promise<boolean> {
  let waited = 0;
  while (!predicate() && waited < budgetMs) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    waited += 20;
  }
  return predicate();
}

test("terminate takes down the group leader and the grandchild it spawned", async () => {
  const group = new ProcessGroup();
  const spawned = group.spawn(spawnOptions(LEADER_WITH_GRANDCHILD));
  const grandchildPid = Number(await firstLine(spawned.stdout));
  const leaderPid = group.processGroupId;

  assert.ok(leaderPid !== null);
  assert.equal(isAlive(grandchildPid), true);

  assert.equal(await group.terminate(), true);
  assert.equal(isAlive(leaderPid), false, "组长应当已经退出");
  assert.equal(isAlive(grandchildPid), false, "孙进程不应当留下来");
});

test("after the leader exits on its own, the remaining grandchild can still be cleared with the group", async () => {
  const group = new ProcessGroup();
  const spawned = group.spawn(spawnOptions(LEADER_EXITS_FIRST));
  const grandchildPid = Number(await firstLine(spawned.stdout));
  const leaderPid = group.processGroupId;

  assert.ok(leaderPid !== null);
  await waitUntil(() => !isAlive(leaderPid));
  // The leader is gone and the grandchild is adopted by init, but it stays in the original process group, which is exactly what a negative pid reaches.
  assert.equal(isAlive(grandchildPid), true, "孙进程还活着");
  assert.equal(groupExists(leaderPid), true, "进程组还在");

  assert.equal(await group.terminate(), true);
  assert.equal(isAlive(grandchildPid), false);
});

test("escalates to SIGKILL when SIGTERM doesn't stop it", async () => {
  const group = new ProcessGroup();
  const spawned = group.spawn(spawnOptions(IGNORES_SIGTERM));
  assert.equal(await firstLine(spawned.stdout), "ready");
  const leaderPid = group.processGroupId;

  assert.ok(leaderPid !== null);
  assert.equal(await group.terminate(), true);
  assert.equal(isAlive(leaderPid), false);
});

test("terminate can be called repeatedly and still succeeds once the group has exited", async () => {
  const group = new ProcessGroup();
  group.spawn(spawnOptions("setTimeout(() => {}, 60000);"));

  assert.equal(await group.terminate(), true);
  assert.equal(await group.terminate(), true);
});

test("reports no leftovers when spawn fails before getting a pid", async () => {
  const group = new ProcessGroup();
  const spawned = group.spawn(
    spawnOptions("setTimeout(() => {}, 60000);"),
  );
  // Nonexistent command: Node returns a ChildProcess with no pid, and the error event arrives asynchronously.
  const missing = new ProcessGroup();
  const failed = missing.spawn({
    command: "lanting-no-such-command",
    args: [],
    env: process.env,
    signal: new AbortController().signal,
  });
  await new Promise<void>((resolve) => failed.once("error", () => resolve()));

  assert.equal(missing.processGroupId, null);
  assert.equal(await missing.terminate(), true);

  assert.ok(spawned.stdin.writable);
  await group.terminate();
});

test("kill() called by the SDK applies to the whole process group", async () => {
  const group = new ProcessGroup();
  const spawned = group.spawn(spawnOptions(LEADER_WITH_GRANDCHILD));
  const grandchildPid = Number(await firstLine(spawned.stdout));

  assert.equal(spawned.kill("SIGKILL"), true);
  assert.equal(await waitUntil(() => !isAlive(grandchildPid)), true, "孙进程应当一起被杀掉");
  await group.terminate();
});

test("the AbortSignal forwarded by the SDK applies to the whole process group", async () => {
  const controller = new AbortController();
  const group = new ProcessGroup();
  const spawned = group.spawn(spawnOptions(LEADER_WITH_GRANDCHILD, controller));
  const grandchildPid = Number(await firstLine(spawned.stdout));

  controller.abort();
  assert.equal(await waitUntil(() => !isAlive(grandchildPid)), true);
  await group.terminate();
});

test("stderr is drained continuously and a bounded tail is kept", async () => {
  const group = new ProcessGroup();
  const spawned = group.spawn(spawnOptions(
    "process.stderr.write('boom\\n'); process.stdout.write('done\\n'); setTimeout(() => {}, 60000);",
  ));
  assert.equal(await firstLine(spawned.stdout), "done");

  assert.equal(await waitUntil(() => group.stderrTail.includes("boom")), true);
  await group.terminate();
});

test("groupExists rejects 0, 1 and negative numbers, never signaling the whole system or its own group", () => {
  assert.equal(groupExists(null), false);
  assert.equal(groupExists(0), false);
  assert.equal(groupExists(1), false);
  assert.equal(groupExists(-1), false);
  assert.equal(groupExists(1.5), false);
});
