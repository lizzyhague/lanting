import { readFile } from "node:fs/promises";
import path from "node:path";

import { LocalizedError } from "../../i18n/text.ts";
import { ensurePrivateDirectory, isMissingFile, writeJsonAtomically } from "../../state/atomic-json.ts";
import {
  AntigravityAcpClient,
  AntigravityRpcError,
  AUTH_REQUIRED_CODE,
  type AntigravitySessionConfig,
} from "./acp-client.ts";

/** Stores the id of the one empty session used for model lookups and `/usage` quota queries. */
export const CATALOG_SESSION_FILE = "catalog-session.json";

/** ACP resource_not_found: session/resume found no saved session with that id (server.py `_restore_session`, 1.5.2). */
export const SESSION_NOT_FOUND_CODE = -32002;

/**
 * When credentials expire and can't be refreshed silently, the Server doesn't error; it prints this authorization URL line on stderr and waits up to 5 minutes for a browser callback.
 * The callback must reach the server machine itself, which the group owner on the web page can't complete, so the operation ends when this line appears.
 */
export const LOGIN_PROMPT = "Open the following link to authenticate the ACP server";

const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;

/** An open response from startup is reused for an immediate model lookup, then refreshed via session/resume later. */
const FRESH_CONFIG_TTL_MS = 30_000;

export type ResidentAntigravityOptions = {
  executable: string;
  stateDirectory: string;
  disabledTools: readonly string[];
  environment: NodeJS.ProcessEnv;
  loginError: () => LocalizedError;
  /** Serializes catalog-session.json creation across proxy and direct residents so only one catalog session is created. */
  withCatalogLock: <T>(work: () => Promise<T>) => Promise<T>;
  startupTimeoutMs?: number;
};

export type ResidentRunOptions = {
  timeoutMs?: number;
  operation?: string;
};

export type ResidentAntigravityHandle = {
  readonly client: AntigravityAcpClient;
  readonly sessionId: string;
  /** Returns and clears the startup configOptions while they are still fresh; returns null on later lookups. */
  takeFreshConfig(): AntigravitySessionConfig | null;
  /** Refreshes the catalog session via session/resume, replacing it only when the Server confirms it is gone. */
  refreshSession(): Promise<AntigravitySessionConfig>;
};

type ReadyState = {
  client: AntigravityAcpClient;
  sessionId: string;
  freshConfig: AntigravitySessionConfig | null;
  freshConfigAt: number;
  loginRequired: boolean;
};

/**
 * Shared Antigravity ACP Server process that runs no chat turns; it keeps the single empty catalog session open
 * so `/usage` quota reads and model catalog lookups avoid a cold start. Operations on one resident are serialized
 * because they share the same session. After exit or failure it stays stopped until the next request restarts it.
 */
