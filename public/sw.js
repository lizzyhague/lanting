/*
 * HTML 每次回源；带内容版本的脚本和样式可以长期缓存。
 * 前端改动不需要手工升级这个名字：只有 SW 缓存格式改变时才换名字。
 * 会话、鉴权和文件内容不进入缓存。没有 push 或后台提醒。
 */
const CACHE_NAME = "lanting-shell-v1";
const ASSET_PATH = /^\/assets\/[a-f0-9]{64}\/[a-zA-Z0-9_.-]+\.(?:js|css)$/;
const ICONS = [
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-512-maskable.png",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(fetch(new URL("/", self.location.origin), { cache: "no-cache" }).then((response) => {
    if (!response.ok) throw new Error("Offline page could not be installed");
    return saveOfflinePage(response);
  }));
});

// 不强制接管已打开的旧页面；它们也能通过普通导航加载新的版本地址。
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith("lanting-shell-") && key !== CACHE_NAME).map((key) => caches.delete(key)),
  )));
});

async function versionedAsset(request) {
  let cache;
  try {
    cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
  } catch (error) {
    console.warn("Offline cache is unavailable", error);
  }
  const response = await fetch(request);
  if (response.ok && cache) {
    try { await cache.put(request, response.clone()); }
    catch (error) { console.warn("Resource could not be saved offline", error); }
  }
  return response;
}

async function saveOfflinePage(response) {
  const html = await response.clone().text();
  const list = /<meta name="lanting-assets" content="([^"]*)">/.exec(html);
  if (!list || !list[1]) return;
  const assets = list[1].split(",");
  if (!assets.every((asset) => ASSET_PATH.test(asset))) return;
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(assets.map(async (asset) => {
    const resource = await versionedAsset(new Request(new URL(asset, self.location.origin)));
    if (!resource.ok || !await cache.match(asset)) throw new Error("Offline resources are incomplete");
  }));
  // 最后才切换离线 HTML：任何脚本下载失败都保留上一次完整页面。
  await cache.put("/", response);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  const isAppRoot = url.pathname === "/" || url.pathname === "/index.html";
  if (request.mode === "navigate") {
    const network = fetch(request, { cache: "no-cache" });
    if (isAppRoot) {
      event.waitUntil(network.then((response) => response.ok ? saveOfflinePage(response.clone()) : undefined)
        .catch((error) => console.warn("Offline page could not be updated", error)));
    }
    event.respondWith(network.catch(async () => {
      if (!isAppRoot) return Response.error();
      const cache = await caches.open(CACHE_NAME);
      return await cache.match("/") ?? Response.error();
    }));
    return;
  }

  if (ASSET_PATH.test(url.pathname)) {
    const response = versionedAsset(request);
    event.respondWith(response);
    event.waitUntil(response.then(() => {}, () => {}));
    return;
  }

  if (ICONS.includes(url.pathname)) {
    const response = (async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const fresh = await fetch(request, { cache: "no-cache" });
        if (fresh.ok) await cache.put(request, fresh.clone());
        return fresh;
      } catch {
        return await cache.match(request) ?? Response.error();
      }
    })();
    event.respondWith(response);
    event.waitUntil(response.then(() => {}, () => {}));
  }
});
