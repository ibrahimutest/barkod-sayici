// Barkod Sayıcı v2 — uygulama kabuğu önbelleği (market içinde çekim yoksa sayfa yine açılsın).
// /api/* ASLA önbelleğe alınmaz. Kabuk: ağ öncelikli (3 sn), olmazsa önbellek.
const CACHE = 'bs2-v6';
const SHELL = ['/', '/app.css?v=6', '/app.js?v=6', '/vendor/html5-qrcode-2.3.8.min.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const key = req.mode === 'navigate' ? '/' : req;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const net = await Promise.race([
        fetch(req),
        new Promise((_, rej) => setTimeout(() => rej(new Error('zaman aşımı')), 3000)),
      ]);
      if (net && net.ok) cache.put(key, net.clone());
      return net;
    } catch (err) {
      const hit = await cache.match(key);
      if (hit) return hit;
      return fetch(req);
    }
  })());
});
