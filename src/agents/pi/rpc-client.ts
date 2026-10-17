import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

import { groupExists } from "../../platform/process-group.ts";

/**
 * Subprocess client for Pi `--mode rpc`. The protocol is in Pi's bundled docs/rpc.md: commands go to stdin,
 * stdout carries LF-delimited JSON records (command responses, session events, extension UI requests), and stderr is diagnostics only.
 *
 * Doesn't split lines with node:readline: it also treats U+2028 and U+2029 as line breaks, which are valid in JSON strings.
 */

export type PiRpcClientOptions = {
  executable: string;
  /** Launch arguments added after `--mode rpc`. */
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
};

/** A stdout record without a command id, handed to the adapter exactly as Pi sent it. */
export type PiEvent = Record<string, unknown> & { type: string };

export type PiUiRequest = Record<string, unknown> & { id: string; method: string };

export type PiUiResponse = { confirmed: boolean } | { cancelled: true };

export type PiExit = { code: number | null; signal: NodeJS.Signals | null; error?: string };

type Pending = {
  command: string;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
};

/** How long to wait for Pi to exit on its own after stdin closes; after that the whole process group is killed. */
const CLOSE_WAIT_MS = 3_000;
const TERM_WAIT_MS = 2_000;
const KILL_WAIT_MS = 1_000;
const STDERR_TAIL_LIMIT = 8_192;

/**
 * Events:
 * - `event`: session event (PiEvent)
 * - `ui`: extension UI request (PiUiRequest); dialog types are answered with respondUi
 * - `diagnostic`: stderr, non-JSON stdout, responses matching no command; for logs only
 * - `exit`: the process has exited (PiExit)
 */
export class PiRpcClient extends EventEmitter {
  readonly #process: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<string, Pending>();
  readonly #exited: Promise<void>;
  #nextId = 1;
  #buffer = "";
  #stderrTail = "";
  #closed = false;
  #exitInfo: PiExit | null = null;

