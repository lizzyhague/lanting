import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";

import { isAgentKind, type AgentKind } from "../agents/kinds.ts";
import { isPaletteId, type PaletteId } from "../agents/palette.ts";
import type { AgentSettings } from "../agents/types.ts";
import type { StoredAttachment } from "../attachments/prompt.ts";
import type { Activity, AgentState, Group, ReplyStatus, Speaker, TranscriptEntry } from "../group/types.ts";
import { AGENT_NAME_PATTERN } from "./settings-store.ts";
import {
  ensurePrivateDirectory,
  readJsonIfPresent,
  writeJsonAtomically,
} from "./atomic-json.ts";

const STORE_VERSION = 2;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type NewMember = {
  tag: string;
  kind: AgentKind;
  color: PaletteId;
  settings: AgentSettings;
};

export type NewGroup = {
  title: string;
  cwd: string;
  username: string;
  members: NewMember[];
  callOrder?: string[];
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
    validateNewGroup(input);
    const id = randomUUID();
    const agents: Group["agents"] = {};
    for (const member of input.members) {
      agents[member.tag] = {
        kind: member.kind,
        color: member.color,
        nativeSessionId: null,
        cursor: 0,
        settings: { ...member.settings },
      };
    }
    const now = Date.now();
    const group: Group = {
      id,
      title: input.title,
      cwd: input.cwd,
      username: input.username,
      members: input.members.map((member) => member.tag),
      callOrder: [...(input.callOrder ?? [])],
      agents,
      createdAt: new Date(now).toISOString(),
      updatedAt: now,
      pinned: false,
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
  if (!isObject(value)) return fail("格式或版本不对");
  const root = value;
  if (root.version === 1) throw new Error("群数据是旧版本（1），需要先清理。");
  if (root.version !== STORE_VERSION || !isObject(root.group)) {
    return fail("格式或版本不对");
  }
  const group = root.group;
  if (group.id !== id) fail("id 和目录名不一致");
  const members = stringArray(group.members) ?? fail("members 不对");
  if (!members.every((member) => AGENT_NAME_PATTERN.test(member))) fail("members 里有非法标签");
  const callOrder = stringArray(group.callOrder) ?? fail("callOrder 不对");
  if (!callOrder.every((agent) => members.includes(agent))) fail("callOrder 里有不是成员的 AI");
  if (!isObject(group.agents)) fail("agents 不对");
  const agents: { [agent: string]: AgentState } = {};
  for (const member of members) {
    const state = (group.agents as { [key: string]: unknown })[member];
    if (!isObject(state) ||
        !isAgentKind(state.kind) ||
        !isPaletteId(state.color) ||
        !(state.nativeSessionId === null || typeof state.nativeSessionId === "string") ||
        !Number.isSafeInteger(state.cursor) || (state.cursor as number) < 0) {
      fail(`agents.${member} 不对`);
    }
    const valid = state as {
      kind: AgentKind;
      color: PaletteId;
      nativeSessionId: string | null;
      cursor: number;
      settings: unknown;
    };
    const settings = parseSettings(valid.settings) ?? fail(`agents.${member}.settings 不对`);
    agents[member] = {
      kind: valid.kind,
      color: valid.color,
      nativeSessionId: valid.nativeSessionId,
      cursor: valid.cursor,
      settings,
    };
  }
  for (const key of ["title", "cwd", "username", "createdAt"] as const) {
    if (typeof group[key] !== "string") fail(`${key} 不对`);
  }
  for (const key of ["trashedAt", "deletingAt"] as const) {
    const value = group[key];
    if (value !== null && typeof value !== "string") fail(`${key} 不对`);
  }
  if (typeof group.updatedAt !== "number" || !Number.isFinite(group.updatedAt)) return fail("updatedAt 不对");
  if (group.pinned !== undefined && typeof group.pinned !== "boolean") fail("pinned 不对");
  const updatedAt = group.updatedAt;
  return {
    id,
    title: group.title as string,
    cwd: group.cwd as string,
    username: group.username as string,
    members,
    callOrder,
    agents,
    createdAt: group.createdAt as string,
    updatedAt,
    pinned: group.pinned === true,
    trashedAt: group.trashedAt as string | null,
    deletingAt: group.deletingAt as string | null,
  };
}

function parseTranscript(value: unknown, id: string): TranscriptEntry[] {
  const fail = (detail: string): never => {
    throw new Error(`群聊记录损坏（${id}）：${detail}`);
  };
  if (value === null) fail("缺少 transcript.json");
  if (!isObject(value)) return fail("格式或版本不对");
  const root = value;
  if (root.version === 1) throw new Error("群聊记录是旧版本（1），需要先清理。");
  if (root.version !== STORE_VERSION || !Array.isArray(root.entries)) {
    return fail("格式或版本不对");
  }
  const entries: TranscriptEntry[] = [];
  for (const raw of root.entries) {
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

function validateNewGroup(input: NewGroup): void {
  const tags = input.members.map((member) => member.tag);
  if (tags.some((tag) => !AGENT_NAME_PATTERN.test(tag))) throw new Error("群成员标签不合法。");
  if (new Set(tags).size !== tags.length) throw new Error("群成员标签不能重复。");
  for (const member of input.members) {
    if (!isAgentKind(member.kind)) throw new Error(`群成员 ${member.tag} 的 CLI 种类不合法。`);
    if (!isPaletteId(member.color)) throw new Error(`群成员 ${member.tag} 的主色不合法。`);
    if (parseSettings(member.settings) === null) throw new Error(`群成员 ${member.tag} 的设置不合法。`);
  }
  const callOrder = input.callOrder ?? [];
  if (new Set(callOrder).size !== callOrder.length) throw new Error("callOrder 里有重复的 AI。");
  if (!callOrder.every((tag) => tags.includes(tag))) throw new Error("callOrder 里有不是成员的 AI。");
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
