import { KiroAcpClient, KiroRpcError } from "./acp-client.ts";

const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const METHOD_NOT_FOUND_CODE = -32601;

export type ResidentKiroOptions = {
  executable: string;
  cwd?: string;
  environment: () => NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
};

export type ResidentKiroRequestOptions = {
  timeoutMs?: number;
};

/**
 * Shared `kiro-cli acp --agent-engine v3` process that runs no chat turns and opens no sessions;
 * it stays initialized so `_kiro/account/getUsage` avoids a cold start. After exit, timeout, or failure
 * it stays stopped until the next request restarts it.
 */
export class ResidentKiroServer {
  readonly #options: ResidentKiroOptions;
  readonly #cleanups = new Map<KiroAcpClient, Promise<void>>();
  #ready: Promise<KiroAcpClient> | null = null;
  #started: KiroAcpClient | null = null;
  #closed = false;

  constructor(options: ResidentKiroOptions) {
    this.#options = options;
  }

  /** Warms up in the background; failures are only logged and must not stop lanting from starting. */
  start(): void {
    void this.#ensureReady().catch((error: unknown) => {
      console.error(`Starting the resident Kiro ACP server failed: ${errorMessage(error)}`);
    });
  }

  /** Sends one sessionless JSON-RPC request against the resident process with a bounded timeout. */
  async request<Result = unknown>(
    method: string,
    params: unknown,
    options?: ResidentKiroRequestOptions,
  ): Promise<Result> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const ready = this.#ensureReady();
    const startingClient = this.#started;
    const active: { client: KiroAcpClient | null } = { client: null };
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      const task = (async () => {
        const client = await ready;
        active.client = client;
        return await client.request(method, params) as Result;
      })();
      task.catch(() => {});
      return await Promise.race([
        task,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error(`Kiro ${method} did not finish within ${timeoutMs / 1_000} seconds.`));
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      if (active.client && active.client.stderrTail.trim()) {
        console.error(`Kiro stderr: ${active.client.stderrTail.trim()}`);
      }
      const client = active.client ?? startingClient;
      if (client) {
        if (timedOut) {
          // Detach immediately and close in the background so a hung process does not stall the caller or the next read;
          // close() still awaits #cleanups so no process group leaks at shutdown.
          this.#detachAndCleanup(client);
        } else if (active.client && (!active.client.alive || !isMethodNotFound(error))) {
          await this.#reset(active.client);
        }
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    const client = this.#started;
    this.#started = null;
    this.#ready = null;
    if (client) void this.#cleanup(client);
    // Wait for both the active client and any already-exited or timed-out client to finish tearing down its process group.
    while (this.#cleanups.size > 0) {
      await Promise.all([...this.#cleanups.values()]);
    }
  }

  #ensureReady(): Promise<KiroAcpClient> {
    if (this.#closed) return Promise.reject(new Error("The resident Kiro ACP server is closed."));
    if (this.#ready) return this.#ready;
    let ready: Promise<KiroAcpClient>;
    ready = this.#start().catch((error: unknown) => {
      if (this.#ready === ready) this.#ready = null;
      throw error;
    });
    this.#ready = ready;
    ready.catch(() => {});
    return ready;
  }

  async #start(): Promise<KiroAcpClient> {
    if (this.#closed) throw new Error("The resident Kiro ACP server is closed.");

    const client = new KiroAcpClient({
      executable: this.#options.executable,
      cwd: this.#options.cwd ?? process.cwd(),
      env: this.#options.environment(),
    });
    this.#started = client;

    client.on("permission", (request) => {
      client.respondPermission(request.rpcId, { outcome: "cancelled" });
    });
    client.on("exit", () => {
      if (!this.#closed && this.#started === client) {
        this.#started = null;
        this.#ready = null;
        console.error("The resident Kiro ACP server exited; it will restart on next use.");
      }
      // Even when the CLI leader exits on its own, helper subprocesses (such as the v3 engine) may still be running in its process group.
      void this.#cleanup(client);
    });

    const timeoutMs = this.#options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        client.initialize(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`The resident Kiro ACP server did not initialize within ${timeoutMs / 1_000} seconds.`));
          }, timeoutMs);
        }),
      ]);
      if (this.#closed || this.#started !== client) {
        throw new Error("The resident Kiro ACP server is closed.");
      }
      return client;
    } catch (error) {
      if (client.stderrTail.trim()) console.error(`Kiro stderr: ${client.stderrTail.trim()}`);
      if (this.#started === client) {
        this.#started = null;
        this.#ready = null;
      }
      await this.#cleanup(client);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  #detachAndCleanup(client: KiroAcpClient): Promise<void> {
    if (this.#started === client) {
      this.#started = null;
      this.#ready = null;
    }
    return this.#cleanup(client);
  }

  async #reset(client: KiroAcpClient): Promise<void> {
    await this.#detachAndCleanup(client);
  }

  #cleanup(client: KiroAcpClient): Promise<void> {
    let pending = this.#cleanups.get(client);
    if (!pending) {
      pending = client.close().catch(() => {}).finally(() => {
        if (this.#cleanups.get(client) === pending) this.#cleanups.delete(client);
      });
      this.#cleanups.set(client, pending);
    }
    return pending;
  }
}

function isMethodNotFound(error: unknown): boolean {
  return error instanceof KiroRpcError && error.code === METHOD_NOT_FOUND_CODE;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
