import type { AgentKind } from "./kinds.ts";
import type { AgentAdapter, AgentCatalog, AgentEvent, AgentSession, SessionOptions } from "./types.ts";
import type { AgentFeatureId, AgentFeatures, UsagePart, UsageRequest } from "../features/index.ts";

/** 剧本里的一步：普通事件，或者向群主申请审批（结果作为 activity 发出）。 */
export type FakeStep = AgentEvent | { type: "ask"; toolName: string; detail?: string };

/** 每次 send 的剧本：按消息决定发出哪些事件。返回 "hang" 表示一直挂着，直到被打断。 */
export type Script = (message: string, call: number) => FakeStep[] | "hang" | Error;

export type FakeCall = {
  kind: "start" | "resume";
  nativeId: string | null;
  options: SessionOptions;
};

export type FakeAdapterOptions = {
  without?: readonly AgentFeatureId[];
};

/** 不调用任何 CLI 的假 AI，记录收到的每条消息。 */
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
  /** 每次压缩的会话 id；compactError 不为 null 时压缩失败。 */
  readonly compacted: string[] = [];
  compactError: Error | null = null;
  /** usage 的剧本；默认不碰会话，返回一段固定文字。 */
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

  /** 删掉的原生会话 id；deleteError 不为 null 时删除失败。 */
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
