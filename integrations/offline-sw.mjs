/**
 * Writes dist/sw.js after the static build.
 * Stylesheet names are hashed, so the precache list is collected from
 * the built HTML instead of being committed as a static file.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OFFLINE_URL = '/offline/';
const APP_PAGES = ['/', '/now/', '/tools/'];

export function offlineServiceWorker() {
  return {
    name: 'lw-offline-sw',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        const root = fileURLToPath(dir);
        const swPath = await writeServiceWorker(root);
        logger.info(`Wrote ${swPath}`);
      },
    },
  };
}

export async function writeServiceWorker(root) {
  const offlineHtmlPath = join(root, 'offline', 'index.html');
  if (!existsSync(offlineHtmlPath)) {
    throw new Error(`Pause page was not built at ${offlineHtmlPath}`);
  }

  const offlineHtml = readFileSync(offlineHtmlPath, 'utf8');
  const catalog = extractCatalog(offlineHtml);
  const postUrls = catalog.posts.slice(0, catalog.limit).map((post) => post.href);

  for (const url of [OFFLINE_URL, ...APP_PAGES, ...postUrls]) {
    const file = urlToFile(root, url);
    if (!existsSync(file)) throw new Error(`Missing built page for ${url} (${file})`);
  }

  const pagesToScan = [OFFLINE_URL, ...APP_PAGES, ...postUrls];
  const stylesheets = [];
  const scripts = [];
  const icons = [];
  for (const url of pagesToScan) {
    const html = readFileSync(urlToFile(root, url), 'utf8');
    const assets = extractAssets(html);
    stylesheets.push(...assets.stylesheets);
    scripts.push(...assets.scripts);
    icons.push(...assets.icons);
  }

  const shell = unique([OFFLINE_URL, '/avatar.webp', ...stylesheets, ...scripts]);
  for (const url of shell) {
    const file = urlToFile(root, url);
    if (!existsSync(file)) throw new Error(`Missing shell asset ${url} (${file})`);
  }
  if (stylesheets.length === 0 && !/<style[\s>]/i.test(offlineHtml)) {
    throw new Error('Pause page has no stylesheet to precache');
  }

  const hardPages = APP_PAGES.filter((url) => !shell.includes(url));
  const extra = unique([...postUrls, ...icons]).filter((url) => !shell.includes(url) && !hardPages.includes(url));

  const hash = createHash('sha256');
  hash.update(readFileSync(fileURLToPath(import.meta.url)));
  for (const url of [...shell, ...hardPages, ...extra]) {
    const file = urlToFile(root, url);
    if (existsSync(file)) hash.update(readFileSync(file));
  }
  const version = hash.digest('hex').slice(0, 12);
  const cacheName = `lw-${version}`;

  const source = renderServiceWorker({
    cacheName,
    shell,
    hardPages,
    extra,
    stylesheets: unique(stylesheets),
  });

  const swPath = join(root, 'sw.js');
  await writeFile(swPath, source);
  return swPath;
}

function renderServiceWorker({ cacheName, shell, hardPages, extra, stylesheets }) {
  return `/* Generated at build time. Navigation failures fall back to the pause page. */
