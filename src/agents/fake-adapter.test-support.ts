import type { AgentKind } from "./kinds.ts";
import type { AgentAdapter, AgentCatalog, AgentEvent, AgentSession, SessionOptions } from "./types.ts";
import type { AgentFeatureId, AgentFeatures, UsagePart, UsageRequest } from "../features/index.ts";

/** One step of a script: a plain event, or an approval request to the group owner (the result is emitted as activity). */
export type FakeStep = AgentEvent | { type: "ask"; toolName: string; detail?: string };

/** Script for each send: decides which events to emit based on the message. Returning "hang" keeps it hanging until interrupted. */
export type Script = (message: string, call: number) => FakeStep[] | "hang" | Error;

export type FakeCall = {
  kind: "start" | "resume";
  nativeId: string | null;
  options: SessionOptions;
};

export type FakeAdapterOptions = {
  without?: readonly AgentFeatureId[];
};

/** Fake AI that calls no CLI and records every message it receives. */
export class FakeAdapter implements AgentAdapter {
  readonly kind: AgentKind;
  closeAfterTurn = false;
  readonly features: AgentFeatures;
  readonly calls: FakeCall[] = [];
  readonly received: string[] = [];
  readonly sessions: FakeSession[] = [];
  script: Script;
  catalogValue: AgentCatalog = {
    models: [
      { id: "small", label: "Small", description: "", efforts: [] },
      { id: "large", label: "Large", description: "", efforts: ["low", "high"] },
    ],
    permissions: [
      { id: "ask", label: "Ask", description: "" },
      { id: "yolo", label: "Yolo", description: "", danger: true },
    ],
  };
  /** Session id of each compaction; compaction fails when compactError isn't null. */
  readonly compacted: string[] = [];
  compactError: Error | null = null;
  /** Script for usage; by default it doesn't touch the session and returns a fixed text. */
  usageScript: (request: UsageRequest) => Promise<UsagePart[] | null> = () =>
    Promise.resolve([{ text: `${this.kind} usage` }]);
  readonly usageRequests: UsageRequest[] = [];
  #nextSession = 1;

  constructor(kind: AgentKind, script?: Script, options?: FakeAdapterOptions) {
    this.kind = kind;
    this.script = script ?? ((_, call) => [
      { type: "text", delta: `${kind} reply ` },
      { type: "end", outcome: "completed", text: `${kind} reply ${call}` },
    ]);
    this.features = {
      compact: (session) => asOwnSession(session).compact(),
      deleteSession: (nativeId) => this.#deleteSession(nativeId),
      models: async (cwd) => (await this.#catalog(cwd)).models,
      permissions: async (cwd) => (await this.#catalog(cwd)).permissions,
      usage: (request) => {
        this.usageRequests.push(request);
        return this.usageScript(request);
      },
    };
    for (const feature of options?.without ?? []) delete this.features[feature];
  }

  startSession(options: SessionOptions): Promise<AgentSession> {
    this.calls.push({ kind: "start", nativeId: null, options });
    const session = new FakeSession(this, `${this.kind}-session-${this.#nextSession++}`, options);
    this.sessions.push(session);
    return Promise.resolve(session);
  }

  /** Deleted native session ids; deletion fails when deleteError isn't null. */
  readonly deleted: string[] = [];
  deleteError: Error | null = null;

  #deleteSession(nativeId: string): Promise<void> {
    if (this.deleteError) return Promise.reject(this.deleteError);
    this.deleted.push(nativeId);
    return Promise.resolve();
  }

  #catalog(_cwd: string): Promise<AgentCatalog> {
    return Promise.resolve(structuredClone(this.catalogValue));
  }

  resumeSession(nativeId: string, options: SessionOptions): Promise<AgentSession> {
    this.calls.push({ kind: "resume", nativeId, options });
    const session = new FakeSession(this, nativeId, options);
    this.sessions.push(session);
    return Promise.resolve(session);
  }
}

function asOwnSession(session: AgentSession): FakeSession {
  if (!(session instanceof FakeSession)) throw new Error("会话不属于这个假适配器。");
  return session;
}

export class FakeSession implements AgentSession {
  readonly nativeId: string;
  readonly #adapter: FakeAdapter;
  readonly #options: SessionOptions;
  #wake: (() => void) | null = null;
  #interrupted = false;
  closed = false;

  constructor(adapter: FakeAdapter, nativeId: string, options: SessionOptions) {
    this.#adapter = adapter;
    this.#options = options;
    this.nativeId = nativeId;
  }

  async *send(text: string): AsyncIterable<AgentEvent> {
    this.#interrupted = false;
    this.#adapter.received.push(text);
    const plan = this.#adapter.script(text, this.#adapter.received.length);
    if (plan instanceof Error) throw plan;
    if (plan === "hang") {
      yield { type: "text", delta: "partial" };
      if (!this.#interrupted) await new Promise<void>((resolve) => { this.#wake = resolve; });
      yield { type: "end", outcome: "interrupted", text: "partial" };
      return;
    }
    for (const step of plan) {
      if (step.type === "ask") {
        const answer = await this.#options.requestApproval({ toolName: step.toolName, detail: step.detail ?? "" });
        yield { type: "activity", activity: { kind: "approval", decision: answer.decision } };
      } else {
        yield step;
      }
    }
  }

  compact(): Promise<void> {
    this.#adapter.compacted.push(this.nativeId);
    return this.#adapter.compactError ? Promise.reject(this.#adapter.compactError) : Promise.resolve();
  }

  interrupt(): Promise<void> {
    this.#interrupted = true;
    this.#wake?.();
    this.#wake = null;
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  get alive(): boolean {
    return !this.closed;
  }
}
