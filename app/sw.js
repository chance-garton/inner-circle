/* InnerVerse app: keeps the app opening fast and offline, and always picks up new versions.
   The page itself is fetched fresh first on every launch, so a pushed update shows on the next open. */
const VERSION = 'iva-2026-10-09c';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/apple-touch-icon.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k.indexOf('iva-') === 0).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
async function networkFirst(req, key, fresh) {
  const c = await caches.open(VERSION);
  try {
    // the app's own files skip the browser's short-term cache, so a pushed update shows on the next open
    const r = fresh ? await fetch(req.url, { cache: 'no-store', credentials: 'same-origin' }) : await fetch(req);
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
  if (url.pathname.endsWith('/version.txt')) return;
  if (req.mode === 'navigate' && url.origin === location.origin && url.pathname.indexOf('/app/') === 0) {
    e.respondWith(networkFirst(req, './index.html', true));
    return;
  }
  if (url.origin === location.origin && url.pathname.indexOf('/app/') === 0) { e.respondWith(networkFirst(req, null, true)); return; }
  if (url.hostname === 'raw.githubusercontent.com' && /innerverse-data/.test(url.pathname)) { e.respondWith(networkFirst(req)); return; }
  if (url.hostname === 'images.squarespace-cdn.com') { e.respondWith(cacheFirst(req)); return; }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') { e.respondWith(cacheFirst(req)); return; }
});

// chat notifications, even with the app closed
const CIRCLE_API = 'https://innerverse-circle.chance-5da.workers.dev';
async function avatarIcon(key) {
  if (!key || !/^circle\/[0-9a-f-]{36}\.(png|jpg|gif|webp)$/.test(key)) return '';
  try {
    const t = await (await caches.open('ivauth')).match('/app/__token');
    if (!t) return '';
    const r = await fetch(CIRCLE_API + '/media/' + key, { headers: { Authorization: 'Bearer ' + (await t.text()) } });
    if (!r.ok) return '';
    const type = r.headers.get('Content-Type') || 'image/jpeg';
    const u = new Uint8Array(await r.arrayBuffer()); let bin = '';
    for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return 'data:' + type + ';base64,' + btoa(bin);
  } catch (e) { return ''; }
}
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  // the poster's photo as the picture where the phone allows it (Android; iPhone always shows the app icon)
  const show = avatarIcon(d.avatar).then(icon => self.registration.showNotification(d.title || 'InnerVerse', {
    body: d.body || '', tag: d.tag || 'ivc', icon: icon || 'icons/icon-192.png', badge: 'icons/icon-192.png',
    data: { url: d.url || '/app/#/chat' },
  }));
  const badge = typeof d.badge === 'number' && self.navigator && self.navigator.setAppBadge ? self.navigator.setAppBadge(d.badge).catch(() => {}) : Promise.resolve();
  e.waitUntil(Promise.all([show, badge]));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/app/#/chat', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (c.url.indexOf('/app/') >= 0) { return c.focus().then(w => (w && 'navigate' in w) ? w.navigate(url).catch(() => {}) : null).catch(() => {}); }
    }
    return self.clients.openWindow(url);
  }));
});
