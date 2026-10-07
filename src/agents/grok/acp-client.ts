import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

import {
  encodeMessage,
  isNotification,
  isRequest,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from "./jsonrpc.ts";

export type AcpPermissionRequest = {
  rpcId: number | string;
  sessionId: string;
  toolCall: Record<string, unknown>;
  options: Array<{ optionId: string; name: string; kind: string }>;
};

export type AcpUpdate = {
  sessionId: string;
  update: Record<string, unknown>;
};

export type AcpPromptContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string; uri?: string }
  | {
    type: "resource";
    resource:
      | { uri: string; mimeType?: string; text: string }
      | { uri: string; mimeType?: string; blob: string };
  };

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

/**
 * ACP JSON-RPC 客户端，搬自 Grok Remote `src/worker/acp-client.ts`，去掉了 rewind 等
 * 本项目不用的调用。不向 Grok 声明 fs / terminal 能力。
 */
export class AcpClient extends EventEmitter {
  readonly #proc: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed = false;
  #rl: readline.Interface;
  #initialize: unknown = null;

  constructor(proc: ChildProcessWithoutNullStreams) {
    super();
    this.#proc = proc;
    this.#rl = readline.createInterface({ input: proc.stdout });
    this.#rl.on("line", (line) => this.#onLine(line));
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString("utf8").trim();
      if (text) this.emit("stderr", text);
    });
    proc.on("exit", (code, signal) => {
      this.#failAll(new Error(`Grok Worker 已退出（${signal ?? code ?? "unknown"}）。`));
      this.emit("exit", { code, signal });
    });
  }

  get initializeResult(): unknown {
    return this.#initialize;
  }

  async initialize(): Promise<unknown> {
    this.#initialize = await this.request("initialize", {
      protocolVersion: 1,
      clientInfo: {
        name: "lanting",
        title: "lanting",
        version: "0.1.0",
      },
      clientCapabilities: {},
    });
    return this.#initialize;
  }

  /**
   * rules 追加到系统提示，只在 session/new 发送；session/resume 不再带，
   * 以免恢复会话时重复追加。
   */
  async sessionNew(cwd: string, yoloMode: boolean, rules: string): Promise<string> {
    const result = await this.request("session/new", {
      cwd,
      mcpServers: [],
      _meta: { yoloMode, rules },
    }) as { sessionId?: string };
    if (!result?.sessionId) {
      throw new Error("Grok 没有返回 session id。");
    }
    return result.sessionId;
  }

  async sessionResume(sessionId: string, cwd: string, yoloMode: boolean): Promise<void> {
    await this.request("session/resume", {
      sessionId,
      cwd,
      mcpServers: [],
      _meta: { yoloMode },
    });
  }

  async sessionSetModel(
    sessionId: string,
    modelId: string,
    reasoningEffort: string | null = null,
  ): Promise<void> {
    await this.request("session/set_model", {
      sessionId,
      modelId,
      ...(reasoningEffort ? { _meta: { reasoningEffort } } : {}),
    });
  }

  async sessionSetMode(sessionId: string, modeId: string): Promise<void> {
    await this.request("session/set_mode", { sessionId, modeId });
  }

  async sessionRename(sessionId: string, title: string): Promise<void> {
    const result = await this.request("_x.ai/session/rename", {
      sessionId,
      title,
      resetToAuto: false,
    }) as { success?: boolean };
    if (result?.success !== true) {
      throw new Error("Grok 没有完成会话重命名。");
    }
  }

  async sessionPrompt(
    sessionId: string,
    input: string | AcpPromptContent[],
  ): Promise<{ stopReason?: string }> {
    return await this.request("session/prompt", {
      sessionId,
      prompt: typeof input === "string" ? [{ type: "text", text: input }] : input,
    }) as { stopReason?: string };
  }

  sessionCancel(sessionId: string): void {
    this.notify("session/cancel", { sessionId });
  }

  async sessionClose(sessionId: string): Promise<void> {
    try {
      await this.request("session/close", { sessionId });
    } catch {
      // close 能力因版本而异；失败时由进程组清理兜底。
    }
  }

  respondPermission(
    rpcId: number | string,
    outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string },
  ): void {
    this.#write({
      jsonrpc: "2.0",
      id: rpcId,
      result: { outcome },
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new Error("Grok Worker 已经关闭。"));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#rl.close();
    this.#failAll(new Error("Grok Worker 已关闭。"));
    if (!this.#proc.killed) {
      this.#proc.stdin.end();
    }
  }

  #onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      this.emit("stderr", trimmed);
      return;
    }

    if (isRequest(message)) {
      this.#onServerRequest(message);
      return;
    }
    if (isNotification(message)) {
      if (message.method === "session/update" || message.method === "_x.ai/session/update") {
        const params = (message.params ?? {}) as Record<string, unknown>;
        this.emit("update", {
          sessionId: typeof params.sessionId === "string" ? params.sessionId : "",
          update: (params.update ?? {}) as Record<string, unknown>,
        } satisfies AcpUpdate);
      }
      this.emit("notification", message);
      return;
    }
    if (message.id === null || message.id === undefined) return;
    const pending = this.#pending.get(Number(message.id));
    if (!pending) return;
    this.#pending.delete(Number(message.id));
    if (message.error) {
      pending.reject(new Error(message.error.message));
      return;
    }
    pending.resolve(message.result);
  }

  #onServerRequest(message: JsonRpcRequest): void {
    if (message.method === "session/request_permission") {
      const params = (message.params ?? {}) as Record<string, unknown>;
      const options = Array.isArray(params.options) ? params.options : [];
      this.emit("permission", {
        rpcId: message.id,
        sessionId: typeof params.sessionId === "string" ? params.sessionId : "",
        toolCall: (params.toolCall ?? {}) as Record<string, unknown>,
        options: options.filter(isPermissionOption),
      } satisfies AcpPermissionRequest);
      return;
    }
    this.#write({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `Method not found: ${message.method}` },
    });
  }

  #write(message: JsonRpcMessage): void {
    if (this.#closed || this.#proc.stdin.destroyed) return;
    this.#proc.stdin.write(encodeMessage(message));
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function isPermissionOption(
  value: unknown,
): value is { optionId: string; name: string; kind: string } {
  return typeof value === "object" &&
    value !== null &&
    typeof (value as { optionId?: unknown }).optionId === "string" &&
    typeof (value as { kind?: unknown }).kind === "string";
}
