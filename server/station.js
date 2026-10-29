import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { FileDocs, typeFor } from './docs.js';
import { Auth, RANK, hashPassword, checkPassword } from './auth.js';

/**
 * Base stations: a computer at an event (e.g. your laptop) linked to the website.
 *
 * The website is the one home for accounts and data. A base station signs in with a website
 * account once (pairing) and from then on:
 *   - uses the website's organizations (those its account is an admin of): people, photos,
 *     schedules, dashboards, gear, comms… changes go both ways;
 *   - keeps a copy, so the event carries on with no internet and catches up afterwards;
 *   - signs people in with their website accounts (and, offline, those who signed in on it before);
 *   - runs the gear and the in-room screens itself, like a host computer always has.
 *
 * Website side: StationHub (pairing, /station-ws). Base station side: StationLink (the connection),
 * StationDocs (data, see docs.js for the interface) and StationAuth (sign-in).
 *
 * Messages over /station-ws are JSON. Requests carry an id and get { t: 'reply', id, ok, data | error };
 * the website also pushes 'changed', 'fileChanged', 'team' and 'orgs' to stations.
 */

const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const orgOf = (key) => /^orgs\/([^/]+)\//.exec(key)?.[1] || null;
const MAX_FILE = 15 * 1024 * 1024;

// ============================================================================ website

export class StationHub extends EventEmitter {
  constructor({ docs, auth, orgs }) {
    super();
    this.docs = docs;
    this.auth = auth;
    this.orgs = orgs;
    this.key = 'stations.json';
    this.conns = new Map(); // ws -> { station, orgs: Set }
    this.applying = null; // the connection whose change is being saved (not echoed back to it)
    this.loginTries = new Map();
    docs.on('written', (w) => this.written(w));
    docs.on('fileWritten', (w) => this.fileWritten(w));
    docs.on('external', (key) => this.written({ key }));
  }

  get data() { return this.docs.get(this.key) || { stations: [] }; }

  save(data) { this.docs.put(this.key, data, { secret: true }); }

  /** Sign in a base station with a website account: returns its token (shown once). */
  pair({ username, password, name, ip = '' }) {
    const u = this.auth.check(username, password, ip);
    const token = crypto.randomBytes(32).toString('base64url');
    const st = { id: crypto.randomUUID(), userId: u.id, name: String(name || 'Base station').trim().slice(0, 60) || 'Base station', tokenHash: sha(token), createdAt: new Date().toISOString(), lastSeen: null };
    const data = this.data;
    data.stations = [...data.stations, st];
    this.save(data);
    return { token, station: { id: st.id, name: st.name }, user: { name: u.name, username: u.username } };
  }

  byToken(token) {
    if (!token) return null;
    const h = Buffer.from(sha(token));
    const st = this.data.stations.find((s) => { const b = Buffer.from(s.tokenHash); return b.length === h.length && crypto.timingSafeEqual(b, h); });
    if (!st) return null;
    const user = this.auth.user(st.userId);
    return user ? { ...st, user } : null;
  }

  /** The base stations an account paired (for Settings). */
  list(userId) {
    const online = new Set([...this.conns.values()].map((c) => c.station.id));
    return this.data.stations.filter((s) => s.userId === userId).map(({ tokenHash, ...s }) => ({ ...s, online: online.has(s.id) }));
  }

  remove(userId, id) {
    const data = this.data;
    const st = data.stations.find((s) => s.id === id && s.userId === userId);
    if (!st) throw new Error('Unknown base station');
    data.stations = data.stations.filter((s) => s.id !== id);
    this.save(data);
    for (const [ws, c] of this.conns) if (c.station.id === id) ws.close(4001, 'Unlinked');
  }

  /** Organizations a station's account may run: the ones it's an admin of. */
  orgsFor(user) {
    return this.orgs.data.orgs.filter((o) => this.auth.rank(user, o.id) >= RANK.admin && (!user.owner || this.auth.memberOf(user, o.id))).map((o) => ({ id: o.id, name: o.name }));
  }

