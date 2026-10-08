// InnerVerse Inner Circle: members-only chat.
// One Worker serves the app page, image uploads and the WebSocket; one
// Durable Object per room keeps the messages, profiles and moderation state
// in its own SQLite storage. Sign-in reuses the Plus+ session the
// innerverse-plus Worker already issues (Memberful or Patreon).

import APP_HTML from './app.html';

const INITIATOR_CUTOFF = Date.UTC(2027, 0, 1); // joined before 1 Jan 2027
const MAX_TEXT = 2000;
const MAX_IMAGE = 8 * 1024 * 1024;
const PAGE = 50;
// Quick reactions shown first; any single real emoji is accepted.
const REACTIONS = ['\u2764\uFE0F', '\uD83D\uDE02', '\uD83D\uDD25', '\uD83E\uDD2F', '\uD83D\uDE4F', '\u2728', '\uD83D\uDC4D'];
const OLD_REACTIONS = { heart: '\u2764\uFE0F', flame: '\uD83D\uDD25', eye: '\uD83D\uDC41\uFE0F', spark: '\u2728', laugh: '\uD83D\uDE02', aha: '\uD83D\uDCA1' };
function isEmoji(k) {
  if (typeof k !== 'string' || !k || k.length > 32) return false;
  if (!/^[\p{Extended_Pictographic}\p{Emoji_Component}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\ufe0f\u20e3\u{E0020}-\u{E007F}]+$/u.test(k)) return false;
  return /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(k);
}
const SIGNS = ['', 'Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo', 'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces'];
const SYMBOLS = ['sun', 'moon', 'eye', 'star', 'triangle', 'leaf'];

// ---------------------------------------------------------------- auth

const authCache = new Map(); // token -> { at, who }

async function verify(token, env) {
  if (!token || typeof token !== 'string' || token.length > 4096) return null;
  if (env.DEV_AUTH === '1' && token.startsWith('dev.')) {
    const [, id, name, ...rest] = token.split('.');
    const email = rest.join('.');
    return { uid: 'm:' + id, email: (email || id + '@example.com').toLowerCase(), name: decodeURIComponent(name || id), source: 'dev', entitled: true };
  }
  const hit = authCache.get(token);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.who;
  let who = null;
  try {
    // A Worker cannot reach another Worker on the same account through its workers.dev
    // address (Cloudflare error 1042), so use the service binding when it exists.
    const init = { headers: { Authorization: 'Bearer ' + token } };
    const r = env.AUTH_SVC ? await env.AUTH_SVC.fetch(env.AUTH_URL + '/auth/status', init) : await fetch(env.AUTH_URL + '/auth/status', init);
    if (r.ok) {
      const s = await r.json();
      if (s && s.signedIn) {
        const email = String(s.email || '').toLowerCase();
        who = {
          uid: 'm:' + (await sha(email || s.name || token)).slice(0, 24),
          email, name: s.name || '', source: s.source || 'memberful', entitled: !!s.entitled,
        };
      }
    }
  } catch (e) { /* fall through: not signed in */ }
  authCache.set(token, { at: Date.now(), who });
  if (authCache.size > 5000) authCache.clear();
  return who;
}

