import type { AgentAdapter, AgentEvent, AgentSession, SessionOptions } from "./types.ts";

/** 每次 send 的剧本：按消息决定发出哪些事件。返回 "hang" 表示一直挂着，直到被打断。 */
export type Script = (message: string, call: number) => AgentEvent[] | "hang" | Error;

export type FakeCall = {
  kind: "start" | "resume";
  nativeId: string | null;
  options: SessionOptions;
};

/** 不调用任何 CLI 的假 AI，记录收到的每条消息。 */
export class FakeAdapter implements AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly calls: FakeCall[] = [];
  readonly received: string[] = [];
  script: Script;
  #nextSession = 1;

  constructor(id: string, script?: Script) {
    this.id = id;
    this.displayName = id[0]!.toUpperCase() + id.slice(1);
    this.script = script ?? ((_, call) => [
      { type: "text", delta: `${id} reply ` },
      { type: "end", outcome: "completed", text: `${id} reply ${call}` },
    ]);
  }

  startSession(options: SessionOptions): Promise<AgentSession> {
    this.calls.push({ kind: "start", nativeId: null, options });
    return Promise.resolve(new FakeSession(this, `${this.id}-session-${this.#nextSession++}`));
  }

  resumeSession(nativeId: string, options: SessionOptions): Promise<AgentSession> {
    this.calls.push({ kind: "resume", nativeId, options });
    return Promise.resolve(new FakeSession(this, nativeId));
  }
}

class FakeSession implements AgentSession {
  readonly nativeId: string;
  readonly #adapter: FakeAdapter;
  #wake: (() => void) | null = null;
  #interrupted = false;
  closed = false;

  constructor(adapter: FakeAdapter, nativeId: string) {
    this.#adapter = adapter;
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
    yield* plan;
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
}
