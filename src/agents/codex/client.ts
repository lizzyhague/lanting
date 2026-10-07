import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

/*
 * codex app-server 的 JSONL 客户端，搬自 Codex Remote `src/app-server/client.ts`。
 * 只保留用到的协议类型，不搬生成的整套类型定义。
 */

export type RequestId = string | number;
type ClientNotification = { method: string; params?: unknown };
type InitializeParams = {
  clientInfo: { name: string; title: string; version: string };
  capabilities: { experimentalApi: boolean; requestAttestation: boolean };
};
type InitializeResponse = {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
};

export type JsonObject = Record<string, unknown>;
export type AppServerMessageListener = (message: JsonObject) => void;

/** 非 JSONL 噪音只记录前几条，避免子进程刷屏时把日志撑爆。 */
const MAX_LOGGED_UNEXPECTED_LINES = 20;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

type RpcErrorPayload = {
  code: number;
  message: string;
  data?: unknown;
};

export type AppServerClientOptions = {
  codexBinary: string;
  environment?: NodeJS.ProcessEnv;
  workingDirectory?: string;
  /**
   * 为这个 app-server 建立独立进程组。会话 Worker 使用它，确保异常清理时
   * 可以终止该 Worker 启动的完整进程树；共享目录进程保持默认值 false。
   */
  processGroup?: boolean;
  onNotification?: AppServerMessageListener;
  onServerRequest?: AppServerMessageListener;
};

export class AppServerRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(payload: RpcErrorPayload) {
    super(payload.message);
    this.name = "AppServerRpcError";
    this.code = payload.code;
    this.data = payload.data;
  }
}

/**
 * 持有一个 codex app-server 子进程，并把 JSONL 请求与响应配对。
 * 浏览器协议不会直接接触这个类；由 Codex 适配器做翻译。
 */
