import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { WebSocketServer } from 'ws';

import { loadConfig, ROOT } from './config.js';
import { OrgRegistry, maskSettings, mergeIncoming } from './orgs.js';
import { Runtime, checkPin } from './runtime.js';
import QRCode from 'qrcode';
import selfsigned from 'selfsigned';
import { testDevice } from './testers.js';
import { Tunnel, lanAddresses } from './tunnel.js';
import { dataDirFor, oldDataCandidates, adoptOldData } from './datadir.js';
import { Auth, RANK, sessionToken, sessionCookie } from './auth.js';
import { localName, startLocalName, setLocalName, stopLocalName, listenPort80 } from './localname.js';
import { createBackup, readBackup, importBackup, isEncrypted } from './backup.js';
import { openDocs, FileDocs, MongoDocs, databaseConfig, saveDatabaseConfig, copyAll, hasSetup, mongoHost } from './docs.js';
import { System } from './system.js';
import { Site } from './site.js';
import { Mailer, resetEmail } from './mail.js';
import { StationHub, StationLink, StationDocs, StationAuth, stationConfig, saveStationConfig } from './station.js';

// config.yaml now only holds server settings (port). Everything else (gear, branding, PIN,
// Planning Center) is per organization and edited in the browser. On first run the
// organization is created from config.yaml, so existing setups carry over.
const cfg = loadConfig();
// WAVS_HOSTED=1: the website (e.g. on Render). Anyone can sign up and get their own
// organization; every organization runs at the same time; nothing reaches a local network.
// Otherwise: one host computer at a venue, running one organization at a time.
const HOSTED = process.env.WAVS_HOSTED === '1';
const dataDir = dataDirFor({ root: ROOT });
if (!process.env.WAVS_DATA && !HOSTED) {
  const from = adoptOldData(dataDir, oldDataCandidates({ root: ROOT }));
  if (from) console.log(`[data] copied your existing setup from ${from}`);
}
console.log(`[data] saved in ${dataDir}`);
// A base station: this computer is linked to the website (Settings → This computer → Website).
const STATION = HOSTED ? null : stationConfig(dataDir);
// Running in the background: keep the log file from growing forever.
if (process.env.WAVS_SERVICE === '1') {
  const log = path.join(dataDir, 'logs', 'dashboard.log');
  try { if (fs.statSync(log).size > 10 * 1024 * 1024) fs.truncateSync(log, 0); } catch { /* no log yet */ }
}
const system = new System(ROOT);
const BOOT = crypto.randomUUID(); // changes on every start, so open screens can pick up a new version
// Where the setup is saved: this computer's folder, or a cloud database (Settings → This computer).
let docs;
let storageProblem = null;
let link = null;
try {
  if (STATION) {
    // Organizations and accounts come from the website; a copy stays here for when it's offline.
    link = new StationLink(STATION);
    docs = new StationDocs({ dir: path.join(dataDir, 'station'), link });
    docs.load();
    link.start();
    console.log(`[station] base station for ${STATION.url} (${STATION.user?.username || 'linked'})`);
  } else docs = await openDocs(dataDir, { hosted: HOSTED, dbName: HOSTED ? 'wavs-web' : undefined });
} catch (e) {
  // The website never falls back to its temporary disk: stop, and the host starts it again.
  if (HOSTED) { console.error(`[data] can't open the database: ${e.message}`); process.exit(1); }
  // The cloud database can't be reached and there's no copy here yet: run from this computer's
  // folder so the dashboard still opens, and say so in Settings.
  storageProblem = `Couldn't open the cloud database (${e.message.replace(/\.$/, '')}). Using this computer's own copy until it's fixed; changes made now stay on this computer.`;
  console.error(`[data] ${storageProblem}`);
  docs = FileDocs.at(dataDir);
}
if (docs.kind === 'mongodb') console.log(`[data] using MongoDB at ${docs.host} (database "${docs.db.databaseName}")`);
else if (HOSTED) console.warn('[data] WAVS_HOSTED without MONGODB_URI: saving to this server\'s disk (fine for trying it out, lost on most hosts when it restarts)');
const orgs = new OrgRegistry({ docs }, { local: STATION ? docs.local : FileDocs.at(dataDir) });
if (!HOSTED && !STATION) await orgs.migrate(cfg);
const auth = STATION ? new StationAuth({ docs: docs.local }, { link, docs }) : new Auth({ docs });
// The website: base stations (laptops at events) link to it.
const stations = HOSTED ? new StationHub({ docs, auth, orgs }) : null;
const site = new Site({ docs });
const mailer = new Mailer();
if (mailer.enabled) console.log(`[mail] sending email as ${mailer.config.from}`);

// Locked out of the owner account: start once with WAVS_RESET_OWNER_PASSWORD=<new password>
// (Render: Environment), sign in with it, then remove the variable.
if (process.env.WAVS_RESET_OWNER_PASSWORD) {
  const owner = auth.data.users.find((u) => u.owner);
  if (!owner) console.warn('[auth] WAVS_RESET_OWNER_PASSWORD is set, but there is no owner account yet');
  else {
    try {
      auth.setPassword(owner.id, process.env.WAVS_RESET_OWNER_PASSWORD);
      console.warn(`[auth] the owner's password (${owner.username}) was reset from WAVS_RESET_OWNER_PASSWORD. Sign in, then remove that variable.`);
    } catch (e) { console.error(`[auth] WAVS_RESET_OWNER_PASSWORD: ${e.message}`); }
  }
}

// ---------------------------------------------------------------- organizations running

// One Runtime per running organization. A host computer runs its active one; the website runs
// each organization while people use it (started on first use).
const runtimes = new Map(); // orgId -> Runtime

function startRuntime(id) {
  const next = new Runtime({ orgId: id, place: orgs.place(id), settings: orgs.read(id), accounts: () => accountsOn(), cloud: HOSTED });
  next.on('message', (msg) => broadcastTo(id, msg));
  next.start();
  next.lastUsed = Date.now();
  // Gear or branding changed on another computer (or the website): start again with it.
  next.unwatchSettings = orgs.watchSettings(id, () => { console.log(`[orgs] ${id}: settings changed elsewhere; reconnecting`); restartRuntime(id); });
  runtimes.set(id, next);
  console.log(`[orgs] running: ${next.settings.org.name}`);
  return next;
}

function stopRuntime(id) {
  const old = runtimes.get(id);
  if (!old) return;
  old.unwatchSettings();
  old.stop();
  runtimes.delete(id);
}

/** The running organization (started if needed), or null if it doesn't exist. */
function runtimeFor(id) {
  if (!id || !orgs.data.orgs.some((o) => o.id === id)) return null;
  const r = runtimes.get(id) || startRuntime(id);
  r.lastUsed = Date.now();
  return r;
}

/** Stop an organization's gear and start again (after a gear or settings change). */
function restartRuntime(id) {
  stopRuntime(id);
  const r = runtimeFor(id);
  broadcastTo(id, { type: 'reload' });
  return r;
}

/** Host computer: the organization it runs (screens follow it). */
const activeId = () => (orgs.data.orgs.some((o) => o.id === orgs.data.active) ? orgs.data.active : orgs.data.orgs[0]?.id) || null;

/** Host computer: switch the organization every screen shows. */
function switchActive(id) {
  orgs.setActive(id);
  for (const other of [...runtimes.keys()]) if (other !== id) stopRuntime(other);
  runtimeFor(id);
  broadcastAll({ type: 'reload' });
}

// Accounts are always on for the website; on a host computer once the first one exists.
const accountsOn = () => HOSTED || Boolean(STATION) || auth.enabled;
const loginRequired = () => HOSTED || Boolean(auth.data.requireLogin);
const myOrgs = (user) => orgs.data.orgs.filter((o) => (HOSTED ? auth.rank(user, o.id) >= 1 && (!user?.owner || auth.memberOf(user, o.id)) : true));

const cookieValue = (req, name) => {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : null;
};

/**
 * Which organization a request is for. Host computer: the active one. Website: the one the
 * person picked (cookie), else their first; a TV link's organization; or, for the comms phone
 * page, the one in its link (?org=).
 */
function orgFor(req, pathname = req.path) {
  if (!HOSTED) return activeId();
  const picked = cookieValue(req, 'wavs_org');
  if (req.user) {
    if (picked && auth.rank(req.user, picked) >= 1) return picked;
    return myOrgs(req.user)[0]?.id || null;
  }
  const tv = tvViewer(req);
  if (tv) return tv;
  const q = new URL(req.url, 'http://x').searchParams.get('org');
  if (q && /^\/(comms|comms-ws|api\/comms\/(info|qr\.svg))$/.test(pathname)) return q;
  return null;
}

/** A TV link's cookie ("<org>.<key>"): that organization's screens, view only. */
function tvViewer(req) {
  const v = cookieValue(req, 'wavs_tv');
  if (!v) return null;
  const dot = v.lastIndexOf('.');
  const org = v.slice(0, dot);
  return org && orgs.tvKeyOk(org, v.slice(dot + 1)) ? org : null;
}

