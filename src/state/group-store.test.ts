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
  assert.equal(group.archived, false);
  assert.equal(group.usageAgent, null);
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

  await assert.rejects(store.create({ ...NEW_GROUP, members: [{ ...first, tag: "Bad" }] }), /Invalid member tag/u);
  await assert.rejects(store.create({ ...NEW_GROUP, members: [first, { ...first }] }), /tags must be unique/u);
  await assert.rejects(store.create({ ...NEW_GROUP, callOrder: ["missing"] }), /not a member/u);
  await assert.rejects(store.create({
    ...NEW_GROUP,
    members: [{ ...first, kind: "unknown" as AgentKind }],
  }), /Invalid CLI kind/u);
  await assert.rejects(store.create({
    ...NEW_GROUP,
    members: [{ ...first, color: "unknown" as PaletteId }],
  }), /Invalid color/u);
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
  await assert.rejects(GroupStore.open(directory), /invalid pinned/u);
});

test("version 2 groups written before archiving default to active", async (t) => {
  const directory = await scratch(t);
  const store = await GroupStore.open(directory);
  const group = await store.create(NEW_GROUP);
  const groupFile = path.join(directory, "groups", group.id, "group.json");
  const saved = JSON.parse(await readFile(groupFile, "utf8"));
  delete saved.group.archived;
  await writeFile(groupFile, JSON.stringify(saved));

  assert.equal((await GroupStore.open(directory)).get(group.id)?.archived, false);

  saved.group.archived = "yes";
  await writeFile(groupFile, JSON.stringify(saved));
  await assert.rejects(GroupStore.open(directory), /invalid archived/u);
});

test("usageAgent defaults to off, rejects bad types and drops non-members", async (t) => {
  const directory = await scratch(t);
  const store = await GroupStore.open(directory);
  const group = await store.create(NEW_GROUP);
  const groupFile = path.join(directory, "groups", group.id, "group.json");
  const saved = JSON.parse(await readFile(groupFile, "utf8"));
  delete saved.group.usageAgent;
  await writeFile(groupFile, JSON.stringify(saved));
  assert.equal((await GroupStore.open(directory)).get(group.id)?.usageAgent, null);

  saved.group.usageAgent = "codex";
  await writeFile(groupFile, JSON.stringify(saved));
  assert.equal((await GroupStore.open(directory)).get(group.id)?.usageAgent, "codex");

  saved.group.usageAgent = "nobody";
  await writeFile(groupFile, JSON.stringify(saved));
  assert.equal((await GroupStore.open(directory)).get(group.id)?.usageAgent, null);

  saved.group.usageAgent = 1;
  await writeFile(groupFile, JSON.stringify(saved));
  await assert.rejects(GroupStore.open(directory), /invalid usageAgent/u);
});

test("invalid frozen member tags, kinds, and colors are rejected", async (t) => {
  const directory = await scratch(t);
  const store = await GroupStore.open(directory);
  const group = await store.create(NEW_GROUP);
  const groupFile = path.join(directory, "groups", group.id, "group.json");
  const saved = JSON.parse(await readFile(groupFile, "utf8"));
  const cases: { pattern: RegExp; change: (value: typeof saved) => void }[] = [
    {
      pattern: /invalid tag/u,
      change: (value) => {
        value.group.members[0] = "Bad";
      },
    },
    {
      pattern: /invalid agents\.claude/u,
      change: (value) => {
        value.group.agents.claude.kind = "unknown";
      },
    },
    {
      pattern: /invalid agents\.claude/u,
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

  await assert.rejects(GroupStore.open(directory), /Group data is from an old version \(1\).*cleared/u);
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

  await assert.rejects(GroupStore.open(directory), /chat record is from an old version \(1\).*cleared/u);
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
  }), /group id cannot change/u);
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
  await assert.rejects(GroupStore.open(directory), /not valid JSON/u);

  await writeFile(groupFile, JSON.stringify({ version: 2, group: { id: group.id } }));
  await assert.rejects(GroupStore.open(directory), /Group data is corrupt/u);
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

test("delivery failures and successful bindings survive reopening", async (t) => {
  const directory = await scratch(t);
  const store = await GroupStore.open(directory);
  const group = await store.create(NEW_GROUP);
  const entry = await store.append(group.id, {
    from: { role: "agent", agent: "claude" }, text: "files", status: "completed",
    deliveries: [
      { path: "/work/demo/a", name: "a", status: "available", attachmentId: "11111111-1111-4111-8111-111111111111",
        size: 0, expiresAtMs: 1000, binding: { caller: "lanting", projectId: "demo", sessionId: group.id } },
      { path: "relative", name: "relative", status: "failed", reason: "invalid_path" },
    ],
  });
  const reopened = await GroupStore.open(directory);
  assert.deepEqual(reopened.transcript(group.id)[0], entry);
});

test("invalid persisted delivery data fails to open without overwriting the record", async (t) => {
  const invalid = [
    { status: "other" },
    { status: "failed", reason: "unknown" },
    { status: "available", attachmentId: "invalid", size: 0, expiresAtMs: 1000 },
    { status: "available", attachmentId: "11111111-1111-4111-8111-111111111111", size: -1, expiresAtMs: 1000 },
    { status: "available", attachmentId: "11111111-1111-4111-8111-111111111111", size: 0, expiresAtMs: 1000,
      binding: { caller: "codex", projectId: "demo", sessionId: "group" } },
  ];
  for (const delivery of invalid) {
    const directory = await scratch(t);
    const store = await GroupStore.open(directory);
    const group = await store.create(NEW_GROUP);
    await store.append(group.id, { from: { role: "agent", agent: "claude" }, text: "reply", status: "completed" });
    const file = path.join(directory, "groups", group.id, "transcript.json");
    const record = JSON.parse(await readFile(file, "utf8"));
    record.entries[0].deliveries = [{ path: "/work/demo/a", name: "a", ...delivery }];
    const bytes = JSON.stringify(record);
    await writeFile(file, bytes);
    await assert.rejects(GroupStore.open(directory), /invalid deliveries/);
    assert.equal(await readFile(file, "utf8"), bytes);
  }
});
