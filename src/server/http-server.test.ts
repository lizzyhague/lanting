import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { WebSocket } from "ws";

import { COOKIE_NAME } from "./auth.ts";
import { ConnectionHub } from "./hub.ts";
import { WebServer } from "./http-server.ts";

const TOKEN = "0123456789abcdef0123456789abcdef";

async function startServer(t: test.TestContext) {
  const webRoot = await mkdtemp(path.join(tmpdir(), "lanting-web-"));
  await writeFile(path.join(webRoot, "index.html"),
    '<!doctype html><html><head><script src="/app.js"></script></head><body>lanting</body></html>');
  await writeFile(path.join(webRoot, "app.js"), "console.log('app');\n");
  await writeFile(path.join(webRoot, "boot.js"), "");
  await writeFile(path.join(webRoot, "styles.css"), "");
  const hub = new ConnectionHub();
  const server = new WebServer({ token: TOKEN, services: { hub }, webRoot });
  const { port } = await server.listen(0);
  t.after(async () => {
    await server.close();
    await rm(webRoot, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${port}`, port, hub };
}

async function login(base: string, token = TOKEN): Promise<Response> {
  return fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const cookie = header.split(";")[0] ?? "";
  assert.ok(cookie.startsWith(`${COOKIE_NAME}=`));
  return cookie;
}

test("healthz reports readiness without login", async (t) => {
  const { base } = await startServer(t);
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("login issues a cookie that authenticates the session endpoint", async (t) => {
  const { base } = await startServer(t);

  assert.equal((await fetch(`${base}/auth/session`)).status, 401);
  assert.equal((await login(base, "wrong")).status, 401);
  assert.equal((await fetch(`${base}/auth/login`)).status, 405);
  const notJson = await fetch(`${base}/auth/login`, { method: "POST", body: "{}" });
  assert.equal(notJson.status, 415);

  const response = await login(base);
  assert.equal(response.status, 200);
  const cookie = cookieFrom(response);
  const session = await fetch(`${base}/auth/session`, { headers: { cookie } });
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), { authenticated: true });
});

test("login and session reject a foreign origin", async (t) => {
  const { base } = await startServer(t);
  const response = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://elsewhere.example" },
    body: JSON.stringify({ token: TOKEN }),
  });
  assert.equal(response.status, 403);
});

test("serves only allow-listed static files and rewrites assets to versioned paths", async (t) => {
  const { base } = await startServer(t);
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/u);
  const html = await page.text();
  const match = /src="(\/assets\/[a-f0-9]{64}\/app\.js)"/u.exec(html);
  assert.ok(match, html);

  const asset = await fetch(`${base}${match[1]}`);
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), "console.log('app');\n");
  assert.match(asset.headers.get("cache-control") ?? "", /immutable/u);

  assert.equal((await fetch(`${base}/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/`, { method: "POST" })).status, 405);
});

test("websocket requires login and answers connection.ready", async (t) => {
  const { base, port, hub } = await startServer(t);

  const anonymous = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  anonymous.on("error", () => {});
  const [upgrade, rejected] = await once(anonymous, "unexpected-response");
  assert.equal(rejected.statusCode, 401);
  upgrade.destroy();

  const cookie = cookieFrom(await login(base));
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
  t.after(() => socket.terminate());
  await once(socket, "open");
  assert.equal(hub.size, 1);

  const messages: unknown[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(String(data))));
  const next = async (): Promise<unknown> => {
    while (messages.length === 0) await once(socket, "message");
    return messages.shift();
  };

  // connection.ready 之前的全局事件要暂存，排在响应之后发出。
  hub.handle({ target: "global", payload: { type: "hello" } });
  socket.send(JSON.stringify({ type: "connection.ready", requestId: "r1" }));
  assert.deepEqual(await next(), { type: "response", requestId: "r1", ok: true, data: {} });
  assert.deepEqual(await next(), { type: "event", event: { type: "hello" } });

  socket.send("not json");
  assert.deepEqual(await next(), {
    type: "error",
    requestId: null,
    error: { code: "invalid_json", message: "消息不是有效的 JSON。" },
  });
});
