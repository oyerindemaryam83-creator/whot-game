/* Caches the game so computer games load and play with no internet. Bump V when you change files. */
const V = 'whot-v4';
const ASSETS = ['./', 'index.html', 'style.css', 'app.js', 'extras.js', 'mp.js', 'social.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => Promise.all(ASSETS.map(a => c.add(a).catch(() => {}))))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== V).map(x => caches.delete(x))))); self.clients.claim();
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api') || u.pathname === '/ws' || u.pathname.startsWith('/admin') || u.pathname === '/healthz') return;
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const c = r.clone(); caches.open(V).then(x => x.put(e.request, c)); } return r; })
    .catch(() => caches.match(e.request).then(m => m || caches.match('index.html'))));
});
