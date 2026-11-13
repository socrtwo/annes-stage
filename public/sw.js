// Anne's Stage service worker: makes the web app (and the ChromeOS / desktop-browser install) work
// offline. The build (vite.config.ts, plugin "sw-precache") fills in BUILD and PRECACHE: each build
// has its own cache, filled at install with every script, style sheet, font, icon and the page, and
// older caches are deleted when the new worker activates. Pages are network-first so an update shows
// on the next visit; spelling dictionaries and other large files are cached the first time they are
// used. Unprocessed (the dev server), BUILD stays '__BUILD__' and only the page is precached.
const BUILD = '__BUILD__';
const PRECACHE = /*__PRECACHE__*/[];
const CACHE = `quillstage-${BUILD}`;
const PREFIX = 'quillstage-';
const SHELL = ['./', './index.html', './manifest.webmanifest'];

self.addEventListener('install', (e) => {
  const files = [...new Set([...SHELL, ...PRECACHE])];
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(files.map((f) => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/** Only complete, direct answers are cached: not errors, redirects or opaque responses. */
const cacheable = (res) => res && res.ok && !res.redirected && res.type === 'basic';

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((res) => {
      if (cacheable(res)) {
        const copy = res.clone();
        e.waitUntil(caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => undefined));
      }
      return res;
    }).catch(async () => (await caches.match('./index.html')) || Response.error()));
    return;
  }
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(req);
    // Built files have content hashes in their names: a hit never needs refreshing.
    if (hit) return hit;
    const res = await fetch(req);
    if (cacheable(res)) {
      const copy = res.clone();
      e.waitUntil(c.put(req, copy).catch(() => undefined));
    }
    return res;
  }));
});
