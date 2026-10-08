import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { FakeAdapter } from "../agents/fake-adapter.test-support.ts";
import { AgentRegistry } from "../agents/registry.ts";
import { DEFAULT_AGENT_SETTINGS, type AgentCatalog } from "../agents/types.ts";
import type { SharedUploadClient } from "../attachments/shared-upload-client.ts";
import type { AttachmentBinding, AttachmentLease } from "../attachments/types.ts";
import { GroupStore } from "../state/group-store.ts";
import { SettingsError, SettingsStore } from "../state/settings-store.ts";
import { GroupError, GroupRuntime } from "./runtime.ts";
import { GroupService, type ServiceEvent } from "./service.ts";

async function setup(t: test.TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-service-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const projectRoot = path.join(directory, "projects");
  await mkdir(path.join(projectRoot, "demo"), { recursive: true });
  const store = await GroupStore.open(path.join(directory, "data"));
  const adapter = new FakeAdapter("claude");
  const codexAdapter = new FakeAdapter("codex");
  const agents = new AgentRegistry([adapter, codexAdapter]);
  const runtime = new GroupRuntime({ store, agents });
  t.after(() => runtime.shutdown());
  const settings = await SettingsStore.open(path.join(directory, "data"), ["claude", "codex"]);
  const uploads = new FakeUploads(path.join(directory, "blobs"));
  const service = new GroupService({ projectRoot, store, runtime, agents, settings, uploads });
  const events: ServiceEvent[] = [];
  service.onEvent((event) => events.push(event));
  const records = settings.get().agents;
  const agentIds = {
    claude: records.find((record) => record.kind === "claude")!.id,
    codex: records.find((record) => record.kind === "codex")!.id,
  };
  const group = await service.create({ directory: "demo", members: [agentIds.claude], title: "" });
  return {
    service,
    store,
    settings,
    events,
    adapter,
    codexAdapter,
    uploads,
    directory,
    agentIds,
    groupId: group.id,
  };
}

/** 假的 ai-remote-upload：记录票据、租约的申请和释放。 */
class FakeUploads implements Pick<SharedUploadClient, "createTicket" | "createLease" | "renewLease" | "releaseLease"> {
  readonly blobs: string;
  readonly tickets: (AttachmentBinding & { originalName: string })[] = [];
  readonly leases: { binding: AttachmentBinding; ids: string[] }[] = [];
  readonly released: string[] = [];

  constructor(blobs: string) {
    this.blobs = blobs;
  }

  createTicket(input: AttachmentBinding & { originalName: string; declaredMime: string; expectedSize: number }) {
    this.tickets.push(input);
    return Promise.resolve({
      ticket: "ticket-1",
      expiresAtMs: 0,
      attachment: { ...input },
    });
  }

  createLease(binding: AttachmentBinding, ownerId: string, ids: string[]): Promise<AttachmentLease> {
    this.leases.push({ binding, ids });
    return Promise.resolve({
      leaseId: `lease-${this.leases.length}`,
      ownerId,
      expiresAtMs: 0,
      attachments: ids.map((id) => ({
        ...binding,
        id,
        originalName: `${id}.png`,
        declaredMime: "image/png",
        detectedMime: "image/png",
        kind: "image" as const,
        size: 10,
        sha256: "",
        createdAtMs: 0,
        expiresAtMs: 0,
        path: path.join(this.blobs, id),
      })),
    });
  }

  renewLease(leaseId: string) {
    return Promise.resolve({ leaseId, expiresAtMs: 0 });
  }

  releaseLease(leaseId: string): Promise<void> {
    this.released.push(leaseId);
    return Promise.resolve();
  }
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

test("the settings AI list keeps its order and incomplete records cannot join a group", async (t) => {
  const { service, settings, agentIds } = await setup(t);
  assert.deepEqual(service.settings().agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    kind: agent.kind,
    color: agent.color,
    complete: agent.complete,
  })), [
    { id: agentIds.claude, name: "claude", kind: "claude", color: "orange", complete: true },
    { id: agentIds.codex, name: "codex", kind: "codex", color: "mint", complete: true },
  ]);

  await assert.rejects(
    service.create({ directory: "demo", members: ["missing"], title: "" }),
    /没有这个 AI/u,
  );
  await settings.update((next) => {
    next.agents.find((agent) => agent.id === agentIds.codex)!.color = null;
  });
  assert.equal(service.settings().agents[1]?.complete, false);
  await assert.rejects(
    service.create({ directory: "demo", members: [agentIds.codex], title: "" }),
    /设置不完整/u,
  );
});

