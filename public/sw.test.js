import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./sw.js", import.meta.url), "utf8");
const origin = "https://example.test";
const version = "a".repeat(64);
const asset = `/assets/${version}/app.js`;
const fontAsset = `/assets/${version}/marck-script.ttf`;

function harness(network) {
  const handlers = {};
  const stores = new Map();
  const key = (request) => new URL(typeof request === "string" ? request : request.url, origin).href;
  const caches = {
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async match(request) { return entries.get(key(request))?.clone(); },
        async put(request, response) { entries.set(key(request), response.clone()); },
      };
    },
  };
  vm.runInNewContext(source, {
    self: { location: { origin }, addEventListener(name, handler) { handlers[name] = handler; } },
    caches, fetch: network, URL, Request, Response, console: { warn() {} },
  });
  return {
    caches,
    async dispatch(request) {
      const pending = [];
      let response;
      handlers.fetch({ request, respondWith(value) { response = value; }, waitUntil(value) { pending.push(value); } });
      const result = await response;
      await Promise.all(pending);
      return result;
    },
    async activate() {
      let pending;
      handlers.activate({ waitUntil(value) { pending = value; } });
      await pending;
    },
    async install() {
      let pending;
      handlers.install({ waitUntil(value) { pending = value; } });
      await pending;
    },
  };
}

const navigation = (pathname = "/") => ({ url: `${origin}${pathname}`, method: "GET", mode: "navigate" });

test("first installation saves a complete offline page without an extra reload", async () => {
  let offline = false;
  const worker = harness(async (request) => {
    if (offline) throw new TypeError("offline");
    return new Response(request instanceof URL
      ? `<head><meta name="lanting-assets" content="${asset}"></head>installed`
      : "script");
  });
  await worker.install();
  offline = true;
  assert.match(await (await worker.dispatch(navigation())).text(), /installed$/u);
});

test("versioned font files use the same offline cache as scripts and styles", async () => {
  const worker = harness(async () => new Response("font"));
  assert.equal(await (await worker.dispatch(new Request(`${origin}${fontAsset}`))).text(), "font");
});

test("reload returns current HTML; an incomplete download preserves the complete offline page", async () => {
  let html = `<head><meta name="lanting-assets" content="${asset}"></head>first`;
  let offline = false;
  let failAsset = false;
  const worker = harness(async (request, options) => {
    if (offline) throw new TypeError("offline");
    if (request.mode === "navigate") {
      assert.equal(options.cache, "no-cache");
      return new Response(html);
    }
    return new Response("script", { status: failAsset ? 404 : 200 });
  });
  assert.match(await (await worker.dispatch(navigation())).text(), /first$/u);
  const nextAsset = asset.replace(version, "b".repeat(64));
  html = `<head><meta name="lanting-assets" content="${nextAsset}"></head>second`;
  failAsset = true;
  assert.match(await (await worker.dispatch(navigation())).text(), /second$/u);
  offline = true;
  assert.match(await (await worker.dispatch(navigation())).text(), /first$/u);
  assert.equal((await worker.dispatch(navigation("/icon.svg"))).type, "error");
  assert.equal(await (await worker.dispatch(new Request(`${origin}${asset}`))).text(), "script");
});

test("activation cleans only lanting shell caches and private requests are never intercepted", async () => {
  const worker = harness(() => { throw new Error("must not fetch"); });
  await worker.caches.open("lanting-shell-v0");
  await worker.caches.open("another-app");
  await worker.activate();
  assert.deepEqual(await worker.caches.keys(), ["another-app"]);
  for (const pathname of ["/auth/session", "/raw?path=example", "/attachments/upload", "/app.js"]) {
    assert.equal(await worker.dispatch(new Request(`${origin}${pathname}`)), undefined);
  }
});
