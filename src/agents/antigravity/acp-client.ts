import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

import { groupExists } from "../../platform/process-group.ts";

/**
 * Antigravity ACP Server（`agy_acp_server.par`）的子进程客户端。stdin/stdout 交换 LF 分隔的
 * JSON-RPC 2.0，stderr 只是诊断。
 *
 * 照 Cursor 的 ACP 客户端；启动参数、恢复方法和错误不同，所以单独一份，不与 Cursor、Grok 共用。
 * 不发 `authenticate`：使用 ACP Server 已有的登录状态；Server 返回的认证错误由上层处理。
 *
 * 不用 node:readline 拆行：它把 U+2028、U+2029 也当换行，而它们在 JSON 字符串里是合法字符。
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

/** ACP 的 auth_required：没有登录，或登录已经失效。 */
export const AUTH_REQUIRED_CODE = -32000;

/** Server 对请求回了 JSON-RPC 错误；保留错误码，供上层分辨没登录等情况。 */
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
 * 不带 `--uid=` 时 Server 启动后会尝试切换到 nobody 用户组，找不到就以 SIGABRT 退出。
 */
const SERVER_ARGS = ["--uid="];

/** 关闭 stdin 后等 Server 自己退出的时间（实测不到 1 秒），过了就杀整个进程组。 */
const CLOSE_WAIT_MS = 3_000;
const TERM_WAIT_MS = 2_000;
const KILL_WAIT_MS = 1_000;
const STDERR_TAIL_LIMIT = 8_192;

/**
 * 事件：
 * - `update`：`session/update` 通知（AntigravityUpdate）
 * - `permission`：`session/request_permission`（AntigravityPermissionRequest），要用 respondPermission 回复
 * - `diagnostic`：stderr、不是 JSON 的 stdout、对不上请求的响应、不认识的通知，只用于日志
 * - `exit`：进程已退出（AntigravityExit）
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
      // 独立进程组：关闭时向负 pid 发信号，带走 localharness_external 和它启动的 shell 等子进程。
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
    // 子进程退出过程中管道出错是正常的，不能让未处理的 error 把后端带走。
    this.#process.stdin.on("error", () => {});
    this.#process.stdout.on("error", () => {});
    this.#process.stderr.on("error", () => {});
    // 启动失败（比如路径不对）时只有 error 事件，没有 exit。
    this.#process.on("error", (error) => {
      this.#onExit({ code: null, signal: null, error: `无法启动 Antigravity：${error.message}` });
      markExited();
    });
    this.#process.on("exit", (code, signal) => {
      this.#onExit({ code, signal });
      markExited();
    });
  }

  /** 进程组 id，也是 Server 进程的 pid；启动失败时为 undefined。 */
  get pid(): number | undefined {
    return this.#process.pid;
  }

  get alive(): boolean {
    return this.#exitInfo === null;
  }

  /** 有上限的 stderr 尾部，只用于服务端日志。 */
  get stderrTail(): string {
    return this.#stderrTail;
  }

  /** 不向 Antigravity 声明 fs / terminal 能力，文件和命令都由它自己执行。 */
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
      throw new Error("Antigravity 没有返回 session id。");
    }
    return result.sessionId;
  }

  /** 用 resume 而不用 load：resume 不重放历史，上下文照样保留。 */
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

  /** 通知，没有响应；进行中的 `session/prompt` 会以 stopReason `cancelled` 返回。 */
  sessionCancel(sessionId: string): void {
    this.notify("session/cancel", { sessionId });
  }

  respondPermission(rpcId: JsonRpcId, outcome: AntigravityPermissionOutcome): void {
    this.#write({ jsonrpc: "2.0", id: rpcId, result: { outcome } });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed || this.#exitInfo) {
      return Promise.reject(new Error(this.#closed || !this.#exitInfo ? "Antigravity 已经关闭。" : exitMessage(this.#exitInfo, this.#stderrTail)));
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
   * 先关 stdin 让 Server 自己收尾，等不到退出再 SIGTERM、SIGKILL 整个进程组。
   * SIGTERM 会让 Server 在 stderr 打出 Fatal Python error，正常关闭走不到这一步。
   * 返回时进程已经退出（或从未启动）。
   */
  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#failAll(new Error("Antigravity 已经关闭。"));
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
    // Server 自己退出了，它启动的工具子进程仍可能留在组里。
    if (groupExists(pid)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // 组已经空了。
      }
      // 孤儿进程要等 init 回收才从进程组里消失。
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
      this.emit("diagnostic", `Antigravity stdout 不是 JSON：${line.slice(0, 500)}`);
      return;
    }
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      this.emit("diagnostic", `Antigravity stdout 不是 JSON 对象：${line.slice(0, 500)}`);
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
    this.emit("diagnostic", `Antigravity 通知未处理：${line.slice(0, 500)}`);
  }

  #onResponse(message: Record<string, unknown>, line: string): void {
    const id = typeof message.id === "number" ? message.id : null;
    const pending = id === null ? undefined : this.#pending.get(id);
    if (!pending || id === null) {
      this.emit("diagnostic", `Antigravity 响应对不上请求：${line.slice(0, 500)}`);
      return;
    }
    this.#pending.delete(id);
    const error = objectOf(message.error);
    if (message.error !== undefined && message.error !== null) {
      const text = typeof error.message === "string" && error.message ? error.message : "未知错误";
      const code = typeof error.code === "number" ? error.code : null;
      pending.reject(new AntigravityRpcError(`Antigravity ${pending.method} 失败：${text}`, code, error.data));
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
        // 进程已经不在了。
      }
    }
  }
}

function exitMessage(exit: AntigravityExit, stderrTail: string): string {
  if (exit.error) return exit.error;
  const status = exit.signal ?? exit.code ?? "unknown";
  const lastLine = stderrTail.trim().split("\n").at(-1)?.trim();
  return `Antigravity 进程已退出（${status}）${lastLine ? `：${lastLine.slice(0, 300)}` : "。"}`;
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
