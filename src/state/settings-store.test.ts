import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SettingsStore } from "./settings-store.ts";

test("settings survive reopening and callers only receive copies", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const store = await SettingsStore.open(directory);
  assert.deepEqual(store.get(), { username: "host", defaults: {}, createMembers: null });
  const saved = await store.update((settings) => {
    settings.username = "lizzy";
    settings.defaults.codex = { model: "gpt", effort: "high", permission: "ask" };
    settings.createMembers = ["codex", "claude"];
  });
  saved.username = "changed outside";
  saved.defaults.codex!.model = "changed outside";

  assert.equal(store.get().username, "lizzy");
  const reopened = await SettingsStore.open(directory);
  assert.deepEqual(reopened.get(), {
    username: "lizzy",
    defaults: { codex: { model: "gpt", effort: "high", permission: "ask" } },
    createMembers: ["codex", "claude"],
  });
});

test("a corrupt settings file stops the store from opening", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-settings-corrupt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "settings.json"), '{"version":1,"settings":{"username":7}}\n');
  await assert.rejects(SettingsStore.open(directory), /设置文件损坏/u);
});