  /** Base stations connected for an organization right now (for the website's pages). */
  connectedFor(orgId) {
    return [...this.conns.values()].filter((c) => c.orgs.has(orgId)).map((c) => ({ id: c.station.id, name: c.station.name }));
  }

  team(orgIds) {
    return this.auth.data.users
      .filter((u) => orgIds.some((id) => this.auth.memberOf(u, id)))
      .map((u) => ({ id: u.id, name: u.name, username: u.username, roles: Object.fromEntries(Object.entries(u.roles || {}).filter(([id]) => orgIds.includes(id))) }));
  }

  attach(ws, station) {
    const conn = { station, orgs: new Set() };
    this.conns.set(ws, conn);
    const data = this.data;
    const rec = data.stations.find((s) => s.id === station.id);
    if (rec) { rec.lastSeen = new Date().toISOString(); this.save(data); }
    console.log(`[station] ${station.name} (${station.user.name}) connected`);
    this.emit('change');
    const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      try {
        const data = await this.handle(conn, msg);
        send({ t: 'reply', id: msg.id, ok: true, data });
      } catch (e) {
        send({ t: 'reply', id: msg.id, ok: false, error: e.message });
      }
    });
    ws.on('close', () => {
      this.conns.delete(ws);
      console.log(`[station] ${station.name} disconnected`);
      this.emit('change');
    });
    conn.send = send;
  }

  /** Is this key in an organization the station opened (and may still run)? */
  allowed(conn, key) {
    const org = orgOf(key);
    if (!org || !conn.orgs.has(org)) throw new Error('Not part of this base station\'s organizations');
    if (this.auth.rank(this.auth.user(conn.station.userId), org) < RANK.admin) throw new Error('This account is no longer an admin of that organization');
    return org;
  }

  async handle(conn, msg) {
    const user = this.auth.user(conn.station.userId);
    if (!user) throw new Error('This account was removed');
    switch (msg.t) {
      case 'orgs':
        return this.orgsFor(user);
      case 'open': {
        const mine = new Set(this.orgsFor(user).map((o) => o.id));
        const ids = (msg.orgIds || []).filter((id) => mine.has(id));
        conn.orgs = new Set(ids);
        const snap = {};
        for (const id of ids) {
          const docs = {};
          const files = {};
          for (const k of this.docs.list(`orgs/${id}/`)) {
            if (k.endsWith('.json')) { const v = this.docs.get(k); if (v !== undefined) docs[k] = JSON.stringify(v); } else files[k] = { type: typeFor(k) };
          }
          snap[id] = { docs, files };
        }
        this.emit('change');
        return { snap, team: this.team(ids) };
      }
      case 'put': {
        const org = this.allowed(conn, msg.key);
        if (msg.key === `orgs/${org}/tv.json`) return null; // TV link keys belong to the website
        const value = JSON.parse(msg.json);
        this.applying = conn;
        try { this.docs.apply(msg.key, value); } finally { this.applying = null; }
        // The organization's name lives in the website's list too.
        if (msg.key === `orgs/${org}/settings.json`) {
          const entry = this.orgs.data.orgs.find((o) => o.id === org);
          const name = value?.org?.name;
          if (entry && name && entry.name !== name) { entry.name = name; this.orgs.save(); }
        }
        return null;
      }
      case 'remove': {
        const org = this.allowed(conn, `${msg.prefix}/`);
        if (msg.prefix.replace(/\/+$/, '') === `orgs/${org}`) throw new Error('Delete organizations on the website');
        this.applying = conn;
        try { await this.docs.remove(msg.prefix); } finally { this.applying = null; }
        return null;
      }
      case 'getFile': {
        this.allowed(conn, msg.key);
        const f = await this.docs.getFile(msg.key);
        return f ? { type: f.type, data: f.data.toString('base64') } : null;
      }
      case 'putFile': {
        this.allowed(conn, msg.key);
        const buf = Buffer.from(String(msg.data || ''), 'base64');
        if (buf.length > MAX_FILE) throw new Error('That file is too big (15 MB at most)');
        this.applying = conn;
        try { await this.docs.putFile(msg.key, buf, msg.type || typeFor(msg.key)); } finally { this.applying = null; }
        return null;
      }
      case 'removeFile': {
        this.allowed(conn, msg.key);
        this.applying = conn;
        try { await this.docs.removeFile(msg.key); } finally { this.applying = null; }
        return null;
      }
      case 'login': {
        // People signing in at the event: checked against their website account.
        const ip = `station:${conn.station.id}`;
        const u = this.auth.check(msg.username, msg.password, ip);
        const roles = Object.fromEntries(Object.entries(u.roles || {}).filter(([id]) => conn.orgs.has(id)));
        if (!Object.keys(roles).length && !u.owner) throw new Error('This account isn\'t on the team of the organization this base station runs');
        if (u.owner) for (const id of conn.orgs) roles[id] ||= 'admin';
        return { id: u.id, name: u.name, username: u.username, roles };
      }
      default:
        throw new Error(`Unknown request "${msg.t}"`);
    }
  }

  /** A change saved on the website (or by another station): pass it to the stations running that organization. */
  written({ key, prefix, removed }) {
    if (key === 'users.json') return this.sendTeams();
    if (key === 'orgs.json') return this.sendOrgs();
    const org = orgOf(key || `${prefix}/`);
    if (!org) return;
    for (const [, c] of this.conns) {
      if (c === this.applying || !c.orgs.has(org)) continue;
      if (removed) c.send({ t: 'removed', prefix });
      else { const v = this.docs.get(key); c.send({ t: 'changed', key, json: v === undefined ? null : JSON.stringify(v) }); }
    }
  }

  fileWritten({ key, info }) {
    const org = orgOf(key);
    if (!org) return;
    for (const [, c] of this.conns) if (c !== this.applying && c.orgs.has(org)) c.send({ t: 'fileChanged', key, info });
  }

  sendTeams() {
    for (const [, c] of this.conns) c.send({ t: 'team', users: this.team([...c.orgs]) });
  }

  sendOrgs() {
    for (const [, c] of this.conns) {
      const user = this.auth.user(c.station.userId);
      if (user) c.send({ t: 'orgs', orgs: this.orgsFor(user) });
    }
  }
}