test("settings AI records can be added, updated, reordered and removed", async (t) => {
  const { service, settings, agentIds } = await setup(t);
  const added = await service.addAgent();
  assert.equal(added.settings.agents.at(-1)?.id, added.agentId);
  assert.deepEqual(added.settings.agents.at(-1), {
    id: added.agentId,
    name: "",
    kind: null,
    color: null,
    defaults: DEFAULT_AGENT_SETTINGS,
    complete: false,
  });
  await assert.rejects(
    service.create({ directory: "demo", members: [added.agentId], title: "" }),
    /未命名的 AI 的设置不完整/u,
  );

  const configured = await service.updateAgent(
    added.agentId,
    { name: "reviewer", kind: "codex", color: "yellow" },
  );
  assert.deepEqual(configured.agents.find((agent) => agent.id === added.agentId), {
    id: added.agentId,
    name: "reviewer",
    kind: "codex",
    color: "yellow",
    defaults: DEFAULT_AGENT_SETTINGS,
    complete: true,
  });

  await service.setDefaultSettings(added.agentId, { model: "large", effort: "high", permission: "yolo" });
  const changed = await service.updateAgent(added.agentId, {
    name: "critic",
    kind: "claude",
    color: "blue",
  });
  const critic = changed.agents.find((agent) => agent.id === added.agentId)!;
  assert.equal(critic.name, "critic");
  assert.equal(critic.kind, "claude");
  assert.equal(critic.color, "blue");
  assert.deepEqual(critic.defaults, DEFAULT_AGENT_SETTINGS);

  const order = [added.agentId, agentIds.codex, agentIds.claude];
  assert.deepEqual((await service.reorderAgents(order)).agents.map((agent) => agent.id), order);
  await assert.rejects(service.reorderAgents([agentIds.claude]), (error: unknown) => {
    assert.ok(error instanceof GroupError);
    assert.equal(error.code, "invalid_order");
    return true;
  });

  await settings.update((next) => {
    next.createMembers = [agentIds.claude, added.agentId];
  });
  const removed = await service.removeAgent(added.agentId);
  assert.ok(!removed.agents.some((agent) => agent.id === added.agentId));
  assert.deepEqual(removed.createMembers, [agentIds.claude]);
});

test("settings AI kind errors identify the field and existing record", async (t) => {
  const { service, settings, agentIds } = await setup(t);
  await assert.rejects(service.updateAgent(agentIds.claude, { kind: "grok" }), (error: unknown) => {
    assert.ok(error instanceof SettingsError);
    assert.equal(error.field, "kind");
    assert.equal(error.agentId, agentIds.claude);
    return true;
  });

  await settings.update((next) => {
    next.agents.find((agent) => agent.id === agentIds.claude)!.kind = "grok";
  });
  const renamed = await service.updateAgent(agentIds.claude, { name: "orphan" });
  assert.equal(renamed.agents.find((agent) => agent.id === agentIds.claude)?.name, "orphan");
  assert.equal((await service.updateAgent(agentIds.claude, { kind: "grok" }))
    .agents.find((agent) => agent.id === agentIds.claude)?.kind, "grok");
});

test("default settings errors identify the defaults field and AI record", async (t) => {
  const { service, agentIds } = await setup(t);
  await assert.rejects(
    service.setDefaultSettings(agentIds.codex, { model: null, effort: "high", permission: null }),
    (error: unknown) => {
      assert.ok(error instanceof GroupError);
      assert.deepEqual(error.details, { field: "defaults", agentId: agentIds.codex });
      return true;
    },
  );
});

test("default settings are not saved if the AI kind changes while its catalog is loading", async (t) => {
  const { service, settings, codexAdapter, agentIds } = await setup(t);
  let resolveCatalog!: (catalog: AgentCatalog) => void;
  codexAdapter.catalog = () => new Promise((resolve) => {
    resolveCatalog = resolve;
  });
  const saving = service.setDefaultSettings(
    agentIds.codex,
    { model: "large", effort: "high", permission: "yolo" },
  );
  await settings.update((next) => {
    next.agents.find((agent) => agent.id === agentIds.codex)!.kind = "claude";
  });
  resolveCatalog(structuredClone(codexAdapter.catalogValue));

  await assert.rejects(saving, /CLI 已经变化/u);
  assert.deepEqual(
    settings.get().agents.find((agent) => agent.id === agentIds.codex)?.defaults,
    DEFAULT_AGENT_SETTINGS,
  );
});

