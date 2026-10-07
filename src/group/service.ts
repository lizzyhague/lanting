import path from "node:path";

import type { AgentRegistry } from "../agents/registry.ts";
import type { AgentCatalog, AgentSettings } from "../agents/types.ts";
import type { ApprovalEvent, ApprovalRequest } from "../approvals/registry.ts";
import type { GroupStore } from "../state/group-store.ts";
import { listDirectories, resolveDirectory } from "./directories.ts";
import {
  GroupError,
  type CompactionSnapshot,
  type GroupEvent,
  type GroupRuntime,
  type RoundSnapshot,
} from "./runtime.ts";
import type { Group, TranscriptEntry } from "./types.ts";

/** 用户名设置到第 7 步才做，之前新建的群都用默认值。 */
const DEFAULT_USERNAME = "host";
const MAX_TITLE_LENGTH = 100;
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
  /** 每个成员在这个群里的模型、思考强度和权限。 */
  settings: Record<string, AgentSettings>;
  createdAt: string;
  busy: boolean;
  /** 移入回收站的时间；不在回收站时为 null。 */
  trashedAt: string | null;
  /** 到期自动永久删除的时间，由 trashedAt 推出。 */
  purgeAt: string | null;
  /** 正在永久删除（或删到一半，等重试）。 */
  deleting: boolean;
};

export type GroupSnapshot = {
  group: GroupSummary;
  transcript: readonly TranscriptEntry[];
  round: RoundSnapshot | null;
  compaction: CompactionSnapshot | null;
  approvals: ApprovalRequest[];
};

/** 多选操作逐个处理，一个失败不影响其他的。 */
export type BatchResult = {
  done: string[];
  failed: { groupId: string; message: string }[];
};

export type ServiceEvent =
  | { scope: "global"; payload: { type: "group.created" | "group.updated"; group: GroupSummary } }
  | { scope: "global"; payload: { type: "group.removed"; groupId: string } }
  | { scope: "group"; groupId: string; payload: GroupEvent | ApprovalEvent };

/** 浏览器连接用到的群操作。把存储、调度、审批和 AI 登记表收在一处。 */
export class GroupService {
  readonly #projectRoot: string;
  readonly #store: GroupStore;
  readonly #runtime: GroupRuntime;
  readonly #agents: AgentRegistry;
  readonly #listeners = new Set<(event: ServiceEvent) => void>();
  /** 正在移入回收站或永久删除的群，这期间不能开始新的一轮或压缩。 */
  readonly #locked = new Set<string>();
  #sweeper: NodeJS.Timeout | null = null;

