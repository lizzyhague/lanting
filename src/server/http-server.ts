import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import type { SharedUploadClient } from "../attachments/shared-upload-client.ts";
import { MAX_UPLOAD_BYTES, SharedUploadError } from "../attachments/types.ts";
import { CookieAuth, secretsEqual } from "./auth.ts";
import { BrowserConnection, type BrowserConnectionServices, type BrowserSocket } from "./connection.ts";
import { openViewableFile } from "./files.ts";
import { MAX_BROWSER_MESSAGE_BYTES } from "./protocol.ts";
import { WebAssets } from "./web-assets.ts";

export type ServerAddress = { host: "127.0.0.1"; port: number };

export type WebServerOptions = {
  token: string;
  services: BrowserConnectionServices;
  fileRoots?: string[];
  /** Returns starting while startup recovery hasn't finished. */
  readyState?: () => "starting" | "ok";
  heartbeatIntervalMs?: number;
  allowedOrigins?: string[];
  webRoot?: string;
  /** ai-remote-upload client; without it the upload endpoint returns 503. */
  uploads?: Pick<SharedUploadClient, "upload">;
};

const DEFAULT_WEB_ROOT = fileURLToPath(new URL("../../public/", import.meta.url));
const MAX_OUTBOUND_BUFFER_BYTES = 16 * 1_048_576;

/*
 * This is an allowlist, not a directory server: new frontend files must be registered here or they all return 404,
 * and the service must be restarted for it to take effect.
 */
