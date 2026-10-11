import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

import { groupExists } from "../../platform/process-group.ts";

/**
 * Cursor `agent acp` 的子进程客户端。stdin/stdout 交换 LF 分隔的 JSON-RPC 2.0，stderr 只是诊断。
 *
 * 协议部分照 Grok 的 ACP 客户端，进程管理和拆行照 Pi 的 RPC 客户端；两家的启动、认证、
 * 恢复方法和扩展请求不同，所以单独一份，不与 Grok 共用。
 *
 * 不用 node:readline 拆行：它把 U+2028、U+2029 也当换行，而它们在 JSON 字符串里是合法字符。
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

/** Cursor 停下来等用户的扩展请求。客户端已经回了 cancelled，事件只用于让上层告诉群主。 */
export type CursorBlockingRequest = {
  method: string;
  params: Record<string, unknown>;
};

/** Cursor 的扩展通知，不是正文。 */
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

/** 会阻塞当前轮、要等用户答复的扩展请求；lanting 一律回 cancelled。 */
const BLOCKING_METHODS = new Set(["cursor/ask_question", "cursor/create_plan"]);
const NOTICE_METHODS = new Set(["cursor/update_todos", "cursor/task", "cursor/generate_image"]);

/** 关闭 stdin 后等 Cursor 自己退出的时间，过了就杀整个进程组。 */
const CLOSE_WAIT_MS = 3_000;
const TERM_WAIT_MS = 2_000;
const KILL_WAIT_MS = 1_000;
const STDERR_TAIL_LIMIT = 8_192;

/**
 * 事件：
 * - `update`：`session/update` 通知（CursorUpdate），包括 `session/load` 时的历史重放
 * - `permission`：`session/request_permission`（CursorPermissionRequest），要用 respondPermission 回复
 * - `blocking`：已回 cancelled 的阻塞扩展请求（CursorBlockingRequest）
 * - `notice`：Cursor 的扩展通知（CursorNotice）
 * - `diagnostic`：stderr、不是 JSON 的 stdout、对不上请求的响应、不认识的通知，只用于日志
 * - `exit`：进程已退出（CursorExit）
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
      // 独立进程组：关闭时向负 pid 发信号，带走 Cursor 启动的 shell 等子进程。
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
    // 子进程退出过程中管道出错是正常的，不能让未处理的 error 把后端带走。
    this.#process.stdin.on("error", () => {});
    this.#process.stdout.on("error", () => {});
    this.#process.stderr.on("error", () => {});
    // 启动失败（比如路径不对）时只有 error 事件，没有 exit。
    this.#process.on("error", (error) => {
      this.#onExit({ code: null, signal: null, error: `无法启动 Cursor：${error.message}` });
      markExited();
    });
    this.#process.on("exit", (code, signal) => {
      this.#onExit({ code, signal });
      markExited();
    });
  }

  /** 进程组 id，也是 Cursor 进程的 pid；启动失败时为 undefined。 */
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

  /** 不向 Cursor 声明 fs / terminal 能力，文件和命令都由它自己执行。 */
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

  /** 使用 `agent login` 留下的登录状态。 */
  async authenticate(): Promise<void> {
    await this.request("authenticate", { methodId: "cursor_login" });
  }

  async sessionNew(cwd: string): Promise<string> {
    const result = objectOf(await this.request("session/new", { cwd, mcpServers: [] }));
    if (typeof result.sessionId !== "string" || !result.sessionId) {
      throw new Error("Cursor 没有返回 session id。");
    }
    return result.sessionId;
  }

  /** 返回前 Cursor 会把历史以 `session/update` 重放一遍，由调用方决定是否忽略。 */
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

  /** 通知，没有响应；进行中的 `session/prompt` 会以 stopReason `cancelled` 返回。 */
  sessionCancel(sessionId: string): void {
    this.notify("session/cancel", { sessionId });
  }

  respondPermission(rpcId: JsonRpcId, outcome: CursorPermissionOutcome): void {
    this.#write({ jsonrpc: "2.0", id: rpcId, result: { outcome } });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed || this.#exitInfo) {
      return Promise.reject(new Error(this.#closed || !this.#exitInfo ? "Cursor 已经关闭。" : exitMessage(this.#exitInfo, this.#stderrTail)));
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
   * 先关 stdin 让 Cursor 自己收尾，等不到退出再 SIGTERM、SIGKILL 整个进程组。
   * 返回时进程已经退出（或从未启动）。
   */
  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#failAll(new Error("Cursor 已经关闭。"));
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
    // Cursor 自己退出了，它启动的工具子进程仍可能留在组里。
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
      this.emit("diagnostic", `Cursor stdout 不是 JSON：${line.slice(0, 500)}`);
      return;
    }
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      this.emit("diagnostic", `Cursor stdout 不是 JSON 对象：${line.slice(0, 500)}`);
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
      // 先回复再通知上层，保证上层出错也不会让这一轮悬挂。
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
    this.emit("diagnostic", `Cursor 通知未处理：${line.slice(0, 500)}`);
  }

  #onResponse(message: Record<string, unknown>, line: string): void {
    const id = typeof message.id === "number" ? message.id : null;
    const pending = id === null ? undefined : this.#pending.get(id);
    if (!pending || id === null) {
      this.emit("diagnostic", `Cursor 响应对不上请求：${line.slice(0, 500)}`);
      return;
    }
    this.#pending.delete(id);
    const error = objectOf(message.error);
    if (message.error !== undefined && message.error !== null) {
      const text = typeof error.message === "string" && error.message ? error.message : "未知错误";
      pending.reject(new Error(`Cursor ${pending.method} 失败：${text}`));
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
        // 进程已经不在了。
      }
    }
  }
}

function exitMessage(exit: CursorExit, stderrTail: string): string {
  if (exit.error) return exit.error;
  const status = exit.signal ?? exit.code ?? "unknown";
  const lastLine = stderrTail.trim().split("\n").at(-1)?.trim();
  return `Cursor 进程已退出（${status}）${lastLine ? `：${lastLine.slice(0, 300)}` : "。"}`;
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
