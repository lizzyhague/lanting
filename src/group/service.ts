import { randomUUID } from "node:crypto";
import path from "node:path";

import type { AgentKind } from "../agents/kinds.ts";
import type { PaletteId } from "../agents/palette.ts";
import { kindDisplayName, SUPPORTED_AGENT_KINDS, type AgentRegistry } from "../agents/registry.ts";
import { DEFAULT_AGENT_SETTINGS, type AgentAdapter, type AgentCatalog, type AgentSettings } from "../agents/types.ts";
import type { ApprovalEvent, ApprovalRequest } from "../approvals/registry.ts";
import { publicAttachment, type StoredAttachment } from "../attachments/prompt.ts";
import { PathRedactor } from "../attachments/redact.ts";
import type { SharedUploadClient } from "../attachments/shared-upload-client.ts";
import { featureIds, type AgentFeatureId, type UsagePart } from "../features/index.ts";
import {
  ATTACHMENT_LEASE_RENEW_INTERVAL_MS,
  MAX_MESSAGE_ATTACHMENTS,
  MAX_UPLOAD_BYTES,
  SharedUploadError,
  UPLOAD_CALLER,
  type AttachmentBinding,
  type UploadTicket,
} from "../attachments/types.ts";
import type { GroupStore } from "../state/group-store.ts";
import {
  isAgentComplete,
  SettingsError,
  type AgentRecord,
  type Settings,
  type SettingsStore,
} from "../state/settings-store.ts";
import { listDirectories, resolveDirectory } from "./directories.ts";
import {
  GroupError,
  type CompactionSnapshot,
  type GroupEvent,
  type GroupRuntime,
  type RoundSnapshot,
} from "./runtime.ts";
import type { Group, TranscriptEntry } from "./types.ts";
import { usernameProblem } from "./username.ts";

const MAX_TITLE_LENGTH = 100;
const TITLE_LENGTH = 60;
const DEFAULT_TITLE = "新群";

type UploadClient = Pick<SharedUploadClient, "createTicket" | "createLease" | "renewLease" | "releaseLease">;
/** Trash keeps groups for 30 days from when they were moved in; the constant lives only here, and the page receives the derived expiry time. */
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60_000;
/** Interval of the expiry scan. One scan runs at startup to catch groups that expired while the service was down. */
const TRASH_SWEEP_INTERVAL_MS = 24 * 60 * 60_000;

export type GroupSummary = {
  id: string;
  title: string;
  /** Name of the working directory under the project root. */
  directory: string;
  members: string[];
  callOrder: string[];
  /** Primary color of each frozen tag. */
  colors: Record<string, PaletteId>;
  /** Each member's model, reasoning effort and permission in this group. */
  settings: Record<string, AgentSettings>;
  /** Sub-features supported by each member's CLI. */
  features: Record<string, AgentFeatureId[]>;
  /** Members whose CLI isn't connected to the current service. */
  unavailable: string[];
  createdAt: string;
  updatedAt: number;
  /** Whether the group is pinned to the top of recent groups. */
  pinned: boolean;
  /** Whether the group has been moved from recent groups to the archive. */
  archived: boolean;
  /** Which member the title bar's usage row shows; null means off. */
  usageAgent: string | null;
  busy: boolean;
  /** Current busy phase and its member; agent is null right as a phase starts or during a handoff between members. */
  busyStatus: { kind: "speaking" | "compacting"; agent: string | null } | null;
  /** When the group was moved to trash; null when it isn't in trash. */
  trashedAt: string | null;
  /** When the group is permanently deleted on expiry, derived from trashedAt. */
  purgeAt: string | null;
  /** Permanent deletion in progress (or half done, awaiting retry). */
  deleting: boolean;
};

/** Chat record sent to the browser: attachments without paths. */
export type PublicEntry = Omit<TranscriptEntry, "attachments"> & {
  attachments?: Omit<StoredAttachment, "path">[];
};

export type GroupSnapshot = {
  group: GroupSummary;
  transcript: PublicEntry[];
  round: RoundSnapshot | null;
  compaction: CompactionSnapshot | null;
  approvals: PublicApproval[];
  /** The latest usage read for the current usageAgent; null when there is no result yet or it is off. */
  usage: PublicUsage | null;
};

/** remainingMs: milliseconds left before auto-rejection at send time. The web page counts down by its own clock, unaffected by skew between device and server clocks. */
export type PublicApproval = ApprovalRequest & { remainingMs: number };

export type PublicUsage =
  | { status: "not_started" }
  | { status: "ok"; parts: UsagePart[] }
  /** The read failed. */
  | { status: "unavailable" };

export type UsageReason = "view" | "turn" | "visible";

/** A member's in-flight usage read. next is the one follow-up read to run after it; only one is kept at a time. */
type UsageTask = {
  done: Promise<void>;
  /** Whether the current read may start a process. */
  open: boolean;
  next: { open: boolean; turn: boolean } | null;
};

/** Bulk operations are processed one by one; one failure doesn't affect the others. */
export type BatchResult = {
  done: string[];
  failed: { groupId: string; message: string }[];
};

export type PublicSettings = Omit<Settings, "agents"> & {
  agents: (AgentRecord & { complete: boolean })[];
};

