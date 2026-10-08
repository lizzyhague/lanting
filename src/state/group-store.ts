import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_AGENT_SETTINGS, type AgentSettings } from "../agents/types.ts";
import type { StoredAttachment } from "../attachments/prompt.ts";
import type { Activity, AgentState, Group, ReplyStatus, Speaker, TranscriptEntry } from "../group/types.ts";
import {
  ensurePrivateDirectory,
  readJsonIfPresent,
  writeJsonAtomically,
} from "./atomic-json.ts";

const STORE_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type NewGroup = {
  title: string;
  cwd: string;
  username: string;
  members: string[];
  callOrder?: string[];
  /** 每个成员一开始的设置；没给的跟随 CLI 默认。 */
  settings?: Record<string, AgentSettings>;
};

export type NewEntry = Omit<TranscriptEntry, "seq" | "at">;

type GroupRecord = { group: Group; transcript: TranscriptEntry[]; queue: Promise<void> };

/**
 * 群和群聊记录。每个群一个目录：group.json 存群的数据，transcript.json 存群聊记录。
 *
 * 全部内容常驻内存，读是同步的；写按群排队，先写盘成功再换掉内存里的值，
 * 写盘失败时内存保持旧值。
 */
export class GroupStore {
  readonly #root: string;
  readonly #records = new Map<string, GroupRecord>();

  private constructor(root: string) {
    this.#root = root;
  }

  /** 任何一个群的文件损坏都直接抛错，绝不用空状态覆盖原文件。 */
  static async open(dataDirectory: string): Promise<GroupStore> {
    const store = new GroupStore(path.join(dataDirectory, "groups"));
    await ensurePrivateDirectory(store.#root);
    for (const name of await readdir(store.#root)) {
      if (!UUID_PATTERN.test(name)) continue;
      const directory = path.join(store.#root, name);
      const group = parseGroup(await readJsonIfPresent(path.join(directory, "group.json")), name);
      const transcript = parseTranscript(
        await readJsonIfPresent(path.join(directory, "transcript.json")),
        name,
      );
      store.#records.set(name, { group, transcript, queue: Promise.resolve() });
    }
    return store;
  }

  list(): Group[] {
    return [...this.#records.values()].map((record) => structuredClone(record.group));
  }

  get(id: string): Group | null {
    const record = this.#records.get(id);
    return record ? structuredClone(record.group) : null;
  }

  transcript(id: string): readonly TranscriptEntry[] {
    return this.#require(id).transcript;
  }

  async create(input: NewGroup): Promise<Group> {
    const id = randomUUID();
    const agents: Group["agents"] = {};
    for (const member of input.members) {
      const settings = input.settings?.[member] ?? DEFAULT_AGENT_SETTINGS;
      agents[member] = { nativeSessionId: null, cursor: 0, settings: { ...settings } };
    }
    const now = Date.now();
    const group: Group = {
      id,
      title: input.title,
      cwd: input.cwd,
      username: input.username,
      members: [...input.members],
      callOrder: [...(input.callOrder ?? [])],
      agents,
      createdAt: new Date(now).toISOString(),
      updatedAt: now,
      trashedAt: null,
      deletingAt: null,
    };
    await this.#writeTranscript(id, []);
    await this.#writeGroup(group);
    this.#records.set(id, { group, transcript: [], queue: Promise.resolve() });
    return structuredClone(group);
  }

  /** 在副本上修改，写盘成功后才生效。 */
  update(id: string, mutate: (group: Group) => void): Promise<Group> {
    return this.#enqueue(id, async (record) => {
      const next = structuredClone(record.group);
      mutate(next);
      if (next.id !== id) throw new Error("不能修改群 id。");
      await this.#writeGroup(next);
      record.group = next;
      return structuredClone(next);
    });
  }

  touch(id: string, now = Date.now()): Promise<Group> {
    return this.update(id, (group) => {
      group.updatedAt = now;
    });
  }

  append(id: string, entry: NewEntry): Promise<TranscriptEntry> {
    return this.#enqueue(id, async (record) => {
      const now = Date.now();
      const full: TranscriptEntry = {
        ...entry,
        seq: (record.transcript.at(-1)?.seq ?? 0) + 1,
        at: new Date(now).toISOString(),
      };
      const next = [...record.transcript, full];
      const nextGroup = { ...record.group, updatedAt: now };
      // 和 Relayu 一样，消息一进入记录就刷新最近活动时间。
      await this.#writeGroup(nextGroup);
      record.group = nextGroup;
      await this.#writeTranscript(id, next);
      record.transcript = next;
      return full;
    });
  }

