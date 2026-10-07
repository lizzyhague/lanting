import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { GroupStore } from "./group-store.ts";

async function scratch(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const NEW_GROUP = { title: "demo", cwd: "/work/demo", username: "host", members: ["claude", "codex"] };

test("groups and transcripts survive reopening the store", async (t) => {
  const directory = await scratch(t);
  const store = await GroupStore.open(directory);
  const group = await store.create(NEW_GROUP);
  assert.deepEqual(group.agents, {
    claude: { nativeSessionId: null, cursor: 0 },
    codex: { nativeSessionId: null, cursor: 0 },
  });
  await store.append(group.id, { from: { role: "host" }, text: "hello" });
  await store.append(group.id, { from: { role: "agent", agent: "claude" }, text: "hi", status: "completed" });
  await store.update(group.id, (next) => {
    next.callOrder = ["claude"];
    next.agents.claude!.nativeSessionId = "native-1";
    next.agents.claude!.cursor = 2;
  });

  const reopened = await GroupStore.open(directory);
  assert.deepEqual(reopened.get(group.id), store.get(group.id));
  assert.deepEqual(reopened.transcript(group.id).map((entry) => [entry.seq, entry.text]), [
    [1, "hello"],
    [2, "hi"],
  ]);
  assert.equal(reopened.get(group.id)?.agents.claude?.nativeSessionId, "native-1");
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

  await writeFile(groupFile, JSON.stringify({ version: 1, group: { id: group.id } }));
  await assert.rejects(GroupStore.open(directory), /群数据损坏/u);
  assert.deepEqual(await readdir(path.join(directory, "groups", group.id)), ["group.json", "transcript.json"]);
});