function publicConfig(req) {
  const { rt } = req;
  const user = req.user ? auth.view(req.user, rt?.orgId) : null;
  const common = {
    hosted: HOSTED,
    station: STATION ? { url: STATION.url, online: link.online, name: STATION.name } : null,
    site: HOSTED ? { name: site.name, owner: Boolean(req.user?.owner), canCreateOrg: Boolean(req.user) } : null,
    orgs: req.user || !HOSTED ? myOrgs(req.user).map((o) => ({ id: o.id, name: o.name, color: orgs.read(o.id).org.theme.accent })) : [],
  };
  // Website, signed in, but not part of any organization yet: the page offers to create one.
  if (!rt) return { ...common, noOrg: true, auth: { enabled: true, requireLogin: true, user, role: null } };
  const s = rt.settings;
  const role = accountsOn() ? (req.user ? auth.roleIn(req.user, rt.orgId) : req.tv ? 'viewer' : null) : 'admin';
  return {
    ...common,
    auth: {
      enabled: accountsOn(),
      requireLogin: loginRequired(),
      user,
      role,
    },
    org: { name: s.org.name, serviceName: s.org.serviceName, theme: s.org.theme, logo: Boolean(orgs.logoKey(rt.orgId)) },
    orgId: rt.orgId,
    tvBase: tvBase(req),
    // TV links on the website carry a key, so a TV shows the dashboards without signing in.
    tvQuery: HOSTED && auth.rank(req.user, rt.orgId) >= RANK.producer ? `?k=${orgs.tvKey(rt.orgId)}` : '',
    setupComplete: s.setupComplete,
    dataDir: HOSTED ? null : dataDir,
    alerts: s.alerts,
    rf: s.rf,
    video: s.video,
    control: s.control,
    switchers: s.switchers.map((x) => ({ id: x.id, name: x.name, me: x.me || 1 })),
    propresenter: s.propresenter.map((x) => ({ id: x.id, name: x.name })),
    planningCenter: Boolean(s.planningCenter),
    pinRequired: !accountsOn() && Boolean(s.security.adminPin),
  };
}

// ---------------------------------------------------------------- http

const app = express();
app.disable('x-powered-by');
// The website sits behind its host's proxy (https, the visitor's address).
if (HOSTED) app.set('trust proxy', 1);
app.use(express.json({ limit: '200kb' }));

const requirePin = (req, res, next) => (checkPin(req.rt?.settings.security.adminPin, req.get('x-admin-pin'))
  ? next()
  : res.status(401).json({ error: 'PIN required' }));

// Who is signed in (session cookie), and which organization the request is for.
app.use((req, _res, next) => {
  req.user = auth.session(sessionToken(req));
  req.tv = !req.user && HOSTED ? tvViewer(req) : null;
  req.rt = runtimeFor(orgFor(req));
  next();
});

// Off-site (through the Cloudflare link, from any network): everyone signs in, whatever the
// "require sign-in" setting, and accounts must exist. Only the sign-in pages, static files and
// the comms phone page are open. The first (owner) account can only be made on this computer.
const OFFSITE_OPEN = /^\/(login|join\/|forgot$|reset\/|api\/auth\/(status|login|logout|invite\/|forgot$|reset\/)|css\/|js\/|vendor\/|logo$|comms$|favicon)/;
app.use((req, res, next) => {
  if (!req.viaTunnel) return next();
  if (req.path === '/api/auth/owner') return res.status(403).json({ error: 'Create the first account on the dashboard computer itself, then sign in here.' });
  if (OFFSITE_OPEN.test(req.path)) return next();
  if (!auth.enabled) {
    if (req.path === '/') return res.redirect('/comms');
    return res.status(403).send('The dashboard can be opened from anywhere once accounts are set up (Settings → Accounts on the dashboard computer). Comms works now at /comms.');
  }
  if (req.user && auth.rank(req.user, req.rt?.orgId) >= 1) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) return res.status(401).json({ error: 'Sign in first', login: true });
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
});

/**
 * Role needed for an action. Before the first account exists, the old admin PIN (if set) guards
 * every change, as before. After that, signed-in roles do: crew < producer < admin.
 */
const need = (role) => (req, res, next) => {
  if (!req.rt) return res.status(req.user ? 409 : 401).json(req.user ? { error: 'Create an organization first', noOrg: true } : { error: 'Sign in first', login: true });
  if (!accountsOn()) return role === 'open' ? next() : requirePin(req, res, next);
  if (role === 'open' && !loginRequired()) return next();
  if (!req.user) return res.status(401).json({ error: 'Sign in to do that', login: true });
  const have = auth.rank(req.user, req.rt.orgId);
  const want = RANK[role] || 1;
  if (have < want) return res.status(403).json({ error: have ? `That needs ${role} access. Ask an admin.` : `Your account doesn't have access to ${req.rt.settings.org.name}. Ask an admin.` });
  next();
};

// "Require sign-in to view" (always on the website): everything except the sign-in pages,
// static files and the comms phone page (crew sign in to comms with their name) needs a
// signed-in account. A TV link may look (GET), not change anything.
const PUBLIC = /^\/(login|join\/|signup$|api\/station\/(pair|import)$|forgot$|reset\/|api\/auth\/|css\/|js\/|vendor\/|logo$|comms$|api\/comms\/qr\.svg$|favicon|tv\/)/;
const TV_CAN_READ = /^\/(api\/(config|state|dashboards|schedule|service|settings)$|uploads\/|d\/|dashboards$)/;
app.use((req, res, next) => {
  if (!accountsOn() || !loginRequired() || PUBLIC.test(req.path)) return next();
  if (req.user && (HOSTED || auth.rank(req.user, req.rt?.orgId) >= 1)) return next();
  if (req.tv && req.method === 'GET' && TV_CAN_READ.test(req.path)) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) return res.status(401).json({ error: 'Sign in first', login: true });
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
});

// Everything else is about one organization: there must be one.
const NO_ORG_OK = /^\/api\/(config|auth\/|orgs$|site(\/|$)|comms\/qr\.svg$|stations?(\/|$))/;
app.use((req, res, next) => {
  if (req.rt || !/^\/(api\/|uploads\/|logo$)/.test(req.path) || NO_ORG_OK.test(req.path)) return next();
  res.status(req.user ? 409 : 401).json(req.user ? { error: 'Create an organization first', noOrg: true } : { error: 'Sign in first', login: true });
});

// A base station: accounts and organizations are managed on the website.
const ON_WEBSITE = /^\/api\/(users\/|auth\/(owner|invite\/|forgot|reset\/|password)|orgs\/[^/]+$|backup\/import|system\/database)/;
app.use((req, res, next) => {
  if (!STATION || req.method === 'GET' || !ON_WEBSITE.test(req.path)) return next();
  if (req.path === '/api/orgs' || req.path === '/api/orgs/active') return next();
  res.status(400).json({ error: `This computer is a base station for ${STATION.url}. Do that on the website.`, website: STATION.url });
});
app.use((req, res, next) => (STATION && req.method === 'POST' && req.path === '/api/orgs' ? res.status(400).json({ error: `Create organizations on the website (${STATION.url}); they show up here by themselves.` }) : next()));

// The website: things that only make sense on a computer at the venue.
const HOST_ONLY = /^\/api\/(system|remote|comms\/remote|auth\/require-login|pin\/check)(\/|$)/;
app.use((req, res, next) => (HOSTED && HOST_ONLY.test(req.path) ? res.status(404).json({ error: 'Not available on the website' }) : next()));

const images = /^image\/(jpeg|png|webp|gif|heic|heif|svg\+xml)$/;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, images.test(file.mimetype) && file.mimetype !== 'image/svg+xml'),
});
/** A person's photo: saved with the organization (see docs.js); req.file.filename is its name. */
const photoUpload = [upload.single('photo'), async (req, res, next) => {
  if (!req.file) return next();
  try {
    req.file.filename = `${crypto.randomUUID()}${path.extname(req.file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg'}`;
    await req.rt.store.savePhoto(req.file.filename, req.file.buffer, req.file.mimetype);
    next();
  } catch (e) { res.status(400).json({ error: e.message }); }
}];
const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 }, fileFilter: (_req, f, cb) => cb(null, /^image\/(png|jpeg|webp)$/.test(f.mimetype)) });

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { res.status(400).json({ error: e.message }); }
};

app.get('/api/config', (req, res) => res.json(publicConfig(req)));
app.get('/api/state', (req, res) => res.json(req.rt.snapshot()));
app.post('/api/pin/check', need('admin'), (req, res) => res.json({ ok: true }));

