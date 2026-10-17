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
 * Groups and chat records. One directory per group: group.json holds the group's data and transcript.json its chat record.
 *
 * Everything stays in memory and reads are synchronous; writes are queued per group, and the in-memory value is replaced only after the disk write succeeds,
 * so on a failed write memory keeps the old value.
 */
export class GroupStore {
  readonly #root: string;
  readonly #records = new Map<string, GroupRecord>();

  private constructor(root: string) {
    this.#root = root;
  }

  /** Any corrupt group file throws immediately; the original files are never overwritten with an empty state. */
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
      archived: false,
      usageAgent: null,
      trashedAt: null,
      deletingAt: null,
    };
    await this.#writeTranscript(id, []);
    await this.#writeGroup(group);
    this.#records.set(id, { group, transcript: [], queue: Promise.resolve() });
    return structuredClone(group);
  }

  /** Modifies a copy, which takes effect only after the disk write succeeds. */
  update(id: string, mutate: (group: Group) => void): Promise<Group> {
    return this.#enqueue(id, async (record) => {
      const next = structuredClone(record.group);
      mutate(next);
      if (next.id !== id) throw new Error("The group id cannot change.");
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
      // As in Relayu, the last activity time is refreshed as soon as a message enters the record.
      await this.#writeGroup(nextGroup);
      record.group = nextGroup;
      await this.#writeTranscript(id, next);
      record.transcript = next;
      return full;
    });
  }

  /** Deletes the group directory (the group's data and chat record); after that the group no longer exists. */
  remove(id: string): Promise<void> {
    return this.#enqueue(id, async () => {
      await rm(path.join(this.#root, id), { recursive: true, force: true });
      this.#records.delete(id);
    });
  }

  #require(id: string): GroupRecord {
    const record = this.#records.get(id);
    if (!record) throw new Error(`Group does not exist: ${id}`);
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
    throw new Error(`Group data is corrupt (${id}): ${detail}`);
  };
  if (value === null) fail("group.json is missing");
  if (!isObject(value)) return fail("wrong format or version");
  const root = value;
  if (root.version === 1) throw new Error("Group data is from an old version (1) and must be cleared first.");
  if (root.version !== STORE_VERSION || !isObject(root.group)) {
    return fail("wrong format or version");
  }
  const group = root.group;
  if (group.id !== id) fail("id does not match the directory name");
  const members = stringArray(group.members) ?? fail("invalid members");
  if (!members.every((member) => AGENT_NAME_PATTERN.test(member))) fail("members contains an invalid tag");
  const callOrder = stringArray(group.callOrder) ?? fail("invalid callOrder");
  if (!callOrder.every((agent) => members.includes(agent))) fail("callOrder contains an AI that is not a member");
  if (!isObject(group.agents)) fail("invalid agents");
  const agents: { [agent: string]: AgentState } = {};
  for (const member of members) {
    const state = (group.agents as { [key: string]: unknown })[member];
    if (!isObject(state) ||
        !isAgentKind(state.kind) ||
        !isPaletteId(state.color) ||
        !(state.nativeSessionId === null || typeof state.nativeSessionId === "string") ||
        !Number.isSafeInteger(state.cursor) || (state.cursor as number) < 0) {
      fail(`invalid agents.${member}`);
    }
    const valid = state as {
      kind: AgentKind;
      color: PaletteId;
      nativeSessionId: string | null;
      cursor: number;
      settings: unknown;
    };
    const settings = parseSettings(valid.settings) ?? fail(`invalid agents.${member}.settings`);
    agents[member] = {
      kind: valid.kind,
      color: valid.color,
      nativeSessionId: valid.nativeSessionId,
      cursor: valid.cursor,
      settings,
    };
  }
  for (const key of ["title", "cwd", "username", "createdAt"] as const) {
    if (typeof group[key] !== "string") fail(`invalid ${key}`);
  }
  for (const key of ["trashedAt", "deletingAt"] as const) {
    const value = group[key];
    if (value !== null && typeof value !== "string") fail(`invalid ${key}`);
  }
  if (typeof group.updatedAt !== "number" || !Number.isFinite(group.updatedAt)) return fail("invalid updatedAt");
  if (group.pinned !== undefined && typeof group.pinned !== "boolean") fail("invalid pinned");
  if (group.archived !== undefined && typeof group.archived !== "boolean") fail("invalid archived");
  if (group.usageAgent !== undefined && group.usageAgent !== null && typeof group.usageAgent !== "string") {
    fail("invalid usageAgent");
  }
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
    archived: group.archived === true,
    // Older groups missing the field are treated as off; so are members not in the group.
    usageAgent: typeof group.usageAgent === "string" && members.includes(group.usageAgent)
      ? group.usageAgent
      : null,
    trashedAt: group.trashedAt as string | null,
    deletingAt: group.deletingAt as string | null,
  };
}

function parseTranscript(value: unknown, id: string): TranscriptEntry[] {
  const fail = (detail: string): never => {
    throw new Error(`Chat record is corrupt (${id}): ${detail}`);
  };
  if (value === null) fail("transcript.json is missing");
  if (!isObject(value)) return fail("wrong format or version");
  const root = value;
  if (root.version === 1) throw new Error("The chat record is from an old version (1) and must be cleared first.");
  if (root.version !== STORE_VERSION || !Array.isArray(root.entries)) {
    return fail("wrong format or version");
  }
  const entries: TranscriptEntry[] = [];
  for (const raw of root.entries) {
    const expected = entries.length + 1;
    if (!isObject(raw) || raw.seq !== expected || typeof raw.at !== "string" ||
        typeof raw.text !== "string") {
      fail(`invalid entry ${expected}`);
    }
    const entry = raw as { [key: string]: unknown };
    const from = parseSpeaker(entry.from) ?? fail(`invalid speaker in entry ${expected}`);
    const status = entry.status;
    if (status !== undefined && !isReplyStatus(status)) fail(`invalid status in entry ${expected}`);
    if (entry.error !== undefined && typeof entry.error !== "string") fail(`invalid error in entry ${expected}`);
    const activities = entry.activities;
    if (activities !== undefined && !(Array.isArray(activities) &&
        activities.every((item) => isObject(item) && typeof item.kind === "string"))) {
      fail(`invalid activities in entry ${expected}`);
    }
    const attachments = entry.attachments;
    if (attachments !== undefined && !(Array.isArray(attachments) && attachments.every(isStoredAttachment))) {
      fail(`invalid attachments in entry ${expected}`);
    }
    const recipients = entry.recipients;
    if (recipients !== undefined && stringArray(recipients) === null) fail(`invalid attachment recipients in entry ${expected}`);
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
  if (tags.some((tag) => !AGENT_NAME_PATTERN.test(tag))) throw new Error("Invalid member tag.");
  if (new Set(tags).size !== tags.length) throw new Error("Member tags must be unique.");
  for (const member of input.members) {
    if (!isAgentKind(member.kind)) throw new Error(`Invalid CLI kind for member ${member.tag}.`);
    if (!isPaletteId(member.color)) throw new Error(`Invalid color for member ${member.tag}.`);
    if (parseSettings(member.settings) === null) throw new Error(`Invalid settings for member ${member.tag}.`);
  }
  const callOrder = input.callOrder ?? [];
  if (new Set(callOrder).size !== callOrder.length) throw new Error("callOrder contains duplicate AIs.");
  if (!callOrder.every((tag) => tags.includes(tag))) throw new Error("callOrder contains an AI that is not a member.");
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
