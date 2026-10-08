import { randomUUID } from "node:crypto";

import { kindDisplayName, type AgentRegistry } from "../agents/registry.ts";
import {
  type AgentAdapter,
  type AgentEvent,
  type AgentSession,
  type AgentSettings,
  type SessionOptions,
} from "../agents/types.ts";
import { ApprovalRegistry } from "../approvals/registry.ts";
import type { StoredAttachment } from "../attachments/prompt.ts";
import { PathRedactor } from "../attachments/redact.ts";
import type { GroupStore } from "../state/group-store.ts";
import { assembleMessage } from "./assemble.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import type { Activity, Group, ReplyStatus, TranscriptEntry } from "./types.ts";

export type RoundOutcome = "completed" | "interrupted" | "failed";

export type GroupEvent =
  | { type: "round.started"; groupId: string; roundId: string; order: string[] }
  | { type: "entry.appended"; groupId: string; entry: TranscriptEntry }
  | { type: "agent.started"; groupId: string; roundId: string; agent: string }
  | { type: "agent.text"; groupId: string; roundId: string; agent: string; delta: string }
  | { type: "agent.activity"; groupId: string; roundId: string; agent: string; activity: Activity }
  | { type: "round.ended"; groupId: string; roundId: string; outcome: RoundOutcome }
  | { type: "compact.started"; groupId: string; agents: string[] }
  | { type: "compact.progress"; groupId: string; agent: string }
  | { type: "compact.ended"; groupId: string };

/** 进行中的压缩，供页面刷新或换设备后接着显示。 */
export type CompactionSnapshot = {
  agents: string[];
  /** 正在压缩的 AI。 */
  current: string | null;
};

/** 进行中的一轮，供页面刷新或换设备后接着显示。 */
export type RoundSnapshot = {
  roundId: string;
  order: string[];
  /** 正在发言的 AI；还没轮到任何 AI 时为 null。 */
  speaking: string | null;
  /** 正在发言的 AI 已经流出来的文字和过程信息。 */
  text: string;
  activities: Activity[];
};

export class GroupError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GroupError";
    this.code = code;
  }
}

type ActiveRound = {
  id: string;
  order: string[];
  interrupted: boolean;
  speakingAgent: string | null;
  speaking: AgentSession | null;
  text: string;
  activities: Activity[];
};

/** settings 是开这个会话时用的设置；群里的设置变了就关掉重开。 */
type CachedSession = { session: AgentSession; settings: AgentSettings; lastUsedAt: number };

type FinalEvent = Extract<AgentEvent, { type: "end" }>;

/** 一次发言最多保留的过程信息条数，防止一轮里成百上千次工具调用把记录撑大。 */
const MAX_ACTIVITIES = 500;
/** 空闲多久的原生会话关掉进程，下次点名时再恢复。 */
const DEFAULT_IDLE_CLOSE_MS = 15 * 60_000;

/**
 * 轮次调度：群主发一条消息并点名，被点名的 AI 按顺序依次发言。
 *
 * - 同一个群同一时间只有一轮、一个 AI 在说话。
 * - 打断或出错时这一轮结束，排在后面的 AI 不再发言。
 * - 原生会话按 (群, AI) 缓存在内存里。常驻的 AI 空闲一段时间后关掉，其余的每次发言完就关；
 *   之后都用记下的原生会话 id 恢复。
 */
export class GroupRuntime {
  readonly #store: GroupStore;
  readonly #agents: AgentRegistry;
  readonly #approvals: ApprovalRegistry;
  readonly #idleCloseMs: number;
  readonly #listeners = new Set<(event: GroupEvent) => void>();
  readonly #rounds = new Map<string, ActiveRound>();
  readonly #sessions = new Map<string, CachedSession>();
  readonly #compactions = new Map<string, CompactionSnapshot>();
  #sweeper: NodeJS.Timeout | null = null;

  constructor(options: {
    store: GroupStore;
    agents: AgentRegistry;
    approvals?: ApprovalRegistry;
    idleCloseMs?: number;
  }) {
    this.#store = options.store;
    this.#agents = options.agents;
    this.#approvals = options.approvals ?? new ApprovalRegistry();
    this.#idleCloseMs = options.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS;
  }

  get approvals(): ApprovalRegistry {
    return this.#approvals;
  }