// ---- accounts & sign in
const signIn = (req, res, token) => res.append('set-cookie', sessionCookie(token, { secure: req.secure || Boolean(req.viaTunnel) }));
/** Website: remember which organization this browser is working in. */
const pickOrg = (req, res, id) => res.append('set-cookie', `wavs_org=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${400 * 86400}${req.secure ? '; Secure' : ''}`);
// The visitor's address (for "too many tries"). The website sits behind its host's proxy, so
// there it's the forwarded address (trust proxy), not the proxy's own.
const clientIp = (req) => (HOSTED && req.ip) || (req.viaTunnel && req.get('cf-connecting-ip')) || req.socket.remoteAddress || '';
// What the sign-in page needs (public, even when sign-in is required to view).
app.get('/api/auth/status', (req, res) => res.json({
  org: req.rt ? { name: req.rt.settings.org.name, theme: req.rt.settings.org.theme, logo: Boolean(orgs.logoKey(req.rt.orgId)) } : HOSTED ? { name: site.name, theme: {}, logo: false } : null,
  auth: { enabled: accountsOn(), user: req.user ? { name: req.user.name } : null, role: req.rt ? auth.roleIn(req.user, req.rt.orgId) : null },
  pinRequired: !accountsOn() && Boolean(req.rt?.settings.security.adminPin),
  hosted: HOSTED,
  signups: HOSTED ? site.signups : null,
  mail: mailer.enabled,
}));

// ---- website: anyone can sign up (open, with the beta code, or closed) and gets their own organization.
const OWNER_EMAIL = String(process.env.WAVS_OWNER_EMAIL || '').trim().toLowerCase();
const signupTries = new Map(); // ip -> { n, at }
app.post('/api/auth/signup', wrap((req, res) => {
  if (!HOSTED) throw new Error('Ask the dashboard\'s admin for an invite link');
  const b = req.body || {};
  const ip = req.ip || '';
  const t = signupTries.get(ip);
  if (t && Date.now() - t.at < 3600000 && t.n >= 5) throw new Error('Too many new accounts from here. Try again in an hour.');
  signupTries.set(ip, t && Date.now() - t.at < 3600000 ? { n: t.n + 1, at: t.at } : { n: 1, at: Date.now() });
  // The site owner (WAVS_OWNER_EMAIL) can always sign up first, and becomes the owner.
  const ownerSignup = Boolean(OWNER_EMAIL) && String(b.username || '').trim().toLowerCase() === OWNER_EMAIL && !auth.data.users.some((u) => u.owner);
  site.check(b.code, { ownerSignup });
  const orgName = String(b.orgName || '').trim();
  if (!orgName) throw new Error('Name your church or organization');
  const u = auth.create({ name: b.name, username: b.username, password: b.password, owner: ownerSignup });
  const id = orgs.create(orgName);
  auth.join(u.id, id, 'admin');
  console.log(`[site] new account${ownerSignup ? ' (owner)' : ''} with organization "${orgName}"`);
  signIn(req, res, auth.startSession(u));
  pickOrg(req, res, id);
  res.json({ ok: true, orgId: id });
}));
// The site owner: who may sign up, and the beta code.
const siteOwner = (req) => { if (!HOSTED || !req.user?.owner) throw new Error('Only the site owner can do that'); };
app.get('/api/site', wrap((req, res) => {
  siteOwner(req);
  res.json({ ...site.view(), accounts: auth.data.users.length, orgs: orgs.data.orgs.map((o) => ({ id: o.id, name: o.name, people: auth.data.users.filter((u) => auth.memberOf(u, o.id)).length, running: runtimes.has(o.id) })) });
}));
app.put('/api/site', wrap((req, res) => { siteOwner(req); res.json(site.update(req.body || {})); }));

