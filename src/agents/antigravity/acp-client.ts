import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

import { groupExists } from "../../platform/process-group.ts";

/**
 * Subprocess client for the Antigravity ACP Server (`agy_acp_server.par`). stdin/stdout carry LF-delimited
 * JSON-RPC 2.0; stderr is diagnostics only.
 *
 * Modeled on the Cursor ACP client; launch arguments, resume method and errors differ, so it is a separate copy not shared with Cursor or Grok.
 * Doesn't send `authenticate`: it uses the ACP Server's existing login; auth errors returned by the Server are handled upstream.
 *
 * Doesn't split lines with node:readline: it also treats U+2028 and U+2029 as line breaks, which are valid in JSON strings.
 */

export type AntigravityAcpClientOptions = {
  executable: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
};

export type AntigravityUpdate = {
  sessionId: string;
  update: Record<string, unknown>;
};

export type AntigravityPermissionOption = { optionId: string; name: string; kind: string };

export type AntigravityPermissionRequest = {
  rpcId: number | string;
  sessionId: string;
  toolCall: Record<string, unknown>;
  options: AntigravityPermissionOption[];
};

export type AntigravityPermissionOutcome =
  | { outcome: "cancelled" }
  | { outcome: "selected"; optionId: string };

export type AntigravityPromptContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string; uri?: string };

export type AntigravityExit = { code: number | null; signal: NodeJS.Signals | null; error?: string };

/** ACP auth_required: not logged in, or the login has expired. */
export const AUTH_REQUIRED_CODE = -32000;

/** The Server answered a request with a JSON-RPC error; the code is kept so upstream can tell cases like not logged in. */
export class AntigravityRpcError extends Error {
  readonly code: number | null;
  readonly data: unknown;

  constructor(message: string, code: number | null, data: unknown) {
    super(message);
    this.name = "AntigravityRpcError";
    this.code = code;
    this.data = data;
  }
}

type JsonRpcId = number | string;