export type ServiceEvent =
  | { scope: "global"; payload: { type: "group.created" | "group.updated"; group: GroupSummary } }
  | { scope: "global"; payload: { type: "group.removed"; groupId: string } }
  | { scope: "global"; payload: { type: "settings.updated"; settings: PublicSettings } }
  | { scope: "group"; groupId: string; payload: PublicGroupEvent | ApprovalEvent };

/** Before group events go to the browser, paths are stripped from attachments in the chat record. */
export type PublicGroupEvent =
  | Exclude<GroupEvent, { type: "entry.appended" | "agent.settled" }>
  | { type: "entry.appended"; groupId: string; entry: PublicEntry }
  | { type: "usage.updated"; groupId: string; agent: string; usage: PublicUsage };

/** Group operations used by browser connections. Gathers storage, scheduling, approvals and the AI registry in one place. */
export class GroupService {
  readonly #projectRoot: string;
  readonly #store: GroupStore;
  readonly #runtime: GroupRuntime;
  readonly #agents: AgentRegistry;
  readonly #settings: SettingsStore;
  readonly #uploads: UploadClient | null;
  readonly #listeners = new Set<(event: ServiceEvent) => void>();
  /** Groups being moved to trash or permanently deleted; no new round or compaction can start meanwhile. */
  readonly #locked = new Set<string>();
  /** usage cache, keyed by "group id\0member". */
  readonly #usage = new Map<string, PublicUsage>();
  readonly #usageTasks = new Map<string, UsageTask>();
  #sweeper: NodeJS.Timeout | null = null;

