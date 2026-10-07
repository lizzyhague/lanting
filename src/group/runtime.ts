import { randomUUID } from "node:crypto";

import type { AgentRegistry } from "../agents/registry.ts";
import type { AgentEvent, AgentSession, SessionOptions } from "../agents/types.ts";
import type { GroupStore } from "../state/group-store.ts";
import { assembleMessage } from "./assemble.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import type { Group, ReplyStatus, TranscriptEntry } from "./types.ts";

export type RoundOutcome = "completed" | "interrupted" | "failed";

export type GroupEvent =
  | { type: "round.started"; groupId: string; roundId: string; order: string[] }
  | { type: "entry.appended"; groupId: string; entry: TranscriptEntry }
  | { type: "agent.started"; groupId: string; roundId: string; agent: string }
  | { type: "agent.text"; groupId: string; roundId: string; agent: string; delta: string }
  | {
    type: "agent.activity";
    groupId: string;
    roundId: string;
    agent: string;
    activity: Record<string, unknown>;
  }
  | { type: "round.ended"; groupId: string; roundId: string; outcome: RoundOutcome };

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
  interrupted: boolean;
  speaking: AgentSession | null;
};

type FinalEvent = Extract<AgentEvent, { type: "end" }>;

/**
 * 轮次调度：群主发一条消息并点名，被点名的 AI 按顺序依次发言。
 *
 * - 同一个群同一时间只有一轮、一个 AI 在说话。
 * - 打断或出错时这一轮结束，排在后面的 AI 不再发言。
 * - 原生会话按 (群, AI) 缓存在内存里；服务重启后用记下的原生会话 id 恢复。
 */
export class GroupRuntime {
  readonly #store: GroupStore;
  readonly #agents: AgentRegistry;
  readonly #listeners = new Set<(event: GroupEvent) => void>();
  readonly #rounds = new Map<string, ActiveRound>();
  readonly #sessions = new Map<string, AgentSession>();

  constructor(options: { store: GroupStore; agents: AgentRegistry }) {
    this.#store = options.store;
    this.#agents = options.agents;
  }

