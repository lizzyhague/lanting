import { randomUUID } from "node:crypto";
import path from "node:path";

import { AGENT_KINDS, isAgentKind, type AgentKind } from "../agents/kinds.ts";
import { isPaletteId, PALETTE, type PaletteId } from "../agents/palette.ts";
import { DEFAULT_AGENT_SETTINGS, type AgentSettings } from "../agents/types.ts";
import { ensurePrivateDirectory, readJsonIfPresent, writeJsonAtomically } from "./atomic-json.ts";

const STORE_VERSION = 2;
export const DEFAULT_USERNAME = "host";
export const MAX_AGENTS = 12;
export const AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,15}$/u;

export type AgentRecord = {
  /** 后端生成且不随改名变化的内部 id。 */
  id: string;
  name: string;
  kind: AgentKind | null;
  color: PaletteId | null;
  defaults: AgentSettings;
};

export type Settings = {
  /** 新开的群用这个用户名；已经开的群不受影响。 */
  username: string;
  /** 设置页里的有序 AI 列表。 */
  agents: AgentRecord[];
  /** 首次预填是否已经完成；完成后即使列表为空也不再自动添加。 */
  initialized: boolean;
  /** 上次新建群时勾选的 AI 内部 id；还没建过群时为 null。 */
  createMembers: string[] | null;
};

export type SettingsField = "username" | "name" | "kind" | "color" | "defaults";

export class SettingsError extends Error {
  readonly code = "invalid_settings";
  readonly field: SettingsField | undefined;
  readonly agentId: string | undefined;

  constructor(message: string, field?: SettingsField, agentId?: string) {
    super(message);
    this.name = "SettingsError";
    this.field = field;
    this.agentId = agentId;
  }
}

export function isAgentComplete(agent: AgentRecord, configured: readonly AgentKind[]): boolean {
  return agent.name.length > 0 && agent.kind !== null && configured.includes(agent.kind) && agent.color !== null;
}

/** 设置存在数据目录的 settings.json。常驻内存，写盘成功后才换掉内存里的值。 */
export class SettingsStore {
  readonly #file: string;
  #settings: Settings;
  #queue: Promise<void> = Promise.resolve();

  private constructor(file: string, settings: Settings) {
    this.#file = file;
    this.#settings = settings;
  }

  /** 文件损坏或版本过旧时直接抛错，不覆盖原文件。 */
  static async open(dataDirectory: string, configured: readonly AgentKind[]): Promise<SettingsStore> {
    await ensurePrivateDirectory(dataDirectory);
    const file = path.join(dataDirectory, "settings.json");
    const value = await readJsonIfPresent(file);
    let settings = value === null
      ? { username: DEFAULT_USERNAME, agents: [], initialized: false, createMembers: null }
      : parseSettingsFile(value);

    if (!settings.initialized) {
      settings = initialSettings(settings.username, configured);
      await writeJsonAtomically(file, storedSettings(settings));
    }
    return new SettingsStore(file, settings);
  }

