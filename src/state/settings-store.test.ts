import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentKind } from "../agents/kinds.ts";
import type { PaletteId } from "../agents/palette.ts";
import type { AgentSettings } from "../agents/types.ts";
import {
  isAgentComplete,
  SettingsError,
  SettingsStore,
  type AgentRecord,
  type Settings,
  type SettingsField,
} from "./settings-store.ts";

const DEFAULTS: AgentSettings = { model: null, effort: null, permission: null };

async function scratch(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "lanting-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function agent(
  id: string,
  name: string,
  kind: AgentKind | null,
  color: PaletteId | null,
  defaults: AgentSettings = DEFAULTS,
): AgentRecord {
  return { id, name, kind, color, defaults: { ...defaults } };
}

async function populatedStore(t: test.TestContext): Promise<{ directory: string; store: SettingsStore }> {
  const directory = await scratch(t);
  const store = await SettingsStore.open(directory, []);
  await store.update((settings) => {
    settings.agents = [
      agent("a", "alice", "claude", "orange"),
      agent("b", "bob", "codex", "mint"),
    ];
    settings.createMembers = ["a", "b"];
  });
  return { directory, store };
}

async function rejectsSettings(
  promise: Promise<Settings>,
  field: SettingsField | undefined,
  agentId: string | undefined,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof SettingsError);
    assert.equal(error.code, "invalid_settings");
    assert.equal(error.field, field);
    assert.equal(error.agentId, agentId);
    return true;
  });
}

test("first open prefills configured kinds in fixed order and writes version 2 immediately", async (t) => {
  const directory = await scratch(t);
  const store = await SettingsStore.open(directory, ["grok", "claude"]);
  const settings = store.get();

  assert.equal(settings.initialized, true);
  assert.equal(settings.username, "host");
  assert.equal(settings.createMembers, null);
  assert.deepEqual(settings.agents.map(({ name, kind, color, defaults }) => ({ name, kind, color, defaults })), [
    { name: "claude", kind: "claude", color: "orange", defaults: DEFAULTS },
    { name: "grok", kind: "grok", color: "mint", defaults: DEFAULTS },
  ]);
  for (const record of settings.agents) assert.match(record.id, /^[0-9a-f-]{36}$/u);

  const saved = JSON.parse(await readFile(path.join(directory, "settings.json"), "utf8")) as {
    version: number;
    settings: Settings;
  };
  assert.equal(saved.version, 2);
  assert.deepEqual(saved.settings, settings);
});

test("an uninitialized version 2 file is replaced with a fresh prefill", async (t) => {
  const directory = await scratch(t);
  const file = path.join(directory, "settings.json");
  await writeFile(file, JSON.stringify({
    version: 2,
    settings: { username: "lizzy", agents: [], initialized: false, createMembers: ["old"] },
  }));

  const settings = (await SettingsStore.open(directory, ["grok", "claude"])).get();
  assert.equal(settings.username, "lizzy");
  assert.equal(settings.initialized, true);
  assert.equal(settings.createMembers, null);
  assert.deepEqual(settings.agents.map((item) => [item.name, item.color]), [
    ["claude", "orange"],
    ["grok", "mint"],
  ]);
  assert.deepEqual((JSON.parse(await readFile(file, "utf8")) as { settings: Settings }).settings, settings);
});

test("a version 1 file is rejected without changing its bytes", async (t) => {
  const directory = await scratch(t);
  const file = path.join(directory, "settings.json");
  const source = '{"version":1,"settings":{"username":"host","defaults":{},"createMembers":null}}\n';
  await writeFile(file, source);

  await assert.rejects(SettingsStore.open(directory, ["claude"]), /旧版本（1）.*清理/u);
  assert.equal(await readFile(file, "utf8"), source);
});

test("a corrupt version 2 file stops the store from opening", async (t) => {
  const directory = await scratch(t);
  await writeFile(path.join(directory, "settings.json"), JSON.stringify({
    version: 2,
    settings: {
      username: "host",
      agents: [agent("a", "alice", "claude", "not-a-color" as PaletteId)],
      initialized: true,
      createMembers: null,
    },
  }));
  await assert.rejects(SettingsStore.open(directory, ["claude"]), /设置文件损坏：主色不在调色板里/u);
});

test("settings survive reopening and callers only receive copies", async (t) => {
  const { directory, store } = await populatedStore(t);
  const saved = await store.update((settings) => {
    settings.username = "lizzy";
    settings.agents[1]!.defaults = { model: "gpt", effort: "high", permission: "ask" };
  });
  saved.username = "changed outside";
  saved.agents[1]!.defaults.model = "changed outside";

  assert.equal(store.get().username, "lizzy");
  assert.deepEqual((await SettingsStore.open(directory, [])).get(), {
    username: "lizzy",
    agents: [
      agent("a", "alice", "claude", "orange"),
      agent("b", "bob", "codex", "mint", { model: "gpt", effort: "high", permission: "ask" }),
    ],
    initialized: true,
    createMembers: ["a", "b"],
  });
});

