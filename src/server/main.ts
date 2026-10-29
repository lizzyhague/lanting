import path from "node:path";
import { pathToFileURL } from "node:url";

import { AGENT_MODULES } from "../agents/index.ts";
import { AgentRegistry } from "../agents/registry.ts";
import { groupAttachmentBinding } from "../attachments/binding.ts";
import { prepareDeliveries } from "../deliveries/prepare.ts";
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
  if (!token || token.length < 32) throw new Error("Set ACCESS_TOKEN to at least 32 characters.");

  const configPath = path.resolve(process.env.CONFIG_PATH ?? "config.json");
  const config = await loadConfig(configPath);
  const adapters: AgentAdapter[] = [];
  // The list order is the order shown in the interface.
  for (const module of AGENT_MODULES) {
    const section = config.agents[module.kind];
    if (section) adapters.push(await module.create(section, `agents.${module.kind}`));
  }
  const previewRoot = await ensurePreviewRoot();
  const dataDirectory = path.resolve(process.env.DATA_DIR ?? "data");

  // Exit immediately if group data can't be read or fails validation; never overwrite the original files with an empty state.
  const store = await GroupStore.open(dataDirectory);
  const settings = await SettingsStore.open(dataDirectory, configuredKinds(config));
  // The socket comes from AI_REMOTE_UPLOAD_SOCKET, or ai-remote-upload's default location when unset.
  const uploads = new SharedUploadClient();
  const agents = new AgentRegistry(adapters);
  const runtime = new GroupRuntime({
    store, agents, collaboration: () => settings.get().collaboration,
    deliverReply: ({ group, source, signal }) => prepareDeliveries({
      source, root: group.cwd, binding: groupAttachmentBinding(group), client: uploads, signal,
    }),
  });
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
    console.log(`Listening on http://${address.host}:${address.port}/`);
    console.log(`Connected CLIs: ${agents.kinds.join(", ") || "none"}`);
    for (const adapter of adapters) adapter.start?.();
    runtime.startIdleSweeper();
    groups.startTrashSweeper();
    await waitForShutdownSignal();
  } finally {
    groups.stopTrashSweeper();
    await server.close();
    await runtime.shutdown();
    await Promise.all(adapters.map((adapter) => adapter.close?.()));
  }
}

function readPort(source: string): number {
  const port = Number(source);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer from 1 to 65535.");
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
