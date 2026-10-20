import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

/**
 * Where everything is saved: a folder on this computer (the default) or a MongoDB database
 * (e.g. MongoDB Atlas), so the setup lives in the cloud and any host computer can use it.
 *
 * Both keep the same layout, named like the files they used to be:
 *   documents  "orgs.json", "users.json", "orgs/<id>/greenroom.json", …   (JSON)
 *   files      "orgs/<id>/uploads/<photo>.jpg", "orgs/<id>/logo.png"      (photos, logos)
 *
 * Reads are instant (documents are kept in memory); writes are saved in the background, in
 * order, and retried if the connection drops. watch(key, fn) tells a store when another
 * computer (or the website) changed one of its documents.
 *
 * Machine-specific things (HTTPS certificate, Cloudflare connector, logs, this computer's
 * name and active organization) always stay in the local folder. With MongoDB, the folder
 * also keeps a copy of everything (cloud-copy/) so the dashboard still starts without internet.
 */
export const LOCAL_ONLY = /^(tls|bin|logs|cloud-copy)\/|^(tunnel|computer|database|host)\.json$|\.tmp$/;
const isDoc = (key) => key.endsWith('.json');
const cleanKey = (key) => {
  const k = String(key).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!k || k.split('/').some((p) => p === '..' || p === '.')) throw new Error(`Bad storage key "${key}"`);
  return k;
};
const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.heic': 'image/heic', '.heif': 'image/heif', '.svg': 'image/svg+xml' };
export const typeFor = (key) => TYPES[path.extname(key).toLowerCase()] || 'application/octet-stream';

/** A store's place: a data folder (older code and tests) or { docs, prefix }. */
export function place(target, name) {
  if (typeof target === 'string') return { docs: FileDocs.at(target), key: name };
  return { docs: target.docs, key: `${target.prefix || ''}${name}` };
}

// ------------------------------------------------------------------------------ files

const folders = new Map();

export class FileDocs extends EventEmitter {
  /** One FileDocs per folder, so every store in a process shares it. */
  static at(root) {
    const r = path.resolve(root);
    if (!folders.has(r)) folders.set(r, new FileDocs(r));
    return folders.get(r);
  }

  constructor(root) {
    super();
    this.root = path.resolve(root);
    this.kind = 'files';
  }

  file(key) { return path.join(this.root, ...cleanKey(key).split('/')); }

  get(key) {
    try { return JSON.parse(fs.readFileSync(this.file(key), 'utf8')); } catch (e) {
      if (e.code !== 'ENOENT') console.error(`[data] could not read ${key}: ${e.message}`);
      return undefined;
    }
  }

  has(key) { return fs.existsSync(this.file(key)); }

  put(key, data, { secret = false } = {}) {
    const f = this.file(key);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(data, null, 2), secret ? { mode: 0o600 } : undefined);
    fs.renameSync(`${f}.tmp`, f);
  }

  /** Every document and file whose key starts with prefix ("orgs/grace/"). */
  list(prefix = '') {
    const out = [];
    const walk = (dir, rel) => {
      let items;
      try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const it of items) {
        const k = rel ? `${rel}/${it.name}` : it.name;
        if (it.isDirectory()) walk(path.join(dir, it.name), k);
        else if (!k.endsWith('.tmp')) out.push(k);
      }
    };
    const dir = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : '';
    walk(dir ? this.file(dir) : this.root, dir);
    return out.filter((k) => k.startsWith(prefix)).sort();
  }

  remove(prefix) {
    const p = cleanKey(prefix).replace(/\/+$/, '');
    fs.rmSync(this.file(p), { recursive: true, force: true });
  }

  async getFile(key) {
    try { return { data: await fs.promises.readFile(this.file(key)), type: typeFor(key) }; } catch { return null; }
  }

  async putFile(key, data) {
    const f = this.file(key);
    await fs.promises.mkdir(path.dirname(f), { recursive: true });
    await fs.promises.writeFile(f, data);
  }

  async removeFile(key) { await fs.promises.rm(this.file(key), { force: true }); }

  watch() { return () => {}; }
  async flush() {}
  async close() {}
  status() { return { kind: 'files', where: this.root, pending: 0, error: null }; }
}

