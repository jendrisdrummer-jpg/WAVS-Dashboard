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
import { System } from './system.js';

// config.yaml now only holds server settings (port). Everything else (gear, branding, PIN,
// Planning Center) is per organization and edited in the browser. On first run the
// organization is created from config.yaml, so existing setups carry over.
const cfg = loadConfig();
const dataDir = dataDirFor({ root: ROOT });
if (!process.env.WAVS_DATA) {
  const from = adoptOldData(dataDir, oldDataCandidates({ root: ROOT }));
  if (from) console.log(`[data] copied your existing setup from ${from}`);
}
console.log(`[data] saved in ${dataDir}`);
// Running in the background: keep the log file from growing forever.
if (process.env.WAVS_SERVICE === '1') {
  const log = path.join(dataDir, 'logs', 'dashboard.log');
  try { if (fs.statSync(log).size > 10 * 1024 * 1024) fs.truncateSync(log, 0); } catch { /* no log yet */ }
}
const system = new System(ROOT);
const BOOT = crypto.randomUUID(); // changes on every start, so open screens can pick up a new version
const orgs = new OrgRegistry(dataDir);
orgs.migrate(cfg);
const auth = new Auth(dataDir);

let rt = null; // Runtime for the active organization

function startRuntime() {
  const id = orgs.data.active || orgs.data.orgs[0].id;
  const next = new Runtime({ orgId: id, dir: orgs.dir(id), settings: orgs.read(id), accounts: () => auth.enabled });
  next.on('message', broadcast);
  next.start();
  rt = next;
  console.log(`[orgs] active organization: ${rt.settings.org.name}`);
}

/** Stop the current organization's gear and start again (after a switch or a gear change). */
function restartRuntime() {
  rt?.stop();
  startRuntime();
  broadcast({ type: 'reload' });
}

function publicConfig(req) {
  const s = rt.settings;
  return {
    auth: {
      enabled: auth.enabled,
      requireLogin: Boolean(auth.data.requireLogin),
      user: req.user ? auth.view(req.user, rt.orgId) : null,
      role: auth.enabled ? auth.roleIn(req.user, rt.orgId) : 'admin',
    },
    org: { name: s.org.name, serviceName: s.org.serviceName, theme: s.org.theme, logo: Boolean(orgs.logoFile(rt.orgId)) },
    orgId: rt.orgId,
    orgs: orgs.list(),
    tvBase: tvBase(req),
    setupComplete: s.setupComplete,
    dataDir,
    alerts: s.alerts,
    rf: s.rf,
    video: s.video,
    control: s.control,
    switchers: s.switchers.map((x) => ({ id: x.id, name: x.name, me: x.me || 1 })),
    propresenter: s.propresenter.map((x) => ({ id: x.id, name: x.name })),
    planningCenter: Boolean(s.planningCenter),
    pinRequired: !auth.enabled && Boolean(s.security.adminPin),
  };
}

// ---------------------------------------------------------------- http

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));

const requirePin = (req, res, next) => (checkPin(rt.settings.security.adminPin, req.get('x-admin-pin'))
  ? next()
  : res.status(401).json({ error: 'PIN required' }));

// Who is signed in (session cookie).
app.use((req, _res, next) => { req.user = auth.session(sessionToken(req)); next(); });

// Off-site (through the Cloudflare link, from any network): everyone signs in, whatever the
// "require sign-in" setting, and accounts must exist. Only the sign-in pages, static files and
// the comms phone page are open. The first (owner) account can only be made on this computer.
const OFFSITE_OPEN = /^\/(login|join\/|api\/auth\/(status|login|logout|invite\/)|css\/|js\/|vendor\/|logo$|comms$|favicon)/;
app.use((req, res, next) => {
  if (!req.viaTunnel) return next();
  if (req.path === '/api/auth/owner') return res.status(403).json({ error: 'Create the first account on the dashboard computer itself, then sign in here.' });
  if (OFFSITE_OPEN.test(req.path)) return next();
  if (!auth.enabled) {
    if (req.path === '/') return res.redirect('/comms');
    return res.status(403).send('The dashboard can be opened from anywhere once accounts are set up (Settings → Accounts on the dashboard computer). Comms works now at /comms.');
  }
  if (req.user && auth.rank(req.user, rt.orgId) >= 1) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) return res.status(401).json({ error: 'Sign in first', login: true });
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
});