test("validation attributes errors to the changed field and existing agent", async (t) => {
  const { store } = await populatedStore(t);

  await rejectsSettings(store.update((settings) => {
    settings.agents[1]!.name = "alice";
  }), "name", "b");
  await rejectsSettings(store.update((settings) => {
    settings.agents[1]!.color = "orange";
  }), "color", "b");
  await rejectsSettings(store.update((settings) => {
    settings.agents[0]!.kind = "unknown" as AgentKind;
  }), "kind", "a");
  await rejectsSettings(store.update((settings) => {
    settings.agents[0]!.defaults.model = 7 as unknown as string;
  }), "defaults", "a");
  await rejectsSettings(store.update((settings) => {
    settings.agents[0]!.name = "host";
  }), "name", "a");
  await rejectsSettings(store.update((settings) => {
    settings.username = "ALICE";
  }), "username", undefined);
});

test("an invalid new agent has no agentId in its error", async (t) => {
  const { store } = await populatedStore(t);
  await rejectsSettings(store.update((settings) => {
    settings.agents.push(agent("new", "Bad Name", null, null));
  }), "name", undefined);
  await rejectsSettings(store.update((settings) => {
    settings.agents.unshift(agent("new", "alice", null, null));
  }), "name", undefined);
  await rejectsSettings(store.update((settings) => {
    settings.agents.unshift(agent("new", "new", null, "orange"));
  }), "color", undefined);
});

test("empty names are valid, need not be unique, and make records incomplete", async (t) => {
  const { store } = await populatedStore(t);
  const updated = await store.update((settings) => {
    settings.agents[0]!.name = "";
    settings.agents[1]!.name = "";
    settings.agents.push(agent("c", "", "claude", "yellow"));
  });

  assert.deepEqual(updated.agents.map((record) => record.name), ["", "", ""]);
  for (const record of updated.agents) {
    assert.equal(isAgentComplete(record, ["claude", "codex"]), false);
  }
});

test("structural and list-wide invariants are enforced", async (t) => {
  const { store } = await populatedStore(t);

  await rejectsSettings(store.update((settings) => {
    settings.agents[1]!.id = "a";
  }), undefined, "a");
  await rejectsSettings(store.update((settings) => {
    for (let index = 0; index < 11; index += 1) {
      settings.agents.push(agent(`new-${index}`, `new_${index}`, null, null));
    }
  }), undefined, undefined);
  await rejectsSettings(store.update((settings) => {
    settings.createMembers = [7 as unknown as string];
  }), undefined, undefined);
});

test("a rejected update changes neither memory nor the file", async (t) => {
  const { directory, store } = await populatedStore(t);
  const before = store.get();
  const bytes = await readFile(path.join(directory, "settings.json"), "utf8");

  await rejectsSettings(store.update((settings) => {
    settings.agents[0]!.color = "mint";
  }), "color", "a");
  assert.deepEqual(store.get(), before);
  assert.equal(await readFile(path.join(directory, "settings.json"), "utf8"), bytes);
});

test("changing kind resets defaults in the same update", async (t) => {
  const { store } = await populatedStore(t);
  await store.update((settings) => {
    settings.agents[0]!.defaults = { model: "opus", effort: "high", permission: "ask" };
  });
  const updated = await store.update((settings) => {
    settings.agents[0]!.kind = "grok";
    settings.agents[0]!.defaults = { model: "should-reset", effort: "low", permission: "root" };
  });
  assert.deepEqual(updated.agents[0]!.defaults, DEFAULTS);
});

test("createMembers keeps incomplete agents but drops deleted agents", async (t) => {
  const { store } = await populatedStore(t);
  const incomplete = await store.update((settings) => {
    settings.agents[0]!.color = null;
  });
  assert.deepEqual(incomplete.createMembers, ["a", "b"]);

  const deleted = await store.update((settings) => {
    settings.agents = settings.agents.filter((item) => item.id !== "a");
  });
  assert.deepEqual(deleted.createMembers, ["b"]);
});

test("records remain readable when their kind is no longer configured", async (t) => {
  const directory = await scratch(t);
  const original = await SettingsStore.open(directory, ["grok"]);
  const reopened = await SettingsStore.open(directory, []);
  assert.deepEqual(reopened.get(), original.get());
  assert.equal(isAgentComplete(reopened.get().agents[0]!, []), false);
});

test("an initialized empty list stays empty after reopening", async (t) => {
  const directory = await scratch(t);
  const store = await SettingsStore.open(directory, ["claude"]);
  await store.update((settings) => {
    settings.agents = [];
  });

  const reopened = await SettingsStore.open(directory, ["claude"]);
  assert.equal(reopened.get().initialized, true);
  assert.deepEqual(reopened.get().agents, []);
});

test("isAgentComplete requires a name, configured kind and color", () => {
  assert.equal(isAgentComplete(agent("a", "alice", "claude", "orange"), ["claude"]), true);
  assert.equal(isAgentComplete(agent("a", "", "claude", "orange"), ["claude"]), false);
  assert.equal(isAgentComplete(agent("a", "alice", null, "orange"), ["claude"]), false);
  assert.equal(isAgentComplete(agent("a", "alice", "claude", null), ["claude"]), false);
  assert.equal(isAgentComplete(agent("a", "alice", "claude", "orange"), ["codex"]), false);
});
