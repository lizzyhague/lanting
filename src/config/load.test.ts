import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { configuredKinds, loadConfig } from "./load.ts";

async function scratch(t: test.TestContext): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "lanting-config-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("loads the project root and drops unknown fields", async (t) => {
  const directory = await scratch(t);
  const projects = path.join(directory, "projects");
  const configPath = path.join(directory, "config.json");
  await mkdir(projects);
  await writeFile(configPath, JSON.stringify({ projectRoot: projects, extra: true }));

  const config = await loadConfig(configPath);
  assert.deepEqual(config, { projectRoot: projects, agents: {} });
});

test("leaves known CLI configuration fields for its module to parse", async (t) => {
  const directory = await scratch(t);
  const projects = path.join(directory, "projects");
  const claude = path.join(directory, "claude");
  const configPath = path.join(directory, "config.json");
  await mkdir(projects);
  await writeFile(configPath, JSON.stringify({
    projectRoot: projects,
    agents: { claude: { executable: claude, futureField: true }, unknown: { ignored: false } },
  }));
  assert.deepEqual((await loadConfig(configPath)).agents, {
    claude: { executable: claude, futureField: true },
  });
});

test("reports configured CLI kinds in their fixed order", async (t) => {
  const directory = await scratch(t);
  const projects = path.join(directory, "projects");
  const executable = path.join(directory, "agent-cli");
  const configPath = path.join(directory, "config.json");
  await mkdir(projects);
  await writeFile(executable, "#!/bin/sh\n", { mode: 0o700 });
  await writeFile(configPath, JSON.stringify({
    projectRoot: projects,
    agents: {
      grok: { executable },
      claude: { executable },
    },
  }));

  assert.deepEqual(configuredKinds(await loadConfig(configPath)), ["claude", "grok"]);
});

test("rejects a relative, missing, or non-directory project root", async (t) => {
  const directory = await scratch(t);
  const configPath = path.join(directory, "config.json");
  const file = path.join(directory, "file");
  await writeFile(file, "");

  await writeFile(configPath, JSON.stringify({ projectRoot: "projects" }));
  await assert.rejects(loadConfig(configPath), /必须是绝对路径/u);

  await writeFile(configPath, JSON.stringify({ projectRoot: path.join(directory, "missing") }));
  await assert.rejects(loadConfig(configPath), /不存在/u);

  await writeFile(configPath, JSON.stringify({ projectRoot: file }));
  await assert.rejects(loadConfig(configPath), /不是文件夹/u);
});

test("rejects unreadable or malformed config files", async (t) => {
  const directory = await scratch(t);
  const configPath = path.join(directory, "config.json");

  await assert.rejects(loadConfig(configPath), /无法读取配置文件/u);
  await writeFile(configPath, "{");
  await assert.rejects(loadConfig(configPath), /不是有效 JSON/u);
  await writeFile(configPath, "[]");
  await assert.rejects(loadConfig(configPath), /顶层必须是 JSON 对象/u);
  await writeFile(configPath, "{}");
  await assert.rejects(loadConfig(configPath), /projectRoot 必须是非空字符串/u);
});