/**
 * Role needed for an action. Before the first account exists, the old admin PIN (if set) guards
 * every change, as before. After that, signed-in roles do: crew < producer < admin.
 */
const need = (role) => (req, res, next) => {
  if (!auth.enabled) return role === 'open' ? next() : requirePin(req, res, next);
  if (role === 'open' && !auth.data.requireLogin) return next();
  if (!req.user) return res.status(401).json({ error: 'Sign in to do that', login: true });
  const have = auth.rank(req.user, rt.orgId);
  const want = RANK[role] || 1;
  if (have < want) return res.status(403).json({ error: have ? `That needs ${role} access. Ask an admin.` : `Your account doesn't have access to ${rt.settings.org.name}. Ask an admin.` });
  next();
};

// "Require sign-in to view": everything except the sign-in pages, static files and the comms
// phone page (crew sign in to comms with their name) needs a signed-in account.
const PUBLIC = /^\/(login|join\/|api\/auth\/|css\/|js\/|vendor\/|logo$|comms$|api\/comms\/qr\.svg)/;
app.use((req, res, next) => {
  if (!auth.enabled || !auth.data.requireLogin || PUBLIC.test(req.path)) return next();
  if (req.user && auth.rank(req.user, rt.orgId) >= 1) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) return res.status(401).json({ error: 'Sign in first', login: true });
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
});

const images = /^image\/(jpeg|png|webp|gif|heic|heif|svg\+xml)$/;
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, rt.store.uploads),
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg'}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, images.test(file.mimetype) && file.mimetype !== 'image/svg+xml'),
});
const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 }, fileFilter: (_req, f, cb) => cb(null, /^image\/(png|jpeg|webp)$/.test(f.mimetype)) });

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { res.status(400).json({ error: e.message }); }
};

app.get('/api/config', (req, res) => res.json(publicConfig(req)));
app.get('/api/state', (_req, res) => res.json(rt.snapshot()));
app.post('/api/pin/check', need('admin'), (_req, res) => res.json({ ok: true }));

// ---- accounts & sign in
const signIn = (req, res, token) => res.setHeader('set-cookie', sessionCookie(token, { secure: req.secure || Boolean(req.viaTunnel) }));
const clientIp = (req) => (req.viaTunnel && req.get('cf-connecting-ip')) || req.socket.remoteAddress || '';
// What the sign-in page needs (public, even when sign-in is required to view).
app.get('/api/auth/status', (req, res) => res.json({
  org: { name: rt.settings.org.name, theme: rt.settings.org.theme, logo: Boolean(orgs.logoFile(rt.orgId)) },
  auth: { enabled: auth.enabled, user: req.user ? { name: req.user.name } : null, role: auth.roleIn(req.user, rt.orgId) },
  pinRequired: !auth.enabled && Boolean(rt.settings.security.adminPin),
}));
app.post('/api/auth/owner', wrap((req, res) => {
  // The first account. If the old admin PIN is set, it's needed to claim the dashboard.
  if (rt.settings.security.adminPin && !checkPin(rt.settings.security.adminPin, req.body?.pin)) throw new Error('Enter the current admin PIN to create the owner account');
  const u = auth.createOwner(req.body || {});
  signIn(req, res, auth.startSession(u));
  res.json({ ok: true });
}));
app.post('/api/auth/login', wrap((req, res) => {
  signIn(req, res, auth.login(req.body?.username, req.body?.password, clientIp(req)));
  res.json({ ok: true });
}));
app.post('/api/auth/logout', (req, res) => { auth.logout(sessionToken(req)); signIn(req, res, null); res.json({ ok: true }); });
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
  const ip = lanAddresses()[0]?.address;
  if (!ip) return shareBase(req);
  const port = localName.port80 || cfg.server.port === 80 ? '' : `:${cfg.server.port}`;
  return `http://${ip}${port}`;
}

