import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

import { groupExists } from "../../platform/process-group.ts";

/**
 * Subprocess client for Cursor `agent acp`. stdin/stdout carry LF-delimited JSON-RPC 2.0; stderr is diagnostics only.
 *
 * The protocol part follows Grok's ACP client, process management and line splitting follow Pi's RPC client; the two differ in launch, auth,
 * resume method and extension requests, so it is a separate copy not shared with Grok.
 *
 * Doesn't split lines with node:readline: it also treats U+2028 and U+2029 as line breaks, which are valid in JSON strings.
 */

export type CursorAcpClientOptions = {
  executable: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
};

export type CursorUpdate = {
  sessionId: string;
  update: Record<string, unknown>;
};

export type CursorPermissionOption = { optionId: string; name: string; kind: string };

export type CursorPermissionRequest = {
  rpcId: number | string;
  sessionId: string;
  toolCall: Record<string, unknown>;
  options: CursorPermissionOption[];
};

export type CursorPermissionOutcome =
  | { outcome: "cancelled" }
  | { outcome: "selected"; optionId: string };

/** Extension request where Cursor stops to wait for the user. The client has already answered cancelled; the event only lets upstream tell the group owner. */
export type CursorBlockingRequest = {
  method: string;
  params: Record<string, unknown>;
};

/** Cursor extension notification, not reply text. */
export type CursorNotice = {
  method: string;
  params: Record<string, unknown>;
};

export type CursorPromptContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string; uri?: string };

export type CursorExit = { code: number | null; signal: NodeJS.Signals | null; error?: string };

type JsonRpcId = number | string;