async function idle(service: GroupService, groupId: string) {
  while (service.groups().find((group) => group.id === groupId)?.busy) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 发一轮让 claude 开出原生会话，等这一轮结束。 */
async function withSession(service: GroupService, groupId: string) {
  await service.startRound(groupId, "hello", ["claude"]);
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

test("group summaries use Relayu recency ordering and visible changes refresh it", async (t) => {
  const { service, store, agentIds, groupId } = await setup(t);
  const other = await service.create({ directory: "demo", members: [agentIds.claude], title: "other" });
  await store.update(groupId, (group) => {
    group.updatedAt = 100;
  });
  await store.update(other.id, (group) => {
    group.updatedAt = 200;
  });
  assert.deepEqual(service.groups().map((group) => group.id), [other.id, groupId]);

  const renamed = await service.rename(groupId, "recent");
  assert.ok(renamed.updatedAt > 200);
  assert.equal(service.groups()[0]?.id, groupId);
});

test("trashed groups keep their data, can be restored, and refuse other operations", async (t) => {
  const { service, store, groupId } = await setup(t);
  const trashed = await service.trash([groupId]);
  assert.deepEqual(trashed, { done: [groupId], failed: [] });
  const summary = service.groups()[0]!;
  assert.ok(summary.trashedAt);
  assert.equal(Date.parse(summary.purgeAt!) - Date.parse(summary.trashedAt!), 30 * 24 * 60 * 60_000);

  assert.throws(() => service.snapshot(groupId), /回收站/u);
  await assert.rejects(service.startRound(groupId, "q", ["claude"]), /回收站/u);
  await assert.rejects(service.rename(groupId, "new"), /回收站/u);
  assert.equal((await service.trash([groupId])).failed[0]?.message, "已经在回收站里了。");

  assert.deepEqual(await service.restore([groupId]), { done: [groupId], failed: [] });
  assert.equal(store.get(groupId)?.trashedAt, null);
  assert.equal(service.snapshot(groupId).group.id, groupId);
});

test("a busy group cannot be moved to the trash", async (t) => {
  const { service, groupId, adapter } = await setup(t);
  adapter.script = () => "hang";
  await service.startRound(groupId, "q", ["claude"]);
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

test("purging abandons a native session whose frozen CLI is no longer configured", async (t) => {
  const { service, store, directory } = await setup(t);
  const group = await store.create({
    title: "orphan",
    cwd: path.join(directory, "projects", "demo"),
    username: "host",
    members: [{
      tag: "orphan",
      kind: "grok",
      color: "yellow",
      settings: { ...DEFAULT_AGENT_SETTINGS },
    }],
  });
  await store.update(group.id, (next) => {
    next.agents.orphan!.nativeSessionId = "grok-session-left-behind";
    next.trashedAt = new Date().toISOString();
  });

  assert.deepEqual(await service.purge([group.id]), { done: [group.id], failed: [] });
  assert.equal(store.get(group.id), null);
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
  const { service, store, agentIds, groupId } = await setup(t);
  const other = await service.create({ directory: "demo", members: [agentIds.claude], title: "keep" });
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

test("the username is validated, and a new group copies the username, default settings and member choice", async (t) => {
  const { service, store, settings, events, agentIds } = await setup(t);
  assert.deepEqual(service.settings().createMembers, [agentIds.claude]);
  await settings.update((next) => {
    next.createMembers = ["missing", agentIds.codex];
  });
  assert.deepEqual(service.settings().createMembers, [agentIds.codex]);
  assert.equal((await service.setUsername("MyClaude")).username, "MyClaude");
  await assert.rejects(service.setUsername("Claude"), (error: unknown) => {
    assert.ok(error instanceof GroupError);
    assert.match(error.message, /“claude”/u);
    assert.deepEqual(error.details, { field: "username" });
    return true;
  });
  await assert.rejects(service.setUsername(""), /不能为空/u);
  assert.equal((await service.setUsername("lizzy")).username, "lizzy");
  await assert.rejects(
    service.setDefaultSettings(agentIds.codex, { model: null, effort: "high", permission: null }),
    /要先选模型/u,
  );
  await service.setDefaultSettings(agentIds.codex, { model: "large", effort: "high", permission: "yolo" });
  assert.ok(events.some((event) => event.scope === "global" && event.payload.type === "settings.updated"));

  const group = await service.create({
    directory: "demo",
    members: [agentIds.codex, agentIds.claude],
    title: "",
  });
  const saved = store.get(group.id)!;
  assert.equal(saved.username, "lizzy");
  assert.deepEqual(saved.members, ["claude", "codex"]);
  assert.deepEqual(group.colors, { claude: "orange", codex: "mint" });
  assert.deepEqual(saved.agents.codex?.settings, { model: "large", effort: "high", permission: "yolo" });
  assert.deepEqual(saved.agents.claude?.settings, { model: null, effort: null, permission: null });
  assert.deepEqual(service.settings().createMembers, [agentIds.claude, agentIds.codex]);

  // 改名、换 CLI、改色、删除设置记录，都不影响已经开的群。
  await settings.update((next) => {
    const claude = next.agents.find((record) => record.id === agentIds.claude)!;
    claude.name = "renamed";
    claude.kind = "grok";
    claude.color = "yellow";
    next.agents = next.agents.filter((record) => record.id !== agentIds.codex);
  });
  await service.setUsername("other");
  const unchanged = store.get(group.id)!;
  assert.equal(unchanged.username, "lizzy");
  assert.deepEqual(unchanged.members, ["claude", "codex"]);
  assert.equal(unchanged.agents.claude?.kind, "claude");
  assert.equal(unchanged.agents.claude?.color, "orange");
  assert.equal(unchanged.agents.codex?.kind, "codex");
  assert.equal(unchanged.agents.codex?.color, "mint");
  assert.deepEqual(unchanged.agents.codex?.settings, { model: "large", effort: "high", permission: "yolo" });
});

test("attachments are leased for the round, reach only the called agents, and never carry paths to the browser", async (t) => {
  const { service, store, events, uploads, adapter, groupId } = await setup(t);
  const ticket = await service.createAttachmentTicket(groupId, { originalName: "a.png", declaredMime: "image/png", expectedSize: 10 });
  assert.equal(ticket.ticket, "ticket-1");
  assert.deepEqual(uploads.tickets[0], {
    caller: "lanting", projectId: "demo", sessionId: groupId, originalName: "a.png", declaredMime: "image/png", expectedSize: 10,
  });
  await assert.rejects(
    service.createAttachmentTicket(groupId, { originalName: "big", declaredMime: "", expectedSize: 26 * 1_048_576 }),
    /25 MiB/u,
  );

  const attachmentId = "11111111-1111-4111-8111-111111111111";
  const blobPath = path.join(uploads.blobs, attachmentId);
  adapter.script = () => [
    { type: "ask", toolName: "Bash", detail: `inspect ${blobPath}` },
    { type: "end", outcome: "completed", text: `I read ${blobPath}` },
  ];
  await service.startRound(groupId, "", ["claude"], [attachmentId]);
  let requested: Extract<ServiceEvent, { scope: "group" }> | undefined;
  while (!(requested = events.find((event): event is Extract<ServiceEvent, { scope: "group" }> =>
    event.scope === "group" && event.payload.type === "approval.requested"))) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(requested.payload.type, "approval.requested");
  assert.equal(requested.payload.approval.detail, `inspect ${attachmentId}.png`);
  assert.equal(service.snapshot(groupId).approvals[0]?.detail, `inspect ${attachmentId}.png`);
  assert.equal(service.respondApproval(requested.payload.approval.approvalId, "allow"), true);
  await idle(service, groupId);

  assert.deepEqual(uploads.leases[0]?.ids, [attachmentId]);
  assert.deepEqual(uploads.released, ["lease-1"]);
  assert.match(adapter.received[0]!, /LANTING_ATTACHMENTS_V1/u);
  assert.ok(adapter.received[0]!.includes(blobPath));
  const host = store.transcript(groupId)[0]!;
  assert.deepEqual(host.recipients, ["claude"]);
  assert.equal(host.attachments?.[0]?.path, blobPath);
  // AI 回复里的路径换成文件名；发给浏览器的记录里没有路径。
  assert.equal(store.transcript(groupId)[1]?.text, `I read ${attachmentId}.png`);
  const browserView = JSON.stringify([service.snapshot(groupId), events]);
  assert.ok(!browserView.includes(uploads.blobs), "a storage path reached the browser");
  assert.equal(service.snapshot(groupId).transcript[0]?.attachments?.[0]?.originalName, `${attachmentId}.png`);
});
