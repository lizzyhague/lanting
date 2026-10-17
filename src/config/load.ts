import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { AGENT_KINDS, type AgentKind } from "../agents/kinds.ts";
import { expandHome, requireString } from "./fields.ts";

export type AppConfig = {
  /** When creating a group, the working directory is chosen from the top-level folders under this directory. */
  projectRoot: string;
  /** Paths to each CLI. Kinds without a configured path aren't connected. */
  agents: Record<string, Record<string, unknown>>;
};

/** CLI kinds configured on this machine, always returned in the fixed order defined in code. */
export function configuredKinds(config: AppConfig): AgentKind[] {
  return AGENT_KINDS.filter((kind) => config.agents[kind] !== undefined);
}

export async function loadConfig(configPath: string): Promise<AppConfig> {
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    throw new Error(`Cannot read the config file: ${configPath}`, { cause: error });
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`The config file is not valid JSON: ${configPath}`, { cause: error });
  }
  if (!isObject(value)) {
    throw new Error("The config file must contain a JSON object.");
  }

  const configuredRoot = expandHome(requireString(value.projectRoot, "projectRoot"));
  if (!path.isAbsolute(configuredRoot)) {
    throw new Error("projectRoot must be an absolute path or start with ~/.");
  }
  const projectRoot = await realpath(configuredRoot).catch((error: unknown) => {
    throw new Error(`The project root does not exist: ${configuredRoot}`, { cause: error });
  });
  if (!(await stat(projectRoot)).isDirectory()) {
    throw new Error(`The project root is not a directory: ${configuredRoot}`);
  }

  const agents: AppConfig["agents"] = {};
  if (value.agents !== undefined) {
    const configured = requireObject(value.agents, "agents");
    for (const kind of AGENT_KINDS) {
      if (configured[kind] === undefined) continue;
      agents[kind] = requireObject(configured[kind], `agents.${kind}`);
    }
  }

  return { projectRoot, agents };
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${label} must be a JSON object.`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
