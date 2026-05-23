// Service worker — network first, no caching
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
  );
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  // Always go to network — never serve from cache
  e.respondWith(fetch(e.request).catch(() => new Response('Offline')));
});