  get(): Settings {
    return structuredClone(this.#settings);
  }

  update(mutate: (settings: Settings) => void): Promise<Settings> {
    const result = this.#queue.then(async () => {
      const previous = this.#settings;
      const next = structuredClone(previous);
      mutate(next);
      normalizeSettings(next, previous);
      validateSettings(next, previous);
      await writeJsonAtomically(this.#file, storedSettings(next));
      this.#settings = next;
      return structuredClone(next);
    });
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function initialSettings(username: string, configured: readonly AgentKind[]): Settings {
  const available = new Set(configured);
  const agents = AGENT_KINDS.filter((kind) => available.has(kind)).map((kind, index) => ({
    id: randomUUID(),
    name: kind,
    kind,
    color: PALETTE[index]!.id,
    defaults: { ...DEFAULT_AGENT_SETTINGS },
  }));
  const settings: Settings = { username, agents, initialized: true, createMembers: null };
  validateSettings(settings);
  return settings;
}

function normalizeSettings(next: Settings, previous: Settings): void {
  if (!Array.isArray(next.agents)) return;
  const previousById = new Map(previous.agents.map((agent) => [agent.id, agent]));
  for (const value of next.agents as unknown[]) {
    if (!isObject(value) || typeof value.id !== "string") continue;
    const old = previousById.get(value.id);
    if (old && value.kind !== old.kind) value.defaults = { ...DEFAULT_AGENT_SETTINGS };
  }

  if (!Array.isArray(next.createMembers) || !next.createMembers.every((id) => typeof id === "string")) return;
  const remaining = new Set(next.agents.flatMap((agent) =>
    isObject(agent) && typeof agent.id === "string" ? [agent.id] : []
  ));
  next.createMembers = next.createMembers.filter((id) => remaining.has(id));
}

function validateSettings(value: unknown, previous?: Settings): asserts value is Settings {
  if (!isObject(value)) throw new SettingsError("设置结构不对。");
  if (typeof value.username !== "string") throw new SettingsError("用户名不对。", "username");
  const username = value.username;
  if (!Array.isArray(value.agents)) throw new SettingsError("AI 列表不对。");
  if (typeof value.initialized !== "boolean") throw new SettingsError("initialized 不对。");
  if (value.createMembers !== null &&
      !(Array.isArray(value.createMembers) && value.createMembers.every((id) => typeof id === "string"))) {
    throw new SettingsError("createMembers 不对。");
  }
  if (value.agents.length > MAX_AGENTS) throw new SettingsError(`最多只能设置 ${MAX_AGENTS} 个 AI。`);

  const previousById = new Map(previous?.agents.map((agent) => [agent.id, agent]) ?? []);
  const changedAgentId = (agent: Record<string, unknown>, field: keyof AgentRecord): string | undefined => {
    if (typeof agent.id !== "string") return undefined;
    const old = previousById.get(agent.id);
    return old && old[field] !== agent[field] ? agent.id : undefined;
  };
  const existingAgentId = (agent: Record<string, unknown>): string | undefined =>
    typeof agent.id === "string" && previousById.has(agent.id) ? agent.id : undefined;
  const isNewAgent = (agent: Record<string, unknown>): boolean =>
    typeof agent.id === "string" && !previousById.has(agent.id);

  const agents: Record<string, unknown>[] = [];
  const ids = new Set<string>();
  for (const item of value.agents as unknown[]) {
    if (!isObject(item)) throw new SettingsError("AI 记录不对。");
    const agentId = existingAgentId(item);
    if (typeof item.id !== "string" || item.id.length === 0) {
      throw new SettingsError("AI 内部 id 不对。", undefined, agentId);
    }
    if (ids.has(item.id)) throw new SettingsError(`AI 内部 id 重复：${item.id}`, undefined, agentId);
    ids.add(item.id);
    if (typeof item.name !== "string" || (item.name !== "" && !AGENT_NAME_PATTERN.test(item.name))) {
      throw new SettingsError("AI 名字只能用小写字母、数字、下划线和连字符，并以字母开头，最多 16 位。", "name", agentId);
    }
    if (item.kind !== null && !isAgentKind(item.kind)) {
      throw new SettingsError("CLI 种类不受支持。", "kind", agentId);
    }
    if (item.color !== null && !isPaletteId(item.color)) {
      throw new SettingsError("主色不在调色板里。", "color", agentId);
    }
    if (!isAgentSettings(item.defaults)) {
      throw new SettingsError("默认模型、思考强度或权限不对。", "defaults", agentId);
    }
    agents.push(item);
  }

  const byName = new Map<string, Record<string, unknown>[]>();
  const byColor = new Map<PaletteId, Record<string, unknown>[]>();
  for (const agent of agents) {
    const name = agent.name as string;
    if (name !== "") {
      const named = byName.get(name) ?? [];
      named.push(agent);
      byName.set(name, named);
    }
    if (agent.color !== null) {
      const color = agent.color as PaletteId;
      const colored = byColor.get(color) ?? [];
      colored.push(agent);
      byColor.set(color, colored);
    }
  }

  for (const [name, matching] of byName) {
    if (matching.length < 2) continue;
    const blamed = matching.find((agent) => changedAgentId(agent, "name") !== undefined) ??
      matching.find(isNewAgent) ?? matching.at(-1)!;
    throw new SettingsError(`AI 名字不能重复：${name}`, "name", existingAgentId(blamed));
  }
  for (const [color, matching] of byColor) {
    if (matching.length < 2) continue;
    const blamed = matching.find((agent) => changedAgentId(agent, "color") !== undefined) ??
      matching.find(isNewAgent) ?? matching.at(-1)!;
    throw new SettingsError(`主色不能重复：${color}`, "color", existingAgentId(blamed));
  }

  const usernameClash = agents.find((agent) =>
    agent.name !== "" && (agent.name as string).toLowerCase() === username.toLowerCase()
  );
  if (usernameClash) {
    if (previous && username !== previous.username) {
      throw new SettingsError("用户名不能和 AI 名字相同（不区分大小写）。", "username");
    }
    throw new SettingsError(
      "AI 名字不能和用户名相同（不区分大小写）。",
      "name",
      existingAgentId(usernameClash),
    );
  }
}

function parseSettingsFile(value: unknown): Settings {
  const fail = (detail: string): never => {
    throw new Error(`设置文件损坏：${detail}`);
  };
  if (!isObject(value)) return fail("格式不对");
  const root = value;
  if (root.version === 1) throw new Error("设置文件是旧版本（1），需要先清理。");
  if (root.version !== STORE_VERSION || !isObject(root.settings)) return fail("格式或版本不对");
  const settings = root.settings;
  try {
    validateSettings(settings);
    return exactSettings(settings);
  } catch (error) {
    if (error instanceof SettingsError) fail(error.message);
    throw error;
  }
}

function exactSettings(settings: Settings): Settings {
  return {
    username: settings.username,
    agents: settings.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      kind: agent.kind,
      color: agent.color,
      defaults: {
        model: agent.defaults.model,
        effort: agent.defaults.effort,
        permission: agent.defaults.permission,
      },
    })),
    initialized: settings.initialized,
    createMembers: settings.createMembers === null ? null : [...settings.createMembers],
  };
}

function storedSettings(settings: Settings): { version: number; settings: Settings } {
  return { version: STORE_VERSION, settings };
}

function isAgentSettings(value: unknown): value is AgentSettings {
  if (!isObject(value)) return false;
  return [value.model, value.effort, value.permission].every((field) =>
    field === null || typeof field === "string"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
