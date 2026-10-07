import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "../config/load.ts";
import { ConnectionHub } from "./hub.ts";
import { WebServer } from "./http-server.ts";

const DEFAULT_PORT = "3010";

export async function main(): Promise<void> {
  const token = process.env.ACCESS_TOKEN;
  if (!token || token.length < 32) throw new Error("请设置至少 32 个字符的 ACCESS_TOKEN。");

  const configPath = path.resolve(process.env.CONFIG_PATH ?? "config.json");
  // 第 1 步还用不到配置，但启动时就校验，免得配置错误拖到建群时才暴露。
  await loadConfig(configPath);

  const hub = new ConnectionHub();
  const server = new WebServer({
    token,
    services: { hub },
    allowedOrigins: readAllowedOrigins(process.env.ALLOWED_ORIGINS),
  });

  try {
    const address = await server.listen(readPort(process.env.PORT ?? DEFAULT_PORT));
    console.log(`服务正在监听 http://${address.host}:${address.port}/`);
    await waitForShutdownSignal();
  } finally {
    await server.close();
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
