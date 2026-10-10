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
import { featureIds, type AgentFeatureId } from "../features/index.ts";
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
/** 回收站保留 30 天，从移入时起算；常量只放这一处，页面拿到的是推出来的到期时间。 */
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60_000;
/** 到期扫描的间隔。启动时先扫一次，补上停机期间到期的群。 */
const TRASH_SWEEP_INTERVAL_MS = 24 * 60 * 60_000;

export type GroupSummary = {
  id: string;
  title: string;
  /** 工作目录在项目根目录下的名字。 */
  directory: string;
  members: string[];
  callOrder: string[];
  /** 每个冻结标签的主色。 */
  colors: Record<string, PaletteId>;
  /** 每个成员在这个群里的模型、思考强度和权限。 */
  settings: Record<string, AgentSettings>;
  /** 每个成员的 CLI 支持的子功能。 */
  features: Record<string, AgentFeatureId[]>;
  createdAt: string;
  updatedAt: number;
  /** 是否固定显示在最近群会话顶部。 */
  pinned: boolean;
  busy: boolean;
  /** 移入回收站的时间；不在回收站时为 null。 */
  trashedAt: string | null;
  /** 到期自动永久删除的时间，由 trashedAt 推出。 */
  purgeAt: string | null;
  /** 正在永久删除（或删到一半，等重试）。 */
  deleting: boolean;
};

/** 发给浏览器的群聊记录：附件去掉路径。 */
export type PublicEntry = Omit<TranscriptEntry, "attachments"> & {
  attachments?: Omit<StoredAttachment, "path">[];
};

export type GroupSnapshot = {
  group: GroupSummary;
  transcript: PublicEntry[];
  round: RoundSnapshot | null;
  compaction: CompactionSnapshot | null;
  approvals: ApprovalRequest[];
};

/** 多选操作逐个处理，一个失败不影响其他的。 */
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

/** 群事件发给浏览器前，群聊记录里的附件去掉路径。 */
export type PublicGroupEvent =
  | Exclude<GroupEvent, { type: "entry.appended" }>
  | { type: "entry.appended"; groupId: string; entry: PublicEntry };

/** 浏览器连接用到的群操作。把存储、调度、审批和 AI 登记表收在一处。 */
export class GroupService {
  readonly #projectRoot: string;
  readonly #store: GroupStore;
  readonly #runtime: GroupRuntime;
  readonly #agents: AgentRegistry;
  readonly #settings: SettingsStore;
  readonly #uploads: UploadClient | null;
  readonly #listeners = new Set<(event: ServiceEvent) => void>();
  /** 正在移入回收站或永久删除的群，这期间不能开始新的一轮或压缩。 */
  readonly #locked = new Set<string>();
  #sweeper: NodeJS.Timeout | null = null;

