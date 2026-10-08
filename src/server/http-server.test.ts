import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { WebSocket } from "ws";

import { FakeAdapter } from "../agents/fake-adapter.test-support.ts";
import { PALETTE } from "../agents/palette.ts";
import { AgentRegistry } from "../agents/registry.ts";
import { GroupRuntime } from "../group/runtime.ts";
import { GroupService } from "../group/service.ts";
import { GroupStore } from "../state/group-store.ts";
import { SettingsStore } from "../state/settings-store.ts";
import { COOKIE_NAME } from "./auth.ts";
import { ConnectionHub } from "./hub.ts";
import { WebServer } from "./http-server.ts";

const TOKEN = "0123456789abcdef0123456789abcdef";

async function startServer(t: test.TestContext) {
  const webRoot = await mkdtemp(path.join(tmpdir(), "lanting-web-"));
  await writeFile(path.join(webRoot, "index.html"),
    '<!doctype html><html><head><script src="/app.js"></script></head><body>lanting</body></html>');
  await writeFile(path.join(webRoot, "view.html"),
    '<!doctype html><html><head><script type="module" src="/viewer.js"></script><link href="/viewer.css" rel="stylesheet"></head></html>');
  await writeFile(path.join(webRoot, "app.js"), "console.log('app');\n");
  await writeFile(path.join(webRoot, "agents.js"), "export const agents = [];\n");
  await writeFile(path.join(webRoot, "boot.js"), "");
  await writeFile(path.join(webRoot, "markdown.js"), "");
  await writeFile(path.join(webRoot, "viewer.js"), 'import "./markdown.js";\n');
  await writeFile(path.join(webRoot, "viewer.css"), ".file-viewer {}\n");
  await writeFile(path.join(webRoot, "styles.css"), "");
  await writeFile(path.join(webRoot, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(path.join(webRoot, "manifest.webmanifest"), "{}");
  await writeFile(path.join(webRoot, "sw.js"), "// sw\n");
  await writeFile(path.join(webRoot, "icon-192.png"), "png");
  await writeFile(path.join(webRoot, "icon-512.png"), "png");
  await writeFile(path.join(webRoot, "icon-512-maskable.png"), "png");
  const projectRoot = path.join(webRoot, "projects");
  await mkdir(path.join(projectRoot, "demo"), { recursive: true });
  const store = await GroupStore.open(path.join(webRoot, "data"));
  const claude = new FakeAdapter("claude");
  const agents = new AgentRegistry([claude]);
  const runtime = new GroupRuntime({ store, agents });
  const settings = await SettingsStore.open(path.join(webRoot, "data"), ["claude"]);
  const groups = new GroupService({ projectRoot, store, runtime, agents, settings });
  const hub = new ConnectionHub();
  groups.onEvent((event) => {
    hub.handle(event.scope === "global"
      ? { target: "global", payload: event.payload }
      : { target: "group", groupId: event.groupId, payload: event.payload });
  });
  const uploaded: { ticket: string; body: string }[] = [];
  const uploads = {
    async upload(ticket: string, _length: number, source: AsyncIterable<Buffer>) {
      const chunks: Buffer[] = [];
      for await (const chunk of source) chunks.push(Buffer.from(chunk));
      uploaded.push({ ticket, body: Buffer.concat(chunks).toString("utf8") });
      return { id: "attachment-1", originalName: "a.txt" } as never;
    },
  };
  const server = new WebServer({
    token: TOKEN,
    services: { hub, groups },
    fileRoots: [await realpath(projectRoot)],
    webRoot,
    uploads,
  });
  const { port } = await server.listen(0);
  t.after(async () => {
    await server.close();
    await runtime.shutdown();
    await rm(webRoot, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${port}`, port, hub, claude, uploaded, projectRoot, webRoot };
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
  assert.match(html, /<meta name="lanting-assets"/u);

  const asset = await fetch(`${base}${match[1]}`);
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), "console.log('app');\n");
  assert.match(asset.headers.get("cache-control") ?? "", /immutable/u);

  const icon = await fetch(`${base}/icon.svg`);
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get("content-type"), "image/svg+xml");

  assert.equal((await fetch(`${base}/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/`, { method: "POST" })).status, 405);
});

test("serves the PWA shell assets with their own content types", async (t) => {
  const { base } = await startServer(t);

  const manifest = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get("content-type") ?? "", /application\/manifest\+json/u);

  const worker = await fetch(`${base}/sw.js`);
  assert.equal(worker.status, 200);
  assert.match(worker.headers.get("content-type") ?? "", /text\/javascript/u);
  assert.match(worker.headers.get("cache-control") ?? "", /no-cache/u);

  for (const name of ["icon-192.png", "icon-512.png", "icon-512-maskable.png"]) {
    const icon = await fetch(`${base}/${name}`);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get("content-type"), "image/png");
  }
});

test("raw serves only caged Markdown and images with authentication and sandbox headers", async (t) => {
  const { base, projectRoot, webRoot } = await startServer(t);
  const project = path.join(projectRoot, "demo");
  const note = path.join(project, "note.md");
  const image = path.join(project, "image.svg");
  const source = path.join(project, "source.ts");
  const secret = path.join(webRoot, "secret.md");
  await Promise.all([
    writeFile(note, "# hello"),
    writeFile(image, '<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    writeFile(source, "code"),
    writeFile(secret, "outside"),
  ]);
  await symlink(secret, path.join(project, "escape.md"));
  const cookie = cookieFrom(await login(base));

  const markdown = await fetch(`${base}/raw?${new URLSearchParams({ path: note })}`, {
    headers: { cookie },
  });
  assert.equal(markdown.status, 200);
  assert.equal(markdown.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(await markdown.text(), "# hello");
  assert.equal(markdown.headers.get("cache-control"), "no-store");
  assert.equal(markdown.headers.get("x-content-type-options"), "nosniff");
  assert.match(markdown.headers.get("content-security-policy") ?? "", /sandbox/u);

  const svg = await fetch(`${base}/raw?${new URLSearchParams({ path: image })}`, {
    method: "HEAD",
    headers: { cookie },
  });
  assert.equal(svg.status, 200);
  assert.equal(svg.headers.get("content-type"), "image/svg+xml");
  assert.match(svg.headers.get("content-security-policy") ?? "", /default-src 'none'/u);

  for (const denied of ["note.md", secret, path.join(project, "escape.md"), source]) {
    const response = await fetch(`${base}/raw?${new URLSearchParams({ path: denied })}`, {
      headers: { cookie },
    });
    assert.equal(response.status, 404, denied);
  }
  assert.equal((await fetch(`${base}/raw?${new URLSearchParams({ path: note })}`)).status, 401);
  assert.equal((await fetch(`${base}/raw?${new URLSearchParams({ path: note })}`, {
    headers: { cookie, origin: "https://attacker.example" },
  })).status, 403);
  assert.equal((await fetch(`${base}/raw?${new URLSearchParams({ path: note })}`, {
    method: "POST",
    headers: { cookie },
  })).status, 405);

  const view = await (await fetch(`${base}/view?path=anything`)).text();
  assert.match(view, /\/assets\/[a-f0-9]{64}\/viewer\.js/u);
  assert.match(view, /\/assets\/[a-f0-9]{64}\/viewer\.css/u);
  for (const asset of ["/viewer.js", "/viewer.css", "/agents.js"]) {
    assert.equal((await fetch(`${base}${asset}`)).status, 200, asset);
  }
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
  const callError = async (type: string, fields: Record<string, unknown> = {}) => {
    const requestId = `r${++nextId}`;
    socket.send(JSON.stringify({ ...fields, type, requestId }));
    const response = await waitFor(() => inbox.find((message) => message.requestId === requestId));
    assert.equal(response.ok, false, JSON.stringify(response));
    return response.error as { code: string; message: string; details?: Record<string, string> };
  };
  const event = (type: string) => waitFor(() => inbox.find((message) => message.event?.type === type)?.event);

  await call("connection.ready");
  const state = await call("app.state") as {
    directories: string[];
    settings: {
      username: string;
      agents: {
        id: string;
        name: string;
        kind: string | null;
        color: string | null;
        defaults: { model: string | null; effort: string | null; permission: string | null };
        complete: boolean;
      }[];
      initialized: boolean;
      createMembers: string[] | null;
    };
    agentKinds: { kind: string; displayName: string; configured: boolean }[];
    palette: unknown;
  };
  assert.deepEqual(state.directories, ["demo"]);
  assert.deepEqual(state.agentKinds, [
    { kind: "claude", displayName: "Claude Code", configured: true },
    { kind: "codex", displayName: "Codex CLI", configured: false },
    { kind: "grok", displayName: "Grok Build", configured: false },
  ]);
  assert.deepEqual(state.palette, PALETTE);
  assert.equal(state.settings.agents.length, 1);
  assert.deepEqual(
    { ...state.settings.agents[0], id: "<uuid>" },
    {
      id: "<uuid>",
      name: "claude",
      kind: "claude",
      color: "orange",
      defaults: { model: null, effort: null, permission: null },
      complete: true,
    },
  );
  const claudeId = state.settings.agents[0]!.id;

  const added = await call("settings.agent.add", {
    name: "claude",
    kind: "claude",
    color: "mint",
  }) as {
    agentId: string;
    settings: { agents: {
      id: string;
      name: string;
      kind: string | null;
      color: string | null;
      defaults: { model: string | null; effort: string | null; permission: string | null };
      complete: boolean;
    }[] };
  };
  assert.deepEqual(
    added.settings.agents.find((agent) => agent.id === added.agentId),
    { id: added.agentId, name: "", kind: null, color: null, defaults: { model: null, effort: null, permission: null }, complete: false },
  );
  const updateConflict = await callError("settings.agent.update", {
    agentId: added.agentId,
    name: "claude",
  });
  assert.deepEqual(updateConflict.details, { field: "name", agentId: added.agentId });

  const { group } = await call("group.create", { directory: "demo", members: [claudeId], title: "" }) as {
    group: { id: string; title: string; directory: string };
  };
  assert.equal(group.title, "新群");
  assert.equal(group.directory, "demo");
  await event("group.created");

  const pinned = await call("group.pin", { groupId: group.id, pinned: true }) as {
    group: { pinned: boolean };
  };
  assert.equal(pinned.group.pinned, true);
  assert.equal((await event("group.updated") as unknown as { group: { pinned: boolean } }).group.pinned, true);

  const snapshot = await call("group.subscribe", { groupId: group.id });
  assert.deepEqual(snapshot.transcript, []);
  assert.deepEqual((snapshot.group as { callOrder: string[] }).callOrder, ["claude"]);
  const cleared = await call("group.callOrder", { groupId: group.id, order: [] }) as { group: { callOrder: string[] } };
  assert.deepEqual(cleared.group.callOrder, []);
  await event("group.updated");
  socket.send(JSON.stringify({ type: "group.callOrder", requestId: "bad", groupId: group.id, order: ["grok"] }));
  const rejected = await waitFor(() => inbox.find((message) => message.requestId === "bad"));
  assert.equal(rejected.ok, false);
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

test("uploads require login and are streamed to the upload service with their ticket", async (t) => {
  const { base, uploaded } = await startServer(t);
  const post = (headers: Record<string, string>) =>
    fetch(`${base}/attachments/upload`, { method: "POST", headers, body: "hello" });
  assert.equal((await post({ "x-upload-ticket": "t1" })).status, 401);

  const cookie = cookieFrom(await login(base));
  assert.equal((await post({ cookie })).status, 401);
  assert.equal((await fetch(`${base}/attachments/upload`, { headers: { cookie } })).status, 405);
  assert.equal((await post({ cookie, "x-upload-ticket": "t1", origin: "https://elsewhere.example" })).status, 403);

  const response = await post({ cookie, "x-upload-ticket": "t1" });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { attachment: { id: "attachment-1", originalName: "a.txt" } });
  assert.deepEqual(uploaded, [{ ticket: "t1", body: "hello" }]);
});