const CACHE = ${JSON.stringify(cacheName)};
const SHELL = ${JSON.stringify(shell)};
const HARD_PAGES = ${JSON.stringify(hardPages)};
const EXTRA = ${JSON.stringify(extra)};
const STYLESHEETS = ${JSON.stringify(stylesheets)};
const OFFLINE_URL = ${JSON.stringify(OFFLINE_URL)};

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll([...SHELL, ...HARD_PAGES]);
    await Promise.all(EXTRA.map(async (url) => {
      try {
        await cache.add(url);
      } catch (reason) {
        console.warn('lw sw skipped', url, reason);
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/sw.js') return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

async function networkFirstNavigation(request) {
  try {
    const headers = new Headers();
    const accept = request.headers.get('Accept');
    if (accept) headers.set('Accept', accept);
    const response = await fetch(new Request(request.url, {
      headers,
      cache: 'no-store',
      redirect: 'follow',
    }));
    if (response && response.ok && response.type === 'basic' && !response.redirected) {
      const cache = await caches.open(CACHE);
      try {
        await cache.put(pagePath(new URL(request.url).pathname), response.clone());
      } catch {
        /* The network response is still returned when it cannot be stored. */
      }
    }
    if (response) return response;
  } catch {
    /* Network unavailable: try a cached page, then the pause page. */
  }
  const cached = await matchNavigation(request);
  if (cached) return cached;
  const offline = await caches.match(OFFLINE_URL);
  if (offline) return offline;
  return fallbackDocument();
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    return await fetch(request);
  } catch {
    return Response.error();
  }
}

async function matchNavigation(request) {
  const path = pagePath(new URL(request.url).pathname);
  return (await caches.match(path)) || (await caches.match(request));
}

function pagePath(pathname) {
  if (pathname.endsWith('/')) return pathname;
  const last = pathname.split('/').pop() || '';
  if (last.includes('.')) return pathname;
  return pathname + '/';
}

function fallbackDocument() {
  const links = STYLESHEETS.map((href) => '<link rel="stylesheet" href="' + href + '">').join('');
  const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<title>这一会儿连不上 · lw</title>'
    + '<meta name="robots" content="noindex">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + links
    + '</head><body><main id="main"><section class="stage hero-stage offline-stage">'
    + '<div class="stage-content"><div class="glass hero-card"><div>'
    + '<h1>这一会儿连不上</h1>'
    + '<p class="offline-lead">网络先去别处了，过一会儿再试试看。</p>'
    + '<p class="tagline">Stay hungry, stay foolish.</p>'
    + '<button class="offline-retry" type="button" onclick="location.reload()">再试一次</button>'
    + '</div></div></div></section></main>'
    + '<script>window.addEventListener("online",function(){location.reload()})<\\/script>'
    + '</body></html>';
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
`;
}

function extractCatalog(html) {
  const match = html.match(/<script\b[^>]*\bid=["']offline-catalog["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error('Pause page is missing #offline-catalog');
  let data;
  try {
    data = JSON.parse(decodeEntities(match[1].trim()));
  } catch (reason) {
    throw new Error(`Pause page catalog is not valid JSON (${reason.message})`);
  }
  const posts = Array.isArray(data.posts) ? data.posts : [];
  const limit = typeof data.limit === 'number' && data.limit > 0 ? data.limit : 5;
  return {
    limit,
    posts: posts.map((post) => {
      if (!post || typeof post.href !== 'string' || !post.href.startsWith('/blog/')) {
        throw new Error('Pause page catalog has a post without a /blog/ href');
      }
      return { href: post.href };
    }),
  };
}

function extractAssets(html) {
  const stylesheets = [];
  const scripts = [];
  const icons = [];
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    const text = tag[0];
    const href = /href="([^"]+)"/i.exec(text)?.[1];
    const rel = (/rel="([^"]+)"/i.exec(text)?.[1] ?? '').toLowerCase().split(/\s+/);
    const path = normalizePath(href);
    if (!path || path.endsWith('/')) continue;
    if (rel.includes('stylesheet')) stylesheets.push(path);
    else if (rel.includes('icon') || rel.includes('apple-touch-icon')) icons.push(path);
  }
  for (const match of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/gi)) {
    const path = normalizePath(match[1]);
    if (path && !path.endsWith('/')) scripts.push(path);
  }
  return { stylesheets, scripts, icons };
}

function normalizePath(value) {
  if (!value) return null;
  try {
    if (value.startsWith('https://www.l-w.sryze.cc/')) {
      return new URL(value).pathname;
    }
  } catch {
    return null;
  }
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  return value.split('#')[0].split('?')[0];
}

function urlToFile(root, urlPath) {
  const path = urlPath.split('#')[0].split('?')[0];
  if (path === '/') return join(root, 'index.html');
  if (path.endsWith('/')) return join(root, path.slice(1), 'index.html');
  return join(root, path.slice(1));
}

function unique(values) {
  return [...new Set(values)];
}

function decodeEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}
