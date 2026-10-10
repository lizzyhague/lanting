import path from "node:path";
import { pathToFileURL } from "node:url";

import { AGENT_MODULES } from "../agents/index.ts";
import { AgentRegistry } from "../agents/registry.ts";
import { SharedUploadClient } from "../attachments/shared-upload-client.ts";
import type { AgentAdapter } from "../agents/types.ts";
import { configuredKinds, loadConfig } from "../config/load.ts";
import { GroupRuntime } from "../group/runtime.ts";
import { GroupService } from "../group/service.ts";
import { GroupStore } from "../state/group-store.ts";
import { SettingsStore } from "../state/settings-store.ts";
import { ConnectionHub } from "./hub.ts";
import { WebServer } from "./http-server.ts";
import { buildViewableRoots, ensurePreviewRoot } from "./viewable-roots.ts";

const DEFAULT_PORT = "3010";

export async function main(): Promise<void> {
  const token = process.env.ACCESS_TOKEN;
  if (!token || token.length < 32) throw new Error("请设置至少 32 个字符的 ACCESS_TOKEN。");

  const configPath = path.resolve(process.env.CONFIG_PATH ?? "config.json");
  const config = await loadConfig(configPath);
  const adapters: AgentAdapter[] = [];
  // 清单顺序就是界面上的排列顺序。
  for (const module of AGENT_MODULES) {
    const section = config.agents[module.kind];
    if (section) adapters.push(await module.create(section, `agents.${module.kind}`));
  }
  const previewRoot = await ensurePreviewRoot();
  const dataDirectory = path.resolve(process.env.DATA_DIR ?? "data");

  // 群数据读不动或校验不过时直接退出，绝不能用空状态覆盖原文件。
  const store = await GroupStore.open(dataDirectory);
  const settings = await SettingsStore.open(dataDirectory, configuredKinds(config));
  // socket 取 AI_REMOTE_UPLOAD_SOCKET，没设时用 ai-remote-upload 的默认位置。
  const uploads = new SharedUploadClient();
  const agents = new AgentRegistry(adapters);
  const runtime = new GroupRuntime({ store, agents });
  const groups = new GroupService({ projectRoot: config.projectRoot, store, runtime, agents, settings, uploads });
  const hub = new ConnectionHub();
  groups.onEvent((event) => {
    hub.handle(event.scope === "global"
      ? { target: "global", payload: event.payload }
      : { target: "group", groupId: event.groupId, payload: event.payload });
  });
  const server = new WebServer({
    token,
    fileRoots: buildViewableRoots([config.projectRoot], [previewRoot]),
    services: { hub, groups },
    uploads,
    allowedOrigins: readAllowedOrigins(process.env.ALLOWED_ORIGINS),
  });

  try {
    const address = await server.listen(readPort(process.env.PORT ?? DEFAULT_PORT));
    console.log(`服务正在监听 http://${address.host}:${address.port}/`);
    console.log(`已接入的 CLI：${agents.kinds.join("、") || "无"}`);
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
