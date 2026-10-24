/* LW 站点 Service Worker：页面/数据走网络优先，字体与 OpenCV 走缓存优先。 */
const VERSION = "lw-v1";
const SHELL_CACHE = "lw-shell-" + VERSION;
const DATA_CACHE = "lw-data-" + VERSION;
const ASSET_CACHE = "lw-assets-" + VERSION;
const KEEP = [SHELL_CACHE, DATA_CACHE, ASSET_CACHE];

const SHELL = [
  "/",
  "/offline.html",
  "/404.html",
  "/styles.css",
  "/boot.js",
  "/nav.js",
  "/script.js",
  "/favicon.svg",
  "/apple-touch-icon.png",
  "/fonts/noto-serif-sc-subset.woff2",
  "/fonts/inter-latin-400.woff2",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith("lw-") && !KEEP.includes(key))
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));
}

async function networkFirst(request, cacheName, ms) {
  const cache = await caches.open(cacheName);
  try {
    const response = await Promise.race([fetch(request), timeout(ms)]);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  return cached || network || fetch(request);
}

async function handleNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await Promise.race([fetch(request), timeout(6500)]);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    return (await cache.match(request))
      || (await cache.match("/offline.html"))
      || new Response("离线状态，请恢复网络后重试。", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }

  const path = url.pathname;
  if (path.startsWith("/vendor/") && path.endsWith("opencv.js")) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }
  if (path.startsWith("/fonts/")) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }
  if (path.endsWith(".json") || path.endsWith(".xml")) {
    event.respondWith(
      networkFirst(request, DATA_CACHE, 4000).catch(() => new Response("", { status: 503 }))
    );
    return;
  }

  event.respondWith(staleWhileRevalidate(request, ASSET_CACHE));
});
