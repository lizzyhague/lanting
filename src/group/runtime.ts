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
import { interruptedDeliveries, type DeliveryResult } from "../deliveries/prepare.ts";
import type { UsagePart } from "../features/index.ts";
import { englishText, localText, textOf, type LocalText } from "../i18n/text.ts";
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
  | { type: "compact.ended"; groupId: string }
  /**
   * All wrap-up for one reply or compaction by this AI is done: the native session id is saved and any process to close has been closed.
   * Only used by the service layer to refresh usage; not forwarded to the browser.
   */
  | { type: "agent.settled"; groupId: string; agent: string };

export type UsageResult =
  | { status: "not_started" }
  | { status: "ok"; parts: UsagePart[] }
  /** No new data this time; keep the previous result. */
  | { status: "none" };

/** Compaction in progress, so it can still be shown after a page refresh or device switch. */
export type CompactionSnapshot = {
  agents: string[];
  /** The AI being compacted. */
  current: string | null;
};

/** The round in progress, so it can still be shown after a page refresh or device switch. */
export type RoundSnapshot = {
  roundId: string;
  order: string[];
  /** The AI currently replying; null before any AI's turn. */
  speaking: string | null;
  /** Text and progress info the replying AI has streamed so far. */
  text: string;
  activities: Activity[];
};

/** text is shown in the browser's language; the message is its English form for logs. */
export class GroupError extends Error {
  readonly code: string;
  readonly text: LocalText;
  readonly details: Record<string, string> | undefined;

  constructor(code: string, text: LocalText, details?: Record<string, string>) {
    super(englishText(text));
    this.name = "GroupError";
    this.code = code;
    this.text = text;
    this.details = details;
  }
}

export type DeliverReply = (input: { group: Group; source: string; signal: AbortSignal }) => Promise<DeliveryResult[]>;

type ActiveRound = {
  id: string;
  order: string[];
  interrupted: boolean;
  deliveryAbort: AbortController;
  speakingAgent: string | null;
  speaking: AgentSession | null;
  text: string;
  activities: Activity[];
};

/** settings are the settings used to open this session; if the group's settings change, it is closed and reopened. */
type CachedSession = { session: AgentSession; settings: AgentSettings; lastUsedAt: number };

type FinalEvent = Extract<AgentEvent, { type: "end" }>;

/** Maximum progress info entries kept per reply, so hundreds or thousands of tool calls in a round don't bloat the record. */
const MAX_ACTIVITIES = 500;
/** How long a native session may idle before its process is closed; it is resumed on the next call. */
const DEFAULT_IDLE_CLOSE_MS = 15 * 60_000;

/**
 * Round scheduling: the group owner sends a message and calls on AIs, which reply one after another in order.
 *
 * - Only one round, and one AI speaking, per group at a time.
 * - An interrupt or error ends the round; AIs later in the order don't reply.
 * - Native sessions are cached in memory per (group, AI). Resident AIs are closed after idling a while, the rest after every reply;
 *   either way they are resumed later from the recorded native session id.
 */
export class GroupRuntime {
  readonly #store: GroupStore;
  readonly #agents: AgentRegistry;
  readonly #approvals: ApprovalRegistry;
  readonly #idleCloseMs: number;
  readonly #collaboration: () => string;
  readonly #deliverReply: DeliverReply | undefined;
  readonly #listeners = new Set<(event: GroupEvent) => void>();
  readonly #rounds = new Map<string, ActiveRound>();
  readonly #sessions = new Map<string, CachedSession>();
  readonly #compactions = new Map<string, CompactionSnapshot>();
  /** Native sessions being opened; each (group, AI) is opened only once and waiters share the result. */
  readonly #opening = new Map<string, Promise<AgentSession>>();
  /** (group, AI) pairs from the start of a reply or compaction until all wrap-up is done. usage doesn't touch their sessions meanwhile. */
  readonly #settling = new Set<string>();
  /** Groups whose sessions are all being closed; usage doesn't start processes for them meanwhile. */
  readonly #closing = new Set<string>();
  #sweeper: NodeJS.Timeout | null = null;