  /** 删掉群目录（群的数据和群聊记录），之后这个群就不存在了。 */
  remove(id: string): Promise<void> {
    return this.#enqueue(id, async () => {
      await rm(path.join(this.#root, id), { recursive: true, force: true });
      this.#records.delete(id);
    });
  }

  #require(id: string): GroupRecord {
    const record = this.#records.get(id);
    if (!record) throw new Error(`群不存在：${id}`);
    return record;
  }

  #enqueue<T>(id: string, task: (record: GroupRecord) => Promise<T>): Promise<T> {
    const record = this.#require(id);
    const result = record.queue.then(() => task(record));
    record.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  #writeGroup(group: Group): Promise<void> {
    return writeJsonAtomically(path.join(this.#root, group.id, "group.json"), {
      version: STORE_VERSION,
      group,
    });
  }

  #writeTranscript(id: string, entries: TranscriptEntry[]): Promise<void> {
    return writeJsonAtomically(path.join(this.#root, id, "transcript.json"), {
      version: STORE_VERSION,
      entries,
    });
  }
}

function parseGroup(value: unknown, id: string): Group {
  const fail = (detail: string): never => {
    throw new Error(`群数据损坏（${id}）：${detail}`);
  };
  if (value === null) fail("缺少 group.json");
  if (!isObject(value) || value.version !== STORE_VERSION || !isObject(value.group)) {
    fail("格式或版本不对");
  }
  const group = (value as { group: { [key: string]: unknown } }).group;
  if (group.id !== id) fail("id 和目录名不一致");
  const members = stringArray(group.members) ?? fail("members 不对");
  const callOrder = stringArray(group.callOrder) ?? fail("callOrder 不对");
  if (!callOrder.every((agent) => members.includes(agent))) fail("callOrder 里有不是成员的 AI");
  if (!isObject(group.agents)) fail("agents 不对");
  const agents: { [agent: string]: AgentState } = {};
  for (const member of members) {
    const state = (group.agents as { [key: string]: unknown })[member];
    if (!isObject(state) ||
        !(state.nativeSessionId === null || typeof state.nativeSessionId === "string") ||
        !Number.isSafeInteger(state.cursor) || (state.cursor as number) < 0) {
      fail(`agents.${member} 不对`);
    }
    const valid = state as { nativeSessionId: string | null; cursor: number; settings?: unknown };
    // 第 5 步之前建的群没有 settings，按跟随默认处理。
    const settings = valid.settings === undefined
      ? { ...DEFAULT_AGENT_SETTINGS }
      : parseSettings(valid.settings) ?? fail(`agents.${member}.settings 不对`);
    agents[member] = { nativeSessionId: valid.nativeSessionId, cursor: valid.cursor, settings };
  }
  for (const key of ["title", "cwd", "username", "createdAt"] as const) {
    if (typeof group[key] !== "string") fail(`${key} 不对`);
  }
  // 第 6 步之前建的群没有这两个字段，按不在回收站处理。
  for (const key of ["trashedAt", "deletingAt"] as const) {
    const value = group[key];
    if (value !== undefined && value !== null && typeof value !== "string") fail(`${key} 不对`);
  }
  return {
    id,
    title: group.title as string,
    cwd: group.cwd as string,
    username: group.username as string,
    members,
    callOrder,
    agents,
    createdAt: group.createdAt as string,
    // 照 Relayu：旧数据没有 updatedAt 时退回创建时间。
    updatedAt: typeof group.updatedAt === "number" && Number.isFinite(group.updatedAt)
      ? group.updatedAt
      : Date.parse(group.createdAt as string),
    trashedAt: (group.trashedAt as string | null | undefined) ?? null,
    deletingAt: (group.deletingAt as string | null | undefined) ?? null,
  };
}

