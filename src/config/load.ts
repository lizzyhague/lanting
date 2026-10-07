import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type AppConfig = {
  /** 新建群时，工作目录从这个目录下的第一层文件夹里选。 */
  projectRoot: string;
  /** 各 AI 的 CLI。没有配置的 AI 不接入。 */
  agents: {
    claude?: { executable: string };
    codex?: { executable: string };
    grok?: { executable: string };
  };
};

export async function loadConfig(configPath: string): Promise<AppConfig> {
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    throw new Error(`无法读取配置文件：${configPath}`, { cause: error });
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`配置文件不是有效 JSON：${configPath}`, { cause: error });
  }
  if (!isObject(value)) {
    throw new Error("配置文件顶层必须是 JSON 对象。");
  }

  const configuredRoot = expandHome(requireString(value.projectRoot, "projectRoot"));
  if (!path.isAbsolute(configuredRoot)) {
    throw new Error("projectRoot 必须是绝对路径或 ~/ 开头的路径。");
  }
  const projectRoot = await realpath(configuredRoot).catch((error: unknown) => {
    throw new Error(`项目根目录不存在：${configuredRoot}`, { cause: error });
  });
  if (!(await stat(projectRoot)).isDirectory()) {
    throw new Error(`项目根目录不是文件夹：${configuredRoot}`);
  }

  const agents: AppConfig["agents"] = {};
  if (value.agents !== undefined) {
    const configured = requireObject(value.agents, "agents");
    for (const id of ["claude", "codex", "grok"] as const) {
      if (configured[id] === undefined) continue;
      const agent = requireObject(configured[id], `agents.${id}`);
      agents[id] = { executable: await requireExecutable(agent.executable, `agents.${id}.executable`) };
    }
  }

  return { projectRoot, agents };
}

async function requireExecutable(value: unknown, label: string): Promise<string> {
  const executable = expandHome(requireString(value, label));
  if (!path.isAbsolute(executable)) throw new Error(`${label} 必须是绝对路径或 ~/ 开头的路径。`);
  await access(executable, constants.X_OK).catch((error: unknown) => {
    throw new Error(`${label} 不存在或不可执行：${executable}`, { cause: error });
  });
  return executable;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${label} 必须是 JSON 对象。`);
  return value;
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} 必须是非空字符串。`);
  }
  return value.trim();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
