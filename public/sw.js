/*
 * HTML always goes to the network; scripts and styles with content versions can be cached long-term.
 * Frontend changes don't require bumping this name by hand: it only changes when the SW cache format changes.
 * Sessions, auth and file contents are never cached. No push or background notifications.
 */
const CACHE_NAME = "lanting-shell-v1";
const ASSET_PATH = /^\/assets\/[a-f0-9]{64}\/[a-zA-Z0-9_.-]+\.(?:js|css)$/;
const ICONS = [
  "/icon.svg",
  "/logo.svg",
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

// Already-open old pages aren't forcibly taken over; they can load the new versioned URLs through normal navigation.
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
  // Switch the offline HTML last: if any script download fails, the last complete page is kept.
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