// ============================================================================ base station

/** The base station's connection to the website: reconnects by itself; call() is a request. */
export class StationLink extends EventEmitter {
  constructor({ url, token }) {
    super();
    this.url = String(url).replace(/\/+$/, '');
    this.token = token;
    this.online = false;
    this.calls = new Map();
    this.next = 1;
    this.wait = 1000;
    this.error = null;
    this.setMaxListeners(0);
  }

  start() {
    if (this.stopped) return;
    const wsUrl = `${this.url.replace(/^http/, 'ws')}/station-ws`;
    const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${this.token}` }, maxPayload: 32 * 1024 * 1024, handshakeTimeout: 15000 });
    this.ws = ws;
    ws.on('open', () => {
      this.online = true;
      this.error = null;
      this.wait = 1000;
      console.log(`[station] connected to ${this.url}`);
      this.emit('online');
    });
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.t === 'reply') {
        const c = this.calls.get(m.id);
        if (!c) return;
        this.calls.delete(m.id);
        clearTimeout(c.timer);
        if (m.ok) c.resolve(m.data); else c.reject(Object.assign(new Error(m.error), { remote: true }));
      } else this.emit('push', m);
    });
    ws.on('unexpected-response', (_req, res) => {
      this.error = res.statusCode === 401 ? 'The website no longer accepts this base station. Link it again in Settings.' : `The website answered ${res.statusCode}`;
      if (res.statusCode === 401) this.revoked = true;
      this.emit('status');
    });
    ws.on('error', (e) => { if (!this.error) this.error = e.message; });
    ws.on('close', (code) => {
      const was = this.online;
      this.online = false;
      for (const [, c] of this.calls) { clearTimeout(c.timer); c.reject(new Error('Not connected to the website')); }
      this.calls.clear();
      if (code === 4001) { this.revoked = true; this.error = 'This base station was unlinked on the website. Link it again in Settings.'; }
      if (was) { console.log('[station] lost the website; carrying on with this computer\'s copy'); this.emit('offline'); }
      this.emit('status');
      if (this.stopped) return;
      this.retry = setTimeout(() => this.start(), this.revoked ? 60000 : this.wait);
      this.wait = Math.min(this.wait * 2, 30000);
    });
  }

  call(t, payload = {}, { timeout = 30000 } = {}) {
    if (!this.online) return Promise.reject(new Error('Not connected to the website'));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.calls.delete(id); reject(new Error('The website didn\'t answer')); }, timeout);
      this.calls.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...payload, t, id }));
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.ws?.close();
  }
}

/**
 * Data on a base station. Organizations (orgs.json and everything under orgs/<id>/) come from
 * the website and are kept in a copy here (station/copy.json, station/files/); changes are sent
 * in order, and wait in the copy while offline. Everything else is this computer's own (station/local/).
 */
export class StationDocs extends EventEmitter {
  constructor({ dir, link }) {
    super();
    this.kind = 'station';
    this.dir = dir;
    this.link = link;
    this.local = FileDocs.at(path.join(dir, 'local'));
    this.copyFile = path.join(dir, 'copy.json');
    this.filesDir = path.join(dir, 'files');
    this.orgList = []; // [{ id, name }] from the website
    this.cache = new Map(); // key -> JSON text (orgs/…)
    this.fileIndex = new Map(); // key -> { type }
    this.queue = []; // changes not on the website yet
    this.watchers = new Map();
    this.busy = false;
    this.idle = [];
    this.lastSync = null;
    this.error = null;
    this.setMaxListeners(0);
  }

  // ---- the copy on this computer

  load() {
    try {
      const c = JSON.parse(fs.readFileSync(this.copyFile, 'utf8'));
      this.orgList = c.orgs || [];
      this.cache = new Map(Object.entries(c.docs || {}));
      this.fileIndex = new Map(Object.entries(c.files || {}));
      this.queue = c.queue || [];
      this.lastSync = c.lastSync || null;
    } catch { /* first start: nothing yet */ }
    this.link.on('online', () => this.sync().catch((e) => { this.error = e.message; console.error(`[station] sync: ${e.message}`); }));
    this.link.on('push', (m) => this.pushed(m));
    this.link.on('status', () => this.emit('status'));
  }

  saveCopy() {
    clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => this.writeCopy(), 500);
  }

  writeCopy() {
    this.copyTimer = null;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const body = { url: this.link.url, orgs: this.orgList, docs: Object.fromEntries(this.cache), files: Object.fromEntries(this.fileIndex), queue: this.queue, lastSync: this.lastSync };
      fs.writeFileSync(`${this.copyFile}.tmp`, JSON.stringify(body), { mode: 0o600 });
      fs.renameSync(`${this.copyFile}.tmp`, this.copyFile);
    } catch (e) { console.error(`[station] couldn't save the copy: ${e.message}`); }
  }

