import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { FakeAdapter } from "../agents/fake-adapter.test-support.ts";
import { AgentRegistry } from "../agents/registry.ts";
import { GroupStore } from "../state/group-store.ts";
import { GroupRuntime } from "./runtime.ts";
import { GroupService, type ServiceEvent } from "./service.ts";

async function setup(t: test.TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-service-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const projectRoot = path.join(directory, "projects");
  await mkdir(path.join(projectRoot, "demo"), { recursive: true });
  const store = await GroupStore.open(path.join(directory, "data"));
  const agents = new AgentRegistry([new FakeAdapter("claude"), new FakeAdapter("codex")]);
  const runtime = new GroupRuntime({ store, agents });
  t.after(() => runtime.shutdown());
  const service = new GroupService({ projectRoot, store, runtime, agents });
  const events: ServiceEvent[] = [];
  service.onEvent((event) => events.push(event));
  const group = await service.create({ directory: "demo", members: ["claude"], title: "" });
  return { service, store, events, groupId: group.id };
}

test("agent settings are checked against the agent's catalog and stored per group", async (t) => {
  const { service, store, events, groupId } = await setup(t);
  assert.deepEqual((await service.catalog(groupId, "claude")).permissions.map((item) => item.id), ["ask", "yolo"]);

  const summary = await service.setAgentSettings(groupId, "claude", { model: "large", effort: "high", permission: "yolo" });
  assert.deepEqual(summary.settings.claude, { model: "large", effort: "high", permission: "yolo" });
  assert.deepEqual(store.get(groupId)?.agents.claude?.settings, { model: "large", effort: "high", permission: "yolo" });
  assert.ok(events.some((event) => event.scope === "global" && event.payload.type === "group.updated"));

  await service.setAgentSettings(groupId, "claude", { model: null, effort: null, permission: null });
  assert.deepEqual(store.get(groupId)?.agents.claude?.settings, { model: null, effort: null, permission: null });
});

test("invalid agent settings are rejected with a clear reason", async (t) => {
  const { service, groupId } = await setup(t);
  const reject = (settings: { model: string | null; effort: string | null; permission: string | null }, pattern: RegExp) =>
    assert.rejects(service.setAgentSettings(groupId, "claude", settings), pattern);
  await reject({ model: "huge", effort: null, permission: null }, /没有这个模型/u);
  await reject({ model: null, effort: "high", permission: null }, /要先选模型/u);
  await reject({ model: "small", effort: "high", permission: null }, /不支持思考强度/u);
  await reject({ model: null, effort: null, permission: "root" }, /没有这个权限/u);
  await assert.rejects(service.setAgentSettings(groupId, "codex", { model: null, effort: null, permission: null }), /不是这个群的成员/u);
  await assert.rejects(service.catalog(groupId, "codex"), /不是这个群的成员/u);
});
