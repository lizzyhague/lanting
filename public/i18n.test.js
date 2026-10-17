import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const SCRIPTS = ["app.js", "boot.js", "agents.js", "markdown.js", "viewer.js", "selection-bar.js", "confirm-dialog.js"];
const scripts = await Promise.all(SCRIPTS.map((file) => readFile(new URL(`./${file}`, import.meta.url), "utf8")));
const [stringsSource, source, html, viewHtml, app, boot] = await Promise.all([
  readFile(new URL("./strings.js", import.meta.url), "utf8"),
  readFile(new URL("./i18n.js", import.meta.url), "utf8"),
  readFile(new URL("./index.html", import.meta.url), "utf8"),
  readFile(new URL("./view.html", import.meta.url), "utf8"),
  readFile(new URL("./app.js", import.meta.url), "utf8"),
  readFile(new URL("./boot.js", import.meta.url), "utf8"),
]);

function loadStrings() {
  const window = {};
  vm.runInNewContext(stringsSource, { window });
  return window.lantingStrings;
}

class FakeNode {
  constructor(attributes, textContent = "") {
    this.attributes = { ...attributes };
    this.textContent = textContent;
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }
}

function run({ stored = null, languages = ["zh-CN"], storage = true, nodes = [] } = {}) {
  const store = new Map(stored === null ? [] : [["lanting.language", stored]]);
  const rootAttributes = {};
  const listeners = {};
  const events = [];
  const localStorage = storage ? {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  } : {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
    removeItem: () => { throw new Error("blocked"); },
  };
  const navigator = { languages, language: languages[0] };
  const window = {
    lantingStrings: {
      "greeting": { zh: "你好，{name}", en: "Hello, {name}" },
      "only.zh": { zh: "只有中文" },
    },
    addEventListener: (type, listener) => { listeners[type] = listener; },
    dispatchEvent: (event) => events.push(event.type),
  };
  const document = {
    readyState: "complete",
    documentElement: { setAttribute: (name, value) => { rootAttributes[name] = value; } },
    querySelectorAll: () => nodes,
    addEventListener() {},
  };
  vm.runInNewContext(source, { window, document, navigator, localStorage, Event: class { constructor(type) { this.type = type; } } });
  return {
    api: window.lantingI18n,
    lang: () => rootAttributes.lang,
    store,
    events,
    setBrowser(next) {
      navigator.languages = next;
      listeners.languagechange();
    },
    storageEvent(value) {
      if (value === null) store.delete("lanting.language");
      else store.set("lanting.language", value);
      listeners.storage({ key: "lanting.language" });
    },
  };
}

test("without a saved choice the page follows the first supported browser language", () => {
  assert.equal(run({ languages: ["zh-TW", "en-US"] }).api.language(), "zh");
  assert.equal(run({ languages: ["fr-FR", "en-GB", "zh-CN"] }).api.language(), "en");
  assert.equal(run({ languages: ["ja-JP"] }).api.language(), "en");
  const page = run({ languages: ["en-US"] });
  assert.equal(page.api.get(), "system");
  assert.equal(page.lang(), "en");
  page.setBrowser(["zh-CN"]);
  assert.equal(page.api.language(), "zh");
  assert.equal(page.lang(), "zh-CN");
});

test("a saved choice overrides the browser and following the browser again stores nothing", () => {
  const page = run({ stored: "en", languages: ["zh-CN"] });
  assert.equal(page.api.get(), "en");
  assert.equal(page.api.language(), "en");
  page.setBrowser(["zh-HK"]);
  assert.equal(page.api.language(), "en");
  page.api.set("system");
  assert.equal(page.store.has("lanting.language"), false);
  assert.equal(page.api.language(), "zh");
  page.api.set("en");
  assert.equal(page.store.get("lanting.language"), "en");
});

test("unknown saved values and blocked storage fall back to following the browser", () => {
  assert.equal(run({ stored: "fr", languages: ["en"] }).api.get(), "system");
  const page = run({ storage: false, languages: ["en"] });
  page.api.set("zh");
  assert.equal(page.api.language(), "zh");
});

test("changes from other tabs apply, and every change is announced", () => {
  const page = run({ languages: ["zh-CN"] });
  page.storageEvent("en");
  assert.equal(page.api.language(), "en");
  page.api.set("zh");
  page.api.set("system");
  assert.deepEqual(page.events, ["lanting-languagechange", "lanting-languagechange", "lanting-languagechange"]);
});

test("t fills placeholders, falls back to Chinese, and shows unknown keys as is", () => {
  const page = run({ languages: ["en"] });
  assert.equal(page.api.t("greeting", { name: "lizzy" }), "Hello, lizzy");
  assert.equal(page.api.t("greeting"), "Hello, {name}");
  assert.equal(page.api.t("only.zh"), "只有中文");
  assert.equal(page.api.t("missing.key"), "missing.key");
});