  fileOnDisk(key) { return path.join(this.filesDir, ...key.split('/')); }

  // ---- catching up with the website

  async sync() {
    const orgs = await this.link.call('orgs');
    const listChanged = JSON.stringify(orgs) !== JSON.stringify(this.orgList);
    this.orgList = orgs;
    const { snap, team } = await this.link.call('open', { orgIds: orgs.map((o) => o.id) });
    this.emit('team', team);
    const pendingKeys = new Set(this.queue.filter((q) => q.op === 'put').map((q) => q.key));
    const pendingFiles = new Set(this.queue.filter((q) => q.op === 'putFile' || q.op === 'removeFile').map((q) => q.key));
    const changed = [];
    const ids = new Set(orgs.map((o) => o.id));
    // Organizations this account no longer runs: forget them (unless changes are waiting).
    for (const k of [...this.cache.keys()]) if (!ids.has(orgOf(k)) && !pendingKeys.has(k)) { this.cache.delete(k); changed.push(k); }
    for (const [id, s] of Object.entries(snap)) {
      const prefix = `orgs/${id}/`;
      for (const [k, json] of Object.entries(s.docs)) {
        if (pendingKeys.has(k) || this.cache.get(k) === json) continue;
        this.cache.set(k, json);
        changed.push(k);
      }
      for (const k of [...this.cache.keys()]) if (k.startsWith(prefix) && !(k in s.docs) && !pendingKeys.has(k)) { this.cache.delete(k); changed.push(k); }
      for (const [k, info] of Object.entries(s.files)) if (!pendingFiles.has(k)) this.fileIndex.set(k, info);
      for (const k of [...this.fileIndex.keys()]) if (k.startsWith(prefix) && !(k in s.files) && !pendingFiles.has(k)) { this.fileIndex.delete(k); fs.rmSync(this.fileOnDisk(k), { force: true }); }
    }
    this.lastSync = new Date().toISOString();
    this.error = null;
    this.saveCopy();
    if (listChanged) this.tell('orgs.json');
    for (const k of changed) this.tell(k);
    this.kick();
    this.emit('synced');
    this.emit('status');
  }