  constructor(options: {
    store: GroupStore;
    agents: AgentRegistry;
    approvals?: ApprovalRegistry;
    idleCloseMs?: number;
    /** The group chat collaboration rules from settings, read at the time a session opens. */
    collaboration?: () => string;
    deliverReply?: DeliverReply;
  }) {
    this.#store = options.store;
    this.#deliverReply = options.deliverReply;
    this.#collaboration = options.collaboration ?? (() => "");
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

  /** A round is in progress, or context is being compacted. */
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
   * Starts a round. Throws GroupError synchronously on bad arguments or a busy group; the outcome comes from done afterwards, which never rejects.
   * attachments go only to the AIs called this round; the caller obtains the paths from ai-remote-upload leases.
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
    if (!group) throw new GroupError("group_not_found", localText("error.groupNotFound"));
    if (!text.trim() && attachments.length === 0) throw new GroupError("empty_message", localText("error.emptyMessage"));
    if (order.length === 0) throw new GroupError("no_speaker", localText("error.noSpeaker"));
    if (new Set(order).size !== order.length) throw new GroupError("invalid_order", localText("error.duplicateSpeaker"));
    for (const agent of order) {
      if (!group.members.includes(agent)) {
        throw new GroupError("invalid_order", localText("error.notMember", { agent }));
      }
    }
    if (this.#rounds.has(groupId)) throw new GroupError("busy", localText("error.roundInProgress"));
    if (this.#compactions.has(groupId)) throw new GroupError("busy", localText("error.compacting"));

    const round: ActiveRound = {
      id: randomUUID(),
      order: [...order],
      interrupted: false,
      deliveryAbort: new AbortController(),
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
   * Compacts several AIs' context in turn. Only allowed while the group is idle; once compaction starts it isn't interrupted.
   * Each AI's result is written to the chat record as a notice, visible only to the group owner. AIs with no native session yet are skipped.
   * Throws GroupError synchronously on bad arguments or a busy group; done never rejects.
   */
  compact(groupId: string, agents: readonly string[]): { done: Promise<void> } {
    const group = this.#requireGroup(groupId);
    if (agents.length === 0) throw new GroupError("no_agent", localText("error.noAgentChosen"));
    if (new Set(agents).size !== agents.length) throw new GroupError("invalid_agents", localText("error.duplicateAgents"));
    for (const agent of agents) {
      if (!group.members.includes(agent)) throw new GroupError("invalid_agents", localText("error.notMember", { agent }));
    }
    if (this.isBusy(groupId)) throw new GroupError("busy", localText("error.groupBusy"));
    const compaction: CompactionSnapshot = { agents: [...agents], current: null };
    this.#compactions.set(groupId, compaction);
    this.#emit({ type: "compact.started", groupId, agents: [...agents] });
    return { done: this.#runCompaction(groupId, compaction) };
  }

  /** Interrupts this group's round in progress. Returns false when there is none. */
  async interrupt(groupId: string): Promise<boolean> {
    const round = this.#rounds.get(groupId);
    if (!round) return false;
    round.interrupted = true;
    round.deliveryAbort.abort();
    this.#approvals.cancel(groupId);
    await round.speaking?.interrupt();
    return true;
  }

  /** Closes all native sessions cached for this group and waits for the processes to actually exit. The group must be idle. */
  async closeSessions(groupId: string): Promise<void> {
    if (this.isBusy(groupId)) throw new GroupError("busy", localText("error.groupBusy"));
    this.#closing.add(groupId);
    try {
      // First wait for sessions being opened (e.g. started by usage) to finish, then close them all together.
      await this.#settleOpening((key) => key.split("\0")[0] === groupId);
      const closing: AgentSession[] = [];
      for (const [key, cached] of this.#sessions) {
        if (key.split("\0")[0] !== groupId) continue;
        this.#sessions.delete(key);
        closing.push(cached.session);
      }
      await Promise.allSettled(closing.map((session) => session.close()));
    } finally {
      this.#closing.delete(groupId);
    }
  }

  /**
   * Reads this AI's context and quota. The module isn't called when there is no native session yet.
   * session(open) passed to the module always returns null while this AI is replying or compacting; with open false it only takes a running session,
   * without starting a process or postponing idle reclamation.
   */
  async readUsage(groupId: string, agent: string, reason: "view" | "turn" | "visible"): Promise<UsageResult> {
    const group = this.#requireGroup(groupId);
    const state = group.agents[agent];
    if (!state) throw new GroupError("invalid_agent", localText("error.notMember", { agent }));
    const nativeId = state.nativeSessionId;
    if (!nativeId) return { status: "not_started" };
    const usage = this.#adapter(group, agent).features.usage;
    if (!usage) throw new GroupError("unsupported", localText("error.usageUnsupported", { agent }));
    const key = sessionKey(groupId, agent);
    let opened = false;
    const session = async (open: boolean): Promise<AgentSession | null> => {
      if (this.#settling.has(key) || this.#closing.has(groupId)) return null;
      if (!open) {
        const cached = this.#sessions.get(key);
        return cached?.session.alive ? cached.session : null;
      }
      const current = this.#requireGroup(groupId);
      if (current.trashedAt || current.deletingAt) return null;
      opened = true;
      return this.#session(current, agent);
    };
    try {
      const parts = await usage({ nativeId, cwd: group.cwd, reason, session });
      return parts ? { status: "ok", parts } : { status: "none" };
    } finally {
      if (opened) this.#touch(groupId, agent);
    }
  }

  /** Periodically closes idle native sessions. */
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

  /** Interrupts all rounds in progress and closes all native sessions. */
  async shutdown(): Promise<void> {
    if (this.#sweeper) clearInterval(this.#sweeper);
    this.#sweeper = null;
    await Promise.allSettled([...this.#rounds.keys()].map((groupId) => this.interrupt(groupId)));
    await this.#settleOpening(() => true);
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
      console.error(`Round in group ${groupId} failed: ${errorMessage(error)}`);
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
        await this.#settle(groupId, agent, async () => {
          const notice = await this.#compactOne(groupId, agent);
          const entry = await this.#store.append(groupId, {
            from: { role: "notice", agent },
            text: englishText(notice),
            noticeText: notice,
          });
          this.#emit({ type: "entry.appended", groupId, entry });
        });
      }
    } catch (error) {
      console.error(`Compaction in group ${groupId} failed: ${errorMessage(error)}`);
    } finally {
      await this.#touchUpdatedAt(groupId);
      this.#compactions.delete(groupId);
      this.#emit({ type: "compact.ended", groupId });
    }
  }

  /** Returns the notice written to the chat record. */
  async #compactOne(groupId: string, agent: string): Promise<LocalText> {
    const group = this.#requireGroup(groupId);
    const state = group.agents[agent]!;
    if (!this.#agents.has(state.kind)) return localText("notice.compactNotConnected", { agent });
    const compact = this.#agents.get(state.kind).features.compact;
    if (!compact) return localText("notice.compactUnsupported", { agent });
    if (!group.agents[agent]?.nativeSessionId) return localText("notice.compactNoSession", { agent });
    let session: AgentSession | null = null;
    let failed = false;
    try {
      session = await this.#session(group, agent);
      await compact(session);
      return localText("notice.compacted", { agent });
    } catch (error) {
      failed = true;
      return localText("notice.compactFailed", { agent, error: errorMessage(error) });
    } finally {
      this.#touch(groupId, agent);
      if (session && (failed || this.#adapter(group, agent).closeAfterTurn)) {
        await this.#dropSession(groupId, agent, session);
      }
    }
  }

  #speak(groupId: string, round: ActiveRound, agent: string): Promise<ReplyStatus> {
    return this.#settle(groupId, agent, () => this.#reply(groupId, round, agent));
  }

  /** Marks this AI as wrapping up during a reply or compaction; agent.settled is sent only once everything is done. */
  async #settle<T>(groupId: string, agent: string, work: () => Promise<T>): Promise<T> {
    const key = sessionKey(groupId, agent);
    this.#settling.add(key);
    try {
      return await work();
    } finally {
      this.#settling.delete(key);
      this.#emit({ type: "agent.settled", groupId, agent });
    }
  }

  async #reply(groupId: string, round: ActiveRound, agent: string): Promise<ReplyStatus> {
    const group = this.#requireGroup(groupId);
    const cursor = group.agents[agent]?.cursor ?? 0;
    const message = assembleMessage(
      this.#store.transcript(groupId).filter((entry) => entry.seq > cursor),
      agent,
      group.username,
    );

    // Attachment paths aren't shown to the browser: paths in replies and progress info are replaced with filenames.
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
          // When progress info appears, the text streamed so far has moved into progress info and the reply text starts over.
          round.text = "";
          stream = redactor.stream();
          if (round.activities.length < MAX_ACTIVITIES) round.activities.push(activity);
          this.#emit({ type: "agent.activity", groupId, roundId: round.id, agent, activity });
        } else {
          final = event;
          break;
        }
      }
      if (!final) {
        const errorText = localText("entry.noEnd");
        final = { type: "end", outcome: "failed", text: round.text, error: englishText(errorText), errorText };
      }
    } catch (error) {
      const errorText = textOf(error);
      final = { type: "end", outcome: "failed", text: round.text, error: errorMessage(error), ...(errorText ? { errorText } : {}) };
    } finally {
      round.speaking = null;
      this.#approvals.cancel(groupId, agent);
      this.#touch(groupId, agent);
    }

    const replyText = redactor.redact(final.text);
    let deliveries = interruptedDeliveries(replyText);
    if (deliveries.length > 0 && final.outcome === "completed" && !round.interrupted) {
      try {
        deliveries = this.#deliverReply
          ? await this.#deliverReply({ group, source: replyText, signal: round.deliveryAbort.signal })
          : deliveries.map((delivery) => ({ ...delivery, status: "failed", reason: "upload_failed" }));
      } catch {
        // A storage outage must not discard the model's completed reply.
        deliveries = interruptedDeliveries(replyText).map((delivery) => ({
          ...delivery, status: "failed", reason: "upload_failed",
        }));
      }
    }
    if (round.interrupted) deliveries = interruptedDeliveries(replyText);
    const entry = await this.#store.append(groupId, {
      from: { role: "agent", agent },
      text: replyText,
      ...(deliveries.length > 0 ? { deliveries } : {}),
      status: final.outcome,
      ...(final.error === undefined ? {} : { error: redactor.redact(final.error) }),
      ...(final.errorText === undefined ? {} : { errorText: final.errorText }),
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
      // After an error it's unclear whether the message arrived, so don't advance: resend next time, preferring a duplicate over a gap.
      // Leave this reply unread so its delivery results reach the author on the next call.
      if (final.outcome !== "failed") state.cursor = entry.deliveries?.length ? entry.seq - 1 : entry.seq;
    });
    if (session && (final.outcome === "failed" || this.#adapter(group, agent).closeAfterTurn)) {
      // Wait for the process to actually close before ending this reply, so on the next call old and new processes don't both continue the same session.
      await this.#dropSession(groupId, agent, session);
    }
    return final.outcome;
  }

  /**
   * Gets this AI's session, opening it if there is none. Only one open task per (group, AI) at a time;
   * replies, compaction and usage needing the session at once share it, so two processes never continue the same native session.
   */
  #session(group: Group, agent: string): Promise<AgentSession> {
    const key = sessionKey(group.id, agent);
    const opening = this.#opening.get(key);
    if (opening) return opening;
    const task = this.#openSession(group.id, agent).finally(() => {
      if (this.#opening.get(key) === task) this.#opening.delete(key);
    });
    this.#opening.set(key, task);
    return task;
  }

  /** Reads the current settings from the store each time; if they change mid-open, close the session opened with the old settings and reopen until they stabilize. */
  async #openSession(groupId: string, agent: string): Promise<AgentSession> {
    for (;;) {
      const group = this.#requireGroup(groupId);
      const session = await this.#openOnce(group, agent);
      const latest = this.#store.get(groupId)?.agents[agent]?.settings;
      if (!latest || sameSettings(latest, group.agents[agent]!.settings)) return session;
    }
  }

  async #openOnce(group: Group, agent: string): Promise<AgentSession> {
    const key = sessionKey(group.id, agent);
    const state = group.agents[agent];
    if (!state) throw new GroupError("invalid_agent", localText("error.notMember", { agent }));
    const settings = state.settings;
    const cached = this.#sessions.get(key);
    // If settings changed, close and reopen, resuming with the new settings: every CLI applies settings when opening a session, so there is only one path.
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
        self: agent,
        others: group.members.filter((member) => member !== agent),
        collaboration: this.#collaboration(),
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

  async #settleOpening(match: (key: string) => boolean): Promise<void> {
    for (;;) {
      const pending = [...this.#opening].filter(([key]) => match(key)).map(([, task]) => task);
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  #touch(groupId: string, agent: string): void {
    const cached = this.#sessions.get(sessionKey(groupId, agent));
    if (cached) cached.lastUsedAt = Date.now();
  }

  async #touchUpdatedAt(groupId: string): Promise<void> {
    try {
      await this.#store.touch(groupId);
    } catch (error) {
      console.error(`Updating the last activity time of group ${groupId} failed: ${errorMessage(error)}`);
    }
  }

  async #dropSession(groupId: string, agent: string, session: AgentSession): Promise<void> {
    const key = sessionKey(groupId, agent);
    if (this.#sessions.get(key)?.session !== session) return;
    this.#sessions.delete(key);
    await session.close().catch((error: unknown) => {
      console.error(`Closing the session of ${agent} failed: ${errorMessage(error)}`);
    });
  }

  #adapter(group: Group, agent: string): AgentAdapter {
    const state = group.agents[agent];
    if (!state) throw new GroupError("invalid_agent", localText("error.notMember", { agent }));
    if (!this.#agents.has(state.kind)) {
      throw new GroupError(
        "agent_unavailable",
        localText("error.kindNotConfiguredFor", { agent, kind: kindDisplayName(state.kind) }),
      );
    }
    return this.#agents.get(state.kind);
  }

  #requireGroup(groupId: string): Group {
    const group = this.#store.get(groupId);
    if (!group) throw new GroupError("group_not_found", localText("error.groupNotFound"));
    return group;
  }

  #emit(event: GroupEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error(`Group event handler failed: ${errorMessage(error)}`);
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
