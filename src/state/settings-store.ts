import path from "node:path";

import { DEFAULT_AGENT_SETTINGS, type AgentSettings } from "../agents/types.ts";
import { ensurePrivateDirectory, readJsonIfPresent, writeJsonAtomically } from "./atomic-json.ts";

const STORE_VERSION = 1;
export const DEFAULT_USERNAME = "host";

export type Settings = {
  /** 新开的群用这个用户名；已经开的群不受影响。 */
  username: string;
  /** 每个 AI 的默认模型、思考强度、权限，新开的群复制一份。没有记录的 AI 跟随 CLI 默认。 */
  defaults: Record<string, AgentSettings>;
  /** 上次新建群时勾选的 AI；还没建过群时为 null，页面上默认全部勾选。 */
  createMembers: string[] | null;
};

/** 设置存在数据目录的 settings.json。常驻内存，写盘成功后才换掉内存里的值。 */
export class SettingsStore {
  readonly #file: string;
  #settings: Settings;
  #queue: Promise<void> = Promise.resolve();

  private constructor(file: string, settings: Settings) {
    this.#file = file;
    this.#settings = settings;
  }

  /** 文件损坏时直接抛错，不用默认值覆盖原文件。 */
  static async open(dataDirectory: string): Promise<SettingsStore> {
    await ensurePrivateDirectory(dataDirectory);
    const file = path.join(dataDirectory, "settings.json");
    return new SettingsStore(file, parseSettings(await readJsonIfPresent(file)));
  }

  get(): Settings {
    return structuredClone(this.#settings);
  }

  /** 每个 AI 的默认设置，没有记录的给跟随默认。 */
  defaultsFor(agent: string): AgentSettings {
    return { ...(this.#settings.defaults[agent] ?? DEFAULT_AGENT_SETTINGS) };
  }

  update(mutate: (settings: Settings) => void): Promise<Settings> {
    const result = this.#queue.then(async () => {
      const next = structuredClone(this.#settings);
      mutate(next);
      await writeJsonAtomically(this.#file, { version: STORE_VERSION, settings: next });
      this.#settings = next;
      return structuredClone(next);
    });
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function parseSettings(value: unknown): Settings {
  if (value === null) return { username: DEFAULT_USERNAME, defaults: {}, createMembers: null };
  const fail = (detail: string): never => {
    throw new Error(`设置文件损坏：${detail}`);
  };
  if (!isObject(value) || value.version !== STORE_VERSION || !isObject(value.settings)) fail("格式或版本不对");
  const raw = (value as { settings: Record<string, unknown> }).settings;
  if (typeof raw.username !== "string") fail("username 不对");
  if (!isObject(raw.defaults)) fail("defaults 不对");
  const defaults: Record<string, AgentSettings> = {};
  for (const [agent, item] of Object.entries(raw.defaults as Record<string, unknown>)) {
    if (!isObject(item)) fail(`defaults.${agent} 不对`);
    const settings = item as Record<string, unknown>;
    const field = (key: string) => settings[key] === null || typeof settings[key] === "string"
      ? settings[key] as string | null
      : fail(`defaults.${agent}.${key} 不对`);
    defaults[agent] = { model: field("model"), effort: field("effort"), permission: field("permission") };
  }
  const members = raw.createMembers;
  if (members !== null && !(Array.isArray(members) && members.every((item) => typeof item === "string"))) {
    fail("createMembers 不对");
  }
  return { username: raw.username as string, defaults, createMembers: members as string[] | null };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