// ------------------------------------------------------------------------------ MongoDB

/** Default database name when the connection string doesn't name one. */
const DB_NAME = 'wavs';

/** "mongodb+srv://user:pw@cluster0.abcd.mongodb.net/x" → "cluster0.abcd.mongodb.net" (no password). */
export function mongoHost(uri) {
  const m = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/.exec(String(uri || '').trim());
  return m ? m[1] : null;
}

/**
 * MongoDB, with a copy on this computer (mirrorDir) so a service keeps running when the
 * internet drops: it starts from the copy, saves changes here, and catches up once it's back.
 */
export class MongoDocs extends EventEmitter {
  /**
   * Connect and load every document. With mirrorDir and offlineOk, a computer that can't reach
   * the database starts from its own copy instead and keeps trying in the background.
   */
  static async connect(uri, { dbName, timeoutMs = 10000, mirrorDir = null, offlineOk = false } = {}) {
    if (!mongoHost(uri)) throw new Error('That doesn\'t look like a MongoDB connection string (it starts with mongodb+srv:// or mongodb://)');
    let MongoClient;
    try { ({ MongoClient } = await import('mongodb')); } catch {
      throw new Error('The MongoDB driver isn\'t installed. Run "npm install" in the dashboard folder.');
    }
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: timeoutMs, appName: 'wavs-dashboard' });
    const fromUri = client.options?.dbName;
    const db = client.db(dbName || (fromUri && fromUri !== 'test' ? fromUri : DB_NAME));
    const docs = new MongoDocs(client, db, uri, mirrorDir);
    try {
      await client.connect();
      await docs.load();
    } catch (e) {
      if (!offlineOk || !docs.loadMirror()) {
        await client.close().catch(() => {});
        throw new Error(friendlyMongoError(e));
      }
      console.warn(`[data] can't reach MongoDB (${friendlyMongoError(e)}); using this computer's copy until it's back`);
      docs.offline = true;
      docs.reconnectLater();
      return docs;
    }
    docs.saveMirror();
    docs.follow();
    return docs;
  }

  constructor(client, db, uri, mirrorDir = null) {
    super();
    this.kind = 'mongodb';
    this.client = client;
    this.db = db;
    this.host = mongoHost(uri);
    this.mirrorDir = mirrorDir;
    this.docsCol = db.collection('docs');
    this.filesCol = db.collection('files');
    this.writer = crypto.randomUUID(); // tells our own changes apart from everyone else's
    this.cache = new Map(); // key -> JSON text
    this.fileIndex = new Map(); // key -> { type, size }
    this.fileCache = new Map(); // key -> { data, type } (recently used photos)
    this.fileCacheBytes = 0;
    this.queue = []; // writes, in order
    this.latest = new Map(); // key -> JSON text waiting to be written
    this.busy = false;
    this.offline = false;
    this.error = null;
    this.watchers = new Map(); // key -> Set(fn)
    this.streams = [];
    this.idle = [];
    this.setMaxListeners(0);
  }

  async load() {
    const cache = new Map();
    const index = new Map();
    for await (const d of this.docsCol.find({}, { projection: { json: 1 } })) cache.set(d._id, d.json);
    for await (const f of this.filesCol.find({}, { projection: { type: 1, size: 1 } })) index.set(f._id, { type: f.type, size: f.size });
    // Changes made here and not saved yet win over what's in the database.
    for (const [k, json] of this.latest) cache.set(k, json);
    for (const it of this.queue) if (it.op === 'putFile') index.set(it.key, { type: it.type, size: it.data.length });
    const changed = [...new Set([...cache.keys(), ...this.cache.keys()])].filter((k) => cache.get(k) !== this.cache.get(k));
    this.cache = cache;
    this.fileIndex = index;
    return changed;
  }

  // ---- the copy on this computer

  mirrorFile(name) { return this.mirrorDir && path.join(this.mirrorDir, name); }

  loadMirror() {
    try {
      const m = JSON.parse(fs.readFileSync(this.mirrorFile('docs.json'), 'utf8'));
      if (m.host !== this.host || m.db !== this.db.databaseName) return false;
      this.cache = new Map(Object.entries(m.docs));
      this.fileIndex = new Map(Object.entries(m.files || {}));
      return true;
    } catch { return false; }
  }

  saveMirror() {
    if (!this.mirrorDir) return;
    clearTimeout(this.mirrorTimer);
    this.mirrorTimer = setTimeout(() => this.writeMirror(), 1000);
  }

  writeMirror() {
    this.mirrorTimer = null;
    try {
      fs.mkdirSync(this.mirrorDir, { recursive: true });
      const f = this.mirrorFile('docs.json');
      const body = { host: this.host, db: this.db.databaseName, savedAt: new Date().toISOString(), docs: Object.fromEntries(this.cache), files: Object.fromEntries(this.fileIndex) };
      fs.writeFileSync(`${f}.tmp`, JSON.stringify(body), { mode: 0o600 });
      fs.renameSync(`${f}.tmp`, f);
    } catch (e) { console.error(`[data] couldn't save the copy on this computer: ${e.message}`); }
  }

  mirrorPhoto(key) { return this.mirrorDir && path.join(this.mirrorDir, 'files', ...key.split('/')); }

  // ---- documents

  get(key) {
    const json = this.cache.get(cleanKey(key));
    if (json === undefined) return undefined;
    try { return JSON.parse(json); } catch { return undefined; }
  }

  has(key) { const k = cleanKey(key); return this.cache.has(k) || this.fileIndex.has(k); }

  put(key, data) {
    const k = cleanKey(key);
    const json = JSON.stringify(data);
    this.cache.set(k, json);
    if (!this.latest.has(k)) this.queue.push({ op: 'put', key: k });
    this.latest.set(k, json);
    this.saveMirror();
    this.kick();
  }

  list(prefix = '') {
    return [...new Set([...this.cache.keys(), ...this.fileIndex.keys()])].filter((k) => k.startsWith(prefix)).sort();
  }

  remove(prefix) {
    const p = cleanKey(prefix).replace(/\/+$/, '');
    const hit = (k) => k === p || k.startsWith(`${p}/`);
    for (const k of [...this.cache.keys()]) if (hit(k)) { this.cache.delete(k); this.latest.delete(k); }
    for (const k of [...this.fileIndex.keys()]) if (hit(k)) { this.fileIndex.delete(k); this.dropCached(k); }
    if (this.mirrorDir) fs.rmSync(this.mirrorPhoto(p), { recursive: true, force: true });
    this.saveMirror();
    return this.enqueue({ op: 'remove', prefix: p }).catch((e) => console.error(`[data] couldn't delete ${p}: ${e.message}`));
  }

  // ---- photos and logos

  async getFile(key) {
    const k = cleanKey(key);
    if (this.fileCache.has(k)) return this.fileCache.get(k);
    const info = this.fileIndex.get(k);
    if (!info) return null;
    let hit = null;
    if (this.mirrorDir) {
      try { hit = { data: await fs.promises.readFile(this.mirrorPhoto(k)), type: info.type || typeFor(k) }; } catch { /* not copied yet */ }
    }
    if (!hit) {
      const f = await this.filesCol.findOne({ _id: k }).catch(() => null);
      if (!f) return null;
      hit = { data: Buffer.from(f.data.buffer ?? f.data), type: f.type || typeFor(k) };
      this.keepPhoto(k, hit.data);
    }
    this.fileCache.set(k, hit);
    this.fileCacheBytes += hit.data.length;
    for (const [old, v] of this.fileCache) {
      if (this.fileCacheBytes <= 64 * 1024 * 1024) break;
      this.fileCache.delete(old);
      this.fileCacheBytes -= v.data.length;
    }
    return hit;
  }

  keepPhoto(k, data) {
    if (!this.mirrorDir) return;
    const f = this.mirrorPhoto(k);
    fs.promises.mkdir(path.dirname(f), { recursive: true }).then(() => fs.promises.writeFile(f, data)).catch(() => {});
  }

  dropCached(k) {
    const v = this.fileCache.get(k);
    if (v) { this.fileCacheBytes -= v.data.length; this.fileCache.delete(k); }
  }

  /** Resolves once it's saved here; it reaches the database in the background (16 MB at most). */
  putFile(key, data, type = typeFor(key)) {
    const k = cleanKey(key);
    const buf = Buffer.from(data);
    if (buf.length > 15 * 1024 * 1024) return Promise.reject(new Error('That file is too big (15 MB at most)'));
    this.fileIndex.set(k, { type, size: buf.length });
    this.dropCached(k);
    this.keepPhoto(k, buf);
    this.saveMirror();
    const saved = this.enqueue({ op: 'putFile', key: k, data: buf, type });
    // Offline, the upload counts as done once it's on this computer.
    return this.offline && this.mirrorDir ? (saved.catch(() => {}), Promise.resolve()) : saved;
  }

  removeFile(key) {
    const k = cleanKey(key);
    this.fileIndex.delete(k);
    this.dropCached(k);
    if (this.mirrorDir) fs.promises.rm(this.mirrorPhoto(k), { force: true }).catch(() => {});
    this.saveMirror();
    const done = this.enqueue({ op: 'removeFile', key: k });
    return this.offline ? (done.catch(() => {}), Promise.resolve()) : done;
  }

  // ---- saving

  enqueue(item) {
    return new Promise((resolve, reject) => {
      this.queue.push({ ...item, resolve, reject });
      this.kick();
    });
  }

  /** Save waiting changes, one at a time and in order; on a lost connection, keep retrying. */
  async kick() {
    if (this.busy || this.closed || this.offline) return;
    this.busy = true;
    let wait = 1000;
    while (this.queue.length && !this.closed && !this.offline) {
      const item = this.queue[0];
      try {
        await this.run(item);
        this.queue.shift();
        item.resolve?.();
        if (this.error) { this.error = null; this.emit('status'); }
        wait = 1000;
      } catch (e) {
        // A change that can never be saved (too big, bad data) isn't retried forever.
        if (!retryable(e)) {
          this.queue.shift();
          console.error(`[data] couldn't save ${item.key || item.prefix}: ${e.message}`);
          item.reject?.(new Error(friendlyMongoError(e)));
          continue;
        }
        if (this.error !== friendlyMongoError(e)) { this.error = friendlyMongoError(e); console.error(`[data] saving to MongoDB failed, retrying: ${this.error}`); this.emit('status'); }
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 30000);
      }
    }
    this.busy = false;
    if (!this.queue.length) for (const r of this.idle.splice(0)) r();
  }

  async run(item) {
    const meta = { by: this.writer, at: new Date() };
    if (item.op === 'put') {
      const json = this.latest.get(item.key);
      if (json === undefined) return; // removed since
      await this.docsCol.replaceOne({ _id: item.key }, { json, ...meta }, { upsert: true });
      if (this.latest.get(item.key) === json) this.latest.delete(item.key);
    } else if (item.op === 'putFile') {
      await this.filesCol.replaceOne({ _id: item.key }, { data: item.data, type: item.type, size: item.data.length, ...meta }, { upsert: true });
    } else if (item.op === 'removeFile') {
      await this.filesCol.deleteOne({ _id: item.key });
    } else if (item.op === 'remove') {
      const re = new RegExp(`^${item.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/|$)`);
      await this.docsCol.deleteMany({ _id: re });
      await this.filesCol.deleteMany({ _id: re });
    }
  }

  // ---- changes from elsewhere

  /** Started offline: keep trying; once back, catch up with what changed and save what's waiting. */
  reconnectLater() {
    this.emit('status');
    const attempt = async () => {
      if (this.closed) return;
      try {
        await this.client.connect();
        const changed = await this.load();
        this.offline = false;
        this.error = null;
        console.log('[data] MongoDB is back; saving the changes made meanwhile');
        this.saveMirror();
        this.follow();
        this.kick();
        this.emit('status');
        for (const k of changed) this.tell(k);
      } catch {
        this.retryTimer = setTimeout(attempt, 15000);
      }
    };
    this.retryTimer = setTimeout(attempt, 5000);
  }

  tell(key) {
    this.emit('external', key);
    for (const fn of this.watchers.get(key) || []) {
      try { fn(this.get(key)); } catch (e) { console.error(`[data] ${key}: ${e.message}`); }
    }
  }

  /** Changes made by another computer or the website: update the copy here and tell the stores. */
  follow() {
    const start = (col, isFiles) => {
      const pipeline = isFiles ? [{ $project: { 'fullDocument.data': 0 } }] : [];
      const stream = col.watch(pipeline, { fullDocument: 'updateLookup' });
      this.streams.push(stream);
      stream.on('change', (ch) => {
        const key = ch.documentKey?._id;
        if (!key || ch.fullDocument?.by === this.writer) return;
        if (isFiles) {
          if (ch.operationType === 'delete') this.fileIndex.delete(key);
          else if (ch.fullDocument) this.fileIndex.set(key, { type: ch.fullDocument.type, size: ch.fullDocument.size });
          this.dropCached(key);
          if (this.mirrorDir) fs.promises.rm(this.mirrorPhoto(key), { force: true }).catch(() => {});
          this.saveMirror();
          return;
        }
        if (this.latest.has(key)) return; // we're about to overwrite it anyway
        if (ch.operationType === 'delete') {
          if (!this.cache.has(key)) return;
          this.cache.delete(key);
        } else if (ch.fullDocument?.json !== undefined) {
          if (this.cache.get(key) === ch.fullDocument.json) return;
          this.cache.set(key, ch.fullDocument.json);
        } else return;
        this.saveMirror();
        this.tell(key);
      });
      stream.on('error', (e) => {
        this.streams = this.streams.filter((s) => s !== stream);
        stream.close().catch(() => {});
        if (this.closed) return;
        // A single server without a replica set can't report changes; everything else still works.
        if (/replica set|change stream|\$changeStream/i.test(e.message)) { console.warn('[data] this MongoDB can\'t report changes from other computers (it needs a replica set; MongoDB Atlas has one)'); return; }
        console.error(`[data] lost track of changes, catching up: ${e.message}`);
        setTimeout(async () => {
          if (this.closed) return;
          try { for (const k of await this.load()) this.tell(k); } catch { /* the stream retries below */ }
          start(col, isFiles);
        }, 5000);
      });
    };
    start(this.docsCol, false);
    start(this.filesCol, true);
  }

  /** Delete everything in this database (before replacing it with this computer's setup). */
  async wipe() {
    await this.flush();
    await this.docsCol.deleteMany({});
    await this.filesCol.deleteMany({});
    this.cache.clear();
    this.fileIndex.clear();
    this.fileCache.clear();
    this.fileCacheBytes = 0;
  }

  /** fn(data) when someone else changes this document. Returns a function that stops it. */
  watch(key, fn) {
    const k = cleanKey(key);
    if (!this.watchers.has(k)) this.watchers.set(k, new Set());
    this.watchers.get(k).add(fn);
    return () => this.watchers.get(k)?.delete(fn);
  }

  /** Resolves once every change so far is saved (or right away while offline). */
  flush() {
    if (this.offline || (!this.queue.length && !this.busy)) return Promise.resolve();
    return new Promise((r) => this.idle.push(r));
  }

  async close() {
    await Promise.race([this.flush(), new Promise((r) => setTimeout(r, 5000))]);
    this.closed = true;
    clearTimeout(this.retryTimer);
    if (this.mirrorTimer) { clearTimeout(this.mirrorTimer); this.writeMirror(); }
    for (const s of this.streams) await s.close().catch(() => {});
    await this.client.close().catch(() => {});
  }

  status() {
    return { kind: 'mongodb', where: this.host, db: this.db.databaseName, pending: this.queue.length, offline: this.offline, error: this.offline ? 'Can\'t reach the database; using this computer\'s copy' : this.error };
  }
}