type Pending = {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

/** Extension requests that block the current round waiting for the user; lanting always answers cancelled. */
const BLOCKING_METHODS = new Set(["cursor/ask_question", "cursor/create_plan"]);
const NOTICE_METHODS = new Set(["cursor/update_todos", "cursor/task", "cursor/generate_image"]);

/** How long to wait for Cursor to exit on its own after stdin closes; after that the whole process group is killed. */
const CLOSE_WAIT_MS = 3_000;
const TERM_WAIT_MS = 2_000;
const KILL_WAIT_MS = 1_000;
const STDERR_TAIL_LIMIT = 8_192;

/**
 * Events:
 * - `update`: `session/update` notification (CursorUpdate), including history replay during `session/load`
 * - `permission`: `session/request_permission` (CursorPermissionRequest), answered with respondPermission
 * - `blocking`: a blocking extension request already answered cancelled (CursorBlockingRequest)
 * - `notice`: Cursor extension notification (CursorNotice)
 * - `diagnostic`: stderr, non-JSON stdout, responses matching no request, unknown notifications; for logs only
 * - `exit`: the process has exited (CursorExit)
 */
export class CursorAcpClient extends EventEmitter {
  readonly #process: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, Pending>();
  readonly #exited: Promise<void>;
  #nextId = 1;
  #buffer = "";
  #stderrTail = "";
  #closed = false;
  #exitInfo: CursorExit | null = null;

  constructor(options: CursorAcpClientOptions) {
    super();
    this.#process = spawn(options.executable, ["acp"], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Separate process group: on close, signal the negative pid to take down the shells and other children Cursor started.
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
      if (text) this.emit("diagnostic", `Cursor stderr：${text}`);
    });
    // Pipe errors while the child exits are normal; an unhandled error must not take down the backend.
    this.#process.stdin.on("error", () => {});
    this.#process.stdout.on("error", () => {});
    this.#process.stderr.on("error", () => {});
    // A failed launch (e.g. wrong path) emits only an error event, no exit.
    this.#process.on("error", (error) => {
      this.#onExit({ code: null, signal: null, error: `Cannot start Cursor: ${error.message}` });
      markExited();
    });
    this.#process.on("exit", (code, signal) => {
      this.#onExit({ code, signal });
      markExited();
    });
  }

  /** Process group id, which is also Cursor's pid; undefined if launch failed. */
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

  /** Doesn't declare fs / terminal capabilities to Cursor; it runs files and commands itself. */
  async initialize(): Promise<Record<string, unknown>> {
    return objectOf(await this.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "lanting", title: "lanting", version: "0.1.0" },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    }));
  }

  /** Uses the login state left by `agent login`. */
  async authenticate(): Promise<void> {
    await this.request("authenticate", { methodId: "cursor_login" });
  }

  async sessionNew(cwd: string): Promise<string> {
    const result = objectOf(await this.request("session/new", { cwd, mcpServers: [] }));
    if (typeof result.sessionId !== "string" || !result.sessionId) {
      throw new Error("Cursor returned no session id.");
    }
    return result.sessionId;
  }

  /** Before returning, Cursor replays the history as `session/update`; the caller decides whether to ignore it. */
  async sessionLoad(sessionId: string, cwd: string): Promise<Record<string, unknown>> {
    return objectOf(await this.request("session/load", { sessionId, cwd, mcpServers: [] }));
  }

  async sessionSetMode(sessionId: string, modeId: string): Promise<void> {
    await this.request("session/set_mode", { sessionId, modeId });
  }

  async sessionPrompt(
    sessionId: string,
    input: string | CursorPromptContent[],
  ): Promise<{ stopReason?: string }> {
    return objectOf(await this.request("session/prompt", {
      sessionId,
      prompt: typeof input === "string" ? [{ type: "text", text: input }] : input,
    })) as { stopReason?: string };
  }

  /** A notification with no response; an in-flight `session/prompt` returns with stopReason `cancelled`. */
  sessionCancel(sessionId: string): void {
    this.notify("session/cancel", { sessionId });
  }

  respondPermission(rpcId: JsonRpcId, outcome: CursorPermissionOutcome): void {
    this.#write({ jsonrpc: "2.0", id: rpcId, result: { outcome } });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed || this.#exitInfo) {
      return Promise.reject(new Error(this.#closed || !this.#exitInfo ? "Cursor is closed." : exitMessage(this.#exitInfo, this.#stderrTail)));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  /**
   * Close stdin first so Cursor can wind down itself; if it doesn't exit, SIGTERM then SIGKILL the whole process group.
   * On return the process has exited (or never started).
   */
  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#failAll(new Error("Cursor is closed."));
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
    // Cursor exited on its own, but tool subprocesses it started may still be in the group.
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
      this.emit("diagnostic", `Cursor stdout is not JSON: ${line.slice(0, 500)}`);
      return;
    }
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      this.emit("diagnostic", `Cursor stdout is not a JSON object: ${line.slice(0, 500)}`);
      return;
    }
    const message = record as Record<string, unknown>;
    const method = typeof message.method === "string" ? message.method : null;
    const hasId = typeof message.id === "number" || typeof message.id === "string";
    if (method !== null && hasId) {
      this.#onServerRequest(message.id as JsonRpcId, method, objectOf(message.params));
      return;
    }
    if (method !== null) {
      this.#onNotification(method, objectOf(message.params), line);
      return;
    }
    this.#onResponse(message, line);
  }

  #onServerRequest(id: JsonRpcId, method: string, params: Record<string, unknown>): void {
    if (method === "session/request_permission") {
      const options = Array.isArray(params.options) ? params.options : [];
      this.emit("permission", {
        rpcId: id,
        sessionId: typeof params.sessionId === "string" ? params.sessionId : "",
        toolCall: objectOf(params.toolCall),
        options: options.filter(isPermissionOption),
      } satisfies CursorPermissionRequest);
      return;
    }
    if (BLOCKING_METHODS.has(method)) {
      // Reply first, then notify upstream, so an upstream error can't leave the round hanging.
      this.#write({ jsonrpc: "2.0", id, result: { outcome: "cancelled" } });
      this.emit("blocking", { method, params } satisfies CursorBlockingRequest);
      return;
    }
    this.#write({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }

  #onNotification(method: string, params: Record<string, unknown>, line: string): void {
    if (method === "session/update") {
      this.emit("update", {
        sessionId: typeof params.sessionId === "string" ? params.sessionId : "",
        update: objectOf(params.update),
      } satisfies CursorUpdate);
      return;
    }
    if (NOTICE_METHODS.has(method)) {
      this.emit("notice", { method, params } satisfies CursorNotice);
      return;
    }
    this.emit("diagnostic", `Unhandled Cursor notification: ${line.slice(0, 500)}`);
  }

  #onResponse(message: Record<string, unknown>, line: string): void {
    const id = typeof message.id === "number" ? message.id : null;
    const pending = id === null ? undefined : this.#pending.get(id);
    if (!pending || id === null) {
      this.emit("diagnostic", `Cursor response matches no request: ${line.slice(0, 500)}`);
      return;
    }
    this.#pending.delete(id);
    const error = objectOf(message.error);
    if (message.error !== undefined && message.error !== null) {
      const text = typeof error.message === "string" && error.message ? error.message : "unknown error";
      pending.reject(new Error(`Cursor ${pending.method} failed: ${text}`));
      return;
    }
    pending.resolve(message.result);
  }

  #onExit(exit: CursorExit): void {
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

function exitMessage(exit: CursorExit, stderrTail: string): string {
  if (exit.error) return exit.error;
  const status = exit.signal ?? exit.code ?? "unknown";
  const lastLine = stderrTail.trim().split("\n").at(-1)?.trim();
  return `The Cursor process exited (${status})${lastLine ? `: ${lastLine.slice(0, 300)}` : "."}`;
}

function isPermissionOption(value: unknown): value is CursorPermissionOption {
  return typeof value === "object" &&
    value !== null &&
    typeof (value as { optionId?: unknown }).optionId === "string" &&
    typeof (value as { kind?: unknown }).kind === "string";
}

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
