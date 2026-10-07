import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { WebSocket } from "ws";

import { FakeAdapter } from "../agents/fake-adapter.test-support.ts";
import { AgentRegistry } from "../agents/registry.ts";
import { GroupRuntime } from "../group/runtime.ts";
import { GroupService } from "../group/service.ts";
import { GroupStore } from "../state/group-store.ts";
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
  const projectRoot = path.join(webRoot, "projects");
  await mkdir(path.join(projectRoot, "demo"), { recursive: true });
  const store = await GroupStore.open(path.join(webRoot, "data"));
  const claude = new FakeAdapter("claude");
  const agents = new AgentRegistry([claude]);
  const runtime = new GroupRuntime({ store, agents });
  const groups = new GroupService({ projectRoot, store, runtime, agents });
  const hub = new ConnectionHub();
  groups.onEvent((event) => {
    hub.handle(event.scope === "global"
      ? { target: "global", payload: event.payload }
      : { target: "group", groupId: event.groupId, payload: event.payload });
  });
  const server = new WebServer({ token: TOKEN, services: { hub, groups }, webRoot });
  const { port } = await server.listen(0);
  t.after(async () => {
    await server.close();
    await runtime.shutdown();
    await rm(webRoot, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${port}`, port, hub, claude };
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

test("a browser can create a group, run a round, and answer an approval over the websocket", async (t) => {
  const { base, port, claude } = await startServer(t);
  claude.script = () => [
    { type: "text", delta: "thinking" },
    { type: "ask", toolName: "Bash" },
    { type: "end", outcome: "completed", text: "final answer" },
  ];
  const cookie = cookieFrom(await login(base));
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
  t.after(() => socket.terminate());
  await once(socket, "open");

  const inbox: { type: string; requestId?: string; event?: { type: string; [key: string]: unknown }; [key: string]: unknown }[] = [];
  socket.on("message", (data) => inbox.push(JSON.parse(String(data))));
  const waitFor = async <T>(pick: () => T | undefined): Promise<T> => {
    for (;;) {
      const found = pick();
      if (found !== undefined) return found;
      await once(socket, "message");
    }
  };
  let nextId = 0;
  const call = async (type: string, fields: Record<string, unknown> = {}) => {
    const requestId = `r${++nextId}`;
    socket.send(JSON.stringify({ ...fields, type, requestId }));
    const response = await waitFor(() => inbox.find((message) => message.requestId === requestId));
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.data as Record<string, unknown>;
  };
  const event = (type: string) => waitFor(() => inbox.find((message) => message.event?.type === type)?.event);

  await call("connection.ready");
  const state = await call("app.state");
  assert.deepEqual(state.agents, [{ id: "claude", displayName: "Claude" }]);
  assert.deepEqual(state.directories, ["demo"]);

  const { group } = await call("group.create", { directory: "demo", members: ["claude"], title: "" }) as {
    group: { id: string; title: string; directory: string };
  };
  assert.equal(group.title, "demo");
  assert.equal(group.directory, "demo");
  await event("group.created");

  const snapshot = await call("group.subscribe", { groupId: group.id });
  assert.deepEqual(snapshot.transcript, []);
  await call("round.start", { groupId: group.id, text: "hello", order: ["claude"] });

  const requested = await event("approval.requested") as unknown as { approval: { approvalId: string; agent: string } };
  assert.equal(requested.approval.agent, "claude");
  const midRound = await call("group.subscribe", { groupId: group.id }) as {
    round: { speaking: string; text: string };
    approvals: unknown[];
  };
  assert.equal(midRound.round.speaking, "claude");
  assert.equal(midRound.round.text, "thinking");
  assert.equal(midRound.approvals.length, 1);
  await call("approval.respond", { approvalId: requested.approval.approvalId, decision: "allow" });

  const ended = await event("round.ended");
  assert.equal(ended.outcome, "completed");
  const final = await call("group.subscribe", { groupId: group.id }) as {
    transcript: { text: string; status?: string }[];
    group: { busy: boolean };
  };
  assert.deepEqual(final.transcript.map((entry) => [entry.text, entry.status]), [
    ["hello", undefined],
    ["final answer", "completed"],
  ]);
  assert.equal(final.group.busy, false);
});
