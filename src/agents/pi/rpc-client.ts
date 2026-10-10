import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

import { groupExists } from "../../platform/process-group.ts";

/**
 * Pi `--mode rpc` 的子进程客户端。协议见 Pi 自带的 docs/rpc.md：stdin 写命令，
 * stdout 是 LF 分隔的 JSON 记录（命令响应、session event、扩展 UI 请求），stderr 只是诊断。
 *
 * 不用 node:readline 拆行：它把 U+2028、U+2029 也当换行，而它们在 JSON 字符串里是合法字符。
 */

export type PiRpcClientOptions = {
  executable: string;
  /** 加在 `--mode rpc` 之后的启动参数。 */
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
};

/** 没有命令 id 的 stdout 记录，按 Pi 的原样交给适配。 */
export type PiEvent = Record<string, unknown> & { type: string };

export type PiUiRequest = Record<string, unknown> & { id: string; method: string };

export type PiUiResponse = { confirmed: boolean } | { cancelled: true };

export type PiExit = { code: number | null; signal: NodeJS.Signals | null; error?: string };

type Pending = {
  command: string;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
};

/** 关闭 stdin 后等 Pi 自己退出的时间，过了就杀整个进程组。 */
const CLOSE_WAIT_MS = 3_000;
const TERM_WAIT_MS = 2_000;
const KILL_WAIT_MS = 1_000;
const STDERR_TAIL_LIMIT = 8_192;

/**
 * 事件：
 * - `event`：session event（PiEvent）
 * - `ui`：扩展 UI 请求（PiUiRequest），对话框类的要用 respondUi 回复
 * - `diagnostic`：stderr、不是 JSON 的 stdout、对不上命令的响应，只用于日志
 * - `exit`：进程已退出（PiExit）
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
      // 独立进程组：关闭时向负 pid 发信号，带走 Pi 启动的 bash 等子进程。
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
      if (text) this.emit("diagnostic", `Pi stderr：${text}`);
    });
    // 子进程退出过程中管道出错是正常的，不能让未处理的 error 把后端带走。
    this.#process.stdin.on("error", () => {});
    this.#process.stdout.on("error", () => {});
    this.#process.stderr.on("error", () => {});
    // 启动失败（比如路径不对）时只有 error 事件，没有 exit。
    this.#process.on("error", (error) => {
      this.#onExit({ code: null, signal: null, error: `无法启动 Pi：${error.message}` });
      markExited();
    });
    this.#process.on("exit", (code, signal) => {
      this.#onExit({ code, signal });
      markExited();
    });
  }

  /** 进程组 id，也是 Pi 进程的 pid；启动失败时为 undefined。 */
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

  /** 发一条命令，等对应 id 的 response；success 为 false 时以 Pi 给的 error 拒绝。 */
  request(type: string, fields: Record<string, unknown> = {}): Promise<unknown> {
    if (this.#closed || this.#exitInfo) {
      return Promise.reject(new Error(this.#exitInfo ? exitMessage(this.#exitInfo, this.#stderrTail) : "Pi 已经关闭。"));
    }
    const id = String(this.#nextId++);
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { command: type, resolve, reject });
      this.#write({ ...fields, id, type });
    });
  }

  /** 成功只表示 Pi 接受了这条消息；这一轮的结果从 session event 读，直到 agent_settled。 */
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

  /** 返回时压缩已经完成。 */
  async compact(): Promise<Record<string, unknown>> {
    return objectOf(await this.request("compact"));
  }

  /** 加载一个 Pi session 文件。扩展可以拒绝切换，这时 cancelled 为 true。 */
  async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    return { cancelled: objectOf(await this.request("switch_session", { sessionPath })).cancelled === true };
  }

  /** 回复扩展的对话框；id 必须是 Pi 在 extension_ui_request 里给的那个。Pi 不会为它发 response。 */
  respondUi(id: string, response: PiUiResponse): void {
    this.#write({ type: "extension_ui_response", id, ...response });
  }

  /**
   * 先关 stdin 让 Pi 自己收尾，等不到退出再 SIGTERM、SIGKILL 整个进程组。
   * 返回时进程已经退出（或从未启动）。
   */
  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#failAll(new Error("Pi 已经关闭。"));
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
    // Pi 自己退出了，它启动的工具子进程仍可能留在组里。
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
      this.emit("diagnostic", `Pi stdout 不是 JSON：${line.slice(0, 500)}`);
      return;
    }
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      this.emit("diagnostic", `Pi stdout 不是 JSON 对象：${line.slice(0, 500)}`);
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
        this.emit("diagnostic", `Pi 扩展 UI 请求缺少 id 或 method：${line.slice(0, 500)}`);
      }
      return;
    }
    if (!type) {
      this.emit("diagnostic", `Pi stdout 记录缺少 type：${line.slice(0, 500)}`);
      return;
    }
    this.emit("event", message as PiEvent);
  }

  #onResponse(message: Record<string, unknown>, line: string): void {
    const id = typeof message.id === "string" ? message.id : null;
    const pending = id === null ? undefined : this.#pending.get(id);
    if (!pending || id === null) {
      // 命令 JSON 本身解析失败时 Pi 回一条没有 id 的 parse 响应。
      this.emit("diagnostic", `Pi 响应对不上命令：${line.slice(0, 500)}`);
      return;
    }
    this.#pending.delete(id);
    if (message.success === true) {
      pending.resolve(message.data);
      return;
    }
    const error = typeof message.error === "string" && message.error ? message.error : "未知错误";
    pending.reject(new Error(`Pi 命令 ${pending.command} 失败：${error}`));
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
        // 进程已经不在了。
      }
    }
  }
}

function exitMessage(exit: PiExit, stderrTail: string): string {
  if (exit.error) return exit.error;
  const status = exit.signal ?? exit.code ?? "unknown";
  const lastLine = stderrTail.trim().split("\n").at(-1)?.trim();
  return `Pi 进程已退出（${status}）${lastLine ? `：${lastLine.slice(0, 300)}` : "。"}`;
}

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