const retryable = (e) => /network|timed? ?out|ECONN|ENOTFOUND|EAI_AGAIN|not primary|server selection|topology|closed|interrupted/i.test(`${e.name} ${e.message}`);

export function friendlyMongoError(e) {
  const m = String(e?.message || e);
  if (/bad auth|authentication failed|auth.*fail/i.test(m)) return 'MongoDB didn\'t accept the username or password in the connection string';
  if (/ENOTFOUND|querySrv|EAI_AGAIN/i.test(m)) return 'Couldn\'t find that database server. Check the connection string and this computer\'s internet connection.';
  if (/Server selection timed out|ECONNREFUSED|timed out/i.test(m)) return 'Couldn\'t reach the database. In MongoDB Atlas, check that Network Access allows this computer (or 0.0.0.0/0).';
  return m;
}

// ------------------------------------------------------------------------------ moving data

/** Copy every shared document and file from one store to another (e.g. this computer → Atlas). */
export async function copyAll(from, to, { onProgress = () => {} } = {}) {
  const keys = from.list('').filter((k) => !LOCAL_ONLY.test(k));
  let done = 0;
  for (const k of keys) {
    if (isDoc(k)) {
      const v = from.get(k);
      if (v !== undefined) to.put(k, v, { secret: /^(users|sessions)\.json$/.test(k) });
    } else {
      const f = await from.getFile(k);
      if (f) await to.putFile(k, f.data, f.type);
    }
    onProgress(++done, keys.length);
  }
  await to.flush();
  return { docs: keys.filter(isDoc).length, files: keys.filter((k) => !isDoc(k)).length };
}