  onEvent(listener: (event: GroupEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 有一轮在进行，或正在压缩上下文。 */
  isBusy(groupId: string): boolean {
    return this.#rounds.has(groupId) || this.#compactions.has(groupId);
  }

  compaction(groupId: string): CompactionSnapshot | null {
    const compaction = this.#compactions.get(groupId);
    return compaction ? { agents: [...compaction.agents], current: compaction.current } : null;
  }

  round(groupId: string): RoundSnapshot | null {
    const round = this.#rounds.get(groupId);
    if (!round) return null;
    return {
      roundId: round.id,
      order: [...round.order],
      speaking: round.speakingAgent,
      text: round.text,
      activities: [...round.activities],
    };
  }

  /**
   * 开始一轮。参数不对或群正忙时同步抛 GroupError；之后的结果从 done 拿，done 不会 reject。
   * attachments 只交给这一轮被点名的 AI，路径由调用方从 ai-remote-upload 的租约里取得。
   */
  startRound(
    groupId: string,
    text: string,
    order: readonly string[],
    attachments: readonly StoredAttachment[] = [],
  ): {
    roundId: string;
    done: Promise<RoundOutcome>;
  } {
    const group = this.#store.get(groupId);
    if (!group) throw new GroupError("group_not_found", "群不存在。");
    if (!text.trim() && attachments.length === 0) throw new GroupError("empty_message", "消息不能为空。");
    if (order.length === 0) throw new GroupError("no_speaker", "至少要点名一个 AI。");
    if (new Set(order).size !== order.length) throw new GroupError("invalid_order", "点名里有重复的 AI。");
    for (const agent of order) {
      if (!group.members.includes(agent)) {
        throw new GroupError("invalid_order", `${agent} 不是这个群的成员。`);
      }
    }
    if (this.#rounds.has(groupId)) throw new GroupError("busy", "这个群还有一轮没有结束。");
    if (this.#compactions.has(groupId)) throw new GroupError("busy", "这个群正在压缩上下文，请等压缩结束。");

    const round: ActiveRound = {
      id: randomUUID(),
      order: [...order],
      interrupted: false,
      speakingAgent: null,
      speaking: null,
      text: "",
      activities: [],
    };
    this.#rounds.set(groupId, round);
    this.#emit({ type: "round.started", groupId, roundId: round.id, order: [...order] });
    return { roundId: round.id, done: this.#run(groupId, round, text, [...attachments]) };
  }

  /**
   * 依次压缩几个 AI 的上下文。只能在群空闲时做；压缩一旦开始不打断。
   * 每个 AI 的结果写成一条提示进群聊记录，只给群主看。还没有原生会话的 AI 跳过。
   * 参数不对或群正忙时同步抛 GroupError；done 不会 reject。
   */
  compact(groupId: string, agents: readonly string[]): { done: Promise<void> } {
    const group = this.#requireGroup(groupId);
    if (agents.length === 0) throw new GroupError("no_agent", "至少要选一个 AI。");
    if (new Set(agents).size !== agents.length) throw new GroupError("invalid_agents", "有重复的 AI。");
    for (const agent of agents) {
      if (!group.members.includes(agent)) throw new GroupError("invalid_agents", `${agent} 不是这个群的成员。`);
    }
    if (this.isBusy(groupId)) throw new GroupError("busy", "这个群正忙，请等这一轮或这次压缩结束。");
    const compaction: CompactionSnapshot = { agents: [...agents], current: null };
    this.#compactions.set(groupId, compaction);
    this.#emit({ type: "compact.started", groupId, agents: [...agents] });
    return { done: this.#runCompaction(groupId, compaction) };
  }

  /** 打断这个群正在进行的一轮。没有进行中的一轮时返回 false。 */
  async interrupt(groupId: string): Promise<boolean> {
    const round = this.#rounds.get(groupId);
    if (!round) return false;
    round.interrupted = true;
    this.#approvals.cancel(groupId);
    await round.speaking?.interrupt();
    return true;
  }

  /** 关掉这个群缓存的所有原生会话，等进程确实退出。群必须空闲。 */
  async closeSessions(groupId: string): Promise<void> {
    if (this.isBusy(groupId)) throw new GroupError("busy", "这个群正忙，请等这一轮或这次压缩结束。");
    const closing: AgentSession[] = [];
    for (const [key, cached] of this.#sessions) {
      if (key.split("\0")[0] !== groupId) continue;
      this.#sessions.delete(key);
      closing.push(cached.session);
    }
    await Promise.allSettled(closing.map((session) => session.close()));
  }

  /** 定时关掉空闲的原生会话。 */
  startIdleSweeper(intervalMs = 60_000): void {
    if (this.#sweeper) return;
    this.#sweeper = setInterval(() => void this.closeIdleSessions(), intervalMs);
    this.#sweeper.unref();
  }

  async closeIdleSessions(now = Date.now()): Promise<number> {
    const closing: AgentSession[] = [];
    for (const [key, cached] of this.#sessions) {
      const groupId = key.split("\0")[0]!;
      if (this.isBusy(groupId)) continue;
      if (now - cached.lastUsedAt < this.#idleCloseMs && cached.session.alive) continue;
      this.#sessions.delete(key);
      closing.push(cached.session);
    }
    await Promise.allSettled(closing.map((session) => session.close()));
    return closing.length;
  }

  /** 打断所有进行中的轮次，关闭所有原生会话。 */
  async shutdown(): Promise<void> {
    if (this.#sweeper) clearInterval(this.#sweeper);
    this.#sweeper = null;
    await Promise.allSettled([...this.#rounds.keys()].map((groupId) => this.interrupt(groupId)));
    const sessions = [...this.#sessions.values()].map((cached) => cached.session);
    this.#sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.close()));
  }

  async #run(
    groupId: string,
    round: ActiveRound,
    text: string,
    attachments: StoredAttachment[],
  ): Promise<RoundOutcome> {
    let outcome: RoundOutcome = "completed";
    try {
      const entry = await this.#store.append(groupId, {
        from: { role: "host" },
        text,
        ...(attachments.length > 0 ? { attachments, recipients: [...round.order] } : {}),
      });
      this.#emit({ type: "entry.appended", groupId, entry });
      await this.#store.update(groupId, (group) => {
        group.callOrder = [...round.order];
      });
      for (const agent of round.order) {
        if (round.interrupted) {
          outcome = "interrupted";
          break;
        }
        const status = await this.#speak(groupId, round, agent);
        if (status !== "completed") {
          outcome = status;
          break;
        }
      }
      if (round.interrupted) outcome = "interrupted";
    } catch (error) {
      console.error(`群 ${groupId} 的这一轮出错：${errorMessage(error)}`);
      outcome = "failed";
    } finally {
      this.#approvals.cancel(groupId);
    }
    await this.#touchUpdatedAt(groupId);
    this.#rounds.delete(groupId);
    this.#emit({ type: "round.ended", groupId, roundId: round.id, outcome });
    return outcome;
  }

  async #runCompaction(groupId: string, compaction: CompactionSnapshot): Promise<void> {
    try {
      for (const agent of compaction.agents) {
        compaction.current = agent;
        this.#emit({ type: "compact.progress", groupId, agent });
        const text = await this.#compactOne(groupId, agent);
        const entry = await this.#store.append(groupId, { from: { role: "notice", agent }, text });
        this.#emit({ type: "entry.appended", groupId, entry });
      }
    } catch (error) {
      console.error(`群 ${groupId} 压缩上下文出错：${errorMessage(error)}`);
    } finally {
      await this.#touchUpdatedAt(groupId);
      this.#compactions.delete(groupId);
      this.#emit({ type: "compact.ended", groupId });
    }
  }

  /** 返回写进群聊记录的提示。 */
  async #compactOne(groupId: string, agent: string): Promise<string> {
    const group = this.#requireGroup(groupId);
    if (!group.agents[agent]?.nativeSessionId) return `${agent} 还没有发过言，没有可压缩的上下文。`;
    let session: AgentSession | null = null;
    let failed = false;
    try {
      session = await this.#session(group, agent);
      await session.compact();
      return `已压缩 ${agent} 的上下文。`;
    } catch (error) {
      failed = true;
      return `${agent} 的上下文没有压缩成功：${errorMessage(error)}`;
    } finally {
      this.#touch(groupId, agent);
      if (session && (failed || this.#adapter(group, agent).closeAfterTurn)) {
        await this.#dropSession(groupId, agent, session);
      }
    }
  }

  async #speak(groupId: string, round: ActiveRound, agent: string): Promise<ReplyStatus> {
    const group = this.#requireGroup(groupId);
    const cursor = group.agents[agent]?.cursor ?? 0;
    const message = assembleMessage(
      this.#store.transcript(groupId).filter((entry) => entry.seq > cursor),
      agent,
      group.username,
    );

    // 附件路径不给浏览器看：回复和过程信息里出现的路径换成文件名。
    const redactor = new PathRedactor(new Map(this.#store.transcript(groupId).flatMap((entry) =>
      (entry.attachments ?? []).map((attachment) => [attachment.path, attachment.originalName] as const)
    )));
    let stream = redactor.stream();

    round.speakingAgent = agent;
    round.text = "";
    round.activities = [];
    this.#emit({ type: "agent.started", groupId, roundId: round.id, agent });
    let final: FinalEvent | null = null;
    let session: AgentSession | null = null;
    try {
      session = await this.#session(group, agent);
      if (round.interrupted) return "interrupted";
      round.speaking = session;
      for await (const event of session.send(message)) {
        if (event.type === "text") {
          const delta = stream.push(event.delta);
          if (!delta) continue;
          round.text += delta;
          this.#emit({ type: "agent.text", groupId, roundId: round.id, agent, delta });
        } else if (event.type === "activity") {
          const activity = toActivity(redactor.redactDeep(event.activity));
          // 过程信息出现时，之前流出的文字已经归入过程信息，正文重新开始。
          round.text = "";
          stream = redactor.stream();
          if (round.activities.length < MAX_ACTIVITIES) round.activities.push(activity);
          this.#emit({ type: "agent.activity", groupId, roundId: round.id, agent, activity });
        } else {
          final = event;
          break;
        }
      }
      final ??= { type: "end", outcome: "failed", text: round.text, error: "AI 没有正常结束这次发言。" };
    } catch (error) {
      final = { type: "end", outcome: "failed", text: round.text, error: errorMessage(error) };
    } finally {
      round.speaking = null;
      this.#approvals.cancel(groupId, agent);
      this.#touch(groupId, agent);
    }

    const entry = await this.#store.append(groupId, {
      from: { role: "agent", agent },
      text: redactor.redact(final.text),
      status: final.outcome,
      ...(final.error === undefined ? {} : { error: redactor.redact(final.error) }),
      ...(round.activities.length > 0 ? { activities: round.activities } : {}),
    });
    round.speakingAgent = null;
    round.text = "";
    round.activities = [];
    this.#emit({ type: "entry.appended", groupId, entry });

    const nativeId = session?.nativeId ?? null;
    await this.#store.update(groupId, (next) => {
      const state = next.agents[agent];
      if (!state) return;
      if (nativeId) state.nativeSessionId = nativeId;
      // 出错时不确定消息有没有送到，不推进：下次重发，宁可重复也不漏。
      if (final.outcome !== "failed") state.cursor = entry.seq;
    });
    if (session && (final.outcome === "failed" || this.#adapter(group, agent).closeAfterTurn)) {
      // 等进程确实关掉再结束这次发言，免得下一次点名时新旧两个进程同时接着同一个会话。
      await this.#dropSession(groupId, agent, session);
    }
    return final.outcome;
  }

  async #session(group: Group, agent: string): Promise<AgentSession> {
    const key = sessionKey(group.id, agent);
    const state = group.agents[agent];
    if (!state) throw new GroupError("invalid_agent", `${agent} 不是这个群的成员。`);
    const settings = state.settings;
    const cached = this.#sessions.get(key);
    // 设置变了就关掉重开，用新设置恢复会话：三家的设置都在开会话时应用，路径只有一条。
    if (cached?.session.alive && sameSettings(cached.settings, settings)) {
      cached.lastUsedAt = Date.now();
      return cached.session;
    }
    if (cached) await this.#dropSession(group.id, agent, cached.session);

    const adapter = this.#adapter(group, agent);
    const options: SessionOptions = {
      cwd: group.cwd,
      settings: { ...settings },
      systemPrompt: buildSystemPrompt({
        username: group.username,
        others: group.members.filter((member) => member !== agent),
      }),
      requestApproval: (ask, signal) => this.#approvals.request(group.id, agent, ask, signal),
    };
    const nativeId = state.nativeSessionId;
    const session = nativeId
      ? await adapter.resumeSession(nativeId, options)
      : await adapter.startSession(options);
    this.#sessions.set(key, { session, settings: { ...settings }, lastUsedAt: Date.now() });
    if (!nativeId && session.nativeId) {
      const id = session.nativeId;
      await this.#store.update(group.id, (next) => {
        const state = next.agents[agent];
        if (state) state.nativeSessionId = id;
      });
    }
    return session;
  }

  #touch(groupId: string, agent: string): void {
    const cached = this.#sessions.get(sessionKey(groupId, agent));
    if (cached) cached.lastUsedAt = Date.now();
  }

  async #touchUpdatedAt(groupId: string): Promise<void> {
    try {
      await this.#store.touch(groupId);
    } catch (error) {
      console.error(`更新群 ${groupId} 的最近活动时间失败：${errorMessage(error)}`);
    }
  }

  async #dropSession(groupId: string, agent: string, session: AgentSession): Promise<void> {
    const key = sessionKey(groupId, agent);
    if (this.#sessions.get(key)?.session !== session) return;
    this.#sessions.delete(key);
    await session.close().catch((error: unknown) => {
      console.error(`关闭 ${agent} 的会话失败：${errorMessage(error)}`);
    });
  }

  #adapter(group: Group, agent: string): AgentAdapter {
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

  #requireGroup(groupId: string): Group {
    const group = this.#store.get(groupId);
    if (!group) throw new GroupError("group_not_found", "群不存在。");
    return group;
  }

  #emit(event: GroupEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error(`群事件处理出错：${errorMessage(error)}`);
      }
    }
  }
}

function sameSettings(a: AgentSettings, b: AgentSettings): boolean {
  return a.model === b.model && a.effort === b.effort && a.permission === b.permission;
}

function toActivity(value: Record<string, unknown>): Activity {
  return { ...value, kind: typeof value.kind === "string" ? value.kind : "other" };
}

function sessionKey(groupId: string, agent: string): string {
  return `${groupId}\0${agent}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
