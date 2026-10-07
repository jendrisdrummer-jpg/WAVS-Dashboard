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

// config.yaml now only holds server settings (port). Everything else (gear, branding, PIN,
// Planning Center) is per organization and edited in the browser. On first run the
// organization is created from config.yaml, so existing setups carry over.
const cfg = loadConfig();
const dataDir = path.resolve(ROOT, process.env.WAVS_DATA || 'data');
const orgs = new OrgRegistry(dataDir);
orgs.migrate(cfg);

let rt = null; // Runtime for the active organization

function startRuntime() {
  const id = orgs.data.active || orgs.data.orgs[0].id;
  const next = new Runtime({ orgId: id, dir: orgs.dir(id), settings: orgs.read(id) });
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

function publicConfig() {
  const s = rt.settings;
  return {
    org: { name: s.org.name, serviceName: s.org.serviceName, theme: s.org.theme, logo: Boolean(orgs.logoFile(rt.orgId)) },
    orgId: rt.orgId,
    orgs: orgs.list(),
    setupComplete: s.setupComplete,
    alerts: s.alerts,
    rf: s.rf,
    video: s.video,
    control: s.control,
    switchers: s.switchers.map((x) => ({ id: x.id, name: x.name, me: x.me || 1 })),
    propresenter: s.propresenter.map((x) => ({ id: x.id, name: x.name })),
    planningCenter: Boolean(s.planningCenter),
    pinRequired: Boolean(s.security.adminPin),
  };
}

// ---------------------------------------------------------------- http

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));

const requirePin = (req, res, next) => (checkPin(rt.settings.security.adminPin, req.get('x-admin-pin'))
  ? next()
  : res.status(401).json({ error: 'PIN required' }));

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

app.get('/api/config', (_req, res) => res.json(publicConfig()));
app.get('/api/state', (_req, res) => res.json(rt.snapshot()));
app.post('/api/pin/check', requirePin, (_req, res) => res.json({ ok: true }));

// ---- organizations
app.get('/api/orgs', (_req, res) => res.json({ active: rt.orgId, orgs: orgs.list() }));
app.post('/api/orgs', requirePin, wrap((req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) throw new Error('Give the organization a name');
  const id = orgs.create(name);
  orgs.setActive(id);
  restartRuntime();
  res.json({ id });
}));
app.post('/api/orgs/active', requirePin, wrap((req, res) => {
  orgs.setActive(String(req.body?.id));
  restartRuntime();
  res.json({ ok: true });
}));
app.delete('/api/orgs/:id', requirePin, wrap((req, res) => { orgs.remove(req.params.id); broadcast({ type: 'reload' }); res.json({ ok: true }); }));

// ---- settings (gear, branding, Planning Center, alerts) for the active organization
app.get('/api/settings', (_req, res) => res.json(maskSettings(rt.settings)));
app.put('/api/settings', requirePin, wrap((req, res) => {
  const next = mergeIncoming(rt.settings, req.body || {});
  orgs.write(rt.orgId, next);
  restartRuntime();
  res.json(maskSettings(next));
}));
app.post('/api/settings/test', requirePin, wrap(async (req, res) => {
  const { kind, device } = req.body || {};
  const dev = { ...device };
  if (kind === 'planningCenter' && dev.secret === '••••••••') dev.secret = rt.settings.planningCenter?.secret;
  res.json(await testDevice(kind, dev));
}));
app.post('/api/settings/logo', requirePin, logoUpload.single('logo'), wrap((req, res) => {
  if (!req.file) throw new Error('Choose a PNG, JPEG or WebP image');
  const dir = orgs.dir(rt.orgId);
  const old = orgs.logoFile(rt.orgId);
  if (old) fs.rmSync(path.join(dir, old), { force: true });
  fs.writeFileSync(path.join(dir, `logo.${req.file.mimetype.split('/')[1].replace('jpeg', 'jpg')}`), req.file.buffer);
  broadcast({ type: 'reload' });
  res.json({ ok: true });
}));
app.delete('/api/settings/logo', requirePin, wrap((_req, res) => {
  const old = orgs.logoFile(rt.orgId);
  if (old) fs.rmSync(path.join(orgs.dir(rt.orgId), old), { force: true });
  broadcast({ type: 'reload' });
  res.json({ ok: true });
}));
app.post('/api/gear/reconnect', requirePin, wrap((_req, res) => { restartRuntime(); res.json({ ok: true }); }));