type Pending = {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

/**
 * Without `--uid=` the Server tries to switch to the nobody group after starting and exits with SIGABRT if it can't find it.
 */
const SERVER_ARGS = ["--uid="];

/** How long to wait for the Server to exit on its own after stdin closes (under 1 second in practice); after that the whole process group is killed. */
const CLOSE_WAIT_MS = 3_000;
const TERM_WAIT_MS = 2_000;
const KILL_WAIT_MS = 1_000;
const STDERR_TAIL_LIMIT = 8_192;

/**
 * Events:
 * - `update`: `session/update` notification (AntigravityUpdate)
 * - `permission`: `session/request_permission` (AntigravityPermissionRequest), answered with respondPermission
 * - `diagnostic`: stderr, non-JSON stdout, responses matching no request, unknown notifications; for logs only
 * - `exit`: the process has exited (AntigravityExit)
 */
export class AntigravityAcpClient extends EventEmitter {
  readonly #process: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, Pending>();
  readonly #exited: Promise<void>;
  #nextId = 1;
  #buffer = "";
  #stderrTail = "";
  #closed = false;
  #exitInfo: AntigravityExit | null = null;

  constructor(options: AntigravityAcpClientOptions) {
    super();
    this.#process = spawn(options.executable, SERVER_ARGS, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Separate process group: on close, signal the negative pid to take down localharness_external and the shells it started.
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
      if (text) this.emit("diagnostic", `Antigravity stderr：${text}`);
    });
    // Pipe errors while the child exits are normal; an unhandled error must not take down the backend.
    this.#process.stdin.on("error", () => {});
    this.#process.stdout.on("error", () => {});
    this.#process.stderr.on("error", () => {});
    // A failed launch (e.g. wrong path) emits only an error event, no exit.
    this.#process.on("error", (error) => {
      this.#onExit({ code: null, signal: null, error: `Cannot start Antigravity: ${error.message}` });
      markExited();
    });
    this.#process.on("exit", (code, signal) => {
      this.#onExit({ code, signal });
      markExited();
    });
  }

  /** Process group id, which is also the Server's pid; undefined if launch failed. */
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

  /** Doesn't declare fs / terminal capabilities to Antigravity; it runs files and commands itself. */
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

  async sessionNew(cwd: string): Promise<string> {
    const result = objectOf(await this.request("session/new", { cwd, mcpServers: [] }));
    if (typeof result.sessionId !== "string" || !result.sessionId) {
      throw new Error("Antigravity returned no session id.");
    }
    return result.sessionId;
  }

  /** Uses resume rather than load: resume doesn't replay history, and context is still kept. */
  async sessionResume(sessionId: string, cwd: string): Promise<Record<string, unknown>> {
    return objectOf(await this.request("session/resume", { sessionId, cwd, mcpServers: [] }));
  }

  async sessionSetMode(sessionId: string, modeId: string): Promise<void> {
    await this.request("session/set_mode", { sessionId, modeId });
  }

  async sessionPrompt(
    sessionId: string,
    input: string | AntigravityPromptContent[],
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

  respondPermission(rpcId: JsonRpcId, outcome: AntigravityPermissionOutcome): void {
    this.#write({ jsonrpc: "2.0", id: rpcId, result: { outcome } });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed || this.#exitInfo) {
      return Promise.reject(new Error(this.#closed || !this.#exitInfo ? "Antigravity is closed." : exitMessage(this.#exitInfo, this.#stderrTail)));
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
   * Close stdin first so the Server can wind down itself; if it doesn't exit, SIGTERM then SIGKILL the whole process group.
   * SIGTERM makes the Server print a Fatal Python error on stderr; a normal shutdown never gets that far.
   * On return the process has exited (or never started).
   */
  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#failAll(new Error("Antigravity is closed."));
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
    // The Server exited on its own, but tool subprocesses it started may still be in the group.
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
      this.emit("diagnostic", `Antigravity stdout is not JSON: ${line.slice(0, 500)}`);
      return;
    }
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      this.emit("diagnostic", `Antigravity stdout is not a JSON object: ${line.slice(0, 500)}`);
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
      } satisfies AntigravityPermissionRequest);
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
      } satisfies AntigravityUpdate);
      return;
    }
    this.emit("diagnostic", `Unhandled Antigravity notification: ${line.slice(0, 500)}`);
  }

  #onResponse(message: Record<string, unknown>, line: string): void {
    const id = typeof message.id === "number" ? message.id : null;
    const pending = id === null ? undefined : this.#pending.get(id);
    if (!pending || id === null) {
      this.emit("diagnostic", `Antigravity response matches no request: ${line.slice(0, 500)}`);
      return;
    }
    this.#pending.delete(id);
    const error = objectOf(message.error);
    if (message.error !== undefined && message.error !== null) {
      const text = typeof error.message === "string" && error.message ? error.message : "unknown error";
      const code = typeof error.code === "number" ? error.code : null;
      pending.reject(new AntigravityRpcError(`Antigravity ${pending.method} failed: ${text}`, code, error.data));
      return;
    }
    pending.resolve(message.result);
  }

  #onExit(exit: AntigravityExit): void {
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

function exitMessage(exit: AntigravityExit, stderrTail: string): string {
  if (exit.error) return exit.error;
  const status = exit.signal ?? exit.code ?? "unknown";
  const lastLine = stderrTail.trim().split("\n").at(-1)?.trim();
  return `The Antigravity process exited (${status})${lastLine ? `: ${lastLine.slice(0, 300)}` : "."}`;
}

function isPermissionOption(value: unknown): value is AntigravityPermissionOption {
  return typeof value === "object" &&
    value !== null &&
    typeof (value as { optionId?: unknown }).optionId === "string" &&
    typeof (value as { kind?: unknown }).kind === "string";
}

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
