import path from "node:path";
import { pathToFileURL } from "node:url";

import { ClaudeAdapter } from "../agents/claude/adapter.ts";
import { CodexAdapter } from "../agents/codex/adapter.ts";
import { GrokAdapter } from "../agents/grok/adapter.ts";
import { AgentRegistry } from "../agents/registry.ts";
import type { AgentAdapter } from "../agents/types.ts";
import { loadConfig } from "../config/load.ts";
import { GroupRuntime } from "../group/runtime.ts";
import { GroupService } from "../group/service.ts";
import { GroupStore } from "../state/group-store.ts";
import { ConnectionHub } from "./hub.ts";
import { WebServer } from "./http-server.ts";

const DEFAULT_PORT = "3010";

export async function main(): Promise<void> {
  const token = process.env.ACCESS_TOKEN;
  if (!token || token.length < 32) throw new Error("请设置至少 32 个字符的 ACCESS_TOKEN。");

  const configPath = path.resolve(process.env.CONFIG_PATH ?? "config.json");
  const config = await loadConfig(configPath);
  const dataDirectory = path.resolve(process.env.DATA_DIR ?? "data");

  // 群数据读不动或校验不过时直接退出，绝不能用空状态覆盖原文件。
  const store = await GroupStore.open(dataDirectory);
  const adapters: AgentAdapter[] = [];
  // 登记顺序就是界面上的排列顺序：claude、codex、grok。
  if (config.agents.claude) {
    adapters.push(new ClaudeAdapter({ pathToClaudeCodeExecutable: config.agents.claude.executable }));
  }
  if (config.agents.codex) adapters.push(new CodexAdapter({ executable: config.agents.codex.executable }));
  if (config.agents.grok) adapters.push(new GrokAdapter({ executable: config.agents.grok.executable }));
  const agents = new AgentRegistry(adapters);
  const runtime = new GroupRuntime({ store, agents });
  const groups = new GroupService({ projectRoot: config.projectRoot, store, runtime, agents });
  const hub = new ConnectionHub();
  groups.onEvent((event) => {
    hub.handle(event.scope === "global"
      ? { target: "global", payload: event.payload }
      : { target: "group", groupId: event.groupId, payload: event.payload });
  });
  const server = new WebServer({
    token,
    services: { hub, groups },
    allowedOrigins: readAllowedOrigins(process.env.ALLOWED_ORIGINS),
  });

  try {
    const address = await server.listen(readPort(process.env.PORT ?? DEFAULT_PORT));
    console.log(`服务正在监听 http://${address.host}:${address.port}/`);
    console.log(`已接入的 AI：${agents.ids.join("、") || "无"}`);
    runtime.startIdleSweeper();
    groups.startTrashSweeper();
    await waitForShutdownSignal();
  } finally {
    groups.stopTrashSweeper();
    await server.close();
    await runtime.shutdown();
  }
}

function readPort(source: string): number {
  const port = Number(source);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT 必须是 1 到 65535 之间的整数。");
  }
  return port;
}

function readAllowedOrigins(source: string | undefined): string[] {
  return (source ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
