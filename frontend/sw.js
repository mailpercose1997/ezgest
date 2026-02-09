const CACHE_NAME = 'ezgest-v9';
const urlsToCache = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', event => {
  self.skipWaiting(); // Forza l'attivazione immediata del nuovo SW
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache)));
});

self.addEventListener('fetch', event => {
  // Ignora le chiamate API (lasciale gestire alla rete direttamente)
  if (event.request.url.includes('/api/')) return;
  event.respondWith(caches.match(event.request).then(response => response || fetch(event.request)));
});