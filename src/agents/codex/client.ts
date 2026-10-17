import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/*
 * JSONL client for codex app-server, ported from Codex Remote `src/app-server/client.ts`.
 * Keeps only the protocol types in use rather than the whole generated type set.
 *
 * Doesn't split lines with node:readline: it also treats U+2028 and U+2029 as line breaks, which are valid in JSON strings.
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

/** Only the first few non-JSONL noise lines are logged, so a chatty subprocess can't flood the log. */
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
   * Gives this app-server its own process group. Session workers use it so that abnormal cleanup
   * can terminate the full process tree the worker started; shared directory processes keep the default false.
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
 * Holds one codex app-server subprocess and pairs JSONL requests with responses.
 * The browser protocol never touches this class directly; the Codex adapter translates.
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
  #stdoutBuffer = "";
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

    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => this.#onStdout(chunk));

    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderrTail = `${this.#stderrTail}${chunk}`.slice(-16_384);
    });

    // When the subprocess exits, stdin becomes a broken pipe. Without this listener an in-flight write
    // throws an uncaught stream error that takes down the whole web backend.
    this.#child.stdin.on("error", (error: Error) => this.#fail(error));

    this.#child.once("error", (error) => {
      this.#fail(error);
      this.#resolveExit();
    });
    this.#child.once("exit", (code, signal) => {
      const detail = code === 0
        ? "codex app-server exited."
        : `codex app-server exited abnormally (code=${String(code)}, signal=${String(signal)}).`;
      this.#fail(new Error(this.#stderrTail.trim() || detail));
      this.#resolveExit();
    });
    // A failed spawn emits only error/close, no exit; close is the fallback so whenExited() always settles.
    this.#child.once("close", () => this.#resolveExit());
  }

  /** Settles once the subprocess ends. Callers use it to decide whether to exit the whole service and let systemd restart it. */
  whenExited(): Promise<void> {
    return this.#exitPromise;
  }

  async initialize(params: InitializeParams): Promise<InitializeResponse> {
    const result = await this.request("initialize", params);
    if (!isInitializeResponse(result)) {
      throw new Error("codex app-server returned an unrecognized initialize result.");
    }

    this.notify({ method: "initialized" });
    return result;
  }

  request<Result = unknown>(method: string, params: unknown): Promise<Result> {
    if (this.#closed) {
      return Promise.reject(new Error("The codex app-server connection is closed."));
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
      throw new Error("The codex app-server connection is closed.");
    }
    this.#write({ id, result });
  }

  /** Unrecognized server requests must still be answered, or Codex waits forever. */
  rejectServerRequest(id: RequestId, message: string): void {
    if (this.#closed) return;
    this.#write({ id, error: { code: -32601, message } });
  }

  get closed(): boolean {
    return this.#closed;
  }

  notify(notification: ClientNotification): void {
    if (this.#closed) {
      throw new Error("The codex app-server connection is closed.");
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
    // After the group leader exits, tool grandchildren that ignore stdin's lifetime may remain in the group.
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
      // ESRCH means the whole group has exited cleanly, which is the desired state.
    }
  }

  #terminate(signal: NodeJS.Signals): void {
    const pid = this.#child.pid;
    if (pid && this.#processGroup) {
      try {
        // A detached child's pid is also its process group id; a negative pid terminates the tool subprocesses too.
        process.kill(-pid, signal);
        return;
      } catch {
        // Non-worker clients have no separate process group, or the process already exited; fall back to a single-process signal.
      }
    }
    this.#child.kill(signal);
  }

  #write(message: object): void {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onStdout(chunk: string): void {
    this.#stdoutBuffer += chunk;
    let index: number;
    while ((index = this.#stdoutBuffer.indexOf("\n")) >= 0) {
      let line = this.#stdoutBuffer.slice(0, index);
      this.#stdoutBuffer = this.#stdoutBuffer.slice(index + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.#handleLine(line);
    }
  }

  #handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // Codex occasionally writes warnings to stdout. Just skip the line; don't permanently
      // disconnect a still-healthy subprocess over one line of noise.
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
      this.#fail(new Error("A codex app-server response has no valid request ID."));
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
      console.warn(`Ignoring non-JSONL output from codex app-server: ${line.slice(0, 200)}`);
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

/**
 * The CLI has no use for the web login token; keeping it would only give every tool subprocess control of the web side.
 * Claude's long-lived OAuth token isn't handed to other CLIs or their tool subprocesses either.
 */
function withoutWebLoginToken(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnvironment = { ...environment };
  delete childEnvironment.ACCESS_TOKEN;
  delete childEnvironment.CLAUDE_CODE_OAUTH_TOKEN;
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
    return { code: -1, message: "codex app-server returned an unknown error." };
  }

  return {
    code: typeof value.code === "number" ? value.code : -1,
    message: typeof value.message === "string" ? value.message : "codex app-server returned an unknown error.",
    ...(value.data === undefined ? {} : { data: value.data }),
  };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
