/* Service Worker – macht die Seite installierbar (Chrome-Menü ⋮ → "App installieren") und offline nutzbar.
   Seite, Skripte und Daten: erst Netz (immer aktuell), offline der zuletzt geladene Stand.
   Bilder/Logos: aus dem Cache (ändern sich praktisch nie). Fremde Server (Karte, CDN) bleiben unberührt. */
const CACHE = 'monster-v1';
const CORE = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'assets/can-ultra-white.webp', 'assets/icon-192.png', 'assets/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  const store = (response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy));
    }
    return response;
  };

  if (url.pathname.includes('/assets/')) {
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request).then(store)));
    return;
  }
  event.respondWith(fetch(request).then(store).catch(() =>
    caches.match(request, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html'))));
});