export class ResidentAntigravityServer {
  readonly #options: ResidentAntigravityOptions;
  readonly #cleanups = new Map<AntigravityAcpClient, Promise<void>>();
  #ready: Promise<ReadyState> | null = null;
  #started: AntigravityAcpClient | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(options: ResidentAntigravityOptions) {
    this.#options = options;
  }

  /** Warms up in the background; failures are only logged and must not stop lanting from starting. */
  start(): void {
    void this.#ensureReady().catch((error: unknown) => {
      console.error(`Starting the resident Antigravity ACP server failed: ${errorMessage(error)}`);
    });
  }

  /** Runs one serialized operation against the resident catalog session with a bounded timeout. */
  run<T>(work: (handle: ResidentAntigravityHandle) => Promise<T>, options?: ResidentRunOptions): Promise<T> {
    const next = this.#queue.then(() => this.#execute(work, options));
    this.#queue = next.catch(() => {});
    return next;
  }

  async close(): Promise<void> {
    this.#closed = true;
    const client = this.#started;
    this.#started = null;
    this.#ready = null;
    if (client) void this.#cleanup(client);
    // Wait for both the active client and any already-exited or reset client to finish tearing down its process group.
    while (this.#cleanups.size > 0) {
      await Promise.all([...this.#cleanups.values()]);
    }
  }

  async #execute<T>(
    work: (handle: ResidentAntigravityHandle) => Promise<T>,
    options?: ResidentRunOptions,
  ): Promise<T> {
    const state = await this.#ensureReady();
    const handle: ResidentAntigravityHandle = {
      client: state.client,
      get sessionId() {
        return state.sessionId;
      },
      takeFreshConfig: () => {
        const config = state.freshConfig;
        state.freshConfig = null;
        if (!config || Date.now() - state.freshConfigAt > FRESH_CONFIG_TTL_MS) return null;
        return config;
      },
      refreshSession: () => this.#options.withCatalogLock(async () => {
        const config = await this.#openCatalogSession(state.client);
        state.sessionId = config.sessionId;
        return config;
      }),
    };
    const timeoutMs = options?.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    const operation = options?.operation ?? "request";
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      const task = work(handle);
      task.catch(() => {});
      return await Promise.race([
        task,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error(`Antigravity ${operation} did not finish within ${timeoutMs / 1_000} seconds.`));
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      if (state.client.stderrTail.trim()) console.error(`Antigravity stderr: ${state.client.stderrTail.trim()}`);
      if (timedOut || !state.client.alive || state.loginRequired || isAuthRequired(error) || isSessionNotFound(error)) {
        await this.#reset(state.client);
      }
      throw state.loginRequired || isAuthRequired(error) ? this.#options.loginError() : error;
    } finally {
      clearTimeout(timer);
    }
  }

  #ensureReady(): Promise<ReadyState> {
    if (this.#closed) return Promise.reject(new Error("The resident Antigravity ACP server is closed."));
    if (this.#ready) return this.#ready;
    let ready: Promise<ReadyState>;
    ready = this.#start().catch((error: unknown) => {
      if (this.#ready === ready) this.#ready = null;
      throw error;
    });
    this.#ready = ready;
    ready.catch(() => {});
    return ready;
  }

  async #start(): Promise<ReadyState> {
    const directory = this.#options.stateDirectory;
    await ensurePrivateDirectory(directory);
    // Validate the catalog record before spawning so an unreadable file never starts a process.
    await readCatalogSessionId(path.join(directory, CATALOG_SESSION_FILE));
    if (this.#closed) throw new Error("The resident Antigravity ACP server is closed.");

    const client = new AntigravityAcpClient({
      executable: this.#options.executable,
      cwd: directory,
      env: this.#options.environment,
    });
    this.#started = client;
    const state: ReadyState = {
      client,
      sessionId: "",
      freshConfig: null,
      freshConfigAt: 0,
      loginRequired: false,
    };

    client.on("diagnostic", () => {
      if (state.loginRequired || !client.stderrTail.includes(LOGIN_PROMPT)) return;
      // Don't wait out the 5-minute browser callback; detaching and closing rejects any pending request.
      state.loginRequired = true;
      void this.#reset(client);
    });
    client.on("permission", (request) => {
      client.respondPermission(request.rpcId, { outcome: "cancelled" });
    });
    client.on("exit", () => {
      if (!this.#closed && this.#started === client) {
        this.#started = null;
        this.#ready = null;
        console.error("The resident Antigravity ACP server exited; it will restart on next use.");
      }
      // Even when the Server leader exits on its own, helper subprocesses may still be running in its process group.
      void this.#cleanup(client);
    });

    const timeoutMs = this.#options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    try {
      const config = await Promise.race([
        (async () => {
          await client.initialize();
          return this.#options.withCatalogLock(() => this.#openCatalogSession(client));
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`The resident Antigravity ACP server did not initialize within ${timeoutMs / 1_000} seconds.`));
          }, timeoutMs);
        }),
      ]);
      if (this.#closed || this.#started !== client) {
        throw new Error("The resident Antigravity ACP server is closed.");
      }
      state.sessionId = config.sessionId;
      state.freshConfig = config;
      state.freshConfigAt = Date.now();
      return state;
    } catch (error) {
      if (client.stderrTail.trim()) console.error(`Antigravity stderr: ${client.stderrTail.trim()}`);
      if (this.#started === client) {
        this.#started = null;
        this.#ready = null;
      }
      await this.#cleanup(client);
      throw state.loginRequired || isAuthRequired(error) ? this.#options.loginError() : error;
    } finally {
      clearTimeout(timer);
    }
  }

  async #openCatalogSession(client: AntigravityAcpClient): Promise<AntigravitySessionConfig> {
    const directory = this.#options.stateDirectory;
    await ensurePrivateDirectory(directory);
    const file = path.join(directory, CATALOG_SESSION_FILE);
    const stored = await readCatalogSessionId(file);
    let config: AntigravitySessionConfig | null = null;
    if (stored) {
      try {
        config = await client.sessionResume(stored, directory, { disabledTools: this.#options.disabledTools });
      } catch (error) {
        // Only a session the Server confirms is gone is replaced. Any other failure keeps the saved id and fails this lookup,
        // so a passing error never leaves an unreachable empty session behind.
        if (!isSessionNotFound(error)) throw error;
      }
    }
    if (!config) {
      config = await client.sessionNew(directory, { disabledTools: this.#options.disabledTools });
      await writeJsonAtomically(file, { sessionId: config.sessionId });
    }
    return config;
  }

  async #reset(client: AntigravityAcpClient): Promise<void> {
    if (this.#started === client) {
      this.#started = null;
      this.#ready = null;
    }
    await this.#cleanup(client);
  }

  #cleanup(client: AntigravityAcpClient): Promise<void> {
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

/**
 * Only a missing file means there is no catalog session yet. A file that can't be read or has no session id fails the lookup
 * and is left as it is, rather than being overwritten by a new session.
 */
export async function readCatalogSessionId(file: string): Promise<string | null> {
  // Reads the file itself: readJsonIfPresent also returns null for a file whose content is JSON null.
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`State file is not valid JSON: ${file}`, { cause: error });
  }
  const sessionId = typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as { sessionId?: unknown }).sessionId
    : undefined;
  if (typeof sessionId !== "string" || !sessionId) throw new Error(`State file has no session id: ${file}`);
  return sessionId;
}

function isAuthRequired(error: unknown): boolean {
  return error instanceof AntigravityRpcError && error.code === AUTH_REQUIRED_CODE;
}

function isSessionNotFound(error: unknown): boolean {
  return error instanceof AntigravityRpcError && error.code === SESSION_NOT_FOUND_CODE;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
