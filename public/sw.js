const CACHE_NAME = 'shiftledger-v1';
const SHELL_URLS = ['/', '/manifest.json', '/icon-192.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(SHELL_URLS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
  )));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Network-first for API calls
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request).catch(() => new Response('{"error":"Offline"}', { headers: { 'Content-Type': 'application/json' } })));
    return;
  }
  // Cache-first for static assets
  e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request).then(response => {
    const clone = response.clone();
    caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
    return response;
  })));
});