  constructor(options: {
    projectRoot: string;
    store: GroupStore;
    runtime: GroupRuntime;
    agents: AgentRegistry;
    settings: SettingsStore;
    /** ai-remote-upload client; attachments can't be sent without it. */
    uploads?: UploadClient | null;
  }) {
    this.#projectRoot = options.projectRoot;
    this.#store = options.store;
    this.#runtime = options.runtime;
    this.#agents = options.agents;
    this.#settings = options.settings;
    this.#uploads = options.uploads ?? null;

    this.#runtime.onEvent((event) => {
      if (event.type === "agent.settled") {
        if (this.#store.get(event.groupId)?.usageAgent === event.agent) {
          void this.refreshUsage(event.groupId, "turn");
        }
        return;
      }
      const payload = event.type === "entry.appended" ? { ...event, entry: publicEntry(event.entry) } : event;
      this.#emit({ scope: "group", groupId: event.groupId, payload });
      if (event.type === "entry.appended" || event.type === "round.started" || event.type === "agent.started" ||
          event.type === "round.ended" || event.type === "compact.started" || event.type === "compact.progress" ||
          event.type === "compact.ended") {
        this.#emitUpdated(event.groupId);
      }
    });
    this.#runtime.approvals.onEvent((event) => {
      const groupId = event.approval.groupId;
      this.#emit({ scope: "group", groupId, payload: publicApprovalEvent(event, this.#attachmentRedactor(groupId)) });
    });
  }

  onEvent(listener: (event: ServiceEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  settings(): PublicSettings {
    return this.#publicSettings(this.#settings.get());
  }

  agentKinds(): { kind: AgentKind; displayName: string; configured: boolean; features: AgentFeatureId[] }[] {
    return SUPPORTED_AGENT_KINDS.map((entry) => ({
      ...entry,
      configured: this.#agents.has(entry.kind),
      features: this.#agents.has(entry.kind) ? featureIds(this.#agents.get(entry.kind).features) : [],
    }));
  }

  /** Changing the username only affects groups created afterwards. */
  async setUsername(username: string): Promise<PublicSettings> {
    const problem = usernameProblem(username, this.#settings.get().agents.map((agent) => agent.name));
    if (problem) throw new GroupError("invalid_username", problem, { field: "username" });
    await this.#settings.update((next) => {
      next.username = username;
    });
    return this.#emitSettings();
  }

  /** Group chat collaboration rules take effect the next time each AI opens a session; sessions already open aren't affected. */
  async setCollaboration(collaboration: string): Promise<PublicSettings> {
    await this.#settings.update((next) => {
      next.collaboration = collaboration;
    });
    return this.#emitSettings();
  }

  /** Models and permissions this AI can choose on the settings page, looked up from the project root. */
  async settingsCatalog(agentId: string): Promise<AgentCatalog> {
    const agent = this.#settingsAgent(this.#settings.get(), agentId);
    return this.#catalogOf(this.#adapterForSettings(agent), this.#projectRoot);
  }

  /** Each AI's default settings, copied into newly created groups; existing groups aren't affected. */
  async setDefaultSettings(agentId: string, settings: AgentSettings): Promise<PublicSettings> {
    const agent = this.#settingsAgent(this.#settings.get(), agentId);
    const kind = agent.kind;
    const adapter = this.#adapterForSettings(agent);
    const catalog = await this.#catalogOf(adapter, this.#projectRoot);
    this.#checkSettings(agent.name, adapter, catalog, settings, { field: "defaults", agentId });
    await this.#settings.update((next) => {
      const current = next.agents.find((item) => item.id === agentId);
      if (!current) throw new GroupError("agent_not_found", `没有这个 AI：${agentId}`);
      if (current.kind !== kind) {
        throw new GroupError("agent_changed", `${current.name} 的 CLI 已经变化，请重试。`);
      }
      current.defaults = { ...settings };
    });
    return this.#emitSettings();
  }

  async addAgent(): Promise<{
    settings: PublicSettings;
    agentId: string;
  }> {
    const agentId = randomUUID();
    await this.#settings.update((next) => {
      next.agents.push({
        id: agentId,
        name: "",
        kind: null,
        color: null,
        defaults: { ...DEFAULT_AGENT_SETTINGS },
      });
    });
    return { settings: this.#emitSettings(), agentId };
  }

  async updateAgent(
    agentId: string,
    patch: { name?: string; kind?: string | null; color?: string | null },
  ): Promise<PublicSettings> {
    await this.#settings.update((next) => {
      const current = next.agents.find((agent) => agent.id === agentId);
      if (!current) throw new GroupError("agent_not_found", `没有这个 AI：${agentId}`);
      if (patch.kind !== undefined && patch.kind !== current.kind &&
          patch.kind !== null && !this.#agents.has(patch.kind)) {
        throw new SettingsError("这个 CLI 没有在 config.json 中配置。", "kind", agentId);
      }
      if (patch.name !== undefined) current.name = patch.name;
      if (patch.kind !== undefined) current.kind = patch.kind as AgentKind | null;
      if (patch.color !== undefined) current.color = patch.color as PaletteId | null;
    });
    return this.#emitSettings();
  }

  async removeAgent(agentId: string): Promise<PublicSettings> {
    await this.#settings.update((next) => {
      const index = next.agents.findIndex((agent) => agent.id === agentId);
      if (index < 0) throw new GroupError("agent_not_found", `没有这个 AI：${agentId}`);
      next.agents.splice(index, 1);
    });
    return this.#emitSettings();
  }

  async reorderAgents(order: string[]): Promise<PublicSettings> {
    await this.#settings.update((next) => {
      const byId = new Map(next.agents.map((agent) => [agent.id, agent]));
      if (order.length !== next.agents.length || new Set(order).size !== order.length ||
          order.some((agentId) => !byId.has(agentId))) {
        throw new GroupError("invalid_order", "AI 顺序必须是当前列表的完整排列。");
      }
      next.agents = order.map((agentId) => byId.get(agentId)!);
    });
    return this.#emitSettings();
  }

  directories(): Promise<string[]> {
    return listDirectories(this.#projectRoot);
  }

  groups(): GroupSummary[] {
    return this.#store.list()
      .sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
      .map((group) => this.#summary(group));
  }

  async create(input: { directory: string; members: string[]; title: string }): Promise<GroupSummary> {
    const cwd = await resolveDirectory(this.#projectRoot, input.directory);
    if (!cwd) throw new GroupError("invalid_directory", "工作目录不存在，或不在项目根目录的第一层。");
    if (input.members.length === 0) throw new GroupError("no_members", "至少要拉一个 AI 进群。");
    if (new Set(input.members).size !== input.members.length) {
      throw new GroupError("invalid_members", "成员里有重复的 AI。");
    }
    const settings = this.#settings.get();
    const requested = new Set(input.members);
    const selected = settings.agents.filter((agent) => requested.has(agent.id));
    if (selected.length !== input.members.length) {
      const known = new Set(selected.map((agent) => agent.id));
      const missing = input.members.find((id) => !known.has(id));
      throw new GroupError("invalid_members", `没有这个 AI：${missing ?? "未知"}`);
    }
    for (const agent of selected) {
      if (!isAgentComplete(agent, this.#agents.kinds)) {
        const label = agent.name || "未命名的 AI";
        throw new GroupError("invalid_members", `${label} 的设置不完整。`);
      }
    }
    const memberIds = selected.map((agent) => agent.id);
    const members = selected.map((agent) => ({
      tag: agent.name,
      kind: agent.kind!,
      color: agent.color!,
      settings: { ...agent.defaults },
    }));
    const tags = members.map((member) => member.tag);
    const title = input.title.trim().slice(0, MAX_TITLE_LENGTH) || DEFAULT_TITLE;
    // The username and each AI's identity and settings are copied from one snapshot; later settings changes don't affect this group.
    const group = await this.#store.create({
      title,
      cwd,
      username: settings.username,
      members,
      callOrder: tags,
    });
    const summary = this.#summary(group);
    this.#emit({ scope: "global", payload: { type: "group.created", group: summary } });
    // Remember which AIs were checked this time and check them again on the next create, across devices too.
    await this.#settings.update((next) => {
      next.createMembers = [...memberIds];
    });
    this.#emitSettings();
    return summary;
  }

  snapshot(groupId: string): GroupSnapshot {
    const group = this.#requireActive(groupId);
    return {
      group: this.#summary(group),
      transcript: this.#store.transcript(groupId).map(publicEntry),
      round: this.#runtime.round(groupId),
      compaction: this.#runtime.compaction(groupId),
      approvals: this.#runtime.approvals.pending(groupId)
        .map((approval) => publicApproval(approval, this.#attachmentRedactor(groupId))),
      usage: group.usageAgent ? this.#usage.get(usageKey(groupId, group.usageAgent)) ?? null : null,
    };
  }

  /** Every call order change is saved to the backend so it carries over to other devices. */
  async setCallOrder(groupId: string, order: string[]): Promise<GroupSummary> {
    const group = this.#requireActive(groupId);
    if (new Set(order).size !== order.length) throw new GroupError("invalid_order", "点名里有重复的 AI。");
    for (const agent of order) {
      if (!group.members.includes(agent)) throw new GroupError("invalid_order", `${agent} 不是这个群的成员。`);
    }
    const updated = await this.#store.update(groupId, (next) => {
      next.callOrder = [...order];
      next.updatedAt = Date.now();
    });
    const summary = this.#summary(updated);
    this.#emit({ scope: "global", payload: { type: "group.updated", group: summary } });
    return summary;
  }

  /** Models and permissions this AI can choose in the member panel. */
  async catalog(groupId: string, agent: string): Promise<AgentCatalog> {
    const group = this.#requireActive(groupId);
    this.#requireMember(group, agent);
    return this.#catalogOf(this.#adapterFor(group, agent), group.cwd);
  }

  /**
   * Changes an AI's settings in this group, validated against the lists its CLI provides.
   * Can be changed at any time; takes effect on this AI's next reply or compaction.
   */
  async setAgentSettings(groupId: string, agent: string, settings: AgentSettings): Promise<GroupSummary> {
    const group = this.#requireActive(groupId);
    this.#requireMember(group, agent);
    const adapter = this.#adapterFor(group, agent);
    this.#checkSettings(agent, adapter, await this.#catalogOf(adapter, group.cwd), settings);
    const updated = await this.#store.update(groupId, (next) => {
      const state = next.agents[agent];
      if (state) state.settings = { ...settings };
      next.updatedAt = Date.now();
    });
    const summary = this.#summary(updated);
    this.#emit({ scope: "global", payload: { type: "group.updated", group: summary } });
    return summary;
  }

  /** Compaction runs in the background and its result is written to the chat record. */
  compact(groupId: string, agents: string[]): void {
    this.#requireActive(groupId);
    void this.#runtime.compact(groupId, agents).done;
  }

  /** Only renames the group in lanting; native session names are left alone. Can be changed at any time. */
  async rename(groupId: string, title: string): Promise<GroupSummary> {
    this.#requireActive(groupId);
    const trimmed = title.trim();
    if (!trimmed) throw new GroupError("invalid_title", "群名不能为空。");
    if (trimmed.length > MAX_TITLE_LENGTH) {
      throw new GroupError("invalid_title", `群名最多 ${MAX_TITLE_LENGTH} 个字。`);
    }
    const updated = await this.#store.update(groupId, (next) => {
      next.title = trimmed;
      next.updatedAt = Date.now();
    });
    const summary = this.#summary(updated);
    this.#emit({ scope: "global", payload: { type: "group.updated", group: summary } });
    return summary;
  }

  /** Pinning only changes list grouping and isn't group activity, so updatedAt isn't refreshed. */
  async setPinned(groupId: string, pinned: boolean): Promise<GroupSummary> {
    const group = this.#requireActive(groupId);
    if (group.pinned === pinned) return this.#summary(group);
    const updated = await this.#store.update(groupId, (next) => {
      next.pinned = pinned;
    });
    const summary = this.#summary(updated);
    this.#emit({ scope: "global", payload: { type: "group.updated", group: summary } });
    return summary;
  }

  /** Which member the usage row shows, stored on the group so it is the same across devices. Display only; updatedAt isn't refreshed. */
  async setUsageAgent(groupId: string, agent: string | null): Promise<GroupSummary> {
    let group = this.#requireActive(groupId);
    if (agent !== null) {
      this.#requireMember(group, agent);
      if (!this.#adapterFor(group, agent).features.usage) {
        throw new GroupError("unsupported", `${agent} 不支持 usage。`);
      }
    }
    if (group.usageAgent !== agent) {
      group = await this.#store.update(groupId, (next) => {
        next.usageAgent = agent;
      });
    }
    const summary = this.#summary(group);
    this.#emit({ scope: "global", payload: { type: "group.updated", group: summary } });
    if (agent !== null) void this.refreshUsage(groupId, "view");
    return summary;
  }

  /**
   * Reads usage for the current usageAgent, writes it to the cache and sends usage.updated. Reads for the same member are merged:
   * - if view arrives while an in-flight read can't start a process, one more read that can follows;
   * - if turn arrives while a read is in flight, one more read follows, repeating until no new turn arrives during a read;
   * - only one follow-up read is kept at a time; requests arriving while it waits are merged into it.
   */
  refreshUsage(groupId: string, reason: UsageReason): Promise<void> {
    if (!this.#usageReadable(groupId)) return Promise.resolve();
    const group = this.#store.get(groupId)!;
    const agent = group.usageAgent;
    if (!agent || !this.#supportsUsage(group, agent)) return Promise.resolve();
    const key = usageKey(groupId, agent);
    const task = this.#usageTasks.get(key);
    const open = reason === "view";
    if (task) {
      if (reason === "visible" || (open && task.open)) return task.done;
      task.next = {
        open: (task.next?.open ?? false) || open,
        turn: (task.next?.turn ?? false) || reason === "turn",
      };
      return task.done;
    }
    const created: UsageTask = { done: Promise.resolve(), open, next: null };
    this.#usageTasks.set(key, created);
    created.done = this.#runUsage(groupId, agent, reason, created).finally(() => {
      if (this.#usageTasks.get(key) === created) this.#usageTasks.delete(key);
    });
    return created.done;
  }

  async #runUsage(groupId: string, agent: string, reason: UsageReason, task: UsageTask): Promise<void> {
    let current = reason;
    for (;;) {
      task.open = current === "view";
      await this.#readUsage(groupId, agent, current);
      const next = task.next;
      task.next = null;
      if (!next) return;
      current = next.open ? "view" : next.turn ? "turn" : "visible";
    }
  }

  async #readUsage(groupId: string, agent: string, reason: UsageReason): Promise<void> {
    if (!this.#usageReadable(groupId)) return;
    let usage: PublicUsage;
    try {
      const result = await this.#runtime.readUsage(groupId, agent, reason);
      if (result.status === "none") return;
      usage = result;
    } catch (error) {
      console.error(`Reading usage for ${agent} failed: ${error instanceof Error ? error.message : String(error)}`);
      usage = { status: "unavailable" };
    }
    // Late result: discard it if the group was deleted, locked or moved to trash. A change of usageAgent doesn't matter; the result still belongs to this member.
    if (!this.#usageReadable(groupId)) return;
    this.#usage.set(usageKey(groupId, agent), usage);
    this.#emit({ scope: "group", groupId, payload: { type: "usage.updated", groupId, agent, usage } });
  }

  #usageReadable(groupId: string): boolean {
    const group = this.#store.get(groupId);
    return group !== null && !group.archived && !group.trashedAt &&
      !group.deletingAt && !this.#locked.has(groupId);
  }

  #supportsUsage(group: Group, agent: string): boolean {
    const kind = group.agents[agent]?.kind;
    return kind !== undefined && this.#agents.has(kind) && typeof this.#agents.get(kind).features.usage === "function";
  }

  /** Archiving only changes lanting's records; the group must be idle, and its session processes are closed. */
  archive(groupIds: string[]): Promise<BatchResult> {
    return this.#batch(groupIds, async (groupId) => {
      const group = this.#requireGroup(groupId);
      if (group.trashedAt) throw new GroupError("group_trashed", "回收站里的群不能归档，请先恢复。");
      if (group.archived) throw new GroupError("already_archived", "已经归档了。");
      if (this.#runtime.isBusy(groupId)) {
        throw new GroupError("busy", "群里正在发言或压缩，请结束后再归档。");
      }
      if (this.#locked.has(groupId)) throw new GroupError("busy", "这个群正在整理。");
      this.#locked.add(groupId);
      try {
        await this.#runtime.closeSessions(groupId);
        const updated = await this.#store.update(groupId, (next) => {
          next.archived = true;
          next.updatedAt = Date.now();
        });
        this.#emit({ scope: "global", payload: { type: "group.updated", group: this.#summary(updated) } });
      } finally {
        this.#locked.delete(groupId);
      }
    });
  }

  unarchive(groupIds: string[]): Promise<BatchResult> {
    return this.#batch(groupIds, async (groupId) => {
      const group = this.#requireGroup(groupId);
      if (group.trashedAt) {
        throw new GroupError("group_trashed", "回收站里的群不能取消归档，请先恢复。");
      }
      if (!group.archived) throw new GroupError("not_archived", "这个群没有归档。");
      if (this.#locked.has(groupId)) throw new GroupError("busy", "这个群正在整理。");
      const updated = await this.#store.update(groupId, (next) => {
        next.archived = false;
        next.updatedAt = Date.now();
      });
      this.#emit({ scope: "global", payload: { type: "group.updated", group: this.#summary(updated) } });
    });
  }

  /** Moving to trash only sets a flag and can be undone. The group must be idle; its session processes are closed. */
  trash(groupIds: string[]): Promise<BatchResult> {
    return this.#batch(groupIds, async (groupId) => {
      const group = this.#requireGroup(groupId);
      if (group.trashedAt) throw new GroupError("already_trashed", "已经在回收站里了。");
      if (this.#runtime.isBusy(groupId)) {
        throw new GroupError("busy", "群里正在发言或压缩，请结束后再删除。");
      }
      this.#locked.add(groupId);
      try {
        await this.#runtime.closeSessions(groupId);
        const now = Date.now();
        const updated = await this.#store.update(groupId, (next) => {
          next.trashedAt = new Date(now).toISOString();
          next.updatedAt = now;
        });
        this.#emit({ scope: "global", payload: { type: "group.updated", group: this.#summary(updated) } });
      } finally {
        this.#locked.delete(groupId);
      }
    });
  }

  restore(groupIds: string[]): Promise<BatchResult> {
    return this.#batch(groupIds, async (groupId) => {
      const group = this.#requireGroup(groupId);
      if (!group.trashedAt) throw new GroupError("not_trashed", "不在回收站里。");
      if (group.deletingAt || this.#locked.has(groupId)) {
        throw new GroupError("deleting", "正在永久删除，不能恢复。");
      }
      const updated = await this.#store.update(groupId, (next) => {
        next.trashedAt = null;
        next.updatedAt = Date.now();
      });
      this.#emit({ scope: "global", payload: { type: "group.updated", group: this.#summary(updated) } });
    });
  }

  /** Permanently deletes a group in trash, together with each AI's native sessions. */
  purge(groupIds: string[]): Promise<BatchResult> {
    return this.#batch(groupIds, async (groupId) => {
      const group = this.#requireGroup(groupId);
      if (!group.trashedAt) throw new GroupError("not_trashed", "只能永久删除回收站里的群。");
      await this.#purge(groupId);
    });
  }

  /**
   * Resumes half-deleted groups, then permanently deletes expired ones. A failing group is only logged and stays in trash for the next scan to retry.
   */
  async sweepTrash(now = Date.now()): Promise<void> {
    for (const group of this.#store.list()) {
      const expired = group.trashedAt !== null && Date.parse(group.trashedAt) + TRASH_RETENTION_MS <= now;
      if (!group.deletingAt && !expired) continue;
      try {
        await this.#purge(group.id);
      } catch (error) {
        console.error(`Permanently deleting group ${group.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  startTrashSweeper(intervalMs = TRASH_SWEEP_INTERVAL_MS): void {
    if (this.#sweeper) return;
    void this.sweepTrash();
    this.#sweeper = setInterval(() => void this.sweepTrash(), intervalMs);
    this.#sweeper.unref();
  }

  stopTrashSweeper(): void {
    if (this.#sweeper) clearInterval(this.#sweeper);
    this.#sweeper = null;
  }

  /**
   * As in Relayu: close processes and record deletingAt first, then delete native sessions one by one (clearing each id once deleted),
   * and only delete lanting's own data after all are gone. On failure deletingAt is kept, and later retries delete only what's left.
   */
  async #purge(groupId: string): Promise<void> {
    if (this.#locked.has(groupId)) throw new GroupError("busy", "这个群正在删除。");
    this.#locked.add(groupId);
    try {
      await this.#runtime.closeSessions(groupId);
      let group = this.#requireGroup(groupId);
      if (!group.deletingAt) {
        const now = Date.now();
        group = await this.#store.update(groupId, (next) => {
          next.deletingAt = new Date(now).toISOString();
          next.updatedAt = now;
        });
        this.#emit({ scope: "global", payload: { type: "group.updated", group: this.#summary(group) } });
      }
      const failures: string[] = [];
      for (const agent of group.members) {
        const state = group.agents[agent];
        if (!state?.nativeSessionId) continue;
        const nativeId = state.nativeSessionId;
        const deleteSession = this.#agents.has(state.kind)
          ? this.#agents.get(state.kind).features.deleteSession
          : undefined;
        if (!deleteSession) {
          await this.#store.update(groupId, (next) => {
            const current = next.agents[agent];
            if (current) current.nativeSessionId = null;
          });
          continue;
        }
        try {
          await deleteSession(nativeId, group.cwd);
          await this.#store.update(groupId, (next) => {
            const state = next.agents[agent];
            if (state) state.nativeSessionId = null;
          });
        } catch (error) {
          failures.push(`${agent}：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (failures.length > 0) {
        throw new GroupError("delete_failed", `有原生会话没删掉，稍后会自动重试。${failures.join("；")}`);
      }
      await this.#store.remove(groupId);
      for (const key of this.#usage.keys()) {
        if (key.startsWith(`${groupId}\0`)) this.#usage.delete(key);
      }
      this.#emit({ scope: "global", payload: { type: "group.removed", groupId } });
    } finally {
      this.#locked.delete(groupId);
    }
  }

  async #catalogOf(adapter: AgentAdapter, cwd: string): Promise<AgentCatalog> {
    return {
      models: adapter.features.models ? await adapter.features.models(cwd) : [],
      permissions: adapter.features.permissions ? await adapter.features.permissions(cwd) : [],
    };
  }

  async #batch(groupIds: string[], action: (groupId: string) => Promise<void>): Promise<BatchResult> {
    const result: BatchResult = { done: [], failed: [] };
    for (const groupId of new Set(groupIds)) {
      try {
        await action(groupId);
        result.done.push(groupId);
      } catch (error) {
        result.failed.push({ groupId, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  }

  /** Before uploading an attachment the browser requests a one-time ticket bound to this group. */
  async createAttachmentTicket(groupId: string, file: {
    originalName: string;
    declaredMime: string;
    expectedSize: number;
  }): Promise<UploadTicket> {
    const group = this.#requireActive(groupId);
    const uploads = this.#requireUploads();
    if (file.expectedSize > MAX_UPLOAD_BYTES) {
      throw new SharedUploadError("file_too_large", "单个文件不能超过 25 MiB。", 413);
    }
    return uploads.createTicket({ ...binding(group), ...file });
  }

  /**
   * With attachments, first request a lease for this round from ai-remote-upload and start once the paths are obtained; the lease is renewed every 5 minutes
   * and released when the round ends.
   */
  async startRound(
    groupId: string,
    text: string,
    order: string[],
    attachmentIds: string[] = [],
  ): Promise<{ roundId: string }> {
    const group = this.#requireActive(groupId);
    if (attachmentIds.length === 0) {
      const { roundId } = await this.#startRuntimeRound(groupId, text, order);
      return { roundId };
    }
    if (attachmentIds.length > MAX_MESSAGE_ATTACHMENTS) {
      throw new GroupError("too_many_attachments", `一条消息最多 ${MAX_MESSAGE_ATTACHMENTS} 个附件。`);
    }
    if (this.#runtime.isBusy(groupId)) throw new GroupError("busy", "这个群还有一轮没有结束。");
    const uploads = this.#requireUploads();
    const ownerId = randomUUID();
    const lease = await uploads.createLease(binding(group), ownerId, [...new Set(attachmentIds)]);
    const release = () => uploads.releaseLease(lease.leaseId, ownerId).catch((error: unknown) => {
      console.error(`Releasing the attachment lease failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    let started;
    try {
      this.#requireActive(groupId);
      started = await this.#startRuntimeRound(groupId, text, order, lease.attachments.map((attachment) => ({
        id: attachment.id,
        originalName: attachment.originalName,
        mimeType: attachment.detectedMime,
        kind: attachment.kind,
        size: attachment.size,
        path: attachment.path,
      })));
    } catch (error) {
      await release();
      throw error;
    }
    const renew = setInterval(() => {
      void uploads.renewLease(lease.leaseId, ownerId).catch((error: unknown) => {
        console.error(`Renewing the attachment lease failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, ATTACHMENT_LEASE_RENEW_INTERVAL_MS);
    renew.unref();
    void started.done.finally(() => {
      clearInterval(renew);
      void release();
    });
    return { roundId: started.roundId };
  }

  /** After runtime accepts the first round, the placeholder title is replaced with the first line of text; a failed rename doesn't turn the round into a send failure. */
  async #startRuntimeRound(
    groupId: string,
    text: string,
    order: string[],
    attachments: StoredAttachment[] = [],
  ): Promise<ReturnType<GroupRuntime["startRound"]>> {
    const group = this.#store.get(groupId);
    const autoTitle = group?.title === DEFAULT_TITLE &&
        !this.#store.transcript(groupId).some((entry) => entry.from.role === "host")
      ? titleFromText(text)
      : null;
    const started = this.#runtime.startRound(groupId, text, order, attachments);
    if (autoTitle !== null && autoTitle !== DEFAULT_TITLE) {
      try {
        let changed = false;
        const updated = await this.#store.update(groupId, (next) => {
          if (next.title !== DEFAULT_TITLE) return;
          next.title = autoTitle;
          next.updatedAt = Date.now();
          changed = true;
        });
        if (changed) {
          this.#emit({ scope: "global", payload: { type: "group.updated", group: this.#summary(updated) } });
        }
      } catch (error) {
        console.error(`Automatic rename of group ${groupId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return started;
  }

  interrupt(groupId: string): Promise<boolean> {
    this.#requireGroup(groupId);
    return this.#runtime.interrupt(groupId);
  }

  respondApproval(approvalId: string, decision: "allow" | "deny"): boolean {
    return this.#runtime.approvals.respond(approvalId, decision);
  }

  #requireGroup(groupId: string): Group {
    const group = this.#store.get(groupId);
    if (!group) throw new GroupError("group_not_found", "群不存在。");
    return group;
  }

  /** Groups that are archived, in trash or being cleaned up can't be used as the current group. */
  #requireActive(groupId: string): Group {
    const group = this.#requireGroup(groupId);
    if (group.archived) {
      throw new GroupError("group_archived", "这个群已经归档，请先取消归档。");
    }
    if (group.trashedAt || this.#locked.has(groupId)) {
      throw new GroupError("group_trashed", "这个群已经在回收站里了。");
    }
    return group;
  }

  #requireUploads(): UploadClient {
    if (!this.#uploads) throw new SharedUploadError("uploads_unavailable", "附件服务没有启用。", 503);
    return this.#uploads;
  }

  /** Every attachment path the browser can see is replaced with the original filename, including approval cards and reconnect snapshots. */
  #attachmentRedactor(groupId: string): PathRedactor {
    return new PathRedactor(new Map(this.#store.transcript(groupId).flatMap((entry) =>
      (entry.attachments ?? []).map((attachment) => [attachment.path, attachment.originalName] as const)
    )));
  }

  /** Validates settings against the lists the CLI provides. Reasoning effort requires a model first and is limited to the levels that model supports. */
  #checkSettings(
    agent: string,
    adapter: AgentAdapter,
    catalog: AgentCatalog,
    settings: AgentSettings,
    details?: Record<string, string>,
  ): void {
    if (!adapter.features.models && (settings.model !== null || settings.effort !== null)) {
      throw new GroupError("invalid_settings", `${agent} 使用的 CLI 不支持选择模型或思考强度。`, details);
    }
    if (!adapter.features.permissions && settings.permission !== null) {
      throw new GroupError("invalid_settings", `${agent} 使用的 CLI 不支持选择权限。`, details);
    }
    const model = settings.model === null ? null : catalog.models.find((item) => item.id === settings.model);
    if (model === undefined) {
      throw new GroupError("invalid_settings", `${agent} 没有这个模型：${settings.model}`, details);
    }
    if (settings.effort !== null) {
      if (!model) throw new GroupError("invalid_settings", "要先选模型，才能选思考强度。", details);
      if (!model.efforts.includes(settings.effort)) {
        throw new GroupError("invalid_settings", `${model.label} 不支持思考强度 ${settings.effort}。`, details);
      }
    }
    if (settings.permission !== null && !catalog.permissions.some((item) => item.id === settings.permission)) {
      throw new GroupError("invalid_settings", `${agent} 没有这个权限选项：${settings.permission}`, details);
    }
  }

  #emitSettings(): PublicSettings {
    const settings = this.settings();
    this.#emit({ scope: "global", payload: { type: "settings.updated", settings } });
    return settings;
  }

  #publicSettings(settings: Settings): PublicSettings {
    return {
      ...settings,
      agents: settings.agents.map((agent) => ({
        ...agent,
        complete: isAgentComplete(agent, this.#agents.kinds),
      })),
    };
  }

  #requireMember(group: Group, agent: string): void {
    if (!group.members.includes(agent)) throw new GroupError("invalid_agent", `${agent} 不是这个群的成员。`);
  }

  #adapterFor(group: Group, agent: string): AgentAdapter {
    const state = group.agents[agent];
    if (!state) throw new GroupError("invalid_agent", `${agent} 不是这个群的成员。`);
    if (!this.#agents.has(state.kind)) {
      throw new GroupError(
        "agent_unavailable",
        `${agent} 使用的 ${kindDisplayName(state.kind)} 没有在 config.json 中配置。`,
      );
    }
    return this.#agents.get(state.kind);
  }

  #settingsAgent(settings: Settings, agentId: string): AgentRecord {
    const agent = settings.agents.find((item) => item.id === agentId);
    if (!agent) throw new GroupError("agent_not_found", `没有这个 AI：${agentId}`);
    return agent;
  }

  #adapterForSettings(agent: AgentRecord): AgentAdapter {
    if (agent.kind === null) {
      throw new GroupError("agent_unavailable", `${agent.name} 还没有选择 CLI。`);
    }
    if (!this.#agents.has(agent.kind)) {
      throw new GroupError(
        "agent_unavailable",
        `${agent.name} 选择的 ${kindDisplayName(agent.kind)} 没有在 config.json 中配置。`,
      );
    }
    return this.#agents.get(agent.kind);
  }

  #summary(group: Group): GroupSummary {
    const round = this.#runtime.round(group.id);
    const compaction = this.#runtime.compaction(group.id);
    return {
      id: group.id,
      title: group.title,
      directory: path.basename(group.cwd),
      members: group.members,
      callOrder: group.callOrder,
      colors: Object.fromEntries(group.members.map((member) => [member, group.agents[member]!.color])),
      settings: Object.fromEntries(group.members.map((member) => [member, group.agents[member]!.settings])),
      features: Object.fromEntries(group.members.map((member) => {
        const kind = group.agents[member]!.kind;
        return [member, this.#agents.has(kind) ? featureIds(this.#agents.get(kind).features) : []];
      })),
      unavailable: group.members.filter((member) => !this.#agents.has(group.agents[member]!.kind)),
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
      pinned: group.pinned,
      archived: group.archived,
      usageAgent: group.usageAgent,
      busy: this.#runtime.isBusy(group.id),
      busyStatus: compaction
        ? { kind: "compacting", agent: compaction.current }
        : round ? { kind: "speaking", agent: round.speaking } : null,
      trashedAt: group.trashedAt,
      purgeAt: group.trashedAt
        ? new Date(Date.parse(group.trashedAt) + TRASH_RETENTION_MS).toISOString()
        : null,
      deleting: group.deletingAt !== null || this.#locked.has(group.id),
    };
  }

  #emitUpdated(groupId: string): void {
    const group = this.#store.get(groupId);
    if (group) this.#emit({ scope: "global", payload: { type: "group.updated", group: this.#summary(group) } });
  }

  #emit(event: ServiceEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error(`Group event handler failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

/** Attachments are bound to a group: the project is the working directory name and the session is the group id. */
function binding(group: Group): AttachmentBinding {
  return { caller: UPLOAD_CALLER, projectId: path.basename(group.cwd), sessionId: group.id };
}

function usageKey(groupId: string, agent: string): string {
  return `${groupId}\0${agent}`;
}

function titleFromText(text: string): string {
  const firstLine = text.trim().split(/\r?\n/u)[0] ?? "";
  const trimmed = firstLine.trim() || DEFAULT_TITLE;
  return trimmed.length > TITLE_LENGTH ? `${trimmed.slice(0, TITLE_LENGTH)}…` : trimmed;
}

function publicEntry(entry: TranscriptEntry): PublicEntry {
  if (!entry.attachments) return entry;
  return { ...entry, attachments: entry.attachments.map(publicAttachment) };
}

function publicApproval<T extends ApprovalRequest>(approval: T, redactor: PathRedactor): T & { remainingMs: number } {
  return {
    ...approval,
    detail: redactor.redact(approval.detail),
    remainingMs: Math.max(0, approval.expiresAt - Date.now()),
  };
}

function publicApprovalEvent(event: ApprovalEvent, redactor: PathRedactor): ApprovalEvent {
  return { ...event, approval: publicApproval(event.approval, redactor) } as ApprovalEvent;
}