async function sha(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function bearer(req) {
  const h = req.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

// ---------------------------------------------------------------- web push

const b64u = buf => { const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const ub64 = str => { let s = String(str || '').replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
const cat = (...arrs) => { let n = 0; for (const a of arrs) n += a.length; const o = new Uint8Array(n); let i = 0; for (const a of arrs) { o.set(a, i); i += a.length; } return o; };
const utf8 = t => new TextEncoder().encode(t);
async function hmac256(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
async function encryptPush(sub, payload) {
  const uaPub = ub64(sub.p256dh), authSecret = ub64(sub.auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const ikm = await hmac256(await hmac256(authSecret, shared), cat(utf8('WebPush: info\0'), uaPub, asPub, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac256(salt, ikm);
  const cek = (await hmac256(prk, cat(utf8('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac256(prk, cat(utf8('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(utf8(payload), new Uint8Array([2]))));
  return cat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPub.length]), asPub, ct);
}
async function vapidHeader(endpoint, vapid) {
  const head = b64u(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(utf8(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:chance@innerversepodcast.com' })));
  const key = await crypto.subtle.importKey('jwk', vapid.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(head + '.' + claims)));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${vapid.pub}`;
}
async function sendPush(sub, payload, vapid) {
  const body = await encryptPush(sub, payload);
  return fetch(sub.endpoint, { method: 'POST', body, headers: {
    'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high',
    Authorization: await vapidHeader(sub.endpoint, vapid) } });
}

// ---------------------------------------------------------------- worker

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    const origin = req.headers.get('Origin') || '';
    const allowed = [url.origin].concat(String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean));
    const okOrigin = !origin || allowed.includes(origin);
    const cors = okOrigin && origin ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' } : {};
    if (req.method === 'OPTIONS') {
      if (!okOrigin) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: Object.assign({}, cors, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '86400' }) });
    }
    const res = await route(req, env, url, path, okOrigin);
    if (!cors['Access-Control-Allow-Origin'] || res.status === 101) return res;
    const out = new Response(res.body, res);
    for (const k in cors) out.headers.set(k, cors[k]);
    return out;
  },
};

async function route(req, env, url, path, okOrigin) {
  {

    if (path === '/' || path === '/index.html') {
      return new Response(APP_HTML.replace('__AUTH_URL__', env.AUTH_URL).replace('__DEV__', env.DEV_AUTH === '1' ? '1' : '0'), {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }

    if (path === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
      if (!okOrigin) return new Response('Origin not allowed', { status: 403 });
      const room = env.ROOM.get(env.ROOM.idFromName('lounge'));
      return room.fetch(req);
    }

    if (path === '/api/push/key' && req.method === 'GET') {
      const room = env.ROOM.get(env.ROOM.idFromName('lounge'));
      return room.fetch(new Request('https://room/push-key'));
    }

    if ((path === '/api/push/subscribe' || path === '/api/push/unsubscribe' || path === '/api/push/test' || path === '/api/unfurl') && req.method === 'POST') {
      if (!okOrigin) return json({ error: 'origin not allowed' }, 403);
      const who = await verify(bearer(req), env);
      if (!who || !who.entitled) return json({ error: 'not a member' }, 401);
      let body = {}; try { body = await req.json(); } catch (e) { /* empty */ }
      const room = env.ROOM.get(env.ROOM.idFromName('lounge'));
      return room.fetch(new Request('https://room/' + path.split('/').pop(), { method: 'POST', body: JSON.stringify({ uid: who.uid, body }) }));
    }

    if (path === '/api/upload' && req.method === 'POST') {
      const who = await verify(bearer(req), env);
      if (!who || !who.entitled) return json({ error: 'not a member' }, 401);
      const type = req.headers.get('Content-Type') || '';
      if (!/^image\/(png|jpeg|gif|webp)$/.test(type)) return json({ error: 'images only (png, jpg, gif, webp)' }, 415);
      const len = Number(req.headers.get('Content-Length') || 0);
      if (len > MAX_IMAGE) return json({ error: 'image too large (8 MB max)' }, 413);
      const body = await req.arrayBuffer();
      if (body.byteLength > MAX_IMAGE) return json({ error: 'image too large (8 MB max)' }, 413);
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[type];
      const key = 'circle/' + crypto.randomUUID() + '.' + ext;
      await env.MEDIA.put(key, body, { httpMetadata: { contentType: type }, customMetadata: { uid: who.uid } });
      return json({ key });
    }

    if (path.startsWith('/media/') && req.method === 'GET') {
      const who = await verify(bearer(req), env);
      if (!who || !who.entitled) return new Response('Members only', { status: 401 });
      const key = decodeURIComponent(path.slice('/media/'.length));
      if (!/^circle\/[0-9a-f-]{36}\.(png|jpg|gif|webp)$/.test(key)) return new Response('Not found', { status: 404 });
      const obj = await env.MEDIA.get(key);
      if (!obj) return new Response('Not found', { status: 404 });
      return new Response(obj.body, {
        headers: { 'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream', 'Cache-Control': 'private, max-age=86400' },
      });
    }

    return new Response('Not found', { status: 404 });
  }
}

// ---------------------------------------------------------------- room

const UNDOABLE = ['delete', 'pin', 'unpin', 'mute', 'unmute', 'remove', 'restore', 'role', 'title_add', 'title_remove'];

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    this.rate = new Map();
    this.typingAt = new Map();
    this.sql.exec(`CREATE TABLE IF NOT EXISTS members (
      uid TEXT PRIMARY KEY, email TEXT, source TEXT, name TEXT DEFAULT '', avatar TEXT DEFAULT '',
      bio TEXT DEFAULT '', sun TEXT DEFAULT '', moon TEXT DEFAULT '', rising TEXT DEFAULT '',
      interests TEXT DEFAULT '[]', favorites TEXT DEFAULT '[]', joined INTEGER DEFAULT 0,
      first_seen INTEGER, rules_ok INTEGER DEFAULT 0, profile_done INTEGER DEFAULT 0,
      role TEXT DEFAULT 'member', muted_until INTEGER DEFAULT 0, banned INTEGER DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT, text TEXT, image TEXT, reply_to INTEGER,
      created INTEGER, edited INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS reactions (msg_id INTEGER, uid TEXT, kind TEXT, PRIMARY KEY (msg_id, uid, kind))`);
    try { this.sql.exec("ALTER TABLE members ADD COLUMN recent TEXT DEFAULT '[]'"); } catch (e) { /* already there */ }
    try { this.sql.exec("ALTER TABLE members ADD COLUMN titles TEXT DEFAULT '[]'"); } catch (e) { /* already there */ }
    try { this.sql.exec("ALTER TABLE members ADD COLUMN no_init INTEGER DEFAULT 0"); } catch (e) { /* already there */ }
    try { this.sql.exec("ALTER TABLE messages ADD COLUMN kind TEXT DEFAULT ''"); } catch (e) { /* already there */ }
    try { this.sql.exec("ALTER TABLE messages ADD COLUMN mentions TEXT DEFAULT '[]'"); } catch (e) { /* already there */ }
    try { this.sql.exec("ALTER TABLE messages ADD COLUMN preview TEXT DEFAULT ''"); } catch (e) { /* already there */ }
    try { this.sql.exec('ALTER TABLE members ADD COLUMN join_alerts INTEGER DEFAULT 1'); } catch (e) { /* already there */ }
    this.sql.exec('CREATE TABLE IF NOT EXISTS link_previews (url TEXT PRIMARY KEY, data TEXT, fetched INTEGER)');
    // who has had a message on screen (only the count is ever shown, never the names)
    this.sql.exec('CREATE TABLE IF NOT EXISTS views (msg_id INTEGER, uid TEXT, PRIMARY KEY (msg_id, uid)) WITHOUT ROWID');
    for (const [oldKey, emoji] of Object.entries(OLD_REACTIONS)) {
      this.sql.exec('UPDATE OR IGNORE reactions SET kind = ? WHERE kind = ?', emoji, oldKey);
      this.sql.exec('DELETE FROM reactions WHERE kind = ?', oldKey);
    }
    this.sql.exec(`CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, msg_id INTEGER, uid TEXT, reason TEXT, created INTEGER, resolved INTEGER DEFAULT 0)`);
    // moderation history (host only), every entry undoable
    this.sql.exec(`CREATE TABLE IF NOT EXISTS modlog (id INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER, actor TEXT DEFAULT '', action TEXT,
      target TEXT DEFAULT '', msg_id INTEGER DEFAULT 0, detail TEXT DEFAULT '{}', undone INTEGER DEFAULT 0, undone_at INTEGER DEFAULT 0, undone_by TEXT DEFAULT '')`);
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, uid TEXT, p256dh TEXT, auth TEXT, created INTEGER)');
    try { this.sql.exec("ALTER TABLE members ADD COLUMN notify TEXT DEFAULT 'all'"); } catch (e) { /* already there */ }
    try { this.sql.exec('ALTER TABLE members ADD COLUMN push_unread INTEGER DEFAULT 0'); } catch (e) { /* already there */ }
    if (!this.one("SELECT v FROM meta WHERE k = 'modlog_backfill'")) {
      // what happened before the history existed: deleted messages, removed and muted members
      const now = Date.now();
      for (const r of this.all('SELECT id, uid, created, pinned FROM messages WHERE deleted = 1 ORDER BY id')) {
        this.sql.exec("INSERT INTO modlog (created, actor, action, target, msg_id, detail) VALUES (?, '', 'delete', ?, ?, ?)", r.created, r.uid, r.id, JSON.stringify({ earlier: true }));
      }
      for (const m of this.all('SELECT uid FROM members WHERE banned = 1')) this.sql.exec("INSERT INTO modlog (created, actor, action, target, detail) VALUES (?, '', 'remove', ?, ?)", now, m.uid, JSON.stringify({ earlier: true }));
      for (const m of this.all('SELECT uid, muted_until FROM members WHERE muted_until > ?', now)) this.sql.exec("INSERT INTO modlog (created, actor, action, target, detail) VALUES (?, '', 'mute', ?, ?)", now, m.uid, JSON.stringify({ earlier: true, prev: 0 }));
      this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('modlog_backfill', '1')");
    }
  }

  async vapid() {
    const row = this.one("SELECT v FROM meta WHERE k = 'vapid'");
    if (row) return JSON.parse(row.v);
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const v = { pub: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), jwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
    this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('vapid', ?)", JSON.stringify(v));
    return v;
  }

  // members looking at the chat right now get it live; everyone else subscribed gets a push, by their setting
  async pushOut(m, author) {
    try {
      const subs = this.all('SELECT s.*, m.notify, m.push_unread, m.role, m.join_alerts FROM push_subs s JOIN members m ON m.uid = s.uid WHERE s.uid != ? AND m.banned = 0 AND m.profile_done = 1', author.uid);
      if (!subs.length) return;
      const looking = new Set();
      for (const ws of this.state.getWebSockets()) {
        if (ws.readyState !== 1) continue;
        const a = ws.deserializeAttachment();
        if (a && a.uid && a.ready && !a.away) looking.add(a.uid);
      }
      const vapid = await this.vapid();
      const mentions = Array.isArray(m.mentions) ? m.mentions : [];
      const bumped = new Map();
      for (const s of subs) {
        if (looking.has(s.uid)) continue;
        const level = s.notify || 'all';
        const tagged = mentions.includes(s.uid);
        if (m.kind === 'join') {
          // a new member joining reaches the host only, whatever their level (Chance, 2026-10-08), unless they switched it off
          if (s.role !== 'host' || s.join_alerts === 0) continue;
        } else if (level === 'none' || (level === 'mentions' && !tagged)) continue;
        if (!bumped.has(s.uid)) { this.sql.exec('UPDATE members SET push_unread = push_unread + 1 WHERE uid = ?', s.uid); bumped.set(s.uid, (s.push_unread || 0) + 1); }
        // Telegram style: the room as the title, "Name: message" as the text (the phone trims it to fit)
        const name = author.name || 'A member';
        const text = (m.text || '').replace(/\s+/g, ' ').trim();
        const body = m.kind === 'join' ? `${name} joined the chat` : `${name}: ${m.image ? '\u{1F4F7} Photo' + (text ? ' ' : '') : ''}${text}`.slice(0, 600);
        const img = typeof author.avatar === 'string' && author.avatar.startsWith('img:') ? author.avatar.slice(4) : '';
        const payload = JSON.stringify({ title: m.kind === 'join' ? 'New member' : 'Inner Circle', body: m.kind === 'join' ? `${name} just joined the Inner Circle` : body, tag: 'ivc-' + m.id, url: '/app/#/chat', badge: bumped.get(s.uid), avatar: img });
        try {
          const r = await sendPush(s, payload, vapid);
          if (r.status === 404 || r.status === 410) this.sql.exec('DELETE FROM push_subs WHERE endpoint = ?', s.endpoint);
        } catch (e) { /* try again next message */ }
      }
    } catch (e) { /* pushes never break the chat */ }
  }

  // ---- link previews, kept a week (a failed look a few hours)
  cachedPreview(url) {
    const r = this.one('SELECT data, fetched FROM link_previews WHERE url = ?', url);
    if (!r) return undefined;
    const fresh = Date.now() - r.fetched < (r.data === 'null' ? 3 * 3600e3 : 7 * 86400e3);
    return fresh ? safeObj(r.data) : undefined;
  }
  async getPreview(url) {
    const c = this.cachedPreview(url);
    if (c !== undefined) return c;
    let p = null;
    try { p = await fetchPreview(url); } catch (e) { p = null; }
    this.sql.exec('INSERT OR REPLACE INTO link_previews (url, data, fetched) VALUES (?, ?, ?)', url, JSON.stringify(p), Date.now());
    return p;
  }
  async fillPreview(id, url) {
    const p = await this.getPreview(url);
    if (!p) return;
    const row = this.one('SELECT * FROM messages WHERE id = ?', id);
    if (!row || row.deleted || firstLink(row.text) !== url) return;
    this.sql.exec('UPDATE messages SET preview = ? WHERE id = ?', JSON.stringify(p), id);
    this.broadcast({ t: 'update', m: this.shape(this.one('SELECT * FROM messages WHERE id = ?', id)) });
  }

  viewCount(id) { return this.one('SELECT COUNT(*) AS n FROM views WHERE msg_id = ?', id).n; }

  log(actor, action, target, msgId, detail) {
    this.sql.exec('INSERT INTO modlog (created, actor, action, target, msg_id, detail) VALUES (?, ?, ?, ?, ?, ?)', Date.now(), actor || '', action, target || '', msgId || 0, JSON.stringify(detail || {}));
  }

  kick(uid) {
    for (const s of this.state.getWebSockets()) {
      const a = s.deserializeAttachment();
      if (a && a.uid === uid) { this.send(s, { t: 'denied', why: 'removed' }); s.serializeAttachment(Object.assign({}, a, { ready: false })); try { s.close(4003, 'removed'); } catch (e) { /* closed */ } }
    }
    this.presence();
  }

  modlogFor() {
    const rows = this.all('SELECT * FROM modlog ORDER BY id DESC LIMIT 150');
    const ids = new Set();
    const entries = rows.map(r => {
      let detail = {}; try { detail = JSON.parse(r.detail || '{}'); } catch (e) { /* keep empty */ }
      if (r.actor) ids.add(r.actor); if (r.target) ids.add(r.target);
      let preview = null;
      if (r.msg_id) {
        const m = this.one('SELECT text, image, kind, deleted FROM messages WHERE id = ?', r.msg_id);
        if (m) preview = { text: (m.text || '').slice(0, 300), image: !!m.image, kind: m.kind || '' };
      }
      return { id: r.id, created: r.created, actor: r.actor, action: r.action, target: r.target, msg_id: r.msg_id, detail, preview,
        undone: !!r.undone, undone_at: r.undone_at, canUndo: !r.undone && UNDOABLE.includes(r.action) };
    });
    const people = {};
    for (const id of ids) { const p = this.person(this.member(id)); if (p) people[id] = p; }
    return { t: 'modlog', entries, people };
  }

  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/push-key') return json({ key: (await this.vapid()).pub });
    if (path === '/subscribe' || path === '/unsubscribe' || path === '/test' || path === '/unfurl') {
      const { uid, body } = await req.json();
      const me = this.member(uid);
      if (!me || me.banned) return json({ error: 'not in the Circle' }, 403);
      if (path === '/unfurl') {
        const link = firstLink(String(body && body.url || ''));
        return json({ url: link, preview: link ? await this.getPreview(link) : null });
      }
      if (path === '/subscribe') {
        const s = body && body.sub;
        if (!s || typeof s.endpoint !== 'string' || !(/^https:\/\//.test(s.endpoint) || (this.env.DEV_AUTH === '1' && /^http:\/\/127\.0\.0\.1:/.test(s.endpoint))) || !s.keys || !s.keys.p256dh || !s.keys.auth) return json({ error: 'bad subscription' }, 400);
        this.sql.exec('INSERT OR REPLACE INTO push_subs (endpoint, uid, p256dh, auth, created) VALUES (?, ?, ?, ?, ?)', s.endpoint, uid, String(s.keys.p256dh), String(s.keys.auth), Date.now());
        if (['all', 'mentions', 'none'].includes(body.level)) this.sql.exec('UPDATE members SET notify = ? WHERE uid = ?', body.level, uid);
        return json({ ok: true });
      }
      if (path === '/unsubscribe') { this.sql.exec('DELETE FROM push_subs WHERE endpoint = ? AND uid = ?', String(body && body.endpoint || ''), uid); return json({ ok: true }); }
      const subs = this.all('SELECT * FROM push_subs WHERE uid = ?', uid);
      const vapid = await this.vapid();
      const results = [];
      for (const s of subs) {
        try { const r = await sendPush(s, JSON.stringify({ title: 'Inner Circle', body: `${me.name || 'InnerVerse'}: Notifications are working.`, tag: 'ivc-test', url: '/app/#/chat', avatar: typeof me.avatar === 'string' && me.avatar.startsWith('img:') ? me.avatar.slice(4) : '' }), vapid); results.push(r.status); if (r.status === 404 || r.status === 410) this.sql.exec('DELETE FROM push_subs WHERE endpoint = ?', s.endpoint); }
        catch (e) { results.push(String(e).slice(0, 80)); }
      }
      return json({ sent: subs.length, results });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ uid: null });
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- helpers

  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) { /* closed */ } }

  broadcast(obj, exceptWs) {
    const s = JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) {
      if (ws === exceptWs) continue;
      const a = ws.deserializeAttachment();
      if (a && a.uid) { try { ws.send(s); } catch (e) { /* closed */ } }
    }
  }

  one(q, ...args) { const r = this.sql.exec(q, ...args).toArray(); return r[0] || null; }
  all(q, ...args) { return this.sql.exec(q, ...args).toArray(); }

  member(uid) { return this.one('SELECT * FROM members WHERE uid = ?', uid); }

  person(m) {
    if (!m) return null;
    return {
      uid: m.uid, name: m.name, avatar: m.avatar, bio: m.bio, sun: m.sun, moon: m.moon, rising: m.rising,
      interests: safeArr(m.interests), favorites: safeArr(m.favorites), joined: m.joined, role: m.role,
      initiator: !!(m.joined && m.joined < INITIATOR_CUTOFF) && !m.no_init, titles: safeArr(m.titles), muted: m.muted_until > Date.now(),
    };
  }

  online(skip) {
    const seen = new Set();
    for (const ws of this.state.getWebSockets()) {
      if (ws === skip || ws.readyState !== 1) continue;
      const a = ws.deserializeAttachment();
      if (a && a.uid && a.ready) seen.add(a.uid);
    }
    return [...seen];
  }

  presence(skip) { this.broadcast({ t: 'presence', online: this.online(skip) }); }

  shape(row) {
    if (!row) return null;
    const reacts = {};
    for (const r of this.all('SELECT uid, kind FROM reactions WHERE msg_id = ?', row.id)) {
      (reacts[r.kind] = reacts[r.kind] || []).push(r.uid);
    }
    let reply = null;
    if (row.reply_to) {
      const p = this.one('SELECT id, uid, text, image, deleted, kind FROM messages WHERE id = ?', row.reply_to);
      if (p) reply = { id: p.id, uid: p.uid, text: p.deleted ? '' : (p.text || '').slice(0, 200), image: !p.deleted && !!p.image, deleted: !!p.deleted, kind: p.kind || '' };
    }
    return {
      id: row.id, uid: row.uid, text: row.deleted ? '' : row.text, image: row.deleted ? '' : row.image,
      reply, created: row.created, edited: !!row.edited, deleted: !!row.deleted, pinned: !!row.pinned, reacts,
      replies: this.one('SELECT COUNT(*) AS n FROM messages WHERE reply_to = ? AND deleted = 0', row.id).n,
      kind: row.kind || '', mentions: safeArr(row.mentions),
      preview: row.deleted ? null : safeObj(row.preview),
      views: this.viewCount(row.id),
    };
  }

  page(before) {
    const rows = before
      ? this.all('SELECT * FROM messages WHERE id < ? AND deleted = 0 ORDER BY id DESC LIMIT ?', before, PAGE)
      : this.all('SELECT * FROM messages WHERE deleted = 0 ORDER BY id DESC LIMIT ?', PAGE);
    return rows.reverse().map(r => this.shape(r));
  }

  pins() {
    return this.all('SELECT * FROM messages WHERE pinned = 1 AND deleted = 0 ORDER BY id DESC LIMIT 10').map(r => this.shape(r));
  }

  peopleFor(msgs, extra) {
    const ids = new Set(extra || []);
    for (const m of msgs) { ids.add(m.uid); if (m.reply) ids.add(m.reply.uid); for (const u of (m.mentions || [])) ids.add(u); }
    const out = {};
    for (const id of ids) { const p = this.person(this.member(id)); if (p) out[id] = p; }
    return out;
  }

  isMod(m) { return m && (m.role === 'host' || m.role === 'mod'); }

  limited(uid) {
    const now = Date.now();
    const list = (this.rate.get(uid) || []).filter(t => now - t < 10000);
    if (list.length >= 6) { this.rate.set(uid, list); return true; }
    list.push(now); this.rate.set(uid, list); return false;
  }

  // ---- socket events

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    const att = ws.deserializeAttachment() || {};

    if (!att.uid) {
      if (msg.t !== 'hello') return ws.close(4001, 'say hello first');
      const who = await verify(msg.token, this.env);
      if (!who) { this.send(ws, { t: 'denied', why: 'signed-out' }); return ws.close(4003, 'signed out'); }
      if (!who.entitled) { this.send(ws, { t: 'denied', why: 'not-member' }); return ws.close(4003, 'not a member'); }
      let m = this.member(who.uid);
      const now = Date.now();
      const hosts = String(this.env.HOST_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
      if (!m) {
        this.sql.exec('INSERT INTO members (uid, email, source, name, first_seen) VALUES (?, ?, ?, ?, ?)', who.uid, who.email, who.source, (who.name || '').split(' ')[0].slice(0, 40), now);
      } else {
        this.sql.exec('UPDATE members SET email = ?, source = ? WHERE uid = ?', who.email, who.source, who.uid);
      }
      if (hosts.includes(who.email)) this.sql.exec("UPDATE members SET role = 'host' WHERE uid = ?", who.uid);
      // people named in MOD_EMAILS become moderators on login (take them off the list to revoke for good)
      const mods = String(this.env.MOD_EMAILS || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
      if (mods.includes(who.email) && !hosts.includes(who.email)) this.sql.exec("UPDATE members SET role = 'mod' WHERE uid = ? AND role = 'member'", who.uid);
      m = this.member(who.uid);
      if (m.banned) { this.send(ws, { t: 'denied', why: 'removed' }); return ws.close(4003, 'removed'); }
      ws.serializeAttachment({ uid: who.uid, ready: !!(m.rules_ok && m.profile_done) });
      this.sql.exec('UPDATE members SET push_unread = 0 WHERE uid = ?', who.uid);
      const msgs = this.page();
      const pins = this.pins();
      this.send(ws, {
        t: 'init', me: this.meFor(who.uid),
        messages: msgs, pins, online: this.online(),
        people: this.peopleFor(msgs.concat(pins), this.online()),
        signs: SIGNS, symbols: SYMBOLS, reactions: REACTIONS,
      });
      if (m.rules_ok && m.profile_done) this.presence();
      return;
    }

    const me = this.member(att.uid);
    if (!me || me.banned) return ws.close(4003, 'removed');
    const now = Date.now();

    switch (msg.t) {
      case 'rules_ok': {
        this.sql.exec('UPDATE members SET rules_ok = 1 WHERE uid = ?', me.uid);
        return this.send(ws, { t: 'me', me: this.meFor(me.uid) });
      }

      case 'profile': {
        const name = clean(msg.name, 40);
        if (!name) return this.send(ws, { t: 'error', what: 'profile', text: 'Please choose a display name.' });
        const avatar = typeof msg.avatar === 'string' && (/^sym:(sun|moon|eye|star|triangle|leaf)$/.test(msg.avatar) || /^img:circle\/[0-9a-f-]{36}\.(png|jpg|gif|webp)$/.test(msg.avatar)) ? msg.avatar : '';
        const sign = s => SIGNS.includes(s) ? s : '';
        const interests = Array.isArray(msg.interests) ? msg.interests.map(x => clean(x, 40)).filter(Boolean).slice(0, 5) : [];
        const favorites = Array.isArray(msg.favorites) ? msg.favorites.map(x => clean(x, 120)).filter(s => /^[a-z0-9-]+$/.test(s)).slice(0, 3) : [];
        const joined = me.joined || now;
        this.sql.exec(`UPDATE members SET name = ?, avatar = ?, bio = ?, sun = ?, moon = ?, rising = ?, interests = ?, favorites = ?, joined = ?, profile_done = 1 WHERE uid = ?`,
          name, avatar, clean(msg.bio, 160), sign(msg.sun), sign(msg.moon), sign(msg.rising), JSON.stringify(interests), JSON.stringify(favorites), joined, me.uid);
        const wasReady = att.ready;
        ws.serializeAttachment({ ...att, ready: !!me.rules_ok });
        this.send(ws, { t: 'me', me: this.meFor(me.uid) });
        this.broadcast({ t: 'person', p: this.person(this.member(me.uid)) });
        if (!wasReady) this.presence();
        // first profile save: tell the room they joined, under the name they chose
        if (!me.profile_done) {
          const row = this.one("INSERT INTO messages (uid, text, image, reply_to, created, kind) VALUES (?, '', '', NULL, ?, 'join') RETURNING *", me.uid, now);
          const m = this.shape(row);
          this.broadcast({ t: 'msg', m, people: this.peopleFor([m]) });
          this.state.waitUntil(this.pushOut(m, this.member(me.uid)));
        }
        return;
      }

      case 'send': {
        if (!me.profile_done || !me.rules_ok) return;
        if (me.muted_until > now) return this.send(ws, { t: 'error', what: 'send', text: 'You are muted for now. Try again later.' });
        if (this.limited(me.uid)) return this.send(ws, { t: 'error', what: 'send', text: 'Easy there. A few seconds between messages, please.' });
        const text = clean(msg.text, MAX_TEXT, true);
        const image = typeof msg.image === 'string' && /^circle\/[0-9a-f-]{36}\.(png|jpg|gif|webp)$/.test(msg.image) ? msg.image : '';
        if (!text && !image) return;
        let reply = null;
        if (Number.isInteger(msg.reply_to)) {
          const p = this.one('SELECT id FROM messages WHERE id = ?', msg.reply_to);
          if (p) reply = p.id;
        }
        const mentions = this.mentionsFrom(msg.mentions, me.uid);
        // a link gets its preview card (left off if the sender closed it); fetched now if not seen before
        const link = msg.nopreview || image ? '' : firstLink(text);
        const cached = link ? this.cachedPreview(link) : undefined;
        const row = this.one('INSERT INTO messages (uid, text, image, reply_to, created, mentions, preview) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *', me.uid, text, image, reply, now, JSON.stringify(mentions), cached ? JSON.stringify(cached) : '');
        if (link && cached === undefined) this.state.waitUntil(this.fillPreview(row.id, link));
        const m = this.shape(row);
        this.broadcast({ t: 'msg', m, cid: clean(msg.cid, 40), people: this.peopleFor([m]) });
        this.state.waitUntil(this.pushOut(m, this.member(me.uid)));
        if (reply) this.broadcast({ t: 'update', m: this.shape(this.one('SELECT * FROM messages WHERE id = ?', reply)) });
        return;
      }

      case 'react': {
        if (!me.profile_done || !isEmoji(msg.kind) || !Number.isInteger(msg.id)) return;
        if (!this.one('SELECT 1 AS x FROM reactions WHERE msg_id = ? AND kind = ?', msg.id, msg.kind)
          && this.one('SELECT COUNT(DISTINCT kind) AS n FROM reactions WHERE msg_id = ?', msg.id).n >= 20) return;
        const exists = this.one('SELECT 1 AS x FROM reactions WHERE msg_id = ? AND uid = ? AND kind = ?', msg.id, me.uid, msg.kind);
        if (exists) this.sql.exec('DELETE FROM reactions WHERE msg_id = ? AND uid = ? AND kind = ?', msg.id, me.uid, msg.kind);
        else { this.sql.exec('INSERT INTO reactions (msg_id, uid, kind) VALUES (?, ?, ?)', msg.id, me.uid, msg.kind); this.useEmoji(me.uid, msg.kind); this.send(ws, { t: 'me', me: this.meFor(me.uid) }); }
        const row = this.one('SELECT * FROM messages WHERE id = ?', msg.id);
        if (row) this.broadcast({ t: 'update', m: this.shape(row) });
        return;
      }

      case 'delete': {
        const row = this.one('SELECT * FROM messages WHERE id = ?', msg.id);
        if (!row) return;
        if (row.uid !== me.uid && !this.isMod(me)) return;
        if (row.deleted) return;
        this.log(me.uid, 'delete', row.uid, row.id, { self: row.uid === me.uid, pinned: !!row.pinned, reacts: this.all('SELECT uid, kind FROM reactions WHERE msg_id = ?', row.id) });
        this.sql.exec('UPDATE messages SET deleted = 1, pinned = 0 WHERE id = ?', row.id);
        this.sql.exec('DELETE FROM reactions WHERE msg_id = ?', row.id);
        this.broadcast({ t: 'update', m: this.shape(this.one('SELECT * FROM messages WHERE id = ?', row.id)) });
        if (row.reply_to) { const parent = this.one('SELECT * FROM messages WHERE id = ?', row.reply_to); if (parent) this.broadcast({ t: 'update', m: this.shape(parent) }); }
        return this.broadcast({ t: 'pins', pins: this.pins() });
      }

      case 'pin': {
        if (!this.isMod(me)) return;
        { const pr = this.one('SELECT uid, pinned FROM messages WHERE id = ? AND deleted = 0', msg.id); if (pr && !!pr.pinned !== !!msg.on) this.log(me.uid, msg.on ? 'pin' : 'unpin', pr.uid, msg.id, {}); }
        this.sql.exec('UPDATE messages SET pinned = ? WHERE id = ? AND deleted = 0', msg.on ? 1 : 0, msg.id);
        const row = this.one('SELECT * FROM messages WHERE id = ?', msg.id);
        if (row) this.broadcast({ t: 'update', m: this.shape(row) });
        const pins = this.pins();
        return this.broadcast({ t: 'pins', pins, people: this.peopleFor(pins) });
      }

      case 'mute': {
        if (!this.isMod(me)) return;
        const target = this.member(msg.uid);
        if (!target || target.role === 'host') return;
        const hours = msg.hours === 0 ? 0 : Math.min(Math.max(Number(msg.hours) || 24, 0), 24 * 30);
        this.log(me.uid, hours ? 'mute' : 'unmute', target.uid, 0, { hours, prev: target.muted_until || 0 });
        this.sql.exec('UPDATE members SET muted_until = ? WHERE uid = ?', hours ? now + hours * 3600000 : 0, target.uid);
        this.broadcast({ t: 'person', p: this.person(this.member(target.uid)) });
        return this.send(ws, { t: 'notice', text: hours ? `${target.name || 'Member'} is muted for ${hours} hours.` : `${target.name || 'Member'} can post again.` });
      }

      case 'remove': {
        if (!this.isMod(me)) return;
        const target = this.member(msg.uid);
        if (!target || target.role === 'host' || (target.role === 'mod' && me.role !== 'host')) return;
        this.log(me.uid, msg.undo ? 'restore' : 'remove', target.uid, 0, {});
        this.sql.exec('UPDATE members SET banned = ? WHERE uid = ?', msg.undo ? 0 : 1, target.uid);
        if (!msg.undo) this.kick(target.uid);
        return this.send(ws, { t: 'notice', text: msg.undo ? 'Member restored.' : `${target.name || 'Member'} was removed from the Inner Circle.` });
      }

      case 'title': {
        // host only: give or take away a title (Initiator included)
        if (me.role !== 'host') return;
        const target = this.member(msg.uid);
        if (!target) return;
        const eligible = !!(target.joined && target.joined < INITIATOR_CUTOFF);
        let titles = safeArr(target.titles);
        if (typeof msg.add === 'string') {
          const t = clean(msg.add, 32);
          if (!t) return;
          if (t.toLowerCase() === 'initiator' && eligible) { this.sql.exec('UPDATE members SET no_init = 0 WHERE uid = ?', target.uid); this.log(me.uid, 'title_add', target.uid, 0, { title: 'Initiator' }); }
          else if (!titles.some(x => x.toLowerCase() === t.toLowerCase())) {
            if (titles.length >= 5) return this.send(ws, { t: 'error', text: 'Five titles at most.' });
            titles.push(t);
            this.log(me.uid, 'title_add', target.uid, 0, { title: t });
          }
        }
        if (typeof msg.remove === 'string') {
          const t = msg.remove.toLowerCase();
          const had = titles.find(x => x.toLowerCase() === t);
          if (t === 'initiator' && eligible) { this.sql.exec('UPDATE members SET no_init = 1 WHERE uid = ?', target.uid); this.log(me.uid, 'title_remove', target.uid, 0, { title: 'Initiator' }); }
          else if (had) this.log(me.uid, 'title_remove', target.uid, 0, { title: had });
          titles = titles.filter(x => x.toLowerCase() !== t);
        }
        this.sql.exec('UPDATE members SET titles = ? WHERE uid = ?', JSON.stringify(titles), target.uid);
        const p = this.person(this.member(target.uid));
        this.broadcast({ t: 'person', p });
        return this.send(ws, { t: 'who', p });
      }

      case 'role': {
        if (me.role !== 'host') return;
        const target = this.member(msg.uid);
        if (!target || target.role === 'host' || !['mod', 'member'].includes(msg.role)) return;
        if (target.role !== msg.role) this.log(me.uid, 'role', target.uid, 0, { from: target.role, to: msg.role });
        this.sql.exec('UPDATE members SET role = ? WHERE uid = ?', msg.role, target.uid);
        this.broadcast({ t: 'person', p: this.person(this.member(target.uid)) });
        return this.send(ws, { t: 'notice', text: msg.role === 'mod' ? `${target.name} is now a moderator.` : `${target.name} is no longer a moderator.` });
      }

      case 'report': {
        const row = this.one('SELECT id FROM messages WHERE id = ?', msg.id);
        if (!row) return;
        this.sql.exec('INSERT INTO reports (msg_id, uid, reason, created) VALUES (?, ?, ?, ?)', row.id, me.uid, clean(msg.reason, 300), now);
        this.notifyMods({ t: 'reports', count: this.one('SELECT COUNT(*) AS n FROM reports WHERE resolved = 0').n });
        return this.send(ws, { t: 'notice', text: 'Thanks. Chance will take a look.' });
      }

      case 'reports': {
        if (!this.isMod(me)) return;
        const rows = this.all('SELECT r.id, r.msg_id, r.uid, r.reason, r.created FROM reports r WHERE resolved = 0 ORDER BY id DESC LIMIT 50');
        const msgs = rows.map(r => this.shape(this.one('SELECT * FROM messages WHERE id = ?', r.msg_id))).filter(Boolean);
        return this.send(ws, { t: 'reportlist', reports: rows, messages: msgs, people: this.peopleFor(msgs, rows.map(r => r.uid)) });
      }

      case 'resolve': {
        if (!this.isMod(me)) return;
        this.sql.exec('UPDATE reports SET resolved = 1 WHERE id = ?', msg.id);
        return this.notifyMods({ t: 'reports', count: this.one('SELECT COUNT(*) AS n FROM reports WHERE resolved = 0').n });
      }

      case 'history': {
        const msgs = this.page(Number(msg.before) || 0);
        return this.send(ws, { t: 'history', messages: msgs, people: this.peopleFor(msgs), done: msgs.length < PAGE });
      }

      case 'used': {
        this.useEmoji(me.uid, msg.e);
        return this.send(ws, { t: 'me', me: this.meFor(me.uid) });
      }

      case 'edit': {
        const row = this.one('SELECT * FROM messages WHERE id = ?', Number(msg.id));
        if (!row || row.deleted || row.uid !== me.uid) return;
        if (me.muted_until > now) return this.send(ws, { t: 'error', text: 'You are muted for now. Try again later.' });
        const text = clean(msg.text, MAX_TEXT, true);
        if (!text && !row.image) return;
        if (text === row.text) return;
        const link = msg.nopreview || row.image ? '' : firstLink(text);
        const old = safeObj(row.preview);
        const cached = link ? (old && old.url === link ? old : this.cachedPreview(link)) : undefined;
        this.sql.exec('UPDATE messages SET text = ?, edited = ?, mentions = ?, preview = ? WHERE id = ?', text, now, JSON.stringify(this.mentionsFrom(msg.mentions, me.uid)), cached ? JSON.stringify(cached) : '', row.id);
        if (link && cached === undefined) this.state.waitUntil(this.fillPreview(row.id, link));
        this.broadcast({ t: 'update', m: this.shape(this.one('SELECT * FROM messages WHERE id = ?', row.id)) });
        // replies quoting it show the new words
        for (const r of this.all('SELECT * FROM messages WHERE reply_to = ? AND deleted = 0', row.id)) this.broadcast({ t: 'update', m: this.shape(r) });
        return;
      }

      case 'search': {
        const q = clean(msg.q, 100);
        if (!q || q.length < 2) return this.send(ws, { t: 'results', q, scope: msg.scope, messages: [], people: {} });
        const like = '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%';
        const rows = this.all("SELECT m.* FROM messages m LEFT JOIN members p ON p.uid = m.uid WHERE m.deleted = 0 AND COALESCE(m.kind, '') = '' AND (m.text LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\') ORDER BY m.id DESC LIMIT 60", like, like);
        const msgs = rows.map(r => this.shape(r));
        return this.send(ws, { t: 'results', q, scope: msg.scope, room: 'Inner Circle Chat', messages: msgs, people: this.peopleFor(msgs) });
      }

      case 'mentions': {
        const rows = this.all("SELECT * FROM messages WHERE deleted = 0 AND mentions LIKE ? ORDER BY id DESC LIMIT 50", '%"' + me.uid + '"%');
        const msgs = rows.map(r => this.shape(r));
        return this.send(ws, { t: 'mentionlist', messages: msgs, people: this.peopleFor(msgs) });
      }

      case 'thread': {
        // the whole conversation this message belongs to
        const start = this.one('SELECT * FROM messages WHERE id = ?', Number(msg.id));
        if (!start) return this.send(ws, { t: 'notice', text: 'That message is no longer here.' });
        const seen = new Map([[start.id, start]]);
        let up = start;
        for (let i = 0; i < 50 && up.reply_to; i++) {
          up = this.one('SELECT * FROM messages WHERE id = ?', up.reply_to);
          if (!up || seen.has(up.id)) break;
          seen.set(up.id, up);
        }
        // the whole conversation: walk up to the first message, then take every reply under it, side branches included
        let root = start;
        for (const r of seen.values()) if (!r.reply_to || !seen.has(r.reply_to)) { if (r.id <= root.id) root = r; }
        let frontier = [root.id];
        while (frontier.length && seen.size < 300) {
          const next = [];
          for (const id of frontier) {
            for (const r of this.all('SELECT * FROM messages WHERE reply_to = ? ORDER BY id LIMIT 200', id)) {
              if (!seen.has(r.id)) { seen.set(r.id, r); next.push(r.id); }
            }
          }
          frontier = next;
        }
        const msgs = [...seen.values()].filter(r => !r.deleted).sort((a, b) => a.id - b.id).map(r => this.shape(r));
        if (!msgs.length) return this.send(ws, { t: 'notice', text: 'That message is no longer here.' });
        return this.send(ws, { t: 'thread', id: start.id, messages: msgs, people: this.peopleFor(msgs) });
      }

      case 'typing': {
        if (!me.profile_done) return;
        const last = this.typingAt.get(me.uid) || 0;
        if (now - last < 2500) return;
        this.typingAt.set(me.uid, now);
        return this.broadcast({ t: 'typing', uid: me.uid }, ws);
      }

      case 'who': {
        const p = this.person(this.member(msg.uid));
        if (!p) return;
        const extra = this.isMod(me) ? { muted_until: this.member(msg.uid).muted_until, source: this.member(msg.uid).source } : {};
        return this.send(ws, { t: 'who', p: { ...p, ...extra } });
      }

      case 'members': {
        const rows = this.all('SELECT * FROM members WHERE profile_done = 1 AND banned = 0 ORDER BY name COLLATE NOCASE LIMIT 500');
        const out = {}; for (const r of rows) out[r.uid] = this.person(r);
        return this.send(ws, { t: 'members', people: out, online: this.online(), quiet: !!msg.quiet });
      }

      case 'modlog': {
        if (me.role !== 'host') return;
        return this.send(ws, this.modlogFor());
      }

      case 'undo': {
        if (me.role !== 'host') return;
        const e = this.one('SELECT * FROM modlog WHERE id = ?', Number(msg.id));
        if (!e || e.undone || !UNDOABLE.includes(e.action)) return this.send(ws, this.modlogFor());
        let d = {}; try { d = JSON.parse(e.detail || '{}'); } catch (err) { /* keep empty */ }
        const target = e.target ? this.member(e.target) : null;
        let note = 'Undone.';
        if (e.action === 'delete') {
          const row = this.one('SELECT * FROM messages WHERE id = ?', e.msg_id);
          if (row && row.deleted) {
            this.sql.exec('UPDATE messages SET deleted = 0, pinned = ? WHERE id = ?', d.pinned ? 1 : 0, row.id);
            for (const r of (Array.isArray(d.reacts) ? d.reacts : [])) this.sql.exec('INSERT OR IGNORE INTO reactions (msg_id, uid, kind) VALUES (?, ?, ?)', row.id, r.uid, r.kind);
            const m = this.shape(this.one('SELECT * FROM messages WHERE id = ?', row.id));
            this.broadcast({ t: 'restore', m, people: this.peopleFor([m]) });
            if (row.reply_to) { const parent = this.one('SELECT * FROM messages WHERE id = ?', row.reply_to); if (parent) this.broadcast({ t: 'update', m: this.shape(parent) }); }
            for (const r of this.all('SELECT * FROM messages WHERE reply_to = ? AND deleted = 0', row.id)) this.broadcast({ t: 'update', m: this.shape(r) });
            const pins = this.pins(); this.broadcast({ t: 'pins', pins, people: this.peopleFor(pins) });
            note = 'Message restored.';
          }
        } else if (e.action === 'pin' || e.action === 'unpin') {
          this.sql.exec('UPDATE messages SET pinned = ? WHERE id = ? AND deleted = 0', e.action === 'pin' ? 0 : 1, e.msg_id);
          const row = this.one('SELECT * FROM messages WHERE id = ?', e.msg_id);
          if (row) this.broadcast({ t: 'update', m: this.shape(row) });
          const pins = this.pins(); this.broadcast({ t: 'pins', pins, people: this.peopleFor(pins) });
        } else if ((e.action === 'mute' || e.action === 'unmute') && target && target.role !== 'host') {
          const back = e.action === 'mute' ? (d.prev > Date.now() ? d.prev : 0) : (d.prev > Date.now() ? d.prev : 0);
          this.sql.exec('UPDATE members SET muted_until = ? WHERE uid = ?', back, target.uid);
          this.broadcast({ t: 'person', p: this.person(this.member(target.uid)) });
          note = back ? `${target.name || 'Member'} is muted again.` : `${target.name || 'Member'} can post again.`;
        } else if (e.action === 'remove' && target) {
          this.sql.exec('UPDATE members SET banned = 0 WHERE uid = ?', target.uid);
          note = `${target.name || 'Member'} can come back into the Circle.`;
        } else if (e.action === 'restore' && target && target.role !== 'host') {
          this.sql.exec('UPDATE members SET banned = 1 WHERE uid = ?', target.uid);
          this.kick(target.uid);
          note = `${target.name || 'Member'} is removed again.`;
        } else if (e.action === 'role' && target && target.role !== 'host' && ['mod', 'member'].includes(d.from)) {
          this.sql.exec('UPDATE members SET role = ? WHERE uid = ?', d.from, target.uid);
          this.broadcast({ t: 'person', p: this.person(this.member(target.uid)) });
        } else if ((e.action === 'title_add' || e.action === 'title_remove') && target && d.title) {
          const add = e.action === 'title_remove';
          if (String(d.title).toLowerCase() === 'initiator') this.sql.exec('UPDATE members SET no_init = ? WHERE uid = ?', add ? 0 : 1, target.uid);
          else {
            let titles = safeArr(target.titles).filter(x => x.toLowerCase() !== String(d.title).toLowerCase());
            if (add && titles.length < 5) titles.push(d.title);
            this.sql.exec('UPDATE members SET titles = ? WHERE uid = ?', JSON.stringify(titles), target.uid);
          }
          this.broadcast({ t: 'person', p: this.person(this.member(target.uid)) });
        } else return this.send(ws, { t: 'notice', text: 'That one cannot be undone now.' });
        this.sql.exec('UPDATE modlog SET undone = 1, undone_at = ?, undone_by = ? WHERE id = ?', Date.now(), me.uid, e.id);
        this.send(ws, { t: 'notice', text: note });
        return this.send(ws, this.modlogFor());
      }

      // the page reports messages that were on screen while the member was looking
      case 'seen': {
        if (!me.profile_done || !Array.isArray(msg.ids)) return;
        const changed = {};
        for (const id of msg.ids.slice(0, 200)) {
          if (!Number.isInteger(id)) continue;
          const row = this.one('SELECT uid, deleted FROM messages WHERE id = ?', id);
          if (!row || row.deleted || row.uid === me.uid) continue;
          const before = this.viewCount(id);
          this.sql.exec('INSERT OR IGNORE INTO views (msg_id, uid) VALUES (?, ?)', id, me.uid);
          const after = this.viewCount(id);
          if (after !== before) changed[id] = after;
        }
        if (Object.keys(changed).length) this.broadcast({ t: 'views', v: changed });
        return;
      }

      case 'away': { ws.serializeAttachment(Object.assign({}, att, { away: !!msg.on })); if (!msg.on) this.sql.exec('UPDATE members SET push_unread = 0 WHERE uid = ?', me.uid); return; }

      case 'joinalerts': {
        if (me.role !== 'host') return;
        this.sql.exec('UPDATE members SET join_alerts = ? WHERE uid = ?', msg.on ? 1 : 0, me.uid);
        return this.send(ws, { t: 'me', me: this.meFor(me.uid) });
      }

      case 'notify': {
        if (['all', 'mentions', 'none'].includes(msg.level)) this.sql.exec('UPDATE members SET notify = ? WHERE uid = ?', msg.level, me.uid);
        return;
      }

      case 'ping': return this.send(ws, { t: 'pong' });
    }
  }

  // @mentions: keep only real members, at most 20
  mentionsFrom(list, self) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const u of list) {
      if (typeof u !== 'string' || u === self || out.includes(u)) continue;
      const m = this.member(u);
      if (m && m.profile_done && !m.banned) out.push(u);
      if (out.length >= 20) break;
    }
    return out;
  }

  useEmoji(uid, e) {
    if (!isEmoji(e)) return;
    const m = this.member(uid); if (!m) return;
    const list = [e].concat(safeArr(m.recent).filter(x => x !== e)).slice(0, 24);
    this.sql.exec('UPDATE members SET recent = ? WHERE uid = ?', JSON.stringify(list), uid);
  }

  meFor(uid) {
    const m = this.member(uid);
    return { ...this.person(m), rules_ok: !!m.rules_ok, profile_done: !!m.profile_done, email: m.email, recent: safeArr(m.recent), join_alerts: m.role === 'host' ? m.join_alerts !== 0 : undefined };
  }

  notifyMods(obj) {
    for (const ws of this.state.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (!a || !a.uid) continue;
      const m = this.member(a.uid);
      if (this.isMod(m)) this.send(ws, obj);
    }
  }

  async webSocketClose(ws) { this.presence(ws); }
  async webSocketError(ws) { this.presence(ws); }
}

function clean(v, max, multiline) {
  if (typeof v !== 'string') return '';
  let s = v.replace(/\r\n?/g, '\n');
  s = multiline ? s.replace(/\n{4,}/g, '\n\n\n') : s.replace(/\s+/g, ' ');
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}

// ---------------------------------------------------------------- link previews
// The first web link in a message, unless it is one of our own episode pages (those get the episode card).
function firstLink(text) {
  const m = String(text || '').match(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/);
  if (!m) return '';
  try {
    const u = new URL(m[1]);
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) return '';
    if (/(^|\.)innerversepodcast\.com$/i.test(u.hostname) && /^\/(episodes|plus)\/[^/]+/i.test(u.pathname)) return '';
    return u.href.slice(0, 800);
  } catch (e) { return ''; }
}
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const unent = s => String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENT[e.toLowerCase()] ?? all));
const trimTo = (s, n) => { s = unent(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
const httpsUrl = (u, base) => { try { const x = new URL(unent(u).trim(), base); if (x.protocol === 'http:') x.protocol = 'https:'; return x.protocol === 'https:' ? x.href.slice(0, 800) : ''; } catch (e) { return ''; } };
function ytId(u) {
  const h = u.hostname.replace(/^(www|m|music)\./, '');
  if (h === 'youtu.be') return { id: u.pathname.slice(1).split('/')[0], vertical: false };
  if (h !== 'youtube.com' && h !== 'youtube-nocookie.com') return null;
  const sh = u.pathname.match(/^\/shorts\/([\w-]{6,})/); if (sh) return { id: sh[1], vertical: true };
  const lv = u.pathname.match(/^\/(?:live|embed)\/([\w-]{6,})/); if (lv) return { id: lv[1], vertical: false };
  const v = u.searchParams.get('v'); return v ? { id: v, vertical: false } : null;
}
const secsFrom = t => { if (!t) return 0; if (/^\d+$/.test(t)) return Number(t); const m = String(t).match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/); return m ? (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) : 0; };
async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; InnerVerseBot/1.0; +https://innerversepodcast.com)', Accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
  return r.ok ? r.json() : null;
}
async function fetchPreview(url) {
  const u = new URL(url);
  // YouTube: title, channel and thumbnail from its own oEmbed; plays right in the chat
  const yt = ytId(u);
  if (yt && /^[\w-]{6,20}$/.test(yt.id)) {
    const o = await getJson('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + yt.id)).catch(() => null);
    return {
      url, site: yt.vertical ? 'YouTube Shorts' : 'YouTube', title: trimTo(o && o.title || 'YouTube video', 200), desc: trimTo(o && o.author_name || '', 120),
      image: yt.vertical ? `https://i.ytimg.com/vi/${yt.id}/oar2.jpg` : `https://i.ytimg.com/vi/${yt.id}/hqdefault.jpg`,
      fallback: `https://i.ytimg.com/vi/${yt.id}/hqdefault.jpg`,
      video: { kind: 'youtube', id: yt.id, vertical: yt.vertical, start: secsFrom(u.searchParams.get('t') || u.searchParams.get('start')) },
    };
  }
  const host = u.hostname.replace(/^www\./, '');
  // Vimeo
  const vm = (host === 'vimeo.com' || host === 'player.vimeo.com') && u.pathname.match(/^\/(?:video\/)?(\d{5,})(?:\/([0-9a-f]{6,}))?/);
  if (vm) {
    const o = await getJson('https://vimeo.com/api/oembed.json?url=' + encodeURIComponent('https://vimeo.com/' + vm[1] + (vm[2] ? '/' + vm[2] : ''))).catch(() => null);
    const video = { kind: 'vimeo', id: vm[1], hash: vm[2] || u.searchParams.get('h') || '', vertical: !!(o && o.height > o.width) };
    if (o && o.title) return { url, site: 'Vimeo', title: trimTo(o.title, 200), desc: trimTo(o.author_name || '', 120), image: httpsUrl(o.thumbnail_url || ''), video };
    const g = await pagePreview(url).catch(() => null);
    return g ? Object.assign(g, { site: 'Vimeo', video }) : { url, site: 'Vimeo', title: 'Vimeo video', desc: '', image: '', video };
  }
  // Rumble
  if (host === 'rumble.com') {
    const o = await getJson('https://rumble.com/api/Media/oembed.json?url=' + encodeURIComponent(url)).catch(() => null);
    const src = o && String(o.html || '').match(/src="(https:\/\/rumble\.com\/embed\/[^"]+)"/);
    if (o && src) return { url, site: 'Rumble', title: trimTo(o.title, 200), desc: trimTo(o.author_name || '', 120), image: httpsUrl(o.thumbnail_url), video: { kind: 'rumble', src: src[1], vertical: o.height > o.width } };
  }
  return pagePreview(url);
}
// anything else: the page's own sharing tags (Open Graph and Twitter cards), as other apps read them
async function pagePreview(url) {
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(7000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; InnerVerseBot/1.0; +https://innerversepodcast.com) facebookexternalhit/1.1', Accept: 'text/html,application/xhtml+xml;q=0.9,image/*;q=0.8,*/*;q=0.5', 'Accept-Language': 'en' } });
  if (!r.ok) return null;
  const type = r.headers.get('Content-Type') || '';
  const base = r.url || url;
  if (/^image\//.test(type)) { try { r.body && r.body.cancel(); } catch (e) {} return { url, site: new URL(base).hostname.replace(/^www\./, ''), title: '', desc: '', image: httpsUrl(base) }; }
  if (!/html/.test(type)) { try { r.body && r.body.cancel(); } catch (e) {} return null; }
  // read at most 600 KB of the page
  const reader = r.body.getReader(); const chunks = []; let got = 0;
  while (got < 600000) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; }
  try { reader.cancel(); } catch (e) {}
  const html = new TextDecoder().decode(chunks.length === 1 ? chunks[0] : chunks.reduce((a, c) => { const t = new Uint8Array(a.length + c.length); t.set(a); t.set(c, a.length); return t; }, new Uint8Array()));
  const meta = {}; let title = '', inTitle = false;
  await new HTMLRewriter()
    .on('meta', { element(e) { const k = (e.getAttribute('property') || e.getAttribute('name') || '').toLowerCase(); const v = e.getAttribute('content'); if (k && v != null && !(k in meta)) meta[k] = v; } })
    .on('title', { element() { inTitle = true; }, text(t) { if (inTitle && title.length < 400) title += t.text; if (t.lastInTextNode) inTitle = false; } })
    .transform(new Response(html, { headers: { 'Content-Type': 'text/html' } })).text();
  const pick = (...ks) => { for (const k of ks) if (meta[k]) return meta[k]; return ''; };
  const t = trimTo(pick('og:title', 'twitter:title') || title, 200);
  const d = trimTo(pick('og:description', 'twitter:description', 'description'), 300);
  const img = httpsUrl(pick('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'), base);
  if (!t && !img) return null;
  const w = Number(meta['og:image:width'] || 0), h = Number(meta['og:image:height'] || 0);
  const big = (meta['twitter:card'] || '') === 'summary_large_image' || (w && h ? w >= h * 1.3 && w >= 400 : !!img);
  return { url, site: trimTo(pick('og:site_name') || new URL(base).hostname.replace(/^www\./, ''), 60), title: t, desc: d, image: img, big };
}

function safeObj(s) { try { const o = JSON.parse(s || 'null'); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch (e) { return null; } }
function safeArr(s) { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
