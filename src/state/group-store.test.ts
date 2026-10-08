import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentKind } from "../agents/kinds.ts";
import type { PaletteId } from "../agents/palette.ts";
import type { AgentSettings } from "../agents/types.ts";
import { GroupStore, type NewGroup } from "./group-store.ts";

const DEFAULTS: AgentSettings = { model: null, effort: null, permission: null };
const NEW_GROUP: NewGroup = {
  title: "demo",
  cwd: "/work/demo",
  username: "host",
  members: [
    { tag: "claude", kind: "claude", color: "orange", settings: { ...DEFAULTS } },
    { tag: "codex", kind: "codex", color: "mint", settings: { ...DEFAULTS } },
  ],
};

async function scratch(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("groups and transcripts preserve frozen member identity after reopening", async (t) => {
  const directory = await scratch(t);
  const store = await GroupStore.open(directory);
  const group = await store.create(NEW_GROUP);
  assert.equal(group.updatedAt, Date.parse(group.createdAt));
  assert.equal(group.pinned, false);
  assert.deepEqual(group.members, ["claude", "codex"]);
  assert.deepEqual(group.agents, {
    claude: {
      kind: "claude",
      color: "orange",
      nativeSessionId: null,
      cursor: 0,
      settings: DEFAULTS,
    },
    codex: {
      kind: "codex",
      color: "mint",
      nativeSessionId: null,
      cursor: 0,
      settings: DEFAULTS,
    },
  });
  await store.append(group.id, { from: { role: "host" }, text: "hello" });
  const reply = await store.append(
    group.id,
    { from: { role: "agent", agent: "claude" }, text: "hi", status: "completed" },
  );
  assert.equal(store.get(group.id)?.updatedAt, Date.parse(reply.at));
  await store.update(group.id, (next) => {
    next.callOrder = ["claude"];
    next.agents.claude!.nativeSessionId = "native-1";
    next.agents.claude!.cursor = 2;
    next.agents.codex!.settings = { model: "gpt", effort: "high", permission: ":workspace" };
  });

  const reopened = await GroupStore.open(directory);
  assert.deepEqual(reopened.get(group.id), store.get(group.id));
  assert.deepEqual(reopened.transcript(group.id).map((entry) => [entry.seq, entry.text]), [
    [1, "hello"],
    [2, "hi"],
  ]);
  assert.equal(reopened.get(group.id)?.agents.claude?.nativeSessionId, "native-1");
  assert.equal(reopened.get(group.id)?.agents.claude?.kind, "claude");
  assert.equal(reopened.get(group.id)?.agents.claude?.color, "orange");
  assert.deepEqual(reopened.get(group.id)?.agents.codex?.settings, {
    model: "gpt",
    effort: "high",
    permission: ":workspace",
  });
});

test("create rejects invalid member identity and call order before writing", async (t) => {
  const directory = await scratch(t);
  const store = await GroupStore.open(directory);
  const first = NEW_GROUP.members[0]!;

  await assert.rejects(store.create({ ...NEW_GROUP, members: [{ ...first, tag: "Bad" }] }), /标签不合法/u);
  await assert.rejects(store.create({ ...NEW_GROUP, members: [first, { ...first }] }), /标签不能重复/u);
  await assert.rejects(store.create({ ...NEW_GROUP, callOrder: ["missing"] }), /不是成员/u);
  await assert.rejects(store.create({
    ...NEW_GROUP,
    members: [{ ...first, kind: "unknown" as AgentKind }],
  }), /CLI 种类不合法/u);
  await assert.rejects(store.create({
    ...NEW_GROUP,
    members: [{ ...first, color: "unknown" as PaletteId }],
  }), /主色不合法/u);
  assert.deepEqual(await readdir(path.join(directory, "groups")), []);
});

test("missing required version 2 group fields are rejected", async (t) => {
  const directory = await scratch(t);
  const store = await GroupStore.open(directory);
  const group = await store.create(NEW_GROUP);
  const groupFile = path.join(directory, "groups", group.id, "group.json");
  const saved = JSON.parse(await readFile(groupFile, "utf8"));
  const cases: { label: string; remove: (value: typeof saved) => void }[] = [
    { label: "settings", remove: (value) => { delete value.group.agents.claude.settings; } },
    { label: "updatedAt", remove: (value) => { delete value.group.updatedAt; } },
    { label: "trashedAt", remove: (value) => { delete value.group.trashedAt; } },
    { label: "deletingAt", remove: (value) => { delete value.group.deletingAt; } },
  ];

  for (const item of cases) {
    const broken = structuredClone(saved);
    item.remove(broken);
    await writeFile(groupFile, JSON.stringify(broken));
    await assert.rejects(GroupStore.open(directory), new RegExp(item.label, "u"));
  }
});

test("version 2 groups written before pinning default to unpinned", async (t) => {
  const directory = await scratch(t);
  const store = await GroupStore.open(directory);
  const group = await store.create(NEW_GROUP);
  const groupFile = path.join(directory, "groups", group.id, "group.json");
  const saved = JSON.parse(await readFile(groupFile, "utf8"));
  delete saved.group.pinned;
  await writeFile(groupFile, JSON.stringify(saved));

  assert.equal((await GroupStore.open(directory)).get(group.id)?.pinned, false);

  saved.group.pinned = "yes";
  await writeFile(groupFile, JSON.stringify(saved));
  await assert.rejects(GroupStore.open(directory), /pinned 不对/u);
});

test("invalid frozen member tags, kinds, and colors are rejected", async (t) => {
  const directory = await scratch(t);
  const store = await GroupStore.open(directory);
  const group = await store.create(NEW_GROUP);
  const groupFile = path.join(directory, "groups", group.id, "group.json");
  const saved = JSON.parse(await readFile(groupFile, "utf8"));
  const cases: { pattern: RegExp; change: (value: typeof saved) => void }[] = [
    {
      pattern: /非法标签/u,
      change: (value) => {
        value.group.members[0] = "Bad";
      },
    },
    {
      pattern: /agents\.claude 不对/u,
      change: (value) => {
        value.group.agents.claude.kind = "unknown";
      },
    },
    {
      pattern: /agents\.claude 不对/u,
      change: (value) => {
        value.group.agents.claude.color = "unknown";
      },
    },
  ];

  for (const item of cases) {
    const broken = structuredClone(saved);
    item.change(broken);
    await writeFile(groupFile, JSON.stringify(broken));
    await assert.rejects(GroupStore.open(directory), item.pattern);
  }
});

test("version 1 group data is rejected without changing its bytes", async (t) => {
  const directory = await scratch(t);
  const store = await GroupStore.open(directory);
  const group = await store.create(NEW_GROUP);
  const groupFile = path.join(directory, "groups", group.id, "group.json");
  const old = JSON.parse(await readFile(groupFile, "utf8"));
  old.version = 1;
  const source = `${JSON.stringify(old)}\n`;
  await writeFile(groupFile, source);

  await assert.rejects(GroupStore.open(directory), /群数据是旧版本（1）.*清理/u);
  assert.equal(await readFile(groupFile, "utf8"), source);
});

test("version 1 transcript data is rejected", async (t) => {
  const directory = await scratch(t);
  const store = await GroupStore.open(directory);
  const group = await store.create(NEW_GROUP);
  const transcriptFile = path.join(directory, "groups", group.id, "transcript.json");
  const old = JSON.parse(await readFile(transcriptFile, "utf8"));
  old.version = 1;
  await writeFile(transcriptFile, JSON.stringify(old));

  await assert.rejects(GroupStore.open(directory), /群聊记录是旧版本（1）.*清理/u);
});

test("notice entries survive reopening", async (t) => {
  const directory = await scratch(t);
  const store = await GroupStore.open(directory);
  const group = await store.create(NEW_GROUP);
  await store.append(group.id, { from: { role: "notice", agent: "codex" }, text: "compacted" });
  const reopened = await GroupStore.open(directory);
  assert.deepEqual(reopened.transcript(group.id)[0]?.from, { role: "notice", agent: "codex" });
});

test("returned groups are copies; changes only land through update", async (t) => {
  const store = await GroupStore.open(await scratch(t));
  const group = await store.create(NEW_GROUP);
  group.title = "changed";
  assert.equal(store.get(group.id)?.title, "demo");
  await assert.rejects(store.update(group.id, (next) => {
    next.id = "other";
  }), /不能修改群 id/u);
  assert.equal(store.get(group.id)?.id, group.id);
});

test("concurrent appends get consecutive sequence numbers", async (t) => {
  const store = await GroupStore.open(await scratch(t));
  const group = await store.create(NEW_GROUP);
  const entries = await Promise.all(
    ["a", "b", "c", "d"].map((text) => store.append(group.id, { from: { role: "host" }, text })),
  );
  assert.deepEqual(entries.map((entry) => entry.seq), [1, 2, 3, 4]);
  assert.deepEqual(store.transcript(group.id).map((entry) => entry.text), ["a", "b", "c", "d"]);
});

test("a corrupt group file stops the store from opening instead of being overwritten", async (t) => {
  const directory = await scratch(t);
  const store = await GroupStore.open(directory);
  const group = await store.create(NEW_GROUP);
  const groupFile = path.join(directory, "groups", group.id, "group.json");
  await writeFile(groupFile, "{");
  await assert.rejects(GroupStore.open(directory), /不是有效 JSON/u);

  await writeFile(groupFile, JSON.stringify({ version: 2, group: { id: group.id } }));
  await assert.rejects(GroupStore.open(directory), /群数据损坏/u);
  assert.deepEqual(await readdir(path.join(directory, "groups", group.id)), ["group.json", "transcript.json"]);
});

test("removing a group deletes its directory and it stays gone after reopening", async (t) => {
  const directory = await scratch(t);
  const store = await GroupStore.open(directory);
  const group = await store.create(NEW_GROUP);
  const kept = await store.create(NEW_GROUP);
  await store.remove(group.id);
  assert.equal(store.get(group.id), null);
  assert.deepEqual(await readdir(path.join(directory, "groups")), [kept.id]);
  const reopened = await GroupStore.open(directory);
  assert.deepEqual(reopened.list().map((item) => item.id), [kept.id]);
});