function parseTranscript(value: unknown, id: string): TranscriptEntry[] {
  const fail = (detail: string): never => {
    throw new Error(`群聊记录损坏（${id}）：${detail}`);
  };
  if (value === null) fail("缺少 transcript.json");
  if (!isObject(value) || value.version !== STORE_VERSION || !Array.isArray(value.entries)) {
    fail("格式或版本不对");
  }
  const entries: TranscriptEntry[] = [];
  for (const raw of (value as { entries: unknown[] }).entries) {
    const expected = entries.length + 1;
    if (!isObject(raw) || raw.seq !== expected || typeof raw.at !== "string" ||
        typeof raw.text !== "string") {
      fail(`第 ${expected} 条不对`);
    }
    const entry = raw as { [key: string]: unknown };
    const from = parseSpeaker(entry.from) ?? fail(`第 ${expected} 条的发言者不对`);
    const status = entry.status;
    if (status !== undefined && !isReplyStatus(status)) fail(`第 ${expected} 条的状态不对`);
    if (entry.error !== undefined && typeof entry.error !== "string") fail(`第 ${expected} 条的错误信息不对`);
    const activities = entry.activities;
    if (activities !== undefined && !(Array.isArray(activities) &&
        activities.every((item) => isObject(item) && typeof item.kind === "string"))) {
      fail(`第 ${expected} 条的过程信息不对`);
    }
    const attachments = entry.attachments;
    if (attachments !== undefined && !(Array.isArray(attachments) && attachments.every(isStoredAttachment))) {
      fail(`第 ${expected} 条的附件不对`);
    }
    const recipients = entry.recipients;
    if (recipients !== undefined && stringArray(recipients) === null) fail(`第 ${expected} 条的附件收件人不对`);
    entries.push({
      seq: expected,
      at: entry.at as string,
      from,
      text: entry.text as string,
      ...(status === undefined ? {} : { status: status as ReplyStatus }),
      ...(entry.error === undefined ? {} : { error: entry.error as string }),
      ...(activities === undefined ? {} : { activities: activities as Activity[] }),
      ...(attachments === undefined ? {} : { attachments: attachments as StoredAttachment[] }),
      ...(recipients === undefined ? {} : { recipients: recipients as string[] }),
    });
  }
  return entries;
}

function isStoredAttachment(value: unknown): boolean {
  return isObject(value) && typeof value.id === "string" && typeof value.originalName === "string" &&
    typeof value.mimeType === "string" && (value.kind === "image" || value.kind === "file") &&
    typeof value.size === "number" && typeof value.path === "string";
}

function parseSettings(value: unknown): AgentSettings | null {
  if (!isObject(value)) return null;
  const field = (key: keyof AgentSettings) => {
    const item = value[key];
    return item === null || typeof item === "string" ? item : undefined;
  };
  const model = field("model");
  const effort = field("effort");
  const permission = field("permission");
  if (model === undefined || effort === undefined || permission === undefined) return null;
  return { model, effort, permission };
}

function parseSpeaker(value: unknown): Speaker | null {
  if (!isObject(value)) return null;
  if (value.role === "host") return { role: "host" };
  if ((value.role === "agent" || value.role === "notice") && typeof value.agent === "string") {
    return { role: value.role, agent: value.agent };
  }
  return null;
}

function isReplyStatus(value: unknown): value is ReplyStatus {
  return value === "completed" || value === "interrupted" || value === "failed";
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  if (new Set(value).size !== value.length) return null;
  return [...value];
}

function isObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
