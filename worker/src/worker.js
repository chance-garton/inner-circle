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
    for (const [oldKey, emoji] of Object.entries(OLD_REACTIONS)) {
      this.sql.exec('UPDATE OR IGNORE reactions SET kind = ? WHERE kind = ?', emoji, oldKey);
      this.sql.exec('DELETE FROM reactions WHERE kind = ?', oldKey);
    }
    this.sql.exec(`CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, msg_id INTEGER, uid TEXT, reason TEXT, created INTEGER, resolved INTEGER DEFAULT 0)`);
  }

  async fetch(req) {
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
      initiator: !!(m.joined && m.joined < INITIATOR_CUTOFF), muted: m.muted_until > Date.now(),
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
      const p = this.one('SELECT id, uid, text, image, deleted FROM messages WHERE id = ?', row.reply_to);
      if (p) reply = { id: p.id, uid: p.uid, text: p.deleted ? '' : (p.text || '').slice(0, 200), image: !p.deleted && !!p.image, deleted: !!p.deleted };
    }
    return {
      id: row.id, uid: row.uid, text: row.deleted ? '' : row.text, image: row.deleted ? '' : row.image,
      reply, created: row.created, edited: !!row.edited, deleted: !!row.deleted, pinned: !!row.pinned, reacts,
      replies: this.one('SELECT COUNT(*) AS n FROM messages WHERE reply_to = ? AND deleted = 0', row.id).n,
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
    for (const m of msgs) { ids.add(m.uid); if (m.reply) ids.add(m.reply.uid); }
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
      m = this.member(who.uid);
      if (m.banned) { this.send(ws, { t: 'denied', why: 'removed' }); return ws.close(4003, 'removed'); }
      ws.serializeAttachment({ uid: who.uid, ready: !!(m.rules_ok && m.profile_done) });
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
        const interests = Array.isArray(msg.interests) ? msg.interests.map(x => clean(x, 40)).filter(Boolean).slice(0, 20) : [];
        const favorites = Array.isArray(msg.favorites) ? msg.favorites.map(x => clean(x, 120)).filter(s => /^[a-z0-9-]+$/.test(s)).slice(0, 3) : [];
        const joined = me.joined || now;
        this.sql.exec(`UPDATE members SET name = ?, avatar = ?, bio = ?, sun = ?, moon = ?, rising = ?, interests = ?, favorites = ?, joined = ?, profile_done = 1 WHERE uid = ?`,
          name, avatar, clean(msg.bio, 160), sign(msg.sun), sign(msg.moon), sign(msg.rising), JSON.stringify(interests), JSON.stringify(favorites), joined, me.uid);
        const wasReady = att.ready;
        ws.serializeAttachment({ ...att, ready: !!me.rules_ok });
        this.send(ws, { t: 'me', me: this.meFor(me.uid) });
        this.broadcast({ t: 'person', p: this.person(this.member(me.uid)) });
        if (!wasReady) this.presence();
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
        const row = this.one('INSERT INTO messages (uid, text, image, reply_to, created) VALUES (?, ?, ?, ?, ?) RETURNING *', me.uid, text, image, reply, now);
        const m = this.shape(row);
        this.broadcast({ t: 'msg', m, cid: clean(msg.cid, 40), people: this.peopleFor([m]) });
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
        this.sql.exec('UPDATE messages SET deleted = 1, pinned = 0 WHERE id = ?', row.id);
        this.sql.exec('DELETE FROM reactions WHERE msg_id = ?', row.id);
        this.broadcast({ t: 'update', m: this.shape(this.one('SELECT * FROM messages WHERE id = ?', row.id)) });
        if (row.reply_to) { const parent = this.one('SELECT * FROM messages WHERE id = ?', row.reply_to); if (parent) this.broadcast({ t: 'update', m: this.shape(parent) }); }
        return this.broadcast({ t: 'pins', pins: this.pins() });
      }

      case 'pin': {
        if (!this.isMod(me)) return;
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
        const hours = Math.min(Math.max(Number(msg.hours) || 24, 0), 24 * 30);
        this.sql.exec('UPDATE members SET muted_until = ? WHERE uid = ?', hours ? now + hours * 3600000 : 0, target.uid);
        this.broadcast({ t: 'person', p: this.person(this.member(target.uid)) });
        return this.send(ws, { t: 'notice', text: hours ? `${target.name || 'Member'} is muted for ${hours} hours.` : `${target.name || 'Member'} can post again.` });
      }

      case 'remove': {
        if (!this.isMod(me)) return;
        const target = this.member(msg.uid);
        if (!target || target.role === 'host' || (target.role === 'mod' && me.role !== 'host')) return;
        this.sql.exec('UPDATE members SET banned = ? WHERE uid = ?', msg.undo ? 0 : 1, target.uid);
        if (!msg.undo) {
          for (const s of this.state.getWebSockets()) {
            const a = s.deserializeAttachment();
            if (a && a.uid === target.uid) { this.send(s, { t: 'denied', why: 'removed' }); s.serializeAttachment(Object.assign({}, a, { ready: false })); try { s.close(4003, 'removed'); } catch (e) { /* closed */ } }
          }
          this.presence();
        }
        return this.send(ws, { t: 'notice', text: msg.undo ? 'Member restored.' : `${target.name || 'Member'} was removed from the Inner Circle.` });
      }

      case 'role': {
        if (me.role !== 'host') return;
        const target = this.member(msg.uid);
        if (!target || target.role === 'host' || !['mod', 'member'].includes(msg.role)) return;
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
        this.sql.exec('UPDATE messages SET text = ?, edited = ? WHERE id = ?', text, now, row.id);
        this.broadcast({ t: 'update', m: this.shape(this.one('SELECT * FROM messages WHERE id = ?', row.id)) });
        // replies quoting it show the new words
        for (const r of this.all('SELECT * FROM messages WHERE reply_to = ? AND deleted = 0', row.id)) this.broadcast({ t: 'update', m: this.shape(r) });
        return;
      }

      case 'search': {
        const q = clean(msg.q, 100);
        if (!q || q.length < 2) return this.send(ws, { t: 'results', q, scope: msg.scope, messages: [], people: {} });
        const like = '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%';
        const rows = this.all("SELECT m.* FROM messages m LEFT JOIN members p ON p.uid = m.uid WHERE m.deleted = 0 AND (m.text LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\') ORDER BY m.id DESC LIMIT 60", like, like);
        const msgs = rows.map(r => this.shape(r));
        return this.send(ws, { t: 'results', q, scope: msg.scope, room: 'Inner Circle Chat', messages: msgs, people: this.peopleFor(msgs) });
      }

      case 'thread': {
        // the message, everything it replies to, and every reply beneath it
        const start = this.one('SELECT * FROM messages WHERE id = ?', Number(msg.id));
        if (!start) return this.send(ws, { t: 'notice', text: 'That message is no longer here.' });
        const seen = new Map([[start.id, start]]);
        let up = start;
        for (let i = 0; i < 50 && up.reply_to; i++) {
          up = this.one('SELECT * FROM messages WHERE id = ?', up.reply_to);
          if (!up || seen.has(up.id)) break;
          seen.set(up.id, up);
        }
        let frontier = [start.id];
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
        return this.send(ws, { t: 'members', people: out, online: this.online() });
      }

      case 'ping': return this.send(ws, { t: 'pong' });
    }
  }

  useEmoji(uid, e) {
    if (!isEmoji(e)) return;
    const m = this.member(uid); if (!m) return;
    const list = [e].concat(safeArr(m.recent).filter(x => x !== e)).slice(0, 24);
    this.sql.exec('UPDATE members SET recent = ? WHERE uid = ?', JSON.stringify(list), uid);
  }

  meFor(uid) {
    const m = this.member(uid);
    return { ...this.person(m), rules_ok: !!m.rules_ok, profile_done: !!m.profile_done, email: m.email, recent: safeArr(m.recent) };
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

function safeArr(s) { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
