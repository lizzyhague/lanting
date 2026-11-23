import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

import { groupExists } from "../../platform/process-group.ts";

export type OpenCodeAcpClientOptions = {
  executable: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
};

export type OpenCodeUpdate = {
  sessionId: string;
  update: Record<string, unknown>;
};

export type OpenCodePermissionOption = { optionId: string; name: string; kind: string };

export type OpenCodePermissionRequest = {
  rpcId: number | string;
  sessionId: string;
  toolCall: Record<string, unknown>;
  options: OpenCodePermissionOption[];
};

export type OpenCodePermissionOutcome =
  | { outcome: "cancelled" }
  | { outcome: "selected"; optionId: string };

export type OpenCodePromptContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string; uri?: string };

export type OpenCodeExit = { code: number | null; signal: NodeJS.Signals | null; error?: string };

export type OpenCodeSessionConfig = {
  sessionId: string;
  configOptions: unknown[];
  modes: Record<string, unknown>;
};

export const AUTH_REQUIRED_CODE = -32000;

/** A OpenCode ACP request failed; keep the JSON-RPC code and data for adapter-level handling. */
export class OpenCodeRpcError extends Error {
  readonly code: number | null;
  readonly data: unknown;

  constructor(message: string, code: number | null, data: unknown) {
    super(message);
    this.name = "OpenCodeRpcError";
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

const CLOSE_WAIT_MS = 3_000;
const TERM_WAIT_MS = 2_000;
const KILL_WAIT_MS = 1_000;
const STDOUT_CLOSE_WAIT_MS = 100;
const STDERR_TAIL_LIMIT = 8_192;

/** LF-delimited JSON-RPC client for `opencode acp`. OpenCode keeps file and terminal execution on its side. */
export class OpenCodeAcpClient extends EventEmitter {
  readonly #process: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, Pending>();
  readonly #exited: Promise<void>;
  #nextId = 1;
  #buffer = "";
  #stderrTail = "";
  #closed = false;
  #exitInfo: OpenCodeExit | null = null;
  #stdoutCloseTimer: NodeJS.Timeout | undefined;

  constructor(options: OpenCodeAcpClientOptions) {
    super();
    this.#process = spawn(options.executable, ["acp"], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
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
      if (text) this.emit("diagnostic", `OpenCode stderr: ${text}`);
    });
    this.#process.stdin.on("error", (error) => this.#failAll(new Error(`OpenCode stdin failed: ${error.message}`)));
    this.#process.stdout.on("error", (error) => this.#failAll(new Error(`OpenCode stdout failed: ${error.message}`)));
    this.#process.stdout.on("end", () => {
      this.#stdoutCloseTimer = setTimeout(() => {
        this.#stdoutCloseTimer = undefined;
        if (!this.#exitInfo) this.#failAll(new Error("OpenCode stdout closed."));
      }, STDOUT_CLOSE_WAIT_MS);
      this.#stdoutCloseTimer.unref();
    });
    this.#process.stderr.on("error", () => {});
    this.#process.on("error", (error) => {
      this.#onExit({ code: null, signal: null, error: `Cannot start OpenCode: ${error.message}` });
      markExited();
    });
    this.#process.on("exit", (code, signal) => {
      this.#onExit({ code, signal });
      markExited();
    });
  }

  get pid(): number | undefined {
    return this.#process.pid;
  }

  get alive(): boolean {
    return this.#exitInfo === null;
  }

  get stderrTail(): string {
    return this.#stderrTail;
  }

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

  async sessionNew(cwd: string): Promise<OpenCodeSessionConfig> {
    return sessionConfig(await this.request("session/new", { cwd, mcpServers: [] }), "session/new");
  }

  async sessionResume(sessionId: string, cwd: string): Promise<OpenCodeSessionConfig> {
    return sessionConfig(
      { ...objectOf(await this.request("session/resume", { sessionId, cwd, mcpServers: [] })), sessionId },
      "session/resume",
    );
  }

  async sessionSetConfigOption(sessionId: string, configId: string, value: string): Promise<Record<string, unknown>> {
    return objectOf(await this.request("session/set_config_option", { sessionId, configId, value }));
  }

  async sessionPrompt(sessionId: string, input: string | OpenCodePromptContent[]): Promise<{ stopReason?: string }> {
    return objectOf(await this.request("session/prompt", {
      sessionId,
      prompt: typeof input === "string" ? [{ type: "text", text: input }] : input,
    })) as { stopReason?: string };
  }

  sessionCancel(sessionId: string): void {
    this.notify("session/cancel", { sessionId });
  }

  async sessionDelete(sessionId: string): Promise<void> {
    await this.request("session/delete", { sessionId });
  }

  respondPermission(rpcId: JsonRpcId, outcome: OpenCodePermissionOutcome): void {
    this.#write({ jsonrpc: "2.0", id: rpcId, result: { outcome } });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed || this.#exitInfo || this.#process.stdin.destroyed || this.#process.stdout.readableEnded) {
      return Promise.reject(new Error(this.#exitInfo ? exitMessage(this.#exitInfo, this.#stderrTail) : "OpenCode is closed or disconnected."));
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

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#failAll(new Error("OpenCode is closed."));
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
    if (groupExists(pid)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // The group is already empty.
      }
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
      this.emit("diagnostic", `OpenCode stdout is not JSON: ${line.slice(0, 500)}`);
      return;
    }
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      this.emit("diagnostic", `OpenCode stdout is not a JSON object: ${line.slice(0, 500)}`);
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
      } satisfies OpenCodePermissionRequest);
      return;
    }
    this.#write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }

  #onNotification(method: string, params: Record<string, unknown>, line: string): void {
    if (method === "session/update") {
      this.emit("update", {
        sessionId: typeof params.sessionId === "string" ? params.sessionId : "",
        update: objectOf(params.update),
      } satisfies OpenCodeUpdate);
      return;
    }
    this.emit("diagnostic", `Unhandled OpenCode notification: ${line.slice(0, 500)}`);
  }

  #onResponse(message: Record<string, unknown>, line: string): void {
    const id = typeof message.id === "number" ? message.id : null;
    const pending = id === null ? undefined : this.#pending.get(id);
    if (!pending || id === null) {
      this.emit("diagnostic", `OpenCode response matches no request: ${line.slice(0, 500)}`);
      return;
    }
    this.#pending.delete(id);
    const error = objectOf(message.error);
    if (message.error !== undefined && message.error !== null) {
      const text = typeof error.message === "string" && error.message ? error.message : "unknown error";
      const code = typeof error.code === "number" ? error.code : null;
      pending.reject(new OpenCodeRpcError(`OpenCode ${pending.method} failed: ${text}`, code, error.data));
      return;
    }
    pending.resolve(message.result);
  }

  #onExit(exit: OpenCodeExit): void {
    if (this.#exitInfo) return;
    clearTimeout(this.#stdoutCloseTimer);
    this.#stdoutCloseTimer = undefined;
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

function sessionConfig(value: unknown, method: string): OpenCodeSessionConfig {
  const result = objectOf(value);
  if (typeof result.sessionId !== "string" || !result.sessionId) {
    throw new Error(`OpenCode ${method} returned no session id.`);
  }
  return {
    sessionId: result.sessionId,
    configOptions: Array.isArray(result.configOptions) ? result.configOptions : [],
    modes: objectOf(result.modes),
  };
}

function exitMessage(exit: OpenCodeExit, stderrTail: string): string {
  if (exit.error) return exit.error;
  const status = exit.signal ?? exit.code ?? "unknown";
  const lastLine = stderrTail.trim().split("\n").at(-1)?.trim();
  return `The OpenCode process exited (${status})${lastLine ? `: ${lastLine.slice(0, 300)}` : "."}`;
}

function isPermissionOption(value: unknown): value is OpenCodePermissionOption {
  return typeof value === "object" && value !== null &&
    typeof (value as { optionId?: unknown }).optionId === "string" &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { kind?: unknown }).kind === "string";
}

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