  pushed(m) {
    const waiting = (k) => this.queue.some((q) => q.key === k);
    if (m.t === 'changed') {
      if (waiting(m.key)) return; // ours is on its way
      if (m.json === null) this.cache.delete(m.key); else if (this.cache.get(m.key) === m.json) return; else this.cache.set(m.key, m.json);
      this.saveCopy();
      this.tell(m.key);
    } else if (m.t === 'removed') {
      for (const k of [...this.cache.keys()]) if (k === m.prefix || k.startsWith(`${m.prefix}/`)) { this.cache.delete(k); this.tell(k); }
      this.saveCopy();
    } else if (m.t === 'fileChanged') {
      if (waiting(m.key)) return;
      if (m.info) this.fileIndex.set(m.key, m.info); else this.fileIndex.delete(m.key);
      fs.rmSync(this.fileOnDisk(m.key), { force: true }); // fetched again when needed
      this.saveCopy();
    } else if (m.t === 'team') {
      this.emit('team', m.users);
    } else if (m.t === 'orgs') {
      // New or removed organizations: open the new list.
      this.sync().catch((e) => console.error(`[station] sync: ${e.message}`));
    }
  }

  // ---- reading and writing (same as FileDocs / MongoDocs)

  isOrg(key) { return key === 'orgs.json' || key.startsWith('orgs/'); }

  get(key) {
    if (key === 'orgs.json') return { orgs: this.orgList };
    if (!this.isOrg(key)) return this.local.get(key);
    const json = this.cache.get(key);
    if (json === undefined) return undefined;
    try { return JSON.parse(json); } catch { return undefined; }
  }

  has(key) { return this.isOrg(key) ? this.cache.has(key) || this.fileIndex.has(key) || key === 'orgs.json' : this.local.has(key); }

  put(key, data, opts) {
    if (key === 'orgs.json') return; // the list of organizations belongs to the website
    if (!this.isOrg(key)) return this.local.put(key, data, opts);
    const json = JSON.stringify(data);
    this.cache.set(key, json);
    const last = this.queue[this.queue.length - 1];
    const started = this.busy && this.queue.length === 1;
    if (last && last.op === 'put' && last.key === key && !started) last.json = json;
    else this.queue.push({ op: 'put', key, json });
    this.saveCopy();
    this.kick();
    this.emit('written', { key });
  }

