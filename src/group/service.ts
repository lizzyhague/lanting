import path from "node:path";

import type { AgentRegistry } from "../agents/registry.ts";
import type { ApprovalEvent, ApprovalRequest } from "../approvals/registry.ts";
import type { GroupStore } from "../state/group-store.ts";
import { listDirectories, resolveDirectory } from "./directories.ts";
import { GroupError, type GroupEvent, type GroupRuntime, type RoundSnapshot } from "./runtime.ts";
import type { Group, TranscriptEntry } from "./types.ts";

/** 用户名设置到第 7 步才做，之前新建的群都用默认值。 */
const DEFAULT_USERNAME = "host";
const MAX_TITLE_LENGTH = 100;

export type GroupSummary = {
  id: string;
  title: string;
  /** 工作目录在项目根目录下的名字。 */
  directory: string;
  members: string[];
  callOrder: string[];
  createdAt: string;
  busy: boolean;
};

export type GroupSnapshot = {
  group: GroupSummary;
  transcript: readonly TranscriptEntry[];
  round: RoundSnapshot | null;
  approvals: ApprovalRequest[];
};

export type ServiceEvent =
  | { scope: "global"; payload: { type: "group.created" | "group.updated"; group: GroupSummary } }
  | { scope: "group"; groupId: string; payload: GroupEvent | ApprovalEvent };

/** 浏览器连接用到的群操作。把存储、调度、审批和 AI 登记表收在一处。 */
export class GroupService {
  readonly #projectRoot: string;
  readonly #store: GroupStore;
  readonly #runtime: GroupRuntime;
  readonly #agents: AgentRegistry;
  readonly #listeners = new Set<(event: ServiceEvent) => void>();

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
      if (event.type === "round.started" || event.type === "round.ended") this.#emitUpdated(event.groupId);
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
    const group = await this.#store.create({ title, cwd, username: DEFAULT_USERNAME, members });
    const summary = this.#summary(group);
    this.#emit({ scope: "global", payload: { type: "group.created", group: summary } });
    return summary;
  }

  snapshot(groupId: string): GroupSnapshot {
    const group = this.#requireGroup(groupId);
    return {
      group: this.#summary(group),
      transcript: this.#store.transcript(groupId),
      round: this.#runtime.round(groupId),
      approvals: this.#runtime.approvals.pending(groupId),
    };
  }

  startRound(groupId: string, text: string, order: string[]): { roundId: string } {
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

  #summary(group: Group): GroupSummary {
    return {
      id: group.id,
      title: group.title,
      directory: path.basename(group.cwd),
      members: group.members,
      callOrder: group.callOrder,
      createdAt: group.createdAt,
      busy: this.#runtime.isBusy(group.id),
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
