const CACHE = 'concierge-v5';
const ASSETS = [
  '/app.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png'
];

// Install — cache core assets
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate — delete old caches immediately
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — network first, cache fallback
// This means users always get the latest version
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  // API calls — never cache
  if (e.request.url.includes('/api/') || e.request.url.includes('supabase') || e.request.url.includes('groq')) {
    return;
  }

  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Update cache with fresh version
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// Listen for update message from app
self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