  list(prefix = '') {
    if (!prefix.startsWith('orgs') && prefix !== '') return this.local.list(prefix);
    const mine = [...new Set([...this.cache.keys(), ...this.fileIndex.keys()])].filter((k) => k.startsWith(prefix));
    return [...mine, ...(prefix === '' ? this.local.list('') : [])].sort();
  }

  remove(prefix) {
    const p = prefix.replace(/\/+$/, '');
    if (!this.isOrg(`${p}/`)) return this.local.remove(p);
    for (const k of [...this.cache.keys()]) if (k === p || k.startsWith(`${p}/`)) this.cache.delete(k);
    for (const k of [...this.fileIndex.keys()]) if (k.startsWith(`${p}/`)) { this.fileIndex.delete(k); fs.rmSync(this.fileOnDisk(k), { force: true }); }
    this.queue.push({ op: 'remove', prefix: p });
    this.saveCopy();
    this.kick();
    return Promise.resolve();
  }

  async getFile(key) {
    if (!this.isOrg(key)) return this.local.getFile(key);
    const info = this.fileIndex.get(key);
    if (!info) return null;
    try { return { data: await fs.promises.readFile(this.fileOnDisk(key)), type: info.type || typeFor(key) }; } catch { /* not here yet */ }
    if (!this.link.online) return null;
    try {
      const f = await this.link.call('getFile', { key });
      if (!f) return null;
      const data = Buffer.from(f.data, 'base64');
      await fs.promises.mkdir(path.dirname(this.fileOnDisk(key)), { recursive: true });
      await fs.promises.writeFile(this.fileOnDisk(key), data);
      return { data, type: f.type || info.type || typeFor(key) };
    } catch { return null; }
  }

  async putFile(key, data, type = typeFor(key)) {
    if (!this.isOrg(key)) return this.local.putFile(key, data, type);
    const buf = Buffer.from(data);
    if (buf.length > MAX_FILE) throw new Error('That file is too big (15 MB at most)');
    await fs.promises.mkdir(path.dirname(this.fileOnDisk(key)), { recursive: true });
    await fs.promises.writeFile(this.fileOnDisk(key), buf);
    this.fileIndex.set(key, { type });
    this.queue.push({ op: 'putFile', key, type });
    this.saveCopy();
    this.kick();
  }

  async removeFile(key) {
    if (!this.isOrg(key)) return this.local.removeFile(key);
    this.fileIndex.delete(key);
    await fs.promises.rm(this.fileOnDisk(key), { force: true });
    this.queue.push({ op: 'removeFile', key });
    this.saveCopy();
    this.kick();
  }

  /** Send waiting changes to the website, in order; when offline they wait in the copy. */
  async kick() {
    if (this.busy || !this.link.online) return;
    this.busy = true;
    while (this.queue.length && this.link.online) {
      const q = this.queue[0];
      try {
        if (q.op === 'put') await this.link.call('put', { key: q.key, json: q.json });
        else if (q.op === 'remove') await this.link.call('remove', { prefix: q.prefix });
        else if (q.op === 'removeFile') await this.link.call('removeFile', { key: q.key });
        else if (q.op === 'putFile') {
          let data = null;
          try { data = await fs.promises.readFile(this.fileOnDisk(q.key)); } catch { /* removed since */ }
          if (data) await this.link.call('putFile', { key: q.key, type: q.type, data: data.toString('base64') }, { timeout: 120000 });
        }
        this.queue.shift();
        this.saveCopy();
      } catch (e) {
        if (!e.remote) break; // offline: try again once connected
        console.error(`[station] the website refused a change (${q.key || q.prefix}): ${e.message}`);
        this.error = e.message;
        this.queue.shift(); // it'll never be accepted; don't block the rest
        this.saveCopy();
      }
    }
    this.busy = false;
    if (!this.queue.length || !this.link.online) for (const r of this.idle.splice(0)) r();
    this.emit('status');
  }