  constructor(options: PiRpcClientOptions) {
    super();
    this.#process = spawn(options.executable, ["--mode", "rpc", ...(options.args ?? [])], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Separate process group: on close, signal the negative pid to take down bash and other children Pi started.
      detached: true,
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    let markExited!: () => void;
    this.#exited = new Promise((resolve) => {
      markExited = resolve;
    });
    this.#process.stdout.setEncoding("utf8");
    this.#process.stdout.on("data", (chunk: string) => this.#onStdout(chunk));
    this.#process.stderr.setEncoding("utf8");
    this.#process.stderr.on("data", (chunk: string) => {
      this.#stderrTail = `${this.#stderrTail}${chunk}`.slice(-STDERR_TAIL_LIMIT);
      const text = chunk.trim();
      if (text) this.emit("diagnostic", `Pi stderr: ${text}`);
    });
    // Pipe errors while the child exits are normal; an unhandled error must not take down the backend.
    this.#process.stdin.on("error", () => {});
    this.#process.stdout.on("error", () => {});
    this.#process.stderr.on("error", () => {});
    // A failed launch (e.g. wrong path) emits only an error event, no exit.
    this.#process.on("error", (error) => {
      this.#onExit({ code: null, signal: null, error: `Cannot start Pi: ${error.message}` });
      markExited();
    });
    this.#process.on("exit", (code, signal) => {
      this.#onExit({ code, signal });
      markExited();
    });
  }

  /** Process group id, which is also Pi's pid; undefined if launch failed. */
  get pid(): number | undefined {
    return this.#process.pid;
  }

  get alive(): boolean {
    return this.#exitInfo === null;
  }

  /** Bounded tail of stderr, for server logs only. */
  get stderrTail(): string {
    return this.#stderrTail;
  }

  /** Sends a command and waits for the response with the matching id; rejects with Pi's error when success is false. */
  request(type: string, fields: Record<string, unknown> = {}): Promise<unknown> {
    if (this.#closed || this.#exitInfo) {
      return Promise.reject(new Error(this.#exitInfo ? exitMessage(this.#exitInfo, this.#stderrTail) : "Pi is closed."));
    }
    const id = String(this.#nextId++);
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { command: type, resolve, reject });
      this.#write({ ...fields, id, type });
    });
  }

  /** Success only means Pi accepted the message; the round's result is read from session events until agent_settled. */
  async prompt(message: string): Promise<{ disposition?: string }> {
    return objectOf(await this.request("prompt", { message })) as { disposition?: string };
  }

  async abort(): Promise<void> {
    await this.request("abort");
  }

  async getState(): Promise<Record<string, unknown>> {
    return objectOf(await this.request("get_state"));
  }

  async setModel(provider: string, modelId: string): Promise<Record<string, unknown>> {
    return objectOf(await this.request("set_model", { provider, modelId }));
  }

  async setThinkingLevel(level: string): Promise<void> {
    await this.request("set_thinking_level", { level });
  }

  async getAvailableModels(): Promise<Record<string, unknown>[]> {
    const models = objectOf(await this.request("get_available_models")).models;
    return Array.isArray(models) ? models.map(objectOf) : [];
  }

  async getAvailableThinkingLevels(): Promise<string[]> {
    const levels = objectOf(await this.request("get_available_thinking_levels")).levels;
    return Array.isArray(levels) ? levels.filter((level): level is string => typeof level === "string") : [];
  }

  /** Compaction is complete on return. */
  async compact(): Promise<Record<string, unknown>> {
    return objectOf(await this.request("compact"));
  }

  /** Loads a Pi session file. Extensions may refuse the switch, in which case cancelled is true. */
  async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    return { cancelled: objectOf(await this.request("switch_session", { sessionPath })).cancelled === true };
  }

  /** Answers an extension dialog; id must be the one Pi gave in extension_ui_request. Pi sends no response for it. */
  respondUi(id: string, response: PiUiResponse): void {
    this.#write({ type: "extension_ui_response", id, ...response });
  }

  /**
   * Close stdin first so Pi can wind down itself; if it doesn't exit, SIGTERM then SIGKILL the whole process group.
   * On return the process has exited (or never started).
   */
  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#failAll(new Error("Pi is closed."));
      if (!this.#process.stdin.destroyed) this.#process.stdin.end();
    }
    const pid = this.#process.pid;
    if (pid === undefined) return;
    if (!this.#exitInfo && !(await this.#waitExit(CLOSE_WAIT_MS))) {
      this.#signalGroup("SIGTERM");
      if (!(await this.#waitExit(TERM_WAIT_MS))) {
        this.#signalGroup("SIGKILL");
        await this.#exited;
      }
    }
    // Pi exited on its own, but tool subprocesses it started may still be in the group.
    if (groupExists(pid)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // The group is already empty.
      }
      // Orphaned processes only leave the process group once init reaps them.
      for (let waited = 0; groupExists(pid) && waited < KILL_WAIT_MS; waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  }

  #onStdout(chunk: string): void {
    this.#buffer += chunk;
    let index: number;
    while ((index = this.#buffer.indexOf("\n")) >= 0) {
      let line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim()) this.#onRecord(line);
    }
  }

  #onRecord(line: string): void {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      this.emit("diagnostic", `Pi stdout is not JSON: ${line.slice(0, 500)}`);
      return;
    }
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      this.emit("diagnostic", `Pi stdout is not a JSON object: ${line.slice(0, 500)}`);
      return;
    }
    const message = record as Record<string, unknown>;
    const type = typeof message.type === "string" ? message.type : "";
    if (type === "response") {
      this.#onResponse(message, line);
      return;
    }
    if (type === "extension_ui_request") {
      if (typeof message.id === "string" && typeof message.method === "string") {
        this.emit("ui", message as PiUiRequest);
      } else {
        this.emit("diagnostic", `Pi extension UI request has no id or method: ${line.slice(0, 500)}`);
      }
      return;
    }
    if (!type) {
      this.emit("diagnostic", `Pi stdout record has no type: ${line.slice(0, 500)}`);
      return;
    }
    this.emit("event", message as PiEvent);
  }

  #onResponse(message: Record<string, unknown>, line: string): void {
    const id = typeof message.id === "string" ? message.id : null;
    const pending = id === null ? undefined : this.#pending.get(id);
    if (!pending || id === null) {
      // When the command JSON itself fails to parse, Pi answers with a parse response that has no id.
      this.emit("diagnostic", `Pi response matches no command: ${line.slice(0, 500)}`);
      return;
    }
    this.#pending.delete(id);
    if (message.success === true) {
      pending.resolve(message.data);
      return;
    }
    const error = typeof message.error === "string" && message.error ? message.error : "unknown error";
    pending.reject(new Error(`Pi command ${pending.command} failed: ${error}`));
  }

  #onExit(exit: PiExit): void {
    if (this.#exitInfo) return;
    this.#exitInfo = exit;
    this.#failAll(new Error(exitMessage(exit, this.#stderrTail)));
    this.emit("exit", exit);
  }

  #write(message: Record<string, unknown>): void {
    if (this.#exitInfo || this.#process.stdin.destroyed || this.#process.stdin.writableEnded) return;
    this.#process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  async #waitExit(timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      this.#exited.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    return result;
  }

  #signalGroup(signal: NodeJS.Signals): void {
    const pid = this.#process.pid;
    if (pid === undefined || pid <= 1) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        this.#process.kill(signal);
      } catch {
        // The process is already gone.
      }
    }
  }
}

function exitMessage(exit: PiExit, stderrTail: string): string {
  if (exit.error) return exit.error;
  const status = exit.signal ?? exit.code ?? "unknown";
  const lastLine = stderrTail.trim().split("\n").at(-1)?.trim();
  return `The Pi process exited (${status})${lastLine ? `: ${lastLine.slice(0, 300)}` : "."}`;
}

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