// ---- people & mic assignments
app.post('/api/people', requirePin, upload.single('photo'), wrap((req, res) => {
  res.json(rt.store.addPerson({ ...req.body, photo: req.file?.filename || null }));
}));
app.put('/api/people/:id', requirePin, upload.single('photo'), wrap((req, res) => {
  const fields = { ...req.body };
  if (req.file) fields.photo = req.file.filename;
  else if (req.body.removePhoto === 'true') fields.photo = null;
  res.json(rt.store.updatePerson(req.params.id, fields));
}));
app.delete('/api/people/:id', requirePin, wrap((req, res) => { rt.store.removePerson(req.params.id); res.json({ ok: true }); }));

app.put('/api/assignments/:micId', requirePin, wrap((req, res) => {
  if (!rt.micSlots.some((m) => m.id === req.params.micId)) throw new Error('Unknown mic');
  const result = rt.store.assign(req.params.micId, req.body || {});
  if (rt.settings.control.pushNamesToReceivers && req.body?.personId !== undefined) rt.pushName(req.params.micId);
  res.json(result);
}));
app.post('/api/assignments/clear', requirePin, wrap((_req, res) => { rt.store.clearAssignments(); res.json({ ok: true }); }));
app.put('/api/service', requirePin, wrap((req, res) => { rt.store.setService({ name: req.body?.name ?? null, notes: req.body?.notes ?? '' }); res.json(rt.store.data.service); }));
app.post('/api/mics/:micId/push-name', requirePin, wrap((req, res) => {
  if (!rt.pushName(req.params.micId)) throw new Error('Receiver does not support naming or nobody is assigned');
  res.json({ ok: true });
}));

// ---- service plan (Planning Center or manual)
app.get('/api/service', (_req, res) => res.json(rt.service.state()));
app.post('/api/service/pco', requirePin, wrap(async (req, res) => {
  await rt.service.selectPco(String(req.body?.serviceTypeId), String(req.body?.planId));
  res.json(rt.service.state());
}));
app.post('/api/service/pco/refresh', requirePin, wrap(async (_req, res) => {
  await rt.service.refreshUpcoming();
  await rt.service.reloadPco();
  res.json(rt.service.state());
}));
app.put('/api/service/manual', requirePin, wrap((req, res) => {
  rt.service.setManual({ title: String(req.body?.title || ''), text: String(req.body?.text || ''), start: String(req.body?.start || '') });
  res.json(rt.service.state());
}));
app.post('/api/service/propresenter', requirePin, wrap((_req, res) => { rt.service.useProPresenter(); res.json(rt.service.state()); }));
// Moving through the plan is allowed without the PIN so any operator can follow along.
app.post('/api/service/current', wrap((req, res) => { rt.service.setCurrent(req.body?.itemId || null, 'manual'); res.json({ ok: true }); }));
app.post('/api/service/next', wrap((_req, res) => { rt.service.step(1); res.json({ ok: true }); }));
app.post('/api/service/previous', wrap((_req, res) => { rt.service.step(-1); res.json({ ok: true }); }));
app.post('/api/service/reset', requirePin, wrap((_req, res) => { rt.service.resetProgress(); res.json({ ok: true }); }));

// ---- shared notes & checklists (team-editable, no PIN)
app.put('/api/notes/:name', wrap((req, res) => { rt.board.setNote(req.params.name, req.body?.text); res.json({ ok: true }); }));
app.put('/api/checklists/:name', wrap((req, res) => { rt.board.setChecklist(req.params.name, req.body || {}); res.json({ ok: true }); }));
app.post('/api/checklists/:name/toggle', wrap((req, res) => { rt.board.toggle(req.params.name, req.body?.itemId, req.body?.done); res.json({ ok: true }); }));
app.post('/api/checklists/:name/reset', wrap((req, res) => { rt.board.resetChecklist(req.params.name); res.json({ ok: true }); }));

// ---- dashboards (layouts)
app.get('/api/dashboards', (_req, res) => res.json(rt.dashboards.list()));
app.post('/api/dashboards', requirePin, wrap((req, res) => res.json(rt.dashboards.create(req.body || {}))));
app.put('/api/dashboards/:id', requirePin, wrap((req, res) => res.json(rt.dashboards.update(req.params.id, req.body || {}))));
app.delete('/api/dashboards/:id', requirePin, wrap((req, res) => { rt.dashboards.remove(req.params.id); res.json({ ok: true }); }));

