import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import test from "node:test";

import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

import { ProcessGroup, groupExists } from "./process-group.ts";

/** SDK 传给 `spawnClaudeCodeProcess` 的那一份参数；测试里用 Node 自己当被测进程。 */
function spawnOptions(script: string, controller = new AbortController()): SpawnOptions {
  return {
    command: process.execPath,
    args: ["-e", script],
    env: process.env,
    signal: controller.signal,
  };
}

/** 起一个自己还会 spawn 孙进程的组长；孙进程 pid 从 stdout 第一行读回来。 */
const LEADER_WITH_GRANDCHILD = [
  "const { spawn } = require('node:child_process');",
  "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
  "process.stdout.write(String(child.pid) + '\\n');",
  "setTimeout(() => {}, 60000);",
].join("");

/** 同上，但组长打印完就自己退出，把孙进程留在同一个进程组里。 */
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
      // readline 关掉之后没人读 stdout 了；保持流动，免得管道写满把子进程卡住。
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

test("terminate 带走组长和它 spawn 的孙进程", async () => {
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

test("组长先自己退出，剩下的孙进程仍能被整组清掉", async () => {
  const group = new ProcessGroup();
  const spawned = group.spawn(spawnOptions(LEADER_EXITS_FIRST));
  const grandchildPid = Number(await firstLine(spawned.stdout));
  const leaderPid = group.processGroupId;

  assert.ok(leaderPid !== null);
  await waitUntil(() => !isAlive(leaderPid));
  // 组长走了，孙进程被 init 收养，但它仍留在原来的进程组里——这正是负 pid 管得到的。
  assert.equal(isAlive(grandchildPid), true, "孙进程还活着");
  assert.equal(groupExists(leaderPid), true, "进程组还在");

  assert.equal(await group.terminate(), true);
  assert.equal(isAlive(grandchildPid), false);
});

test("SIGTERM 不退出时升级到 SIGKILL", async () => {
  const group = new ProcessGroup();
  const spawned = group.spawn(spawnOptions(IGNORES_SIGTERM));
  assert.equal(await firstLine(spawned.stdout), "ready");
  const leaderPid = group.processGroupId;

  assert.ok(leaderPid !== null);
  assert.equal(await group.terminate(), true);
  assert.equal(isAlive(leaderPid), false);
});

test("terminate 可以重复调用，整组已退出时仍返回成功", async () => {
  const group = new ProcessGroup();
  group.spawn(spawnOptions("setTimeout(() => {}, 60000);"));

  assert.equal(await group.terminate(), true);
  assert.equal(await group.terminate(), true);
});

test("spawn 在取得 pid 之前失败时不报残留", async () => {
  const group = new ProcessGroup();
  const spawned = group.spawn(
    spawnOptions("setTimeout(() => {}, 60000);"),
  );
  // 命令不存在：Node 返回 ChildProcess 但没有 pid，error 事件异步到达。
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

test("SDK 调用的 kill() 作用到整个进程组", async () => {
  const group = new ProcessGroup();
  const spawned = group.spawn(spawnOptions(LEADER_WITH_GRANDCHILD));
  const grandchildPid = Number(await firstLine(spawned.stdout));

  assert.equal(spawned.kill("SIGKILL"), true);
  assert.equal(await waitUntil(() => !isAlive(grandchildPid)), true, "孙进程应当一起被杀掉");
  await group.terminate();
});

test("SDK 转发的 AbortSignal 作用到整个进程组", async () => {
  const controller = new AbortController();
  const group = new ProcessGroup();
  const spawned = group.spawn(spawnOptions(LEADER_WITH_GRANDCHILD, controller));
  const grandchildPid = Number(await firstLine(spawned.stdout));

  controller.abort();
  assert.equal(await waitUntil(() => !isAlive(grandchildPid)), true);
  await group.terminate();
});

test("stderr 被持续读走，并保留有上限的尾部", async () => {
  const group = new ProcessGroup();
  const spawned = group.spawn(spawnOptions(
    "process.stderr.write('boom\\n'); process.stdout.write('done\\n'); setTimeout(() => {}, 60000);",
  ));
  assert.equal(await firstLine(spawned.stdout), "done");

  assert.equal(await waitUntil(() => group.stderrTail.includes("boom")), true);
  await group.terminate();
});

test("groupExists 挡住 0、1 和负数，绝不把信号发给全系统或自己这一组", () => {
  assert.equal(groupExists(null), false);
  assert.equal(groupExists(0), false);
  assert.equal(groupExists(1), false);
  assert.equal(groupExists(-1), false);
  assert.equal(groupExists(1.5), false);
});