  watch(key, fn) {
    if (!this.isOrg(key)) return this.local.watch(key, fn);
    if (!this.watchers.has(key)) this.watchers.set(key, new Set());
    this.watchers.get(key).add(fn);
    return () => this.watchers.get(key)?.delete(fn);
  }

  tell(key) {
    this.emit('external', key);
    for (const fn of [...(this.watchers.get(key) || [])]) {
      try { fn(this.get(key)); } catch (e) { console.error(`[station] ${key}: ${e.message}`); }
    }
  }

  flush() {
    if (!this.queue.length || !this.link.online) return Promise.resolve();
    return new Promise((r) => { this.idle.push(r); this.kick(); });
  }

  async close() {
    await Promise.race([this.flush(), new Promise((r) => setTimeout(r, 5000))]);
    if (this.copyTimer) { clearTimeout(this.copyTimer); this.writeCopy(); }
    this.link.stop();
  }

  status() {
    return {
      kind: 'station', where: this.link.url, online: this.link.online, pending: this.queue.length, lastSync: this.lastSync,
      offline: !this.link.online, error: this.link.error || this.error,
    };
  }
}

/**
 * Sign-in on a base station: website accounts. Online, the website checks the password; this
 * computer remembers (as a hash) the people who signed in here, so they can sign in offline too.
 * Accounts are managed on the website.
 */
export class StationAuth extends Auth {
  constructor(target, { link, docs }) {
    super(target);
    this.link = link;
    this.team = null;
    docs.on('team', (users) => this.setTeam(users));
  }

  get enabled() { return true; }

  /** The website's team list: names and roles; keep the offline passwords of those still on it. */
  setTeam(users) {
    const known = new Map(this.data.users.map((u) => [u.id, u]));
    this.data.users = users.map((u) => ({
      id: u.id, name: u.name, username: u.username, key: String(u.username).trim().toLowerCase(), roles: u.roles, owner: false,
      pass: known.get(u.id)?.pass || null, createdAt: known.get(u.id)?.createdAt || new Date().toISOString(), lastSeen: known.get(u.id)?.lastSeen || null,
    }));
    this.data.invites = [];
    this.save();
  }

  async login(username, password, ip = '') {
    if (this.tooMany(ip)) throw new Error('Too many wrong tries. Wait 10 minutes and try again.');
    if (this.link.online) {
      let w;
      try { w = await this.link.call('login', { username, password }); } catch (e) {
        if (!e.remote) return this.offlineLogin(username, password, ip);
        this.failed(ip);
        throw e;
      }
      let u = this.user(w.id);
      if (!u) { u = { id: w.id, createdAt: new Date().toISOString() }; this.data.users.push(u); }
      Object.assign(u, { name: w.name, username: w.username, key: String(w.username).trim().toLowerCase(), roles: w.roles, owner: false, pass: hashPassword(String(password)) });
      this.save();
      return this.startSession(u);
    }
    return this.offlineLogin(username, password, ip);
  }

  offlineLogin(username, password, ip) {
    const u = this.byName(username);
    if (!u?.pass) throw new Error('Can\'t reach the website to check this account. Sign in once while online, or ask someone who has.');
    if (!checkPassword(u.pass, password)) { this.failed(ip); throw new Error('That email/username or password is not right'); }
    return this.startSession(u);
  }

  createOwner() { throw new Error('Accounts are managed on the website'); }
  create() { throw new Error('Accounts are managed on the website'); }
}

/** Is this data folder linked to a website? Returns { url, token, name, user } or null. */
export function stationConfig(dataDir) {
  const c = FileDocs.at(dataDir).get('station.json');
  return c?.url && c?.token ? c : null;
}

export function saveStationConfig(dataDir, conf) {
  const local = FileDocs.at(dataDir);
  if (conf) local.put('station.json', conf, { secret: true });
  else local.remove('station.json');
}