  constructor(options: {
    projectRoot: string;
    store: GroupStore;
    runtime: GroupRuntime;
    agents: AgentRegistry;
    settings: SettingsStore;
    /** ai-remote-upload 的客户端；没有时不能发附件。 */
    uploads?: UploadClient | null;
  }) {
    this.#projectRoot = options.projectRoot;
    this.#store = options.store;
    this.#runtime = options.runtime;
    this.#agents = options.agents;
    this.#settings = options.settings;
    this.#uploads = options.uploads ?? null;

    this.#runtime.onEvent((event) => {
      const payload = event.type === "entry.appended" ? { ...event, entry: publicEntry(event.entry) } : event;
      this.#emit({ scope: "group", groupId: event.groupId, payload });
      if (event.type === "entry.appended" || event.type === "round.started" || event.type === "round.ended" ||
          event.type === "compact.started" || event.type === "compact.ended") {
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

  /** 改用户名只影响以后新开的群。 */
  async setUsername(username: string): Promise<PublicSettings> {
    const problem = usernameProblem(username, this.#settings.get().agents.map((agent) => agent.name));
    if (problem) throw new GroupError("invalid_username", problem, { field: "username" });
    await this.#settings.update((next) => {
      next.username = username;
    });
    return this.#emitSettings();
  }

  /** 设置页里这个 AI 能选的模型和权限，按项目根目录查。 */
  async settingsCatalog(agentId: string): Promise<AgentCatalog> {
    const agent = this.#settingsAgent(this.#settings.get(), agentId);
    return this.#catalogOf(this.#adapterForSettings(agent), this.#projectRoot);
  }

  /** 每个 AI 的默认设置，新开的群复制一份；已经开的群不受影响。 */
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
    // 用户名和每个 AI 的身份、设置从同一份快照复制，之后改设置不影响这个群。
    const group = await this.#store.create({
      title,
      cwd,
      username: settings.username,
      members,
      callOrder: tags,
    });
    const summary = this.#summary(group);
    this.#emit({ scope: "global", payload: { type: "group.created", group: summary } });
    // 记住这次勾了哪些 AI，下次新建时照这个勾，换设备也一样。
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
    };
  }

  /** 点名每次变化都存到后端，换设备也能接着用。 */
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

  /** 成员面板里这个 AI 能选的模型和权限。 */
  async catalog(groupId: string, agent: string): Promise<AgentCatalog> {
    const group = this.#requireActive(groupId);
    this.#requireMember(group, agent);
    return this.#catalogOf(this.#adapterFor(group, agent), group.cwd);
  }

  /**
   * 改这个群里某个 AI 的设置，按它的 CLI 给出的列表校验。
   * 随时都能改，这个 AI 下次发言或压缩时生效。
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

  /** 压缩在后台进行，结果写进群聊记录。 */
  compact(groupId: string, agents: string[]): void {
    this.#requireActive(groupId);
    void this.#runtime.compact(groupId, agents).done;
  }

  /** 只改 lanting 里的群名，原生会话名不动。随时都能改。 */
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

  /** 钉住只改变列表分组，不算群内活动，因此不刷新 updatedAt。 */
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

  /** 移入回收站：只打标记，可以恢复。群必须空闲；关掉它的会话进程。 */
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

  /** 永久删除回收站里的群，连同各 AI 的原生会话。 */
  purge(groupIds: string[]): Promise<BatchResult> {
    return this.#batch(groupIds, async (groupId) => {
      const group = this.#requireGroup(groupId);
      if (!group.trashedAt) throw new GroupError("not_trashed", "只能永久删除回收站里的群。");
      await this.#purge(groupId);
    });
  }

  /**
   * 续做删到一半的群，再永久删除到期的群。一个群失败只记日志，留在回收站，下一次扫描重试。
   */
  async sweepTrash(now = Date.now()): Promise<void> {
    for (const group of this.#store.list()) {
      const expired = group.trashedAt !== null && Date.parse(group.trashedAt) + TRASH_RETENTION_MS <= now;
      if (!group.deletingAt && !expired) continue;
      try {
        await this.#purge(group.id);
      } catch (error) {
        console.error(`永久删除群 ${group.id} 失败：${error instanceof Error ? error.message : String(error)}`);
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
   * 照 Relayu：先关进程、记下 deletingAt，再逐个删原生会话（删掉一个就清掉它的 id），
   * 全部删完才删 lanting 自己的数据。中途失败时保留 deletingAt，之后重试只删剩下的。
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

  /** 浏览器上传附件前先要一张一次性的票据，绑定到这个群。 */
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
   * 带附件时先向 ai-remote-upload 申请这一轮的租约，拿到路径再开始；租约每 5 分钟续一次，
   * 这一轮结束就释放。
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
      console.error(`释放附件租约失败：${error instanceof Error ? error.message : String(error)}`);
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
        console.error(`续期附件租约失败：${error instanceof Error ? error.message : String(error)}`);
      });
    }, ATTACHMENT_LEASE_RENEW_INTERVAL_MS);
    renew.unref();
    void started.done.finally(() => {
      clearInterval(renew);
      void release();
    });
    return { roundId: started.roundId };
  }

  /** runtime 接受首轮后，用第一行正文替换占位标题；改名失败不反过来把这一轮报成发送失败。 */
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
        console.error(`群 ${groupId} 没有自动改名：${error instanceof Error ? error.message : String(error)}`);
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

  /** 在回收站里或正在删除的群，只能恢复或永久删除。 */
  #requireActive(groupId: string): Group {
    const group = this.#requireGroup(groupId);
    if (group.trashedAt || this.#locked.has(groupId)) {
      throw new GroupError("group_trashed", "这个群已经在回收站里了。");
    }
    return group;
  }

  #requireUploads(): UploadClient {
    if (!this.#uploads) throw new SharedUploadError("uploads_unavailable", "附件服务没有启用。", 503);
    return this.#uploads;
  }

  /** 浏览器能看到的所有附件路径都替换为原文件名，包括审批卡片和重连快照。 */
  #attachmentRedactor(groupId: string): PathRedactor {
    return new PathRedactor(new Map(this.#store.transcript(groupId).flatMap((entry) =>
      (entry.attachments ?? []).map((attachment) => [attachment.path, attachment.originalName] as const)
    )));
  }

  /** 按 CLI 给出的列表校验设置。思考强度要先选模型，取值限于那个模型支持的档位。 */
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
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
      pinned: group.pinned,
      busy: this.#runtime.isBusy(group.id),
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
        console.error(`群事件处理出错：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

/** 附件绑定到群：项目取工作目录名，会话取群 id。 */
function binding(group: Group): AttachmentBinding {
  return { caller: UPLOAD_CALLER, projectId: path.basename(group.cwd), sessionId: group.id };
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

function publicApproval<T extends ApprovalRequest>(approval: T, redactor: PathRedactor): T {
  return { ...approval, detail: redactor.redact(approval.detail) };
}

function publicApprovalEvent(event: ApprovalEvent, redactor: PathRedactor): ApprovalEvent {
  return { ...event, approval: publicApproval(event.approval, redactor) } as ApprovalEvent;
}