/** Is there a setup saved here already (organizations)? */
export const hasSetup = (docs) => Boolean(docs.get('orgs.json')?.orgs?.length);

// ------------------------------------------------------------------------------ choosing

/** The saved connection (Settings → This computer → Cloud database), or MONGODB_URI. */
export function databaseConfig(dataDir) {
  if (process.env.MONGODB_URI) return { uri: process.env.MONGODB_URI, fromEnv: true };
  const saved = FileDocs.at(dataDir).get('database.json');
  return saved?.uri ? { uri: saved.uri, fromEnv: false } : null;
}

export function saveDatabaseConfig(dataDir, uri) {
  const local = FileDocs.at(dataDir);
  if (uri) local.put('database.json', { uri, savedAt: new Date().toISOString() }, { secret: true });
  else local.remove('database.json');
}

/**
 * Open where this computer saves things. With a cloud database that's still empty, the setup
 * already on this computer is copied there first, so nothing is lost.
 */
export async function openDocs(dataDir) {
  const local = FileDocs.at(dataDir);
  const conf = databaseConfig(dataDir);
  if (!conf) return local;
  const docs = await MongoDocs.connect(conf.uri, { mirrorDir: path.join(dataDir, 'cloud-copy'), offlineOk: true });
  if (!hasSetup(docs) && hasSetup(local)) {
    const n = await copyAll(local, docs);
    console.log(`[data] copied this computer's setup to MongoDB (${n.docs} documents, ${n.files} photos and logos)`);
  }
  return docs;
}
