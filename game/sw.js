// Daily Jump service worker: makes the game installable and lets it open offline.
// Network first for everything it caches (so a new version always wins when you're
// online); the cache is only the fallback.  The API is never cached.
const CACHE = 'daily-jump-v3';
const SHELL = ['./', 'game.js', 'rooms-worker.js', 'manifest.webmanifest', 'favicon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Every visit to the page (whatever ?query it carries) is one cache entry: './'.
  const key = e.request.mode === 'navigate' ? './' : e.request;
  const cached = () => caches.match(key, { ignoreSearch: true }).then((hit) => hit || caches.match('./'));
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // A tunnel or proxy that's down still *answers* (502/530 error pages): treat any
        // non-OK response like no network and fall back to the cached game.
        if (!res.ok) return cached().then((hit) => hit || res);
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(key, copy));
        return res;
      })
      .catch(cached),
  );
});
