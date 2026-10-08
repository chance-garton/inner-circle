/* InnerVerse app: keeps the app opening fast and offline, and always picks up new versions.
   The page itself is fetched fresh first on every launch, so a pushed update shows on the next open. */
const VERSION = 'iva-2026-10-08b';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/apple-touch-icon.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k.indexOf('iva-') === 0).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
async function networkFirst(req, key) {
  const c = await caches.open(VERSION);
  try {
    const r = await fetch(req);
    if (r && r.ok) c.put(key || req, r.clone());
    return r;
  } catch (e) {
    const hit = await c.match(key || req, { ignoreSearch: true });
    if (hit) return hit;
    throw e;
  }
}
async function cacheFirst(req) {
  const c = await caches.open(VERSION + '-img');
  const hit = await c.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (r && (r.ok || r.type === 'opaque')) {
    await c.put(req, r.clone());
    const keys = await c.keys();
    if (keys.length > 400) for (const k of keys.slice(0, keys.length - 400)) await c.delete(k);
  }
  return r;
}
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate' && url.origin === location.origin && url.pathname.indexOf('/app/') === 0) {
    e.respondWith(networkFirst(req, './index.html'));
    return;
  }
  if (url.origin === location.origin && url.pathname.indexOf('/app/') === 0) { e.respondWith(networkFirst(req)); return; }
  if (url.hostname === 'raw.githubusercontent.com' && /innerverse-data/.test(url.pathname)) { e.respondWith(networkFirst(req)); return; }
  if (url.hostname === 'images.squarespace-cdn.com') { e.respondWith(cacheFirst(req)); return; }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') { e.respondWith(cacheFirst(req)); return; }
});