app.get('/api/users', need('admin'), (req, res) => {
  res.json({
    users: auth.data.users.map((u) => auth.view(u, rt.orgId)),
    invites: auth.data.invites.filter((i) => i.orgId === rt.orgId && i.expires > Date.now()).map((i) => ({ ...i, url: `${shareBase(req)}/join/${i.code}`, anywhereUrl: offsiteUrl(`/join/${i.code}`) })),
    requireLogin: Boolean(auth.data.requireLogin),
    orgs: orgs.data.orgs,
  });
});
app.post('/api/users/invite', need('admin'), wrap((req, res) => {
  const inv = auth.invite({ orgId: rt.orgId, role: req.body?.role, by: req.user?.id, days: req.body?.days, label: req.body?.label });
  res.json({ ...inv, url: `${shareBase(req)}/join/${inv.code}`, anywhereUrl: offsiteUrl(`/join/${inv.code}`) });
}));
app.delete('/api/users/invite/:code', need('admin'), wrap((req, res) => { auth.revokeInvite(req.params.code); res.json({ ok: true }); }));
app.put('/api/users/:id/role', need('admin'), wrap((req, res) => {
  if (req.params.id === req.user?.id) throw new Error("You can't change your own role");
  auth.setRole(req.params.id, rt.orgId, req.body?.role || null);
  res.json({ ok: true });
}));
app.post('/api/users/:id/reset', need('admin'), wrap((req, res) => res.json({ password: auth.resetPassword(req.params.id) })));
app.delete('/api/users/:id', need('admin'), wrap((req, res) => {
  if (!req.user?.owner) throw new Error('Only the owner can delete accounts. You can remove their access to this organization instead.');
  auth.remove(req.params.id);
  res.json({ ok: true });
}));
app.put('/api/auth/require-login', need('admin'), wrap((req, res) => { auth.setRequireLogin(req.body?.on); broadcast({ type: 'reload' }); res.json({ ok: true }); }));