export class AppServerClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #processGroup: boolean;
  readonly #notificationListeners = new Set<AppServerMessageListener>();
  readonly #serverRequestListeners = new Set<AppServerMessageListener>();
  readonly #pending = new Map<RequestId, PendingRequest>();
  readonly #exitPromise: Promise<void>;
  #resolveExit!: () => void;
  #nextRequestId = 1;
  #closed = false;
  #stderrTail = "";
  #unexpectedLines = 0;

  constructor(options: AppServerClientOptions) {
    this.#processGroup = options.processGroup === true;
    if (options.onNotification) {
      this.#notificationListeners.add(options.onNotification);
    }
    if (options.onServerRequest) {
      this.#serverRequestListeners.add(options.onServerRequest);
    }
    this.#exitPromise = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });

    this.#child = spawn(
      options.codexBinary,
      ["app-server", "--stdio"],
      {
        ...(options.workingDirectory === undefined ? {} : { cwd: options.workingDirectory }),
        env: withoutWebLoginToken(options.environment ?? process.env),
        stdio: ["pipe", "pipe", "pipe"],
        detached: this.#processGroup,
      },
    );

    const lines = createInterface({ input: this.#child.stdout });
    lines.on("line", (line) => this.#handleLine(line));

    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderrTail = `${this.#stderrTail}${chunk}`.slice(-16_384);
    });

    // 子进程退出时 stdin 会变成断开的管道。没有这个监听器，正在进行的写入
    // 会抛出未捕获的流错误，把整个网页后端一起带走。
    this.#child.stdin.on("error", (error: Error) => this.#fail(error));

    this.#child.once("error", (error) => {
      this.#fail(error);
      this.#resolveExit();
    });
    this.#child.once("exit", (code, signal) => {
      const detail = code === 0
        ? "codex app-server 已退出。"
        : `codex app-server 异常退出（code=${String(code)}, signal=${String(signal)}）。`;
      this.#fail(new Error(this.#stderrTail.trim() || detail));
      this.#resolveExit();
    });
    // spawn 失败时只有 error/close，没有 exit；close 兜底避免 whenExited() 永不落地。
    this.#child.once("close", () => this.#resolveExit());
  }

  /** 子进程结束后落地。调用方据此决定是否让整个服务退出，交给 systemd 重启。 */
  whenExited(): Promise<void> {
    return this.#exitPromise;
  }

  async initialize(params: InitializeParams): Promise<InitializeResponse> {
    const result = await this.request("initialize", params);
    if (!isInitializeResponse(result)) {
      throw new Error("codex app-server 返回了无法识别的初始化结果。");
    }

    this.notify({ method: "initialized" });
    return result;
  }

  request<Result = unknown>(method: string, params: unknown): Promise<Result> {
    if (this.#closed) {
      return Promise.reject(new Error("codex app-server 连接已经关闭。"));
    }

    const id = this.#nextRequestId;
    this.#nextRequestId += 1;

    const response = new Promise<Result>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (value) => resolve(value as Result),
        reject,
      });
    });

    try {
      this.#write({ method, id, params });
    } catch (error) {
      this.#pending.delete(id);
      return Promise.reject(asError(error));
    }

    return response;
  }

  onNotification(listener: AppServerMessageListener): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  onServerRequest(listener: AppServerMessageListener): () => void {
    this.#serverRequestListeners.add(listener);
    return () => this.#serverRequestListeners.delete(listener);
  }

  respondToServerRequest(id: RequestId, result: unknown): void {
    if (this.#closed) {
      throw new Error("codex app-server 连接已经关闭。");
    }
    this.#write({ id, result });
  }

  /** 认不得的反向请求也必须回复，否则 Codex 会一直等。 */
  rejectServerRequest(id: RequestId, message: string): void {
    if (this.#closed) return;
    this.#write({ id, error: { code: -32601, message } });
  }

  get closed(): boolean {
    return this.#closed;
  }

  notify(notification: ClientNotification): void {
    if (this.#closed) {
      throw new Error("codex app-server 连接已经关闭。");
    }
    this.#write(notification);
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#child.stdin.end();
    }

    let timer: NodeJS.Timeout | undefined;
    const exited = await Promise.race([
      this.#exitPromise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 3_000);
      }),
    ]).finally(() => clearTimeout(timer));

    if (!exited) {
      this.#terminate("SIGTERM");
      let killTimer: NodeJS.Timeout | undefined;
      const terminated = await Promise.race([
        this.#exitPromise.then(() => true),
        new Promise<false>((resolve) => {
          killTimer = setTimeout(() => resolve(false), 2_000);
        }),
      ]).finally(() => clearTimeout(killTimer));
      if (!terminated) {
        this.#terminate("SIGKILL");
        await this.#exitPromise;
      }
    }
    await this.#terminateRemainingProcessGroup();
  }

  async #terminateRemainingProcessGroup(): Promise<void> {
    const pid = this.#child.pid;
    if (!pid || !this.#processGroup || !processGroupExists(pid)) return;
    // 组长退出后，仍可能有忽略 stdin 生命周期的工具孙进程留在同一组。
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      return;
    }
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (!processGroupExists(pid)) return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // ESRCH 表示整个组已经干净退出，正是期望状态。
    }
  }

  #terminate(signal: NodeJS.Signals): void {
    const pid = this.#child.pid;
    if (pid && this.#processGroup) {
      try {
        // detached 子进程的 pid 同时是进程组 id；负 pid 会把工具子进程一起终止。
        process.kill(-pid, signal);
        return;
      } catch {
        // 非 Worker 客户端没有独立进程组，或者进程已先一步退出；退回单进程信号。
      }
    }
    this.#child.kill(signal);
  }

  #write(message: object): void {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // Codex 偶尔会把告警写到 stdout。跳过这一行即可，不要因为一行噪音
      // 就永久断开一个仍然健康的子进程。
      this.#warnUnexpectedLine(line);
      return;
    }

    if (!isJsonObject(message)) {
      this.#warnUnexpectedLine(line);
      return;
    }

    if ("id" in message && ("result" in message || "error" in message)) {
      this.#handleResponse(message);
      return;
    }

    if (typeof message.method === "string" && "id" in message) {
      for (const listener of this.#serverRequestListeners) {
        listener(message);
      }
      return;
    }

    if (typeof message.method === "string") {
      for (const listener of this.#notificationListeners) {
        listener(message);
      }
    }
  }

  #handleResponse(message: JsonObject): void {
    const id = message.id;
    if (typeof id !== "string" && typeof id !== "number") {
      this.#fail(new Error("codex app-server 响应缺少有效请求 ID。"));
      return;
    }

    const pending = this.#pending.get(id);
    if (!pending) {
      return;
    }
    this.#pending.delete(id);

    if ("error" in message) {
      pending.reject(new AppServerRpcError(normalizeRpcError(message.error)));
    } else {
      pending.resolve(message.result);
    }
  }

  #warnUnexpectedLine(line: string): void {
    this.#unexpectedLines += 1;
    if (this.#unexpectedLines <= MAX_LOGGED_UNEXPECTED_LINES) {
      console.warn(`忽略 codex app-server 的非 JSONL 输出：${line.slice(0, 200)}`);
    }
  }

  #fail(error: Error): void {
    if (!this.#closed) {
      this.#closed = true;
    }
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

/** 网页登录令牌 CLI 用不到，留着只会让每个工具子进程都能拿到网页端的控制权。 */
function withoutWebLoginToken(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnvironment = { ...environment };
  delete childEnvironment.ACCESS_TOKEN;
  return childEnvironment;
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch {
    return false;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInitializeResponse(value: unknown): value is InitializeResponse {
  return isJsonObject(value) &&
    typeof value.userAgent === "string" &&
    typeof value.codexHome === "string" &&
    typeof value.platformFamily === "string" &&
    typeof value.platformOs === "string";
}

function normalizeRpcError(value: unknown): RpcErrorPayload {
  if (!isJsonObject(value)) {
    return { code: -1, message: "codex app-server 返回了未知错误。" };
  }

  return {
    code: typeof value.code === "number" ? value.code : -1,
    message: typeof value.message === "string" ? value.message : "codex app-server 返回了未知错误。",
    ...(value.data === undefined ? {} : { data: value.data }),
  };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