const STATIC_FILES: Record<string, { file: string; contentType: string }> = {
  "/view": { file: "view.html", contentType: "text/html; charset=utf-8" },
  "/viewer.js": { file: "viewer.js", contentType: "text/javascript; charset=utf-8" },
  "/viewer.css": { file: "viewer.css", contentType: "text/css; charset=utf-8" },
  "/": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/boot.js": { file: "boot.js", contentType: "text/javascript; charset=utf-8" },
  "/theme.js": { file: "theme.js", contentType: "text/javascript; charset=utf-8" },
  "/strings.js": { file: "strings.js", contentType: "text/javascript; charset=utf-8" },
  "/i18n.js": { file: "i18n.js", contentType: "text/javascript; charset=utf-8" },
  "/app.js": { file: "app.js", contentType: "text/javascript; charset=utf-8" },
  "/agents.js": { file: "agents.js", contentType: "text/javascript; charset=utf-8" },
  "/markdown.js": { file: "markdown.js", contentType: "text/javascript; charset=utf-8" },
  "/call-order.js": { file: "call-order.js", contentType: "text/javascript; charset=utf-8" },
  "/confirm-dialog.js": { file: "confirm-dialog.js", contentType: "text/javascript; charset=utf-8" },
  "/notice.js": { file: "notice.js", contentType: "text/javascript; charset=utf-8" },
  "/selection-bar.js": { file: "selection-bar.js", contentType: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", contentType: "text/css; charset=utf-8" },
  "/icon.svg": { file: "icon.svg", contentType: "image/svg+xml" },
  "/logo.svg": { file: "logo.svg", contentType: "image/svg+xml" },
  "/manifest.webmanifest": {
    file: "manifest.webmanifest",
    contentType: "application/manifest+json; charset=utf-8",
  },
  "/sw.js": { file: "sw.js", contentType: "text/javascript; charset=utf-8" },
  "/icon-192.png": { file: "icon-192.png", contentType: "image/png" },
  "/icon-512.png": { file: "icon-512.png", contentType: "image/png" },
  "/icon-512-maskable.png": { file: "icon-512-maskable.png", contentType: "image/png" },
};

export class WebServer {
  readonly #token: string;
  readonly #auth: CookieAuth;
  readonly #fileRoots: readonly string[];
  readonly #services: BrowserConnectionServices;
  readonly #readyState: () => "starting" | "ok";
  readonly #heartbeatIntervalMs: number;
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #webRoot: string;
  readonly #webAssets: WebAssets;
  readonly #uploads: WebServerOptions["uploads"];
  readonly #http: Server;
  readonly #webSockets: WebSocketServer;
  readonly #connections = new Map<WebSocket, BrowserConnection>();
  #listening = false;

  constructor(options: WebServerOptions) {
    if (!options.token) throw new Error("The access token must not be empty.");
    this.#token = options.token;
    this.#auth = new CookieAuth(options.token);
    this.#fileRoots = options.fileRoots ?? [];
    this.#services = options.services;
    this.#readyState = options.readyState ?? (() => "ok");
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.#allowedOrigins = new Set(options.allowedOrigins ?? []);
    this.#webRoot = options.webRoot ?? DEFAULT_WEB_ROOT;
    this.#uploads = options.uploads;
    this.#webAssets = new WebAssets(this.#webRoot, Object.values(STATIC_FILES)
      .map((asset) => asset.file).filter((file) => /\.(js|css)$/u.test(file) && file !== "sw.js"));
    this.#http = createServer((request, response) => {
      void this.#serveHttp(request, response).catch((error: unknown) => {
        console.error(error);
        if (response.headersSent) response.destroy();
        else sendJson(response, 500, { error: { message: "The request failed." } });
      });
    });
    this.#webSockets = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_BROWSER_MESSAGE_BYTES,
      perMessageDeflate: false,
    });

    this.#http.on("upgrade", (request, socket, head) => {
      // This listener is a synchronous callback; an uncaught throw would exit the process. An unparsable request target is treated as non-/ws.
      const pathname = URL.parse(request.url ?? "/", "http://127.0.0.1")?.pathname;
      if (pathname !== "/ws") {
        socket.destroy();
        return;
      }
      if (!this.#originAllowed(request)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      if (!this.#auth.read(request.headers.cookie)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.#webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        this.#webSockets.emit("connection", webSocket, request);
      });
    });
    this.#webSockets.on("connection", (webSocket) => this.#accept(webSocket));
  }

  listen(port: number): Promise<ServerAddress> {
    if (this.#listening) return Promise.reject(new Error("The server is already listening."));
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        this.#http.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.#http.off("error", onError);
        this.#listening = true;
        const address = this.#http.address() as AddressInfo;
        resolve({ host: "127.0.0.1", port: address.port });
      };
      this.#http.once("error", onError);
      this.#http.once("listening", onListening);
      this.#http.listen(port, "127.0.0.1");
    });
  }

  async close(): Promise<void> {
    if (!this.#listening) return;
    this.#listening = false;
    for (const [webSocket, connection] of this.#connections) {
      connection.dispose();
      webSocket.terminate();
    }
    this.#connections.clear();
    await Promise.all([
      new Promise<void>((resolve) => this.#webSockets.close(() => resolve())),
      new Promise<void>((resolve, reject) =>
        this.#http.close((error) => error ? reject(error) : resolve())
      ),
    ]);
  }

  async #serveHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "GET" && pathname === "/healthz") {
      const status = this.#readyState();
      response.writeHead(status === "ok" ? 200 : 503, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(`${JSON.stringify({ status })}\n`);
      return;
    }
    if (pathname === "/auth/login") {
      await this.#login(request, response);
      return;
    }
    if (["/auth/session", "/raw", "/attachments/upload"].includes(pathname)) {
      if (!this.#originAllowed(request)) {
        sendJson(response, 403, { error: { message: "Request origin mismatch." } });
        return;
      }
      const cookie = this.#auth.read(request.headers.cookie);
      if (!cookie) {
        sendJson(response, 401, { error: { message: "Sign in first." } });
        return;
      }
      // Authenticated HTTP requests renew the cookie.
      response.setHeader("set-cookie", this.#auth.header(cookie));
    }
    if (pathname === "/attachments/upload") {
      await this.#receiveUpload(request, response);
      return;
    }
    if (pathname === "/auth/session") {
      if (request.method !== "GET") {
        response.setHeader("allow", "GET");
        sendJson(response, 405, { error: { message: "Only GET is allowed." } });
      } else {
        sendJson(response, 200, { authenticated: true });
      }
      return;
    }
    if (pathname === "/raw") {
      await this.#serveRaw(request, response);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" });
      response.end("Method not allowed\n");
      return;
    }
    const versioned = pathname.startsWith("/assets/") ? await this.#webAssets.read(pathname) : null;
    const asset = STATIC_FILES[versioned ? `/${versioned.file}` : pathname];
    if (!asset) {
      response.writeHead(404);
      response.end("Not found\n");
      return;
    }
    let body = versioned?.body ?? await readFile(path.join(this.#webRoot, asset.file));
    if (asset.contentType.startsWith("text/html")) body = await this.#webAssets.page(body);
    response.writeHead(200, {
      "content-type": asset.contentType,
      "content-length": body.byteLength,
      "cache-control": versioned ? "public, max-age=31536000, immutable" : "no-cache, must-revalidate",
      "content-security-policy": [
        "default-src 'self'",
        "connect-src 'self' ws: wss:",
        "img-src 'self' data:",
        "style-src 'self'",
        "script-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
      "x-content-type-options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  }

  async #serveRaw(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader(
      "content-security-policy",
      "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    );
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      sendJson(response, 405, { error: { message: "Only GET or HEAD is allowed." } });
      return;
    }
    const params = new URL(request.url ?? "/", "http://127.0.0.1").searchParams;
    const file = params.getAll("path").length === 1
      ? await openViewableFile(this.#fileRoots, params.get("path")!)
      : null;
    if (!file) {
      sendJson(response, 404, { error: { message: "The file does not exist or cannot be viewed." } });
      return;
    }
    try {
      response.writeHead(200, {
        "content-type": file.contentType,
        "content-length": file.size,
      });
      if (request.method === "HEAD" || file.size === 0) {
        response.end();
      } else {
        await pipeline(file.handle.createReadStream({ autoClose: false, end: file.size - 1 }), response);
      }
    } finally {
      await file.handle.close();
    }
  }

  async #login(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      sendJson(response, 405, { error: { message: "Only POST is allowed." } });
      return;
    }
    if (!this.#originAllowed(request)) {
      sendJson(response, 403, { error: { message: "Sign-in origin mismatch." } });
      return;
    }
    if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
      sendJson(response, 415, { error: { message: "A JSON request is required." } });
      return;
    }
    const chunks: Buffer[] = [];
    let length = 0;
    try {
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        length += buffer.length;
        if (length > 16_384) {
          sendJson(response, 413, { error: { message: "The sign-in request is too large." } });
          return;
        }
        chunks.push(buffer);
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (typeof value !== "object" || value === null ||
          !("token" in value) || typeof value.token !== "string") {
        sendJson(response, 400, { error: { message: "Provide the access token." } });
        return;
      }
      if (!secretsEqual(value.token, this.#token)) {
        sendJson(response, 401, { error: { message: "The access token is incorrect." } });
        return;
      }
    } catch {
      sendJson(response, 400, { error: { message: "Invalid sign-in request." } });
      return;
    }
    response.setHeader("set-cookie", this.#auth.header(this.#auth.issue()));
    sendJson(response, 200, { authenticated: true });
  }

  /** As in Relayu: the browser sends the file here with a ticket, and it is streamed as-is to ai-remote-upload without first reading it into memory. */
  async #receiveUpload(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      sendUploadError(response, new SharedUploadError("method_not_allowed", "只允许 POST 上传。", 405));
      return;
    }
    if (!this.#uploads) {
      sendUploadError(response, new SharedUploadError("uploads_unavailable", "附件服务没有启用。", 503));
      return;
    }
    const ticket = request.headers["x-upload-ticket"];
    const contentLength = parseUploadLength(request.headers["content-length"]);
    if (typeof ticket !== "string" || !ticket) {
      sendUploadError(response, new SharedUploadError("missing_ticket", "请求缺少上传票据。", 401));
      return;
    }
    if (contentLength === null) {
      sendUploadError(response, new SharedUploadError("invalid_content_length", "上传必须提供有效的 Content-Length。", 411));
      return;
    }
    if (contentLength > MAX_UPLOAD_BYTES) {
      sendUploadError(response, new SharedUploadError("file_too_large", "单个文件不能超过 25 MiB。", 413));
      return;
    }
    try {
      const attachment = await this.#uploads.upload(ticket, contentLength, request);
      sendJson(response, 201, { attachment });
    } catch (error) {
      sendUploadError(response, error);
    }
  }

  #originAllowed(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (typeof origin !== "string" || !origin) return true;
    if (this.#allowedOrigins.has(origin)) return true;

    let originHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return false;
    }
    return [request.headers.host, request.headers["x-forwarded-host"]]
      .flatMap((value) => typeof value === "string" ? value.split(",") : [])
      .map((value) => value.trim().toLowerCase())
      .includes(originHost);
  }

  #accept(webSocket: WebSocket): void {
    const socket: BrowserSocket = {
      send: (data) => {
        if (webSocket.readyState !== WebSocket.OPEN) return;
        if (webSocket.bufferedAmount > MAX_OUTBOUND_BUFFER_BYTES) {
          webSocket.close(1013, "Client too slow");
          return;
        }
        webSocket.send(data);
      },
      close: (code, reason) => webSocket.close(code, reason),
    };
    const connection = new BrowserConnection(socket, this.#services);
    this.#connections.set(webSocket, connection);

    let responsive = true;
    webSocket.on("pong", () => {
      responsive = true;
    });
    const heartbeat = setInterval(() => {
      if (!responsive) {
        webSocket.terminate();
        return;
      }
      responsive = false;
      webSocket.ping();
    }, this.#heartbeatIntervalMs);
    heartbeat.unref();

    webSocket.on("message", (data, isBinary) => {
      if (isBinary) {
        webSocket.close(1003, "Text messages only");
        return;
      }
      connection.receiveText(rawDataToString(data));
    });
    // On protocol errors such as oversized frames or invalid UTF-8, ws closes the connection itself and then emits error;
    // an error with no listener would exit the whole process, so this only logs.
    webSocket.on("error", (error) => {
      console.error(`WebSocket error, connection closed: ${error.message}`);
    });
    webSocket.once("close", () => {
      clearInterval(heartbeat);
      connection.dispose();
      this.#connections.delete(webSocket);
    });
  }
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function parseUploadLength(value: string | undefined): number | null {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

function sendUploadError(response: ServerResponse, error: unknown): void {
  const normalized = error instanceof SharedUploadError
    ? error
    : new SharedUploadError("upload_failed", "附件上传失败。", 500);
  // When responding with an error before the upload is fully read, tell the browser to stop sending.
  response.setHeader("connection", "close");
  sendJson(response, normalized.status, { error: { code: normalized.code, message: normalized.message } });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}
