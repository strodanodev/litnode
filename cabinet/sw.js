/* litnode arcade — service worker.
 * Network first, always. The cache is only an offline fallback for the
 * cabinet's own static files, so a fresh deploy shows up on the next load
 * and node API responses (/health, /leaderboard, …) are never cached. */
const VERSION = 'cabinet-v6';
const STATIC = /\.(html|css|js|mjs|json|webmanifest|png|svg)$|\/$/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || !STATIC.test(url.pathname)) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const r = await fetch(e.request);
      if (r.ok) cache.put(e.request, r.clone());
      return r;
    } catch {
      return (await cache.match(e.request)) ?? Response.error();
    }
  })());
});