// ---- this computer: address, background service, version and updates (admins)
app.get('/api/system', need('admin'), wrap(async (req, res) => {
  const port = cfg.server.port;
  res.json({
    ...(await system.version()),
    git: system.isGit,
    root: ROOT,
    dataDir,
    service: { running: system.asService, installed: system.serviceInstalled(), platform: process.platform },
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

// ---- move organizations between host computers (backup file)
app.post('/api/backup', need('admin'), wrap((req, res) => {
  const ids = (Array.isArray(req.body?.orgs) ? req.body.orgs : [rt.orgId]).map(String);
  // An admin can take the organizations they're admin of (the owner: all of them).
  if (auth.enabled) for (const id of ids) if (auth.rank(req.user, id) < RANK.admin) throw new Error("You can only back up organizations you're an admin of");
  const buf = createBackup({ orgs, auth, orgIds: ids, password: String(req.body?.password || '') });
  const names = ids.map((id) => orgs.data.orgs.find((o) => o.id === id)?.name || id).join(' + ');
  const file = `WAVS ${names} ${new Date().toISOString().slice(0, 10)}.wavsbackup`.replace(/[^\w .+-]/g, '');
  res.set({ 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${file}"` }).send(buf);
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
    orgs: data.orgs.map((o) => ({ id: o.id, name: o.name, files: Object.keys(o.files).length, exists: orgs.data.orgs.some((x) => x.id === o.id), active: o.id === rt.orgId })),
    users: (data.users || []).length,
  });
}));
app.post('/api/backup/import', need('admin'), wrap((req, res) => {
  const p = pendingImports.get(String(req.body?.token));
  if (!p) throw new Error('Choose the backup file again (it expired)');
  const data = readBackup(p.buf, String(req.body?.password || ''));
  const choices = req.body?.choices || {};
  // Replacing the organization that's running: stop it first so nothing overwrites the new files.
  const replacingActive = choices[rt.orgId] === 'replace';
  if (replacingActive) rt.stop();
  let result;
  try { result = importBackup({ data, orgs, auth, choices }); } finally { if (replacingActive) startRuntime(); }
  pendingImports.delete(String(req.body?.token));
  broadcast({ type: 'reload' });
  res.json({ ...result, signInNeeded: auth.enabled && !req.user });
}));

app.post('/api/system/check', need('admin'), wrap(async (_req, res) => res.json(await system.check())));
app.post('/api/system/update', need('admin'), wrap(async (_req, res) => {
  const r = await system.update();
  res.json(r);
  if (r.restart) system.restartSoon(); // screens reload by themselves when they reconnect (new boot id)
}));

// ---- organizations
app.get('/api/orgs', (_req, res) => res.json({ active: rt.orgId, orgs: orgs.list() }));
app.post('/api/orgs', need('admin'), wrap((req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) throw new Error('Give the organization a name');
  const id = orgs.create(name);
  if (req.user && !req.user.owner) auth.setRole(req.user.id, id, 'admin');
  orgs.setActive(id);
  restartRuntime();
  res.json({ id });
}));
app.post('/api/orgs/active', need('admin'), wrap((req, res) => {
  if (auth.enabled && auth.rank(req.user, String(req.body?.id)) < RANK.admin) throw new Error("You're not an admin of that organization");
  orgs.setActive(String(req.body?.id));
  restartRuntime();
  res.json({ ok: true });
}));
app.delete('/api/orgs/:id', need('admin'), wrap((req, res) => { orgs.remove(req.params.id); broadcast({ type: 'reload' }); res.json({ ok: true }); }));

// ---- settings (gear, branding, Planning Center, alerts) for the active organization
app.get('/api/settings', (_req, res) => res.json(maskSettings(rt.settings)));
app.put('/api/settings', need('admin'), wrap((req, res) => {
  const next = mergeIncoming(rt.settings, req.body || {});
  orgs.write(rt.orgId, next);
  restartRuntime();
  res.json(maskSettings(next));
}));
app.post('/api/settings/test', need('admin'), wrap(async (req, res) => {
  const { kind, device } = req.body || {};
  const dev = { ...device };
  if (kind === 'planningCenter' && dev.secret === '••••••••') dev.secret = rt.settings.planningCenter?.secret;
  if (kind === 'stream') {
    const saved = (rt.settings.streams || []).find((x) => x.id === dev.id) || {};
    if (dev.apiKey === '••••••••') dev.apiKey = saved.apiKey;
    if (dev.token === '••••••••') dev.token = saved.token;
  }
  res.json(await testDevice(kind, dev));
}));
app.post('/api/settings/logo', need('admin'), logoUpload.single('logo'), wrap((req, res) => {
  if (!req.file) throw new Error('Choose a PNG, JPEG or WebP image');
  const dir = orgs.dir(rt.orgId);
  const old = orgs.logoFile(rt.orgId);
  if (old) fs.rmSync(path.join(dir, old), { force: true });
  fs.writeFileSync(path.join(dir, `logo.${req.file.mimetype.split('/')[1].replace('jpeg', 'jpg')}`), req.file.buffer);
  broadcast({ type: 'reload' });
  res.json({ ok: true });
}));
app.delete('/api/settings/logo', need('admin'), wrap((_req, res) => {
  const old = orgs.logoFile(rt.orgId);
  if (old) fs.rmSync(path.join(orgs.dir(rt.orgId), old), { force: true });
  broadcast({ type: 'reload' });
  res.json({ ok: true });
}));
app.post('/api/gear/reconnect', need('admin'), wrap((_req, res) => { restartRuntime(); res.json({ ok: true }); }));

// ---- people & mic assignments
app.post('/api/people', need('producer'), upload.single('photo'), wrap((req, res) => {
  res.json(rt.store.addPerson({ ...req.body, photo: req.file?.filename || null }));
}));
app.put('/api/people/:id', need('producer'), upload.single('photo'), wrap((req, res) => {
  const fields = { ...req.body };
  if (req.file) fields.photo = req.file.filename;
  else if (req.body.removePhoto === 'true') fields.photo = null;
  res.json(rt.store.updatePerson(req.params.id, fields));
}));
app.put('/api/people/:id/face', need('producer'), wrap((req, res) => {
  res.json(rt.store.setFace(req.params.id, { photo: req.body?.photo, face: req.body?.face, manual: Boolean(req.body?.manual) }));
}));
app.delete('/api/people/:id', need('producer'), wrap((req, res) => { rt.store.removePerson(req.params.id); res.json({ ok: true }); }));

// Alerts: snooze one for everyone for a few minutes (it comes back by itself), or wake it.
app.post('/api/alerts/snooze', need('crew'), wrap((req, res) => { rt.snooze(String(req.body?.key || ''), req.body?.minutes ?? 10); res.json({ ok: true }); }));
app.put('/api/assignments/:micId', need('crew'), wrap((req, res) => {
  if (!rt.micSlots.some((m) => m.id === req.params.micId)) throw new Error('Unknown mic');
  const result = rt.store.assign(req.params.micId, req.body || {});
  if (rt.settings.control.pushNamesToReceivers && req.body?.personId !== undefined) rt.pushName(req.params.micId);
  res.json(result);
}));
app.post('/api/assignments/clear', need('producer'), wrap((_req, res) => { rt.store.clearAssignments(); res.json({ ok: true }); }));
app.put('/api/service', need('producer'), wrap((req, res) => { rt.store.setService({ name: req.body?.name ?? null, notes: req.body?.notes ?? '' }); res.json(rt.store.data.service); }));
app.post('/api/mics/:micId/push-name', need('producer'), wrap((req, res) => {
  if (!rt.pushName(req.params.micId)) throw new Error('Receiver does not support naming or nobody is assigned');
  res.json({ ok: true });
}));

// ---- service plan (Planning Center or manual)
app.get('/api/service', (_req, res) => res.json(rt.service.state()));
app.post('/api/service/pco', need('producer'), wrap(async (req, res) => {
  await rt.service.selectPco(String(req.body?.serviceTypeId), String(req.body?.planId));
  const picked = rt.service.upcoming.find((u) => u.id === String(req.body?.planId));
  livePlan({ source: 'pco', serviceTypeId: String(req.body?.serviceTypeId), planId: String(req.body?.planId), pcoTitle: picked?.title || '' });
  res.json(rt.service.state());
}));
app.post('/api/service/pco/refresh', need('producer'), wrap(async (_req, res) => {
  await rt.service.refreshUpcoming();
  await rt.service.reloadPco();
  res.json(rt.service.state());
}));
// Changing the plan while a scheduled service is live also changes that service.
const livePlan = (fields) => rt.schedule.syncLive({ plan: { ...(rt.schedule.live()?.plan || {}), ...fields } });
app.put('/api/service/manual', need('producer'), wrap((req, res) => {
  rt.service.setManual({ title: String(req.body?.title || ''), text: String(req.body?.text || ''), start: String(req.body?.start || '') });
  livePlan({ source: 'manual', text: String(req.body?.text || '') });
  res.json(rt.service.state());
}));
// Matching ProPresenter's playlist to the plan: what each item matches now, and setting links.
const activePlaylist = () => Object.entries(rt.hub.state.propresenter || {}).map(([id, p]) => ({ id, ...p })).find((p) => p.online && p.playlist?.items?.length);
app.get('/api/service/pp-match', need('producer'), (_req, res) => {
  const pp = activePlaylist();
  res.json({ pp: pp ? { id: pp.id, name: pp.name } : null, playlist: pp ? { name: pp.playlist.name, index: pp.playlist.index, items: rt.service.preview(pp.playlist) } : null, source: rt.service.saved.source });
});
app.put('/api/service/links', need('producer'), wrap((req, res) => {
  const { key, name, itemId } = req.body || {};
  rt.service.setLink({ key: String(key), name: String(name || ''), itemId: itemId || null });
  const pp = activePlaylist(); // the cued item may now point somewhere else: follow it
  if (pp && rt.service.saved.source !== 'propresenter') rt.service.onPlaylist(pp.playlist);
  res.json({ ok: true });
}));
app.post('/api/service/propresenter', need('producer'), wrap((_req, res) => { rt.service.useProPresenter(); livePlan({ source: 'propresenter' }); res.json(rt.service.state()); }));

// ---- schedule: services planned ahead (events, recurring), which one is live
app.get('/api/schedule', (_req, res) => res.json(rt.schedule.view()));
app.post('/api/schedule/services', need('producer'), wrap((req, res) => res.json(rt.schedule.addService(req.body || {}))));
app.put('/api/schedule/services/:id', need('producer'), wrap((req, res) => {
  const planBefore = JSON.stringify(rt.schedule.get(req.params.id)?.plan);
  const s = rt.schedule.updateService(req.params.id, req.body || {});
  // Editing the live service: load the changes (hand-off statuses are kept; the plan only if it changed).
  if (rt.schedule.data.liveId === s.id) rt.goLive(s.id, 'edit', { reloadPlan: JSON.stringify(s.plan) !== planBefore });
  res.json(s);
}));
app.delete('/api/schedule/services/:id', need('producer'), wrap((req, res) => { rt.schedule.removeService(req.params.id); res.json({ ok: true }); }));
app.post('/api/schedule/services/:id/duplicate', need('producer'), wrap((req, res) => res.json(rt.schedule.duplicate(req.params.id, req.body || {}))));
app.post('/api/schedule/services/:id/live', need('producer'), wrap((req, res) => res.json(rt.goLive(req.params.id))));
app.post('/api/schedule/next', need('producer'), wrap((_req, res) => {
  const next = rt.schedule.next();
  if (!next) throw new Error('Nothing else is scheduled. Add services on the Schedule page.');
  res.json(rt.goLive(next.id));
}));
app.post('/api/schedule/undo', need('producer'), wrap((_req, res) => { rt.undoLive(); res.json(rt.schedule.view()); }));
app.post('/api/schedule/end', need('producer'), wrap((_req, res) => { rt.clearLive({ end: true }); rt.checkSchedule(); res.json(rt.schedule.view()); }));
// Nothing is live but an order of service is still loaded (e.g. from before the schedule): clear it.
app.post('/api/schedule/clear', need('producer'), wrap((_req, res) => {
  if (rt.schedule.data.liveId) throw new Error('A service is live: use End service');
  rt.clearLive({ end: false });
  res.json(rt.schedule.view());
}));
app.put('/api/schedule/options', need('producer'), wrap((req, res) => { rt.schedule.setOptions(req.body || {}); rt.checkSchedule(); res.json(rt.schedule.view()); }));
app.post('/api/schedule/events', need('producer'), wrap((req, res) => res.json(rt.schedule.addEvent(req.body || {}))));
app.put('/api/schedule/events/:id', need('producer'), wrap((req, res) => res.json(rt.schedule.updateEvent(req.params.id, req.body || {}))));
app.delete('/api/schedule/events/:id', need('producer'), wrap((req, res) => { rt.schedule.removeEvent(req.params.id, { withServices: req.query.services === '1' }); res.json({ ok: true }); }));
app.post('/api/schedule/templates', need('producer'), wrap((req, res) => res.json(rt.schedule.saveTemplate(req.body || {}))));
app.delete('/api/schedule/templates/:id', need('producer'), wrap((req, res) => { rt.schedule.removeTemplate(req.params.id); res.json({ ok: true }); }));
// Moving through the plan is allowed without the PIN so any operator can follow along.
app.post('/api/service/current', need('open'), wrap((req, res) => { rt.service.setCurrent(req.body?.itemId || null, 'manual'); res.json({ ok: true }); }));
app.post('/api/service/next', need('open'), wrap((_req, res) => { rt.service.step(1); res.json({ ok: true }); }));
app.post('/api/service/previous', need('open'), wrap((_req, res) => { rt.service.step(-1); res.json({ ok: true }); }));
app.post('/api/service/reset', need('producer'), wrap((_req, res) => { rt.service.resetProgress(); res.json({ ok: true }); }));

// ---- shared notes & checklists (team-editable, no PIN)
app.put('/api/notes/:name', need('open'), wrap((req, res) => { rt.board.setNote(req.params.name, req.body?.text); res.json({ ok: true }); }));
app.put('/api/checklists/:name', need('open'), wrap((req, res) => { rt.board.setChecklist(req.params.name, req.body || {}); res.json({ ok: true }); }));
app.post('/api/checklists/:name/toggle', need('open'), wrap((req, res) => { rt.board.toggle(req.params.name, req.body?.itemId, req.body?.done); res.json({ ok: true }); }));
app.post('/api/checklists/:name/reset', need('open'), wrap((req, res) => { rt.board.resetChecklist(req.params.name); res.json({ ok: true }); }));

// ---- dashboards (layouts)
app.get('/api/dashboards', (_req, res) => res.json(rt.dashboards.list()));
app.post('/api/dashboards', need('producer'), wrap((req, res) => res.json(rt.dashboards.create(req.body || {}))));
app.put('/api/dashboards/:id', need('producer'), wrap((req, res) => res.json(rt.dashboards.update(req.params.id, req.body || {}))));
app.delete('/api/dashboards/:id', need('producer'), wrap((req, res) => { rt.dashboards.remove(req.params.id); res.json({ ok: true }); }));

// ---- live streams: pin or hide a comment
app.post('/api/streams/pin', need('producer'), wrap((req, res) => { rt.streams.pin(req.body?.id || null); res.json({ ok: true }); }));
app.post('/api/streams/hide', need('producer'), wrap((req, res) => { rt.streams.hide(String(req.body?.id)); res.json({ ok: true }); }));

// ---- ProPresenter
app.get('/api/propresenter/:id/thumbnail/:uuid/:index', async (req, res) => {
  try {
    const img = await rt.propresenters[req.params.id]?.thumbnail(req.params.uuid, req.params.index);
    if (!img) return res.status(404).end();
    res.set('content-type', img.type).set('cache-control', 'max-age=30').send(img.body);
  } catch { res.status(502).end(); }
});
app.post('/api/propresenter/:id/stage-message', need('producer'), wrap(async (req, res) => {
  if (!rt.settings.control.propresenterStageMessage) throw new Error('Stage messages are turned off (Settings → Remote control)');
  const pp = rt.propresenters[req.params.id];
  if (!pp) throw new Error('Unknown ProPresenter');
  await pp.setStageMessage(String(req.body?.text || '').slice(0, 300));
  res.json({ ok: true });
}));

// ---- comms: join links / QR code for phones
app.get('/api/comms/info', (_req, res) => {
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
app.get('/api/remote', need('admin'), (_req, res) => res.json({ ...tunnel.publicState(), url: offsiteUrl(''), accounts: auth.enabled }));
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
const pages = {
  '/': 'home.html', '/welcome': 'welcome.html', '/dashboards': 'dashboard.html', '/d/:slug': 'dashboard.html', '/tv/:org/:dash': 'dashboard.html',
  '/greenroom': 'greenroom.html', '/rf': 'rf.html', '/admin': 'admin.html', '/people': 'people.html', '/schedule': 'schedule.html', '/gear': 'gear.html', '/settings': 'settings.html',
  '/comms': 'comms.html', '/comms/control': 'comms-control.html', '/comms/engine': 'comms-engine.html',
  '/login': 'login.html', '/join/:code': 'login.html',
};
for (const [route, file] of Object.entries(pages)) app.get(route, (_req, res) => res.sendFile(path.join(pub, file)));
app.get('/uploads/:file', (req, res) => res.sendFile(path.join(rt.store.uploads, path.basename(req.params.file)), { maxAge: '1h' }, (e) => e && res.status(404).end()));
app.get('/logo', (_req, res) => {
  const f = orgs.logoFile(rt.orgId);
  return f ? res.sendFile(path.join(orgs.dir(rt.orgId), f), { maxAge: 0 }) : res.status(404).end();
});
// Face finding for photo crops (runs in the browser; the models are bundled, so no internet needed).
const faceApi = path.join(ROOT, 'node_modules/@vladmandic/face-api');
app.get('/vendor/face-api.esm.js', (_req, res) => res.sendFile(path.join(faceApi, 'dist/face-api.esm.js'), { maxAge: '7d' }));
app.get('/vendor/face-models/:file', (req, res) => {
  const f = path.basename(req.params.file);
  if (!/^ssd_mobilenetv1_model/.test(f)) return res.status(404).end();
  res.sendFile(path.join(faceApi, 'model', f), { maxAge: '7d' }, (e) => e && res.status(404).end());
});
app.get('/vendor/hls.min.js', (_req, res) => res.sendFile(path.join(ROOT, 'node_modules/hls.js/dist/hls.min.js')));
app.get('/vendor/gridstack-all.js', (_req, res) => res.sendFile(path.join(ROOT, 'node_modules/gridstack/dist/gridstack-all.js')));
app.get('/vendor/gridstack.min.css', (_req, res) => res.sendFile(path.join(ROOT, 'node_modules/gridstack/dist/gridstack.min.css')));
app.use(express.static(pub));

// ---------------------------------------------------------------- websocket

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true }); // dashboards
const commsWss = new WebSocketServer({ noServer: true }); // phones, comms engine, comms control
commsWss.on('connection', (ws, req) => rt.comms.attach(ws, req));

function upgrade(req, socket, head) {
  req.viaTunnel = Boolean(req.viaTunnel);
  req.user = auth.session(sessionToken(req));
  req.authRank = auth.enabled ? auth.rank(req.user, rt.orgId) : 0;
  const { pathname: p } = new URL(req.url, 'http://x');
  if (p === '/ws' && ((auth.enabled && auth.data.requireLogin) || req.viaTunnel) && req.authRank < 1) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return;
  }
  const { pathname } = new URL(req.url, 'http://x');
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
remoteServer.listen(REMOTE_PORT, '127.0.0.1');

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

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(data);
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify({ ...rt.snapshot(), boot: BOOT }));
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000).unref();

// ---------------------------------------------------------------- start

startRuntime();
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
  await startLocalName(dataDir);
  // http://wavs.local without ":8080" when port 80 is free (allowed for normal users on macOS).
  if (cfg.server.port !== 80) {
    const plain = http.createServer(app);
    plain.on('upgrade', upgrade);
    await listenPort80(plain, cfg.server.host);
  }
  if (localName.active) console.log(`  On this network: http://${localName.host}${localName.port80 || cfg.server.port === 80 ? '' : `:${cfg.server.port}`}`);
});
if (tlsPort) {
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
  process.on(sig, () => {
    rt?.stop();
    tunnel.stop();
    stopLocalName();
    server.close();
    process.exit(0);
  });
}
