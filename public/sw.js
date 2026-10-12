/* Service worker — app-shell caching for offline launch on iPhone.
   API responses are NEVER cached (they must always be live), except the
   dashboard snapshot which is served stale-while-offline so the home screen
   still renders something when the device has no signal. */

const VERSION='wa-v5';
const SHELL = [
  './', './index.html', './styles.css', './app.js',
  './icons.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET') return;

  // API: network-first, never cache except dashboard fallback
  if (url.pathname.includes('/api/')) {
    const isDashboard = url.pathname.endsWith('/api/dashboard');
    e.respondWith(
      fetch(req).then((res) => {
        if (isDashboard) caches.open(VERSION + '-data').then((c) => c.put(req, res.clone()));
        return res;
      }).catch(async () => {
        if (isDashboard) {
          const cached = await caches.match(req);
          if (cached) return cached;
        }
        return new Response(JSON.stringify({ ok: false, error: 'offline', note: 'オフラインです。ネットワーク復帰後に再試行します。' }),
          { status: 503, headers: { 'content-type': 'application/json' } });
      }),
    );
    return;
  }

  // App shell: network-first, so a new deploy lands on the very next launch
  // instead of being pinned behind an old cached bundle. Cache = offline only.
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok && url.origin === self.location.origin) {
        caches.open(VERSION).then((c) => c.put(req, res.clone()));
      }
      return res;
    }).catch(() => caches.match(req).then((c) => c || caches.match('./index.html'))),
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