test("marked text and attributes are filled in and refilled on switching", () => {
  const text = new FakeNode({ "data-i18n": "greeting" });
  const button = new FakeNode({ "data-i18n-aria-label": "greeting", "data-i18n-title": "greeting" });
  const page = run({ languages: ["zh-CN"], nodes: [text, button] });
  assert.equal(text.textContent, "你好，{name}");
  assert.equal(button.attributes["aria-label"], "你好，{name}");
  page.api.set("en");
  assert.equal(text.textContent, "Hello, {name}");
  assert.equal(button.attributes.title, "Hello, {name}");
});

test("every string has both languages and the same placeholders in each", () => {
  for (const [key, entry] of Object.entries(loadStrings())) {
    assert.deepEqual(Object.keys(entry).sort(), ["en", "zh"], key);
    const names = (text) => [...text.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]).sort();
    // A { one, other } translation is checked through its "other" form, which keeps every placeholder.
    const forms = (text) => typeof text === "string" ? { other: text } : text;
    assert.deepEqual(names(forms(entry.en).other), names(forms(entry.zh).other), key);
    for (const form of Object.values(forms(entry.en))) assert.equal(typeof form, "string", key);
  }
});

test("markup keeps the Chinese text as its default, and every key used exists", () => {
  const strings = loadStrings();
  const markup = `${html}\n${viewHtml}`;
  for (const match of markup.matchAll(/data-i18n="([^"]+)">([^<]*)</gu)) {
    assert.ok(strings[match[1]], match[1]);
    assert.equal(match[2], strings[match[1]].zh, match[1]);
  }
  // Attributes marked for translation keep the Chinese text as their default too.
  for (const tag of markup.matchAll(/<[a-z][^>]*data-i18n-[^>]*>/gu)) {
    for (const match of tag[0].matchAll(/data-i18n-(aria-label|title|placeholder)="([^"]+)"/gu)) {
      assert.ok(strings[match[2]], match[2]);
      const value = new RegExp(`\\s${match[1]}="([^"]*)"`, "u").exec(tag[0]);
      assert.equal(value?.[1], strings[match[2]].zh, `${match[1]} of ${match[2]}`);
    }
  }
});

/** Every quoted literal inside a t(...) call, including both branches of a conditional key. */
function keysInCalls(code) {
  const keys = [];
  for (const start of code.matchAll(/\bt\(/gu)) {
    let depth = 0;
    let end = start.index + 1;
    for (; end < code.length; end += 1) {
      if (code[end] === "(") depth += 1;
      else if (code[end] === ")" && --depth === 0) break;
    }
    const call = code.slice(start.index, end);
    for (const match of call.matchAll(/"([a-z]+(?:\.[A-Za-z]+)+)"/gu)) keys.push(match[1]);
  }
  return keys;
}

test("every key the scripts use exists, including keys built from a state name", () => {
  const strings = loadStrings();
  for (const key of scripts.flatMap(keysInCalls)) assert.ok(strings[key], key);
  for (const status of ["interrupted", "failed", "thinking", "tool", "replying", "approval", "stopping"]) {
    assert.ok(strings[`status.${status}`], status);
  }
  for (const action of ["compacting", "replying"]) {
    assert.ok(strings[`list.busy.${action}`], action);
    assert.ok(strings[`list.busyAgent.${action}`], action);
  }
  for (const match of app.matchAll(/(?:labelKey|doneKey): "([^"]+)"/gu)) assert.ok(strings[match[1]], match[1]);
  for (const match of app.matchAll(/setConnectionStatus\("\w+", "([^"]+)"\)/gu)) assert.ok(strings[match[1]], match[1]);
});

test("the page scripts no longer contain Chinese interface text", () => {
  for (const [index, code] of scripts.entries()) {
    const lines = code.split("\n").filter((line) => /[\u4e00-\u9fff]/u.test(line));
    assert.deepEqual(lines, [], SCRIPTS[index]);
  }
});

test("the language scripts load in <head> before the page scripts", () => {
  for (const page of [html, viewHtml]) {
    const head = page.slice(0, page.indexOf("</head>"));
    assert.ok(head.includes('<script src="/i18n.js"></script>'));
    assert.ok(head.indexOf('<script src="/strings.js"></script>') < head.indexOf('<script src="/i18n.js"></script>'));
  }
  assert.ok(viewHtml.indexOf('<script src="/i18n.js"></script>') < viewHtml.indexOf('src="/viewer.js"'));
});