// ---- ProPresenter
app.get('/api/propresenter/:id/thumbnail/:uuid/:index', async (req, res) => {
  try {
    const img = await rt.propresenters[req.params.id]?.thumbnail(req.params.uuid, req.params.index);
    if (!img) return res.status(404).end();
    res.set('content-type', img.type).set('cache-control', 'max-age=30').send(img.body);
  } catch { res.status(502).end(); }
});
app.post('/api/propresenter/:id/stage-message', requirePin, wrap(async (req, res) => {
  if (!rt.settings.control.propresenterStageMessage) throw new Error('Stage messages are turned off (Settings → Remote control)');
  const pp = rt.propresenters[req.params.id];
  if (!pp) throw new Error('Unknown ProPresenter');
  await pp.setStageMessage(String(req.body?.text || '').slice(0, 300));
  res.json({ ok: true });
}));

// ---- comms: join links / QR code for phones
function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}
app.get('/api/comms/info', (_req, res) => {
  const ips = lanAddresses();
  res.json({
    httpsPort: tlsPort,
    joinUrls: ips.map((ip) => `https://${ip}:${tlsPort}/comms`),
    hostname: os.hostname(),
  });
});
app.get('/api/comms/qr.svg', wrap(async (req, res) => {
  const url = String(req.query.url || '');
  if (!/^https?:\/\/[^\s]{1,200}$/.test(url)) throw new Error('Bad URL');
  res.type('image/svg+xml').send(await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#000000', light: '#ffffff' } }));
}));

// ---- pages & static files
const pub = path.join(ROOT, 'public');
const pages = {
  '/': 'home.html', '/welcome': 'welcome.html', '/dashboards': 'dashboard.html', '/d/:slug': 'dashboard.html',
  '/greenroom': 'greenroom.html', '/rf': 'rf.html', '/admin': 'admin.html', '/gear': 'gear.html', '/settings': 'settings.html',
  '/comms': 'comms.html', '/comms/control': 'comms-control.html', '/comms/engine': 'comms-engine.html',
};
for (const [route, file] of Object.entries(pages)) app.get(route, (_req, res) => res.sendFile(path.join(pub, file)));
app.get('/uploads/:file', (req, res) => res.sendFile(path.join(rt.store.uploads, path.basename(req.params.file)), { maxAge: '1h' }, (e) => e && res.status(404).end()));
app.get('/logo', (_req, res) => {
  const f = orgs.logoFile(rt.orgId);
  return f ? res.sendFile(path.join(orgs.dir(rt.orgId), f), { maxAge: 0 }) : res.status(404).end();
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
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/ws') wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  else if (pathname === '/comms-ws') commsWss.handleUpgrade(req, socket, head, (ws) => commsWss.emit('connection', ws, req));
  else socket.destroy();
}
server.on('upgrade', upgrade);

// HTTPS (self-signed) so phones may use their microphone for comms. Browsers only allow
// microphones on https:// pages (or localhost). The certificate is created once and kept in data/tls/.
const tlsPort = Number(process.env.HTTPS_PORT || cfg.server.httpsPort || 8443);
async function tlsOptions() {
  const dir = path.join(dataDir, 'tls');
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  if (!fs.existsSync(keyFile)) {
    fs.mkdirSync(dir, { recursive: true });
    const altNames = [{ type: 2, value: 'localhost' }, { type: 2, value: os.hostname() }, { type: 2, value: `${os.hostname().replace(/\.local$/, '')}.local` },
      { type: 7, ip: '127.0.0.1' }, ...lanAddresses().map((ip) => ({ type: 7, ip }))];
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
  ws.send(JSON.stringify(rt.snapshot()));
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
server.listen(cfg.server.port, cfg.server.host, () => {
  console.log(`WAVS Dashboard running: http://localhost:${cfg.server.port}`);
  console.log(`  Organizations: ${orgs.list().map((o) => o.name).join(', ')}`);
});
if (tlsPort) {
  tlsOptions().then((opts) => {
    const secure = https.createServer(opts, app);
    secure.on('upgrade', upgrade);
    secure.on('error', (e) => console.error(`[https] ${e.message}`));
    secure.listen(tlsPort, cfg.server.host, () => {
      const ips = lanAddresses();
      console.log(`  Comms for phones: ${ips.length ? ips.map((ip) => `https://${ip}:${tlsPort}/comms`).join('  ') : `https://localhost:${tlsPort}/comms`}`);
    });
  }).catch((e) => console.error(`[https] could not start: ${e.message}`));
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    rt?.stop();
    server.close();
    process.exit(0);
  });
}
