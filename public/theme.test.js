import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./theme.js", import.meta.url), "utf8");

function run({ stored = null, systemLight = false, storage = true } = {}) {
  const attributes = {};
  const header = { content: "#161617", setAttribute(name, value) { if (name === "content") this.content = value; } };
  const store = new Map(stored === null ? [] : [["lanting.theme", stored]]);
  const mediaListeners = [];
  const windowListeners = {};
  const media = {
    matches: systemLight,
    addEventListener: (type, listener) => { if (type === "change") mediaListeners.push(listener); },
  };
  const localStorage = storage ? {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  } : {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
    removeItem: () => { throw new Error("blocked"); },
  };
  const window = {
    matchMedia: () => media,
    addEventListener: (type, listener) => { windowListeners[type] = listener; },
  };
  const context = {
    window,
    localStorage,
    document: {
      documentElement: { setAttribute: (name, value) => { attributes[name] = value; } },
      querySelector: (selector) => (selector === 'meta[name="theme-color"]' ? header : null),
    },
  };
  vm.runInNewContext(source, context);
  return {
    theme: () => attributes["data-theme"],
    header: () => header.content,
    api: window.lantingTheme,
    store,
    setSystem(light) {
      media.matches = light;
      for (const listener of mediaListeners) listener();
    },
    storageEvent(key, value) {
      if (value === null) store.delete(key);
      else store.set(key, value);
      windowListeners.storage({ key });
    },
  };
}

test("without a saved choice the page follows the system and its later changes", () => {
  const page = run({ systemLight: true });
  assert.equal(page.api.get(), "system");
  assert.equal(page.theme(), "light");
  page.setSystem(false);
  assert.equal(page.theme(), "dark");
});

test("a saved choice overrides the system", () => {
  const page = run({ stored: "dark", systemLight: true });
  assert.equal(page.api.get(), "dark");
  assert.equal(page.theme(), "dark");
  page.setSystem(false);
  page.setSystem(true);
  assert.equal(page.theme(), "dark");
});

test("unknown saved values fall back to following the system", () => {
  const page = run({ stored: "sepia", systemLight: false });
  assert.equal(page.api.get(), "system");
  assert.equal(page.theme(), "dark");
});

test("choosing stores the value; following the system clears it", () => {
  const page = run({ systemLight: false });
  page.api.set("light");
  assert.equal(page.theme(), "light");
  assert.equal(page.store.get("lanting.theme"), "light");
  page.api.set("system");
  assert.equal(page.theme(), "dark");
  assert.equal(page.store.has("lanting.theme"), false);
});

test("a choice still applies to the current page when storage is blocked", () => {
  const page = run({ storage: false, systemLight: false });
  assert.equal(page.theme(), "dark");
  page.api.set("light");
  assert.equal(page.api.get(), "light");
  assert.equal(page.theme(), "light");
});

test("another tab changing the choice updates this page", () => {
  const page = run({ systemLight: false });
  page.storageEvent("lanting.theme", "light");
  assert.equal(page.theme(), "light");
  page.storageEvent("lanting.theme", null);
  assert.equal(page.theme(), "dark");
});

test("the PWA header color follows the applied theme", () => {
  const page = run({ systemLight: true });
  assert.equal(page.header(), "#fbf9f4");
  page.setSystem(false);
  assert.equal(page.header(), "#161617");
  page.api.set("light");
  assert.equal(page.header(), "#fbf9f4");
});

test("pages load theme.js before the stylesheet", async () => {
  for (const name of ["index.html", "view.html"]) {
    const html = await readFile(new URL(`./${name}`, import.meta.url), "utf8");
    const script = html.indexOf('<script src="/theme.js"></script>');
    assert.notEqual(script, -1, name);
    assert.ok(script < html.indexOf('<link rel="stylesheet" href="/styles.css">'), name);
  }
});
