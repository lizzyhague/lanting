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
  const adapter = new FakeAdapter("claude");
  const agents = new AgentRegistry([adapter, new FakeAdapter("codex")]);
  const runtime = new GroupRuntime({ store, agents });
  t.after(() => runtime.shutdown());
  const service = new GroupService({ projectRoot, store, runtime, agents });
  const events: ServiceEvent[] = [];
  service.onEvent((event) => events.push(event));
  const group = await service.create({ directory: "demo", members: ["claude"], title: "" });
  return { service, store, events, adapter, groupId: group.id };
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

async function idle(service: GroupService, groupId: string) {
  while (service.groups().find((group) => group.id === groupId)?.busy) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 发一轮让 claude 开出原生会话，等这一轮结束。 */
async function withSession(service: GroupService, groupId: string) {
  service.startRound(groupId, "hello", ["claude"]);
  await idle(service, groupId);
}

test("renaming changes only the lanting title and rejects empty names", async (t) => {
  const { service, store, groupId } = await setup(t);
  const summary = await service.rename(groupId, "  design review  ");
  assert.equal(summary.title, "design review");
  assert.equal(store.get(groupId)?.title, "design review");
  await assert.rejects(service.rename(groupId, "   "), /不能为空/u);
  await assert.rejects(service.rename(groupId, "x".repeat(101)), /最多 100/u);
});

test("trashed groups keep their data, can be restored, and refuse other operations", async (t) => {
  const { service, store, groupId } = await setup(t);
  const trashed = await service.trash([groupId]);
  assert.deepEqual(trashed, { done: [groupId], failed: [] });
  const summary = service.groups()[0]!;
  assert.ok(summary.trashedAt);
  assert.equal(Date.parse(summary.purgeAt!) - Date.parse(summary.trashedAt!), 30 * 24 * 60 * 60_000);

  assert.throws(() => service.snapshot(groupId), /回收站/u);
  assert.throws(() => service.startRound(groupId, "q", ["claude"]), /回收站/u);
  await assert.rejects(service.rename(groupId, "new"), /回收站/u);
  assert.equal((await service.trash([groupId])).failed[0]?.message, "已经在回收站里了。");

  assert.deepEqual(await service.restore([groupId]), { done: [groupId], failed: [] });
  assert.equal(store.get(groupId)?.trashedAt, null);
  assert.equal(service.snapshot(groupId).group.id, groupId);
});

test("a busy group cannot be moved to the trash", async (t) => {
  const { service, groupId, adapter } = await setup(t);
  adapter.script = () => "hang";
  service.startRound(groupId, "q", ["claude"]);
  const result = await service.trash([groupId]);
  assert.match(result.failed[0]?.message ?? "", /正在发言或压缩/u);
  await service.interrupt(groupId);
  await idle(service, groupId);
});

test("purging deletes each agent's native session before the group's own data", async (t) => {
  const { service, store, events, groupId, adapter } = await setup(t);
  await withSession(service, groupId);
  const nativeId = store.get(groupId)!.agents.claude!.nativeSessionId!;

  assert.match((await service.purge([groupId])).failed[0]?.message ?? "", /只能永久删除回收站里的群/u);
  await service.trash([groupId]);
  assert.equal(adapter.sessions[0]!.closed, true);
  assert.deepEqual(await service.purge([groupId]), { done: [groupId], failed: [] });
  assert.deepEqual(adapter.deleted, [nativeId]);
  assert.equal(store.get(groupId), null);
  assert.deepEqual(service.groups(), []);
  assert.ok(events.some((event) => event.scope === "global" && event.payload.type === "group.removed"));
});

test("a failed purge stays in the trash as deleting and is finished by the next sweep", async (t) => {
  const { service, store, groupId, adapter } = await setup(t);
  await withSession(service, groupId);
  await service.trash([groupId]);
  adapter.deleteError = new Error("disk busy");
  assert.match((await service.purge([groupId])).failed[0]?.message ?? "", /disk busy/u);
  assert.ok(store.get(groupId)?.deletingAt);
  assert.equal(service.groups()[0]?.deleting, true);
  assert.match((await service.restore([groupId])).failed[0]?.message ?? "", /不能恢复/u);

  adapter.deleteError = null;
  await service.sweepTrash();
  assert.equal(store.get(groupId), null);
  assert.equal(adapter.deleted.length, 1);
});

test("the sweep permanently deletes groups whose 30 days in the trash are over", async (t) => {
  const { service, store, groupId } = await setup(t);
  const other = await service.create({ directory: "demo", members: ["claude"], title: "keep" });
  await service.trash([groupId, other.id]);
  const trashedAt = Date.parse(store.get(groupId)!.trashedAt!);

  await service.sweepTrash(trashedAt + 29 * 24 * 60 * 60_000);
  assert.ok(store.get(groupId));
  await store.update(other.id, (group) => {
    group.trashedAt = new Date(trashedAt + 24 * 60 * 60_000).toISOString();
  });
  await service.sweepTrash(trashedAt + 30 * 24 * 60 * 60_000);
  assert.equal(store.get(groupId), null);
  assert.ok(store.get(other.id));
});
