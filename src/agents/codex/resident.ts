import { AppServerClient } from "./client.ts";

type ResidentOptions = {
  executable: string;
  initializeParams: Parameters<AppServerClient["initialize"]>[0];
  startupTimeoutMs?: number;
};

const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;

/**
 * 不跑 turn 的共享 app-server。进程退出或初始化失败后保持停用，下一次请求再启动。
 */
export class ResidentAppServer {
  readonly #options: ResidentOptions;
  #ready: Promise<AppServerClient> | null = null;
  #started: AppServerClient | null = null;
  #closed = false;

  constructor(options: ResidentOptions) {
    this.#options = options;
  }

  /** 后台预热；失败只记日志，不能阻止 lanting 启动。 */
  start(): void {
    void this.#client().catch((error: unknown) => {
      console.error(`Codex 常驻 app-server 启动失败：${errorMessage(error)}`);
    });
  }

  async request<Result = unknown>(method: string, params: unknown): Promise<Result> {
    const client = await this.#client();
    return client.request<Result>(method, params);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const client = this.#started;
    this.#started = null;
    this.#ready = null;
    await client?.close();
  }

  #client(): Promise<AppServerClient> {
    if (this.#closed) return Promise.reject(new Error("Codex 常驻 app-server 已关闭。"));
    if (this.#ready) return this.#ready;

    const client = new AppServerClient({
      codexBinary: this.#options.executable,
      workingDirectory: process.cwd(),
    });
    this.#started = client;
    const ready = this.#initialize(client);
    this.#ready = ready;
    ready.catch(() => {});

    void client.whenExited().then(() => {
      if (this.#closed || this.#started !== client) return;
      this.#started = null;
      this.#ready = null;
      console.error("Codex 常驻 app-server 已退出；下次使用时会重新启动。");
    });
    return ready;
  }

  async #initialize(client: AppServerClient): Promise<AppServerClient> {
    const timeoutMs = this.#options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        client.initialize(this.#options.initializeParams),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Codex 常驻 app-server 在 ${timeoutMs / 1_000} 秒内没有完成初始化。`));
          }, timeoutMs);
        }),
      ]);
      return client;
    } catch (error) {
      if (this.#started === client) {
        this.#started = null;
        this.#ready = null;
      }
      await client.close().catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
