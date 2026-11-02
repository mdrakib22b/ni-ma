// Ni'ma PWA service worker
const CACHE = 'nimah-v84';
const ASSETS = [
  './',
  './index.html',
  './Onboarding.dc.html',
  './support.js',
  './vendor/react.production.min.js',
  './vendor/react-dom.production.min.js',
  './vendor/fonts/geist-variable.woff2',
  './price-feed.js',
  './sync.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png'
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // Never cache the live price/FX API — always hit the network so quotes stay fresh.
  const url = new URL(req.url);
  if (url.pathname.includes('/api/') || url.pathname.includes('quotes')) return;
  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        // Only cache good responses — a cached CDN error would break the app until the next cache bump.
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()));
    })
  );
});

// Bill reminders. The daily reminders job sends an EMPTY push (no payload, so
// no bill details ever pass through the server); the notification text is
// fixed here and the details are in the app once it's unlocked.
self.addEventListener('push', (e) => {
  e.waitUntil(self.registration.showNotification('Ni’ma', {
    body: 'You have a bill due today. Open Ni’ma to see it.',
    icon: 'icon-192.png', badge: 'icon-192.png', tag: 'nima-due'
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('./');
  }));
});