app.post('/api/auth/owner', wrap((req, res) => {
  if (HOSTED) throw new Error('On the website, the owner signs up with the email in WAVS_OWNER_EMAIL');
  if (!req.rt) throw new Error('No organization yet');
  // The first account. If the old admin PIN is set, it's needed to claim the dashboard.
  if (req.rt.settings.security.adminPin && !checkPin(req.rt.settings.security.adminPin, req.body?.pin)) throw new Error('Enter the current admin PIN to create the owner account');
  const u = auth.createOwner(req.body || {});
  signIn(req, res, auth.startSession(u));
  res.json({ ok: true });
}));
app.post('/api/auth/login', wrap(async (req, res) => {
  signIn(req, res, await auth.login(req.body?.username, req.body?.password, clientIp(req)));
  res.json({ ok: true });
}));
app.post('/api/auth/logout', (req, res) => { auth.logout(sessionToken(req)); signIn(req, res, null); res.json({ ok: true }); });
// ---- forgot password: a one-time link by email (when email is set up, see mail.js)
// Links use the site's own address, never one a request claims (Host), so a link can't be
// pointed at someone else's server.
const siteBase = (req) => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || shareBase(req)).replace(/\/+$/, '');
const forgotTries = new Map(); // ip or email -> { n, at }
const tooManyForgot = (key) => {
  const t = forgotTries.get(key);
  const fresh = t && Date.now() - t.at < 3600000;
  forgotTries.set(key, fresh ? { n: t.n + 1, at: t.at } : { n: 1, at: Date.now() });
  return fresh && t.n >= 5;
};
app.post('/api/auth/forgot', wrap(async (req, res) => {
  if (!mailer.enabled) throw new Error('Password reset by email isn\'t set up on this dashboard. Ask an admin to reset your password.');
  const email = String(req.body?.username || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter the email address you sign in with');
  if (tooManyForgot(clientIp(req)) || tooManyForgot(email)) throw new Error('Too many reset emails. Try again in an hour.');
  const r = auth.startReset(email);
  if (r) {
    const link = `${siteBase(req)}/reset/${r.token}`;
    try {
      await mailer.send({ to: r.user.username, ...resetEmail({ name: r.user.name, link, site: HOSTED ? site.name : 'WAVS Dashboard' }) });
    } catch (e) {
      console.error(`[mail] couldn't send a reset email: ${e.message}`);
      throw new Error('The email couldn\'t be sent right now. Try again in a few minutes, or ask an admin.');
    }
  }
  // The same answer whether or not there's an account, so nobody can find out who has one.
  res.json({ ok: true });
}));
app.get('/api/auth/reset/:token', (req, res) => {
  const u = auth.resetFor(req.params.token);
  if (!u) return res.status(404).json({ error: 'This reset link has expired or was already used. Ask for a new one.' });
  res.json({ ok: true, name: u.name, username: u.username });
});
app.post('/api/auth/reset/:token', wrap((req, res) => {
  signIn(req, res, auth.finishReset(req.params.token, req.body?.password));
  res.json({ ok: true });
}));

app.post('/api/auth/password', wrap((req, res) => {
  if (!req.user) throw new Error('Sign in first');
  auth.changePassword(req.user.id, req.body?.current, req.body?.next);
  res.json({ ok: true });
}));
app.get('/api/auth/invite/:code', (req, res) => {
  const inv = auth.findInvite(req.params.code);
  if (!inv) return res.status(404).json({ error: 'This invite link has expired or was cancelled. Ask for a new one.' });
  const org = orgs.data.orgs.find((o) => o.id === inv.orgId);
  res.json({ org: org?.name || 'the dashboard', role: inv.role, signedIn: req.user ? req.user.name : null });
});
app.post('/api/auth/invite/:code', wrap((req, res) => {
  const { token } = auth.acceptInvite(req.params.code, req.body || {}, clientIp(req));
  signIn(req, res, token);
  res.json({ ok: true });
}));

/** Address others can open: this request's host, unless that's "localhost" on this computer. */
function shareBase(req) {
  const host = req.get('host') || '';
  if (HOSTED) return `${req.protocol}://${host}`;
  if (req.viaTunnel) return `https://${host}`;
  if (!/^(localhost|127\.|\[::1\])/.test(host)) return `${req.protocol}://${host}`;
  const port = cfg.server.port === 80 ? '' : `:${cfg.server.port}`;
  if (localName.active) return `http://${localName.host}${localName.port80 ? '' : port}`;
  const ip = lanAddresses()[0]?.address;
  return ip ? `http://${ip}${port}` : `http://localhost${port}`;
}

/**
 * Address for TV players (Fire TV / AbleSign, smart TVs): the number address, since many of
 * them can't look up ".local" names. Set a DHCP reservation for this computer so it stays put.
 */
function tvBase(req) {
  if (HOSTED) return shareBase(req);
  const ip = lanAddresses()[0]?.address;
  if (!ip) return shareBase(req);
  const port = localName.port80 || cfg.server.port === 80 ? '' : `:${cfg.server.port}`;
  return `http://${ip}${port}`;
}

app.get('/api/users', need('admin'), (req, res) => {
  res.json({
    // The website only shows this organization's team.
    users: auth.data.users.filter((u) => !HOSTED || auth.memberOf(u, req.rt.orgId)).map((u) => auth.view(u, req.rt.orgId)),
    invites: auth.data.invites.filter((i) => i.orgId === req.rt.orgId && i.expires > Date.now()).map((i) => ({ ...i, url: `${shareBase(req)}/join/${i.code}`, anywhereUrl: offsiteUrl(`/join/${i.code}`) })),
    requireLogin: Boolean(auth.data.requireLogin),
    orgs: orgs.data.orgs,
  });
});
app.post('/api/users/invite', need('admin'), wrap((req, res) => {
  const inv = auth.invite({ orgId: req.rt.orgId, role: req.body?.role, by: req.user?.id, days: req.body?.days, label: req.body?.label });
  res.json({ ...inv, url: `${shareBase(req)}/join/${inv.code}`, anywhereUrl: offsiteUrl(`/join/${inv.code}`) });
}));
app.delete('/api/users/invite/:code', need('admin'), wrap((req, res) => { auth.revokeInvite(req.params.code); res.json({ ok: true }); }));
app.put('/api/users/:id/role', need('admin'), wrap((req, res) => {
  if (req.params.id === req.user?.id) throw new Error("You can't change your own role");
  if (HOSTED && !auth.memberOf(auth.user(req.params.id), req.rt.orgId)) throw new Error('That account isn\'t on this team. Send them an invite link.');
  auth.setRole(req.params.id, req.rt.orgId, req.body?.role || null);
  res.json({ ok: true });
}));
app.post('/api/users/:id/reset', need('admin'), wrap((req, res) => {
  const u = auth.user(req.params.id);
  if (!u) throw new Error('Unknown account');
  if (u.owner && !req.user?.owner) throw new Error("The owner's password can only be changed by the owner");
  // Website: an admin can only reset accounts that belong to their organization alone.
  if (HOSTED && !req.user?.owner) {
    if (!auth.memberOf(u, req.rt.orgId)) throw new Error('That account isn\'t on this team');
    if (Object.keys(u.roles || {}).some((id) => id !== req.rt.orgId && orgs.data.orgs.some((o) => o.id === id))) throw new Error('That account is also on another organization\'s team, so only they (or the site owner) can change its password');
  }
  res.json({ password: auth.resetPassword(req.params.id) });
}));
app.delete('/api/users/:id', need('admin'), wrap((req, res) => {
  if (!req.user?.owner) throw new Error('Only the owner can delete accounts. You can remove their access to this organization instead.');
  auth.remove(req.params.id);
  res.json({ ok: true });
}));
app.put('/api/auth/require-login', need('admin'), wrap((req, res) => { auth.setRequireLogin(req.body?.on); broadcastAll({ type: 'reload' }); res.json({ ok: true }); }));

// ---- this computer: address, background service, version and updates (admins)
app.get('/api/system', need('admin'), wrap(async (req, res) => {
  const port = cfg.server.port;
  res.json({
    ...(await system.version()),
    git: system.isGit,
    root: ROOT,
    dataDir,
    service: { running: system.asService, installed: system.serviceInstalled(), platform: process.platform },
    storage: { ...docs.status(), problem: storageProblem },
    computerName: localName.name,
    nameConflict: localName.conflict,
    nameFixed: Boolean(process.env.WAVS_NAME),
    address: {
      name: localName.active ? `http://${localName.host}${localName.port80 || port === 80 ? '' : `:${port}`}` : null,
      ip: lanAddresses()[0] ? `http://${lanAddresses()[0].address}:${port}` : null,
    },
  });
}));
app.put('/api/system/name', need('admin'), wrap(async (req, res) => {
  await setLocalName(req.body?.name);
  res.json({ name: localName.name, conflict: localName.conflict });
}));

// ---- where the setup is saved: this computer, or a cloud database (MongoDB Atlas)
const ownerOnly = (req) => {
  if (accountsOn() && !req.user?.owner) throw new Error('Only the owner can change where everything is saved');
};
const orgNames = (d) => (d.get('orgs.json')?.orgs || []).map((o) => o.name);
/** After switching, start again with the new place (automatic when running in the background). */
const restartForStorage = () => system.restartSoon();

app.get('/api/system/database', need('admin'), (req, res) => {
  const conf = databaseConfig(dataDir);
  res.json({ ...docs.status(), problem: storageProblem, configured: Boolean(conf), fromEnv: Boolean(conf?.fromEnv), host: conf ? mongoHost(conf.uri) : null, canRestart: system.asService });
});
app.post('/api/system/database/test', need('admin'), wrap(async (req, res) => {
  ownerOnly(req);
  const uri = String(req.body?.uri || '').trim();
  const cloud = await MongoDocs.connect(uri, { timeoutMs: 8000 });
  try {
    res.json({ ok: true, host: cloud.host, db: cloud.db.databaseName, orgs: orgNames(cloud), empty: !cloud.list('').length, here: orgNames(docs) });
  } finally { await cloud.close(); }
}));
// mode: 'upload' (this computer's setup goes to the database, replacing what's there) or 'use' (use what's there).
app.post('/api/system/database', need('admin'), wrap(async (req, res) => {
  ownerOnly(req);
  if (databaseConfig(dataDir)?.fromEnv) throw new Error('The database is set by MONGODB_URI on this computer; change it there');
  const uri = String(req.body?.uri || '').trim();
  const mode = req.body?.mode === 'use' ? 'use' : 'upload';
  const cloud = await MongoDocs.connect(uri, { timeoutMs: 8000 });
  let copied = null;
  try {
    if (mode === 'use' && !hasSetup(cloud)) throw new Error('That database is empty. Choose “Move this computer\'s setup there” instead.');
    if (mode === 'upload') {
      await docs.flush();
      await cloud.wipe();
      copied = await copyAll(docs, cloud);
    }
  } finally { await cloud.close(); }
  saveDatabaseConfig(dataDir, uri);
  console.log(`[data] now saving to MongoDB at ${mongoHost(uri)}${copied ? ` (copied ${copied.docs} documents, ${copied.files} photos and logos)` : ''}`);
  res.json({ ok: true, copied, restarting: restartForStorage() });
}));
// Back to this computer's folder; copyBack brings the cloud's current setup down first.
app.delete('/api/system/database', need('admin'), wrap(async (req, res) => {
  ownerOnly(req);
  const conf = databaseConfig(dataDir);
  if (conf?.fromEnv) throw new Error('The database is set by MONGODB_URI on this computer; remove it there');
  if (!conf) throw new Error('This computer already saves everything itself');
  let copied = null;
  if (req.body?.copyBack && docs.kind === 'mongodb') {
    const local = FileDocs.at(dataDir);
    await docs.flush();
    for (const k of ['orgs', 'orgs.json', 'users.json', 'sessions.json']) local.remove(k);
    copied = await copyAll(docs, local);
  }
  saveDatabaseConfig(dataDir, null);
  console.log('[data] now saving on this computer');
  res.json({ ok: true, copied, restarting: restartForStorage() });
}));

// ---- move organizations between host computers (backup file)
app.post('/api/backup', need('admin'), wrap(async (req, res) => {
  const ids = (Array.isArray(req.body?.orgs) ? req.body.orgs : [req.rt.orgId]).map(String);
  // An admin can take the organizations they're admin of (the owner: all of them).
  if (accountsOn()) for (const id of ids) if (auth.rank(req.user, id) < RANK.admin) throw new Error("You can only back up organizations you're an admin of");
  const buf = await createBackup({ orgs, auth, orgIds: ids, password: String(req.body?.password || '') });
  const names = ids.map((id) => orgs.data.orgs.find((o) => o.id === id)?.name || id).join(' + ');
  const file = `WAVS ${names} ${new Date().toISOString().slice(0, 10)}.wavsbackup`.replace(/[^\w .+-]/g, '');
  res.set({ 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${file}"` }).send(buf);
}));
// ---- base stations
const bearer = (req) => /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '')?.[1] || null;
if (HOSTED) {
  // A laptop links itself with a website account (email + password); it gets a token.
  app.post('/api/station/pair', wrap((req, res) => {
    res.json(stations.pair({ username: req.body?.username, password: req.body?.password, name: req.body?.name, ip: clientIp(req) }));
  }));
  // While linking: bring that laptop's own organizations to the website (as new ones it runs).
  app.post('/api/station/import', express.raw({ type: '*/*', limit: '200mb' }), wrap(async (req, res) => {
    const st = stations.byToken(bearer(req));
    if (!st) return res.status(401).json({ error: 'Link this computer first' });
    const data = readBackup(req.body);
    const choices = Object.fromEntries(data.orgs.map((o) => [o.id, 'new']));
    const result = await importBackup({ data, orgs, auth, choices, withUsers: false });
    for (const r of result.imported) auth.join(st.userId, r.id, 'admin');
    stations.sendOrgs();
    res.json(result);
  }));
  app.get('/api/stations', wrap((req, res) => {
    if (!req.user) throw new Error('Sign in first');
    res.json({ stations: stations.list(req.user.id), here: req.rt ? stations.connectedFor(req.rt.orgId) : [] });
  }));
  app.delete('/api/stations/:id', wrap((req, res) => {
    if (!req.user) throw new Error('Sign in first');
    stations.remove(req.user.id, req.params.id);
    res.json({ ok: true });
  }));
} else {
  // This computer as a base station: status, link, unlink.
  app.get('/api/station', need('admin'), (_req, res) => res.json(STATION
    ? { linked: true, url: STATION.url, name: STATION.name, user: STATION.user, ...docs.status(), orgs: docs.orgList }
    : { linked: false, orgs: orgs.data.orgs.map((o) => ({ id: o.id, name: o.name })) }));
  app.post('/api/station/link', need('admin'), wrap(async (req, res) => {
    if (STATION) throw new Error('This computer is already linked');
    if (accountsOn() && !req.user?.owner) throw new Error('Only the owner can link this computer');
    let url = String(req.body?.url || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(url)) url = `https://${url}`;
    if (!/^https?:\/\/[\w.-]+(:\d+)?$/.test(url)) throw new Error('Enter the website\'s address, e.g. https://wavs-dashboard.onrender.com');
    const ask = async (pathname, init) => {
      let r;
      try { r = await fetch(`${url}${pathname}`, { ...init, signal: AbortSignal.timeout(60000) }); } catch { throw new Error(`Couldn't reach ${url}. Check the address and this computer's internet.`); }
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `The website answered ${r.status}`);
      return body;
    };
    const paired = await ask('/api/station/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: req.body?.username, password: req.body?.password, name: req.body?.name || os.hostname() }) });
    let imported = [];
    const upload = (Array.isArray(req.body?.upload) ? req.body.upload : []).map(String).filter((id) => orgs.data.orgs.some((o) => o.id === id));
    if (upload.length) {
      const buf = await createBackup({ orgs, auth, orgIds: upload });
      imported = (await ask('/api/station/import', { method: 'POST', headers: { authorization: `Bearer ${paired.token}`, 'content-type': 'application/octet-stream' }, body: buf })).imported;
    }
    saveStationConfig(dataDir, { url, token: paired.token, name: paired.station.name, user: paired.user, linkedAt: new Date().toISOString() });
    console.log(`[station] linked to ${url} as ${paired.user.username}`);
    res.json({ ok: true, user: paired.user, imported, restarting: system.restartSoon() });
  }));
}
// Unlink: an admin, or (with no organization to sign in to yet) anyone on this computer itself.
const unlinkAllowed = (req, res, next) => (STATION && !orgs.data.orgs.length && thisComputer(req.socket.remoteAddress) ? next() : need('admin')(req, res, next));
app.delete('/api/station', unlinkAllowed, wrap(async (_req, res) => {
  if (!STATION) throw new Error('This computer isn\'t linked');
  saveStationConfig(dataDir, null);
  console.log('[station] unlinked; back to this computer\'s own setup');
  res.json({ ok: true, restarting: system.restartSoon() });
}));

const pendingImports = new Map(); // token -> { buf, at }
const rawBody = express.raw({ type: '*/*', limit: '1gb' });
app.post('/api/backup/inspect', need('admin'), rawBody, wrap((req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('Choose a backup file');
  for (const [t, p] of pendingImports) if (Date.now() - p.at > 15 * 60000) pendingImports.delete(t);
  const token = crypto.randomBytes(12).toString('base64url');
  pendingImports.set(token, { buf, at: Date.now() });
  let data = null;
  try { data = readBackup(buf, req.get('x-backup-password') || ''); } catch (e) { if (!e.needsPassword) throw e; return res.json({ token, encrypted: true, needsPassword: true, error: req.get('x-backup-password') ? e.message : null }); }
  res.json({
    token, encrypted: isEncrypted(buf), createdAt: data.createdAt,
    orgs: data.orgs.map((o) => ({ id: o.id, name: o.name, files: Object.keys(o.files).length, exists: !HOSTED && orgs.data.orgs.some((x) => x.id === o.id), active: !HOSTED && o.id === req.rt.orgId })),
    users: (data.users || []).length,
  });
}));
app.post('/api/backup/import', need('admin'), wrap(async (req, res) => {
  const p = pendingImports.get(String(req.body?.token));
  if (!p) throw new Error('Choose the backup file again (it expired)');
  const data = readBackup(p.buf, String(req.body?.password || ''));
  const choices = { ...(req.body?.choices || {}) };
  for (const [id, mode] of Object.entries(choices)) {
    // Replacing needs admin rights there; the website always adds a separate copy.
    if (mode === 'replace' && (HOSTED || (accountsOn() && auth.rank(req.user, id) < RANK.admin))) choices[id] = HOSTED ? 'new' : 'skip';
  }
  if (HOSTED) for (const o of data.orgs) if (choices[o.id] !== 'skip') choices[o.id] = 'new';
  // Replacing an organization that's running: stop it first so nothing overwrites the new files.
  const replacing = Object.entries(choices).filter(([, m]) => m === 'replace').map(([id]) => id).filter((id) => runtimes.has(id));
  for (const id of replacing) stopRuntime(id);
  let result;
  try { result = await importBackup({ data, orgs, auth, choices, withUsers: !HOSTED }); } finally { for (const id of replacing) runtimeFor(id); }
  // Website: whoever imported it runs the new organization.
  if (HOSTED) for (const r of result.imported) auth.join(req.user.id, r.id, 'admin');
  pendingImports.delete(String(req.body?.token));
  if (HOSTED) broadcastTo(req.rt.orgId, { type: 'reload' }); else broadcastAll({ type: 'reload' });
  res.json({ ...result, signInNeeded: accountsOn() && !req.user });
}));

app.post('/api/system/check', need('admin'), wrap(async (req, res) => res.json(await system.check())));
app.post('/api/system/update', need('admin'), wrap(async (req, res) => {
  const r = await system.update();
  res.json(r);
  if (r.restart) system.restartSoon(); // screens reload by themselves when they reconnect (new boot id)
}));

// ---- organizations
const orgList = (user) => myOrgs(user).map((o) => ({ id: o.id, name: o.name, color: orgs.read(o.id).org.theme.accent }));
app.get('/api/orgs', (req, res) => res.json({ active: req.rt?.orgId || null, orgs: HOSTED && !req.user ? [] : orgList(req.user) }));
// New organization. Website: anyone signed in (up to 5 of their own); host computer: admins.
app.post('/api/orgs', (req, res, next) => (HOSTED ? next() : need('admin')(req, res, next)), wrap((req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) throw new Error('Give the organization a name');
  if (HOSTED) {
    if (!req.user) throw new Error('Sign in first');
    const mine = orgs.data.orgs.filter((o) => req.user.roles?.[o.id] === 'admin').length;
    if (!req.user.owner && mine >= 5) throw new Error('You can have up to 5 organizations during the beta');
  }
  const id = orgs.create(name);
  if (req.user && (HOSTED || !req.user.owner)) auth.join(req.user.id, id, 'admin');
  if (HOSTED) pickOrg(req, res, id); else switchActive(id);
  res.json({ id });
}));
app.post('/api/orgs/active', (req, res, next) => (HOSTED ? next() : need('admin')(req, res, next)), wrap((req, res) => {
  const id = String(req.body?.id);
  if (HOSTED) {
    if (!req.user || auth.rank(req.user, id) < 1) throw new Error("You're not on that organization's team");
    pickOrg(req, res, id);
    return res.json({ ok: true });
  }
  if (auth.enabled && auth.rank(req.user, id) < RANK.admin) throw new Error("You're not an admin of that organization");
  switchActive(id);
  res.json({ ok: true });
}));
app.delete('/api/orgs/:id', need('admin'), wrap((req, res) => {
  const id = req.params.id;
  if (accountsOn() && auth.rank(req.user, id) < RANK.admin) throw new Error("You're not an admin of that organization");
  if (HOSTED) {
    if (!orgs.data.orgs.some((o) => o.id === id)) throw new Error('Unknown organization');
    broadcastTo(id, { type: 'reload' });
    stopRuntime(id);
    orgs.data.orgs = orgs.data.orgs.filter((o) => o.id !== id);
    orgs.save();
    orgs.docs.remove(`orgs/${id}`);
  } else orgs.remove(id);
  if (!HOSTED) broadcastAll({ type: 'reload' });
  res.json({ ok: true });
}));

// ---- settings (gear, branding, Planning Center, alerts) for the active organization
app.get('/api/settings', (req, res) => res.json(maskSettings(req.rt.settings)));
app.put('/api/settings', need('admin'), wrap((req, res) => {
  const next = mergeIncoming(req.rt.settings, req.body || {});
  orgs.write(req.rt.orgId, next);
  restartRuntime(req.rt.orgId);
  res.json(maskSettings(next));
}));
app.post('/api/settings/test', need('admin'), wrap(async (req, res) => {
  const { kind, device } = req.body || {};
  // The website can only test services on the internet, never addresses on someone's network.
  if (HOSTED && !['planningCenter', 'stream'].includes(kind)) return res.json({ ok: false, detail: 'The website can\'t reach gear on your network. The venue computer will test it (coming soon).' });
  const dev = { ...device };
  if (kind === 'planningCenter' && dev.secret === '••••••••') dev.secret = req.rt.settings.planningCenter?.secret;
  if (kind === 'stream') {
    const saved = (req.rt.settings.streams || []).find((x) => x.id === dev.id) || {};
    if (dev.apiKey === '••••••••') dev.apiKey = saved.apiKey;
    if (dev.token === '••••••••') dev.token = saved.token;
  }
  res.json(await testDevice(kind, dev));
}));
app.post('/api/settings/logo', need('admin'), logoUpload.single('logo'), wrap(async (req, res) => {
  if (!req.file) throw new Error('Choose a PNG, JPEG or WebP image');
  await orgs.setLogo(req.rt.orgId, req.file.buffer, req.file.mimetype.split('/')[1].replace('jpeg', 'jpg'));
  broadcastTo(req.rt.orgId, { type: 'reload' });
  res.json({ ok: true });
}));
app.delete('/api/settings/logo', need('admin'), wrap(async (req, res) => {
  await orgs.setLogo(req.rt.orgId, null);
  broadcastTo(req.rt.orgId, { type: 'reload' });
  res.json({ ok: true });
}));
app.post('/api/gear/reconnect', need('admin'), wrap((req, res) => { restartRuntime(req.rt.orgId); res.json({ ok: true }); }));

// ---- people & mic assignments
app.post('/api/people', need('producer'), photoUpload, wrap((req, res) => {
  res.json(req.rt.store.addPerson({ ...req.body, photo: req.file?.filename || null }));
}));
app.put('/api/people/:id', need('producer'), photoUpload, wrap((req, res) => {
  const fields = { ...req.body };
  if (req.file) fields.photo = req.file.filename;
  else if (req.body.removePhoto === 'true') fields.photo = null;
  res.json(req.rt.store.updatePerson(req.params.id, fields));
}));
app.put('/api/people/:id/face', need('producer'), wrap((req, res) => {
  res.json(req.rt.store.setFace(req.params.id, { photo: req.body?.photo, face: req.body?.face, manual: Boolean(req.body?.manual) }));
}));
app.delete('/api/people/:id', need('producer'), wrap((req, res) => { req.rt.store.removePerson(req.params.id); res.json({ ok: true }); }));

// Alerts: snooze one for everyone for a few minutes (it comes back by itself), or wake it.
app.post('/api/alerts/snooze', need('crew'), wrap((req, res) => { req.rt.snooze(String(req.body?.key || ''), req.body?.minutes ?? 10); res.json({ ok: true }); }));
app.put('/api/assignments/:micId', need('crew'), wrap((req, res) => {
  if (!req.rt.micSlots.some((m) => m.id === req.params.micId)) throw new Error('Unknown mic');
  const result = req.rt.store.assign(req.params.micId, req.body || {});
  if (req.rt.settings.control.pushNamesToReceivers && req.body?.personId !== undefined) req.rt.pushName(req.params.micId);
  res.json(result);
}));
app.post('/api/assignments/clear', need('producer'), wrap((req, res) => { req.rt.store.clearAssignments(); res.json({ ok: true }); }));
app.put('/api/service', need('producer'), wrap((req, res) => { req.rt.store.setService({ name: req.body?.name ?? null, notes: req.body?.notes ?? '' }); res.json(req.rt.store.data.service); }));
app.post('/api/mics/:micId/push-name', need('producer'), wrap((req, res) => {
  if (!req.rt.pushName(req.params.micId)) throw new Error('Receiver does not support naming or nobody is assigned');
  res.json({ ok: true });
}));

// ---- service plan (Planning Center or manual)
app.get('/api/service', (req, res) => res.json(req.rt.service.state()));
app.post('/api/service/pco', need('producer'), wrap(async (req, res) => {
  await req.rt.service.selectPco(String(req.body?.serviceTypeId), String(req.body?.planId));
  const picked = req.rt.service.upcoming.find((u) => u.id === String(req.body?.planId));
  livePlan(req.rt, { source: 'pco', serviceTypeId: String(req.body?.serviceTypeId), planId: String(req.body?.planId), pcoTitle: picked?.title || '' });
  res.json(req.rt.service.state());
}));
app.post('/api/service/pco/refresh', need('producer'), wrap(async (req, res) => {
  await req.rt.service.refreshUpcoming();
  await req.rt.service.reloadPco();
  res.json(req.rt.service.state());
}));
// Changing the plan while a scheduled service is live also changes that service.
const livePlan = (rt, fields) => rt.schedule.syncLive({ plan: { ...(rt.schedule.live()?.plan || {}), ...fields } });
app.put('/api/service/manual', need('producer'), wrap((req, res) => {
  req.rt.service.setManual({ title: String(req.body?.title || ''), text: String(req.body?.text || ''), start: String(req.body?.start || '') });
  livePlan(req.rt, { source: 'manual', text: String(req.body?.text || '') });
  res.json(req.rt.service.state());
}));
// Matching ProPresenter's playlist to the plan: what each item matches now, and setting links.
const activePlaylist = (rt) => Object.entries(rt.hub.state.propresenter || {}).map(([id, p]) => ({ id, ...p })).find((p) => p.online && p.playlist?.items?.length);
app.get('/api/service/pp-match', need('producer'), (req, res) => {
  const pp = activePlaylist(req.rt);
  res.json({ pp: pp ? { id: pp.id, name: pp.name } : null, playlist: pp ? { name: pp.playlist.name, index: pp.playlist.index, items: req.rt.service.preview(pp.playlist) } : null, source: req.rt.service.saved.source });
});
app.put('/api/service/links', need('producer'), wrap((req, res) => {
  const { key, name, itemId } = req.body || {};
  req.rt.service.setLink({ key: String(key), name: String(name || ''), itemId: itemId || null });
  const pp = activePlaylist(req.rt); // the cued item may now point somewhere else: follow it
  if (pp && req.rt.service.saved.source !== 'propresenter') req.rt.service.onPlaylist(pp.playlist);
  res.json({ ok: true });
}));
app.post('/api/service/propresenter', need('producer'), wrap((req, res) => { req.rt.service.useProPresenter(); livePlan(req.rt, { source: 'propresenter' }); res.json(req.rt.service.state()); }));

// ---- schedule: services planned ahead (events, recurring), which one is live
app.get('/api/schedule', (req, res) => res.json(req.rt.schedule.view()));
app.post('/api/schedule/services', need('producer'), wrap((req, res) => res.json(req.rt.schedule.addService(req.body || {}))));
app.put('/api/schedule/services/:id', need('producer'), wrap((req, res) => {
  const planBefore = JSON.stringify(req.rt.schedule.get(req.params.id)?.plan);
  const s = req.rt.schedule.updateService(req.params.id, req.body || {});
  // Editing the live service: load the changes (hand-off statuses are kept; the plan only if it changed).
  if (req.rt.schedule.data.liveId === s.id) req.rt.goLive(s.id, 'edit', { reloadPlan: JSON.stringify(s.plan) !== planBefore });
  res.json(s);
}));
app.delete('/api/schedule/services/:id', need('producer'), wrap((req, res) => { req.rt.schedule.removeService(req.params.id); res.json({ ok: true }); }));
app.post('/api/schedule/services/:id/duplicate', need('producer'), wrap((req, res) => res.json(req.rt.schedule.duplicate(req.params.id, req.body || {}))));
app.post('/api/schedule/services/:id/live', need('producer'), wrap((req, res) => res.json(req.rt.goLive(req.params.id))));
app.post('/api/schedule/next', need('producer'), wrap((req, res) => {
  const next = req.rt.schedule.next();
  if (!next) throw new Error('Nothing else is scheduled. Add services on the Schedule page.');
  res.json(req.rt.goLive(next.id));
}));
app.post('/api/schedule/undo', need('producer'), wrap((req, res) => { req.rt.undoLive(); res.json(req.rt.schedule.view()); }));
app.post('/api/schedule/end', need('producer'), wrap((req, res) => { req.rt.clearLive({ end: true }); req.rt.checkSchedule(); res.json(req.rt.schedule.view()); }));
// Nothing is live but an order of service is still loaded (e.g. from before the schedule): clear it.
app.post('/api/schedule/clear', need('producer'), wrap((req, res) => {
  if (req.rt.schedule.data.liveId) throw new Error('A service is live: use End service');
  req.rt.clearLive({ end: false });
  res.json(req.rt.schedule.view());
}));
app.put('/api/schedule/options', need('producer'), wrap((req, res) => { req.rt.schedule.setOptions(req.body || {}); req.rt.checkSchedule(); res.json(req.rt.schedule.view()); }));
app.post('/api/schedule/events', need('producer'), wrap((req, res) => res.json(req.rt.schedule.addEvent(req.body || {}))));
app.put('/api/schedule/events/:id', need('producer'), wrap((req, res) => res.json(req.rt.schedule.updateEvent(req.params.id, req.body || {}))));
app.delete('/api/schedule/events/:id', need('producer'), wrap((req, res) => { req.rt.schedule.removeEvent(req.params.id, { withServices: req.query.services === '1' }); res.json({ ok: true }); }));
app.post('/api/schedule/templates', need('producer'), wrap((req, res) => res.json(req.rt.schedule.saveTemplate(req.body || {}))));
app.delete('/api/schedule/templates/:id', need('producer'), wrap((req, res) => { req.rt.schedule.removeTemplate(req.params.id); res.json({ ok: true }); }));
// Moving through the plan is allowed without the PIN so any operator can follow along.
app.post('/api/service/current', need('open'), wrap((req, res) => { req.rt.service.setCurrent(req.body?.itemId || null, 'manual'); res.json({ ok: true }); }));
app.post('/api/service/next', need('open'), wrap((req, res) => { req.rt.service.step(1); res.json({ ok: true }); }));
app.post('/api/service/previous', need('open'), wrap((req, res) => { req.rt.service.step(-1); res.json({ ok: true }); }));
app.post('/api/service/reset', need('producer'), wrap((req, res) => { req.rt.service.resetProgress(); res.json({ ok: true }); }));

// ---- shared notes & checklists (team-editable, no PIN)
app.put('/api/notes/:name', need('open'), wrap((req, res) => { req.rt.board.setNote(req.params.name, req.body?.text); res.json({ ok: true }); }));
app.put('/api/checklists/:name', need('open'), wrap((req, res) => { req.rt.board.setChecklist(req.params.name, req.body || {}); res.json({ ok: true }); }));
app.post('/api/checklists/:name/toggle', need('open'), wrap((req, res) => { req.rt.board.toggle(req.params.name, req.body?.itemId, req.body?.done); res.json({ ok: true }); }));
app.post('/api/checklists/:name/reset', need('open'), wrap((req, res) => { req.rt.board.resetChecklist(req.params.name); res.json({ ok: true }); }));

// ---- dashboards (layouts)
app.get('/api/dashboards', (req, res) => res.json(req.rt.dashboards.list()));
app.post('/api/dashboards', need('producer'), wrap((req, res) => res.json(req.rt.dashboards.create(req.body || {}))));
app.put('/api/dashboards/:id', need('producer'), wrap((req, res) => res.json(req.rt.dashboards.update(req.params.id, req.body || {}))));
app.delete('/api/dashboards/:id', need('producer'), wrap((req, res) => { req.rt.dashboards.remove(req.params.id); res.json({ ok: true }); }));

// ---- live streams: pin or hide a comment
app.post('/api/streams/pin', need('producer'), wrap((req, res) => { req.rt.streams.pin(req.body?.id || null); res.json({ ok: true }); }));
app.post('/api/streams/hide', need('producer'), wrap((req, res) => { req.rt.streams.hide(String(req.body?.id)); res.json({ ok: true }); }));

// ---- ProPresenter
app.get('/api/propresenter/:id/thumbnail/:uuid/:index', async (req, res) => {
  try {
    const img = await req.rt.propresenters[req.params.id]?.thumbnail(req.params.uuid, req.params.index);
    if (!img) return res.status(404).end();
    res.set('content-type', img.type).set('cache-control', 'max-age=30').send(img.body);
  } catch { res.status(502).end(); }
});
app.post('/api/propresenter/:id/stage-message', need('producer'), wrap(async (req, res) => {
  if (!req.rt.settings.control.propresenterStageMessage) throw new Error('Stage messages are turned off (Settings → Remote control)');
  const pp = req.rt.propresenters[req.params.id];
  if (!pp) throw new Error('Unknown ProPresenter');
  await pp.setStageMessage(String(req.body?.text || '').slice(0, 300));
  res.json({ ok: true });
}));

// ---- comms: join links / QR code for phones
app.get('/api/comms/info', (req, res) => {
  // Website: one link for every phone, on any network.
  if (HOSTED) return res.json({ hosted: true, lan: [], joinUrls: [], remote: { enabled: true, status: 'on', url: `${shareBase(req)}/comms?org=${encodeURIComponent(req.rt.orgId)}` } });
  const ips = lanAddresses();
  const local = os.hostname().replace(/\.local$/i, '');
  res.json({
    httpsPort: tlsPort,
    // Same Wi-Fi: every address this computer has (best guess first), plus its Bonjour name.
    lan: [
      ...ips.map((i) => ({ url: `https://${i.address}:${tlsPort}/comms`, label: `${i.address} (${i.iface})`, likely: i.likely })),
      ...(localName.active ? [{ url: `https://${localName.host}:${tlsPort}/comms`, label: `${localName.host} (name)`, likely: false }] : []),
      { url: `https://${local}.local:${tlsPort}/comms`, label: `${local}.local (computer name)`, likely: false },
    ],
    joinUrls: ips.map((i) => `https://${i.address}:${tlsPort}/comms`),
    hostname: os.hostname(),
    httpUrl: ips[0] ? `http://${ips[0].address}:${cfg.server.port}` : null,
    remote: { ...tunnel.publicState(), url: offsiteUrl('/comms') },
  });
});
// Off-site access: the whole dashboard (signed in) and comms from any network, through Cloudflare.
const offsiteUrl = (pathname = '') => (tunnel.state.status === 'on' && tunnel.state.url ? `${tunnel.state.url}${pathname}` : null);
app.get('/api/remote', need('admin'), (req, res) => res.json({ ...tunnel.publicState(), url: offsiteUrl(''), accounts: accountsOn() }));
app.post('/api/comms/remote', need('admin'), wrap(async (req, res) => {
  const b = req.body || {};
  if (b.mode || b.token !== undefined || b.hostname !== undefined) tunnel.configure({ mode: b.mode, token: b.token, hostname: b.hostname });
  if (b.on !== undefined) tunnel.enable(Boolean(b.on)); // starts in the background; status comes back through /api/remote
  else if (tunnel.enabled) tunnel.restart();
  res.json({ ok: true });
}));
app.get('/api/comms/qr.svg', wrap(async (req, res) => {
  const url = String(req.query.url || '');
  if (!/^https?:\/\/[^\s]{1,200}$/.test(url)) throw new Error('Bad URL');
  res.type('image/svg+xml').send(await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#000000', light: '#ffffff' } }));
}));

// ---- pages & static files
const pub = path.join(ROOT, 'public');
// The comms engine needs a "secure" page for the microphone and audio processing; browsers
// treat http://localhost as secure but not http://name.local or http://192.168…. The engine
// always runs on this computer, so if it's opened here by another name, use localhost instead.
const thisComputer = (ip) => {
  const a = String(ip || '').replace(/^::ffff:/, '');
  if (a === '127.0.0.1' || a === '::1') return true;
  return Object.values(os.networkInterfaces()).flat().some((i) => i && i.address === a);
};
app.get('/comms/engine', (req, res, next) => {
  if (req.viaTunnel || req.secure || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.get('host') || '')) return next();
  if (!thisComputer(req.socket.remoteAddress)) return next(); // the page explains what to do
  res.redirect(`http://localhost:${cfg.server.port}/comms/engine`);
});

const pages = {
  '/': 'home.html', '/welcome': 'welcome.html', '/dashboards': 'dashboard.html', '/d/:slug': 'dashboard.html', '/tv/:org/:dash': 'dashboard.html',
  '/greenroom': 'greenroom.html', '/rf': 'rf.html', '/admin': 'admin.html', '/people': 'people.html', '/schedule': 'schedule.html', '/gear': 'gear.html', '/settings': 'settings.html',
  '/comms': 'comms.html', '/comms/control': 'comms-control.html', '/comms/engine': 'comms-engine.html',
  '/login': 'login.html', '/join/:code': 'login.html', '/signup': 'login.html', '/forgot': 'login.html', '/reset/:token': 'login.html',
};
// Website: a TV link carries its organization's key; the TV keeps it (cookie) and can then show
// that organization's dashboards without anyone signing in. Someone signed in just switches to it.
app.get('/tv/:org/:dash', (req, res, next) => {
  if (!HOSTED) return next();
  const { org } = req.params;
  if (req.user && auth.rank(req.user, org) >= 1) pickOrg(req, res, org);
  else if (orgs.tvKeyOk(org, req.query.k)) res.append('set-cookie', `wavs_tv=${encodeURIComponent(`${org}.${req.query.k}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${3650 * 86400}${req.secure ? '; Secure' : ''}`);
  else if (!tvViewer(req)) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  next();
});
for (const [route, file] of Object.entries(pages)) app.get(route, (req, res) => res.sendFile(path.join(pub, file)));
app.get('/uploads/:file', wrap(async (req, res) => {
  const f = await req.rt.store.getPhoto(req.params.file);
  if (!f) return res.status(404).end();
  res.set('cache-control', 'public, max-age=3600').type(f.type).send(f.data);
}));
app.get('/logo', wrap(async (req, res) => {
  const key = orgs.logoKey(req.rt.orgId);
  const f = key && await orgs.docs.getFile(key);
  if (!f) return res.status(404).end();
  res.set('cache-control', 'no-cache').type(f.type).send(f.data);
}));
// Face finding for photo crops (runs in the browser; the models are bundled, so no internet needed).
const faceApi = path.join(ROOT, 'node_modules/@vladmandic/face-api');
app.get('/vendor/face-api.esm.js', (req, res) => res.sendFile(path.join(faceApi, 'dist/face-api.esm.js'), { maxAge: '7d' }));
app.get('/vendor/face-models/:file', (req, res) => {
  const f = path.basename(req.params.file);
  if (!/^ssd_mobilenetv1_model/.test(f)) return res.status(404).end();
  res.sendFile(path.join(faceApi, 'model', f), { maxAge: '7d' }, (e) => e && res.status(404).end());
});
app.get('/vendor/hls.min.js', (req, res) => res.sendFile(path.join(ROOT, 'node_modules/hls.js/dist/hls.min.js')));
app.get('/vendor/gridstack-all.js', (req, res) => res.sendFile(path.join(ROOT, 'node_modules/gridstack/dist/gridstack-all.js')));
app.get('/vendor/gridstack.min.css', (req, res) => res.sendFile(path.join(ROOT, 'node_modules/gridstack/dist/gridstack.min.css')));
app.use(express.static(pub));

// ---------------------------------------------------------------- websocket

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true }); // dashboards
const commsWss = new WebSocketServer({ noServer: true }); // phones, comms engine, comms control
const stationWss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 }); // base stations (website)
commsWss.on('connection', (ws, req) => { ws.orgId = req.rt.orgId; req.rt.comms.attach(ws, req); });

function upgrade(req, socket, head) {
  req.viaTunnel = Boolean(req.viaTunnel);
  if (HOSTED && req.url.startsWith('/station-ws')) {
    const st = stations.byToken(/^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1]);
    if (!st) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    stationWss.handleUpgrade(req, socket, head, (ws) => stations.attach(ws, st));
    return;
  }
  req.user = auth.session(sessionToken(req));
  const { pathname } = new URL(req.url, 'http://x');
  req.tv = !req.user && HOSTED ? tvViewer(req) : null;
  req.rt = runtimeFor(orgFor(req, pathname));
  req.authRank = accountsOn() && req.rt ? auth.rank(req.user, req.rt.orgId) : 0;
  const deny = (code) => socket.end(`HTTP/1.1 ${code}\r\n\r\n`);
  if (!req.rt) return deny('401 Unauthorized');
  if (pathname === '/ws' && (loginRequired() || req.viaTunnel) && accountsOn() && req.authRank < 1 && !req.tv) return deny('401 Unauthorized');
  if (pathname === '/ws') wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  else if (pathname === '/comms-ws') commsWss.handleUpgrade(req, socket, head, (ws) => commsWss.emit('connection', ws, req));
  else socket.destroy();
}
server.on('upgrade', upgrade);

// ---------------------------------------------------------------- off-site access (Cloudflare tunnel)
// A local-only server that the Cloudflare link points at. It's the same dashboard, but every
// request through it is marked off-site, so it needs a signed-in account (see the gate above),
// and the comms engine can't run through it.
const remoteServer = http.createServer((req, res) => { req.viaTunnel = true; app(req, res); });
remoteServer.on('upgrade', (req, socket, head) => { req.viaTunnel = true; upgrade(req, socket, head); });
const tunnel = new Tunnel(dataDir, 0);
const REMOTE_PORT = Number(process.env.COMMS_REMOTE_PORT) || 8090; // fixed, so a Cloudflare tunnel with your own address can point at it
remoteServer.on('error', (e) => {
  if (e.code !== 'EADDRINUSE' || remoteServer.listening) return console.error(`[remote] ${e.message}`);
  console.error(`[remote] port ${REMOTE_PORT} is busy; using another one (a free Cloudflare link still works)`);
  remoteServer.listen(0, '127.0.0.1');
});
remoteServer.on('listening', () => {
  tunnel.port = remoteServer.address().port;
  if (tunnel.enabled) tunnel.start();
});
if (!HOSTED) remoteServer.listen(REMOTE_PORT, '127.0.0.1');

// HTTPS (self-signed) so phones may use their microphone for comms. Browsers only allow
// microphones on https:// pages (or localhost). The certificate is created once and kept in data/tls/.
const tlsPort = Number(process.env.HTTPS_PORT || cfg.server.httpsPort || 8443);
async function tlsOptions() {
  const dir = path.join(dataDir, 'tls');
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  if (!fs.existsSync(keyFile)) {
    fs.mkdirSync(dir, { recursive: true });
    const altNames = [{ type: 2, value: 'localhost' }, { type: 2, value: localName.host || 'wavs.local' }, { type: 2, value: os.hostname() }, { type: 2, value: `${os.hostname().replace(/\.local$/, '')}.local` },
      { type: 7, ip: '127.0.0.1' }, ...lanAddresses().map((i) => ({ type: 7, ip: i.address }))];
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'WAVS Dashboard' }], { days: 3650, keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames }] });
    fs.writeFileSync(keyFile, pems.private, { mode: 0o600 });
    fs.writeFileSync(certFile, pems.cert);
  }
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
}

/** Every screen of one organization. */
function broadcastTo(orgId, msg) {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws.readyState === 1 && ws.orgId === orgId) ws.send(data);
}

function broadcastAll(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(data);
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.orgId = req.rt.orgId;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify({ ...req.rt.snapshot(), boot: BOOT }));
});

// Website: an organization nobody has used for a while stops (it starts again when someone opens it).
if (HOSTED) {
  setInterval(() => {
    const inUse = new Set([...wss.clients, ...commsWss.clients].map((ws) => ws.orgId));
    for (const [id, r] of runtimes) if (!inUse.has(id) && Date.now() - r.lastUsed > 2 * 3600000) { console.log(`[orgs] idle: ${r.settings.org.name}`); stopRuntime(id); }
  }, 10 * 60000).unref();
}
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000).unref();

// ---------------------------------------------------------------- start

if (!HOSTED) runtimeFor(activeId());
// Organizations added, renamed or removed elsewhere.
orgs.onChange = () => {
  for (const id of [...runtimes.keys()]) if (!orgs.data.orgs.some((o) => o.id === id)) stopRuntime(id);
  // A base station's first sync (or a new organization on the website): run one.
  if (!HOSTED && !runtimes.size) runtimeFor(activeId());
  if (!HOSTED) broadcastAll({ type: 'reload' });
};
// A base station tells open screens when it goes on or offline (the header shows it).
link?.on('online', () => broadcastAll({ type: 'station', online: true }));
link?.on('offline', () => broadcastAll({ type: 'station', online: false }));
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\nThe dashboard is already running (port ${cfg.server.port} is in use).`);
    console.error(`If you set it to start by itself, it's running in the background: open http://localhost:${cfg.server.port}`);
    console.error('To stop the background copy: npm run service:stop\n');
    process.exit(1);
  }
  throw e;
});
server.listen(cfg.server.port, cfg.server.host, async () => {
  console.log(`WAVS Dashboard running: http://localhost:${cfg.server.port}`);
  console.log(`  Organizations: ${orgs.list().map((o) => o.name).join(', ')}`);
  if (HOSTED) { console.log(`  Website mode: sign-ups ${site.signups}${OWNER_EMAIL ? `, owner ${OWNER_EMAIL}` : ''}`); return; }
  await startLocalName(dataDir);
  // http://wavs.local without ":8080" when port 80 is free (allowed for normal users on macOS).
  if (cfg.server.port !== 80) {
    const plain = http.createServer(app);
    plain.on('upgrade', upgrade);
    await listenPort80(plain, cfg.server.host);
  }
  if (localName.active) console.log(`  On this network: http://${localName.host}${localName.port80 || cfg.server.port === 80 ? '' : `:${cfg.server.port}`}`);
});
if (tlsPort && !HOSTED) {
  tlsOptions().then((opts) => {
    const secure = https.createServer(opts, app);
    secure.on('upgrade', upgrade);
    secure.on('error', (e) => console.error(`[https] ${e.message}`));
    secure.listen(tlsPort, cfg.server.host, () => {
      const ips = lanAddresses();
      console.log(`  Comms for phones: ${ips.length ? ips.map((i) => `https://${i.address}:${tlsPort}/comms`).join('  ') : `https://localhost:${tlsPort}/comms`}`);
    });
  }).catch((e) => console.error(`[https] could not start: ${e.message}`));
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    for (const id of [...runtimes.keys()]) stopRuntime(id);
    auth.flush();
    tunnel.stop();
    stopLocalName();
    server.close();
    await docs.close(); // finish saving to the cloud database (a few seconds at most)
    process.exit(0);
  });
}