  constructor(options: {
    projectRoot: string;
    store: GroupStore;
    runtime: GroupRuntime;
    agents: AgentRegistry;
  }) {
    this.#projectRoot = options.projectRoot;
    this.#store = options.store;
    this.#runtime = options.runtime;
    this.#agents = options.agents;

    this.#runtime.onEvent((event) => {
      this.#emit({ scope: "group", groupId: event.groupId, payload: event });
      if (event.type === "round.started" || event.type === "round.ended" ||
          event.type === "compact.started" || event.type === "compact.ended") {
        this.#emitUpdated(event.groupId);
      }
    });
    this.#runtime.approvals.onEvent((event) => {
      this.#emit({ scope: "group", groupId: event.approval.groupId, payload: event });
    });
  }

  onEvent(listener: (event: ServiceEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  agents(): { id: string; displayName: string }[] {
    return this.#agents.ids.map((id) => ({ id, displayName: this.#agents.get(id).displayName }));
  }

  directories(): Promise<string[]> {
    return listDirectories(this.#projectRoot);
  }

  groups(): GroupSummary[] {
    return this.#store.list()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((group) => this.#summary(group));
  }

  async create(input: { directory: string; members: string[]; title: string }): Promise<GroupSummary> {
    const cwd = await resolveDirectory(this.#projectRoot, input.directory);
    if (!cwd) throw new GroupError("invalid_directory", "工作目录不存在，或不在项目根目录的第一层。");
    if (input.members.length === 0) throw new GroupError("no_members", "至少要拉一个 AI 进群。");
    if (new Set(input.members).size !== input.members.length) {
      throw new GroupError("invalid_members", "成员里有重复的 AI。");
    }
    for (const member of input.members) {
      if (!this.#agents.has(member)) throw new GroupError("invalid_members", `${member} 目前没有接入。`);
    }
    // 成员按界面顺序（登记顺序）保存，和勾选先后无关。
    const members = this.#agents.ids.filter((id) => input.members.includes(id));
    const title = input.title.trim().slice(0, MAX_TITLE_LENGTH) || input.directory;
    // 新群的点名默认是全部成员，按界面顺序。
    const group = await this.#store.create({ title, cwd, username: DEFAULT_USERNAME, members, callOrder: members });
    const summary = this.#summary(group);
    this.#emit({ scope: "global", payload: { type: "group.created", group: summary } });
    return summary;
  }

  snapshot(groupId: string): GroupSnapshot {
    const group = this.#requireActive(groupId);
    return {
      group: this.#summary(group),
      transcript: this.#store.transcript(groupId),
      round: this.#runtime.round(groupId),
      compaction: this.#runtime.compaction(groupId),
      approvals: this.#runtime.approvals.pending(groupId),
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
    });
    const summary = this.#summary(updated);
    this.#emit({ scope: "global", payload: { type: "group.updated", group: summary } });
    return summary;
  }

  /** 成员面板里这个 AI 能选的模型和权限。 */
  async catalog(groupId: string, agent: string): Promise<AgentCatalog> {
    const group = this.#requireActive(groupId);
    this.#requireMember(group, agent);
    return this.#agents.get(agent).catalog(group.cwd);
  }

  /**
   * 改这个群里某个 AI 的设置，按它的 CLI 给出的列表校验。
   * 随时都能改，这个 AI 下次发言或压缩时生效。
   */
  async setAgentSettings(groupId: string, agent: string, settings: AgentSettings): Promise<GroupSummary> {
    const group = this.#requireActive(groupId);
    this.#requireMember(group, agent);
    const catalog = await this.#agents.get(agent).catalog(group.cwd);
    const model = settings.model === null ? null : catalog.models.find((item) => item.id === settings.model);
    if (model === undefined) throw new GroupError("invalid_settings", `${agent} 没有这个模型：${settings.model}`);
    if (settings.effort !== null) {
      if (!model) throw new GroupError("invalid_settings", "要先选模型，才能选思考强度。");
      if (!model.efforts.includes(settings.effort)) {
        throw new GroupError("invalid_settings", `${model.label} 不支持思考强度 ${settings.effort}。`);
      }
    }
    if (settings.permission !== null && !catalog.permissions.some((item) => item.id === settings.permission)) {
      throw new GroupError("invalid_settings", `${agent} 没有这个权限选项：${settings.permission}`);
    }
    const updated = await this.#store.update(groupId, (next) => {
      const state = next.agents[agent];
      if (state) state.settings = { ...settings };
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
        const updated = await this.#store.update(groupId, (next) => {
          next.trashedAt = new Date().toISOString();
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
        group = await this.#store.update(groupId, (next) => {
          next.deletingAt = new Date().toISOString();
        });
        this.#emit({ scope: "global", payload: { type: "group.updated", group: this.#summary(group) } });
      }
      const failures: string[] = [];
      for (const agent of group.members) {
        const nativeId = group.agents[agent]?.nativeSessionId;
        if (!nativeId) continue;
        try {
          if (!this.#agents.has(agent)) throw new Error("目前没有接入，删不了它的原生会话");
          await this.#agents.get(agent).deleteSession(nativeId, group.cwd);
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

  startRound(groupId: string, text: string, order: string[]): { roundId: string } {
    this.#requireActive(groupId);
    const { roundId } = this.#runtime.startRound(groupId, text, order);
    return { roundId };
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

  #requireMember(group: Group, agent: string): void {
    if (!group.members.includes(agent)) throw new GroupError("invalid_agent", `${agent} 不是这个群的成员。`);
    if (!this.#agents.has(agent)) throw new GroupError("agent_unavailable", `${agent} 目前没有接入。`);
  }

  #summary(group: Group): GroupSummary {
    return {
      id: group.id,
      title: group.title,
      directory: path.basename(group.cwd),
      members: group.members,
      callOrder: group.callOrder,
      settings: Object.fromEntries(group.members.map((member) => [member, group.agents[member]!.settings])),
      createdAt: group.createdAt,
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