  onEvent(listener: (event: GroupEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  isBusy(groupId: string): boolean {
    return this.#rounds.has(groupId);
  }

  /**
   * 开始一轮。参数不对或群正忙时同步抛 GroupError；之后的结果从 done 拿，done 不会 reject。
   */
  startRound(groupId: string, text: string, order: readonly string[]): {
    roundId: string;
    done: Promise<RoundOutcome>;
  } {
    const group = this.#store.get(groupId);
    if (!group) throw new GroupError("group_not_found", "群不存在。");
    if (!text.trim()) throw new GroupError("empty_message", "消息不能为空。");
    if (order.length === 0) throw new GroupError("no_speaker", "至少要点名一个 AI。");
    if (new Set(order).size !== order.length) throw new GroupError("invalid_order", "点名里有重复的 AI。");
    for (const agent of order) {
      if (!group.members.includes(agent)) {
        throw new GroupError("invalid_order", `${agent} 不是这个群的成员。`);
      }
    }
    if (this.#rounds.has(groupId)) throw new GroupError("busy", "这个群还有一轮没有结束。");

    const round: ActiveRound = { id: randomUUID(), interrupted: false, speaking: null };
    this.#rounds.set(groupId, round);
    this.#emit({ type: "round.started", groupId, roundId: round.id, order: [...order] });
    return { roundId: round.id, done: this.#run(groupId, round, text, [...order]) };
  }

  /** 打断这个群正在进行的一轮。没有进行中的一轮时返回 false。 */
  async interrupt(groupId: string): Promise<boolean> {
    const round = this.#rounds.get(groupId);
    if (!round) return false;
    round.interrupted = true;
    await round.speaking?.interrupt();
    return true;
  }

  /** 打断所有进行中的轮次，关闭所有原生会话。 */
  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.#rounds.keys()].map((groupId) => this.interrupt(groupId)));
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.close()));
  }

  async #run(
    groupId: string,
    round: ActiveRound,
    text: string,
    order: string[],
  ): Promise<RoundOutcome> {
    let outcome: RoundOutcome = "completed";
    try {
      const entry = await this.#store.append(groupId, { from: { role: "host" }, text });
      this.#emit({ type: "entry.appended", groupId, entry });
      await this.#store.update(groupId, (group) => {
        group.callOrder = order;
      });
      for (const agent of order) {
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
      this.#rounds.delete(groupId);
    }
    this.#emit({ type: "round.ended", groupId, roundId: round.id, outcome });
    return outcome;
  }

  async #speak(groupId: string, round: ActiveRound, agent: string): Promise<ReplyStatus> {
    const group = this.#requireGroup(groupId);
    const cursor = group.agents[agent]?.cursor ?? 0;
    const message = assembleMessage(
      this.#store.transcript(groupId).filter((entry) => entry.seq > cursor),
      agent,
      group.username,
    );

    this.#emit({ type: "agent.started", groupId, roundId: round.id, agent });
    let streamed = "";
    let final: FinalEvent | null = null;
    let session: AgentSession | null = null;
    try {
      session = await this.#session(group, agent);
      if (round.interrupted) return "interrupted";
      round.speaking = session;
      for await (const event of session.send(message)) {
        if (event.type === "text") {
          streamed += event.delta;
          this.#emit({ type: "agent.text", groupId, roundId: round.id, agent, delta: event.delta });
        } else if (event.type === "activity") {
          this.#emit({
            type: "agent.activity",
            groupId,
            roundId: round.id,
            agent,
            activity: event.activity,
          });
        } else {
          final = event;
          break;
        }
      }
      final ??= { type: "end", outcome: "failed", text: streamed, error: "AI 没有正常结束这次发言。" };
    } catch (error) {
      final = { type: "end", outcome: "failed", text: streamed, error: errorMessage(error) };
    } finally {
      round.speaking = null;
    }

    const entry = await this.#store.append(groupId, {
      from: { role: "agent", agent },
      text: final.text,
      status: final.outcome,
      ...(final.error === undefined ? {} : { error: final.error }),
    });
    this.#emit({ type: "entry.appended", groupId, entry });

    const nativeId = session?.nativeId ?? null;
    await this.#store.update(groupId, (next) => {
      const state = next.agents[agent];
      if (!state) return;
      if (nativeId) state.nativeSessionId = nativeId;
      // 出错时不确定消息有没有送到，不推进：下次重发，宁可重复也不漏。
      if (final.outcome !== "failed") state.cursor = entry.seq;
    });
    if (final.outcome === "failed" && session) this.#dropSession(groupId, agent, session);
    return final.outcome;
  }

  async #session(group: Group, agent: string): Promise<AgentSession> {
    const key = sessionKey(group.id, agent);
    const cached = this.#sessions.get(key);
    if (cached) return cached;

    const adapter = this.#agents.get(agent);
    const options: SessionOptions = {
      cwd: group.cwd,
      systemPrompt: buildSystemPrompt({
        username: group.username,
        cwd: group.cwd,
        others: group.members
          .filter((member) => member !== agent && this.#agents.has(member))
          .map((member) => ({ tag: member, name: this.#agents.get(member).displayName })),
      }),
    };
    const nativeId = group.agents[agent]?.nativeSessionId ?? null;
    const session = nativeId
      ? await adapter.resumeSession(nativeId, options)
      : await adapter.startSession(options);
    this.#sessions.set(key, session);
    if (!nativeId && session.nativeId) {
      const id = session.nativeId;
      await this.#store.update(group.id, (next) => {
        const state = next.agents[agent];
        if (state) state.nativeSessionId = id;
      });
    }
    return session;
  }

  #dropSession(groupId: string, agent: string, session: AgentSession): void {
    const key = sessionKey(groupId, agent);
    if (this.#sessions.get(key) !== session) return;
    this.#sessions.delete(key);
    void session.close().catch((error: unknown) => {
      console.error(`关闭 ${agent} 的会话失败：${errorMessage(error)}`);
    });
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

function sessionKey(groupId: string, agent: string): string {
  return `${groupId}\0${agent}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
