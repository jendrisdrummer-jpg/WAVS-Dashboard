import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { WebSocketServer } from 'ws';

import { loadConfig, publicConfig, ROOT } from './config.js';
import { Hub } from './hub.js';
import { GreenroomStore } from './store.js';
import { computeAlerts } from './alerts.js';
import { ShureReceiver } from './drivers/shure.js';
import { ProPresenter } from './drivers/propresenter.js';
import { AtemSwitcher, VmixSwitcher } from './drivers/switchers.js';
import { SimReceiver, SimProPresenter, SimSwitcher } from './drivers/simulator.js';
import { PlanningCenter } from './drivers/planningcenter.js';
import { ServiceManager } from './service.js';
import { Board, Dashboards } from './collab.js';
import { defaultDashboards } from './default-dashboards.js';

const cfg = loadConfig();
const hub = new Hub();
const dataDir = path.resolve(ROOT, process.env.WAVS_DATA || 'data');
const store = new GreenroomStore(dataDir);
const board = new Board(dataDir);
const dashboards = new Dashboards(dataDir, defaultDashboards(cfg));
const service = new ServiceManager({
  dataDir,
  pco: cfg.planningCenter ? new PlanningCenter(cfg.planningCenter) : null,
  cfg: cfg.service,
});

// ---------------------------------------------------------------- devices

const micIdFor = (rxId, ch) => `${rxId}.${ch}`;
const RECEIVER_DRIVERS = { shure: ShureReceiver, simulator: SimReceiver };
const PP_DRIVERS = { propresenter: ProPresenter, simulator: SimProPresenter };
const SWITCHER_DRIVERS = { atem: AtemSwitcher, vmix: VmixSwitcher, simulator: SimSwitcher };

/** Static mic slot list (order, labels, kinds) built from config. */
const micSlots = [];
const receivers = {};
for (const rx of cfg.mics.receivers) {
  const Driver = RECEIVER_DRIVERS[rx.type || 'shure'];
  if (!Driver) { console.error(`[mics] unknown receiver type "${rx.type}" for ${rx.id}`); continue; }
  const chans = Array.isArray(rx.channels) ? rx.channels : Array.from({ length: rx.channels || 4 }, () => ({}));
  chans.forEach((c, i) => {
    const slot = typeof c === 'string' ? { label: c } : c || {};
    micSlots.push({
      id: micIdFor(rx.id, i + 1),
      receiverId: rx.id,
      receiverName: rx.name || rx.id,
      channel: i + 1,
      label: slot.label || `${rx.name || rx.id} ${i + 1}`,
      kind: slot.kind || 'handheld',
      color: slot.color || null,
      hidden: Boolean(slot.hidden),
    });
  });
  receivers[rx.id] = new Driver({ ...rx, channels: chans.length }, hub, micIdFor);
}

const propresenters = {};
for (const pp of cfg.propresenter) {
  const Driver = PP_DRIVERS[pp.type || 'propresenter'];
  if (Driver) propresenters[pp.id] = new Driver(pp, hub);
}
const switchers = {};
for (const sw of cfg.switchers) {
  const Driver = SWITCHER_DRIVERS[sw.type];
  if (Driver) switchers[sw.id] = new Driver(sw, hub);
  else console.error(`[switchers] unknown type "${sw.type}" for ${sw.id}`);
}

// ---------------------------------------------------------------- alerts

let alerts = [];
function refreshAlerts() {
  const next = computeAlerts(hub.state, store.data, micSlots, cfg);
  if (JSON.stringify(next) !== JSON.stringify(alerts)) {
    alerts = next;
    broadcast({ type: 'alerts', alerts });
  }
}
setInterval(refreshAlerts, 1000).unref();

// ---------------------------------------------------------------- http

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

const requirePin = (req, res, next) => {
  const pin = cfg.security.adminPin;
  if (!pin) return next();
  const given = String(req.get('x-admin-pin') || '');
  const ok = given.length === String(pin).length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(String(pin)));
  return ok ? next() : res.status(401).json({ error: 'PIN required' });
};

const upload = multer({
  storage: multer.diskStorage({
    destination: store.uploads,
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg'}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(jpeg|png|webp|gif|heic|heif)$/.test(file.mimetype)),
});

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { res.status(400).json({ error: e.message }); }
};

app.get('/api/config', (_req, res) => res.json(publicConfig(cfg)));
app.get('/api/state', (_req, res) => res.json(snapshot()));

app.post('/api/pin/check', requirePin, (_req, res) => res.json({ ok: true }));

app.post('/api/people', requirePin, upload.single('photo'), wrap((req, res) => {
  res.json(store.addPerson({ ...req.body, photo: req.file?.filename || null }));
}));
app.put('/api/people/:id', requirePin, upload.single('photo'), wrap((req, res) => {
  const fields = { ...req.body };
  if (req.file) fields.photo = req.file.filename;
  else if (req.body.removePhoto === 'true') fields.photo = null;
  res.json(store.updatePerson(req.params.id, fields));
}));
app.delete('/api/people/:id', requirePin, wrap((req, res) => { store.removePerson(req.params.id); res.json({ ok: true }); }));

app.put('/api/assignments/:micId', requirePin, wrap((req, res) => {
  if (!micSlots.some((m) => m.id === req.params.micId)) throw new Error('Unknown mic');
  const result = store.assign(req.params.micId, req.body || {});
  if (cfg.control.pushNamesToReceivers && req.body?.personId !== undefined) pushName(req.params.micId);
  res.json(result);
}));
app.post('/api/assignments/clear', requirePin, wrap((_req, res) => { store.clearAssignments(); res.json({ ok: true }); }));
app.put('/api/service', requirePin, wrap((req, res) => { store.setService({ name: req.body?.name ?? null, notes: req.body?.notes ?? '' }); res.json(store.data.service); }));

app.post('/api/mics/:micId/push-name', requirePin, wrap((req, res) => {
  if (!pushName(req.params.micId)) throw new Error('Receiver does not support naming or nobody is assigned');
  res.json({ ok: true });
}));

function pushName(micId) {
  const slot = micSlots.find((m) => m.id === micId);
  const a = store.data.assignments[micId];
  const person = a && store.person(a.personId);
  const rx = slot && receivers[slot.receiverId];
  if (!rx?.setChannelName) return false;
  rx.setChannelName(slot.channel, person ? person.name.split(' ')[0] : slot.label);
  return true;
}

// ---- service plan (Planning Center or manual)
app.get('/api/service', (_req, res) => res.json(service.state()));
app.post('/api/service/pco', requirePin, wrap(async (req, res) => {
  await service.selectPco(String(req.body?.serviceTypeId), String(req.body?.planId));
  res.json(service.state());
}));
app.post('/api/service/pco/refresh', requirePin, wrap(async (_req, res) => {
  await service.refreshUpcoming();
  await service.reloadPco();
  res.json(service.state());
}));
app.put('/api/service/manual', requirePin, wrap((req, res) => {
  service.setManual({ title: String(req.body?.title || ''), text: String(req.body?.text || ''), start: String(req.body?.start || '') });
  res.json(service.state());
}));
// Moving through the plan is allowed without the PIN so any operator can follow along.
app.post('/api/service/current', wrap((req, res) => { service.setCurrent(req.body?.itemId || null, 'manual'); res.json({ ok: true }); }));
app.post('/api/service/next', wrap((_req, res) => { service.step(1); res.json({ ok: true }); }));
app.post('/api/service/previous', wrap((_req, res) => { service.step(-1); res.json({ ok: true }); }));
app.post('/api/service/reset', requirePin, wrap((_req, res) => { service.resetProgress(); res.json({ ok: true }); }));

// ---- shared notes & checklists (team-editable, no PIN)
app.put('/api/notes/:name', wrap((req, res) => { board.setNote(req.params.name, req.body?.text); res.json({ ok: true }); }));
app.put('/api/checklists/:name', wrap((req, res) => { board.setChecklist(req.params.name, req.body || {}); res.json({ ok: true }); }));
app.post('/api/checklists/:name/toggle', wrap((req, res) => { board.toggle(req.params.name, req.body?.itemId, req.body?.done); res.json({ ok: true }); }));
app.post('/api/checklists/:name/reset', wrap((req, res) => { board.resetChecklist(req.params.name); res.json({ ok: true }); }));

// ---- dashboards (layouts)
app.get('/api/dashboards', (_req, res) => res.json(dashboards.list()));
app.post('/api/dashboards', requirePin, wrap((req, res) => res.json(dashboards.create(req.body || {}))));
app.put('/api/dashboards/:id', requirePin, wrap((req, res) => res.json(dashboards.update(req.params.id, req.body || {}))));
app.delete('/api/dashboards/:id', requirePin, wrap((req, res) => { dashboards.remove(req.params.id); res.json({ ok: true }); }));

app.get('/api/propresenter/:id/thumbnail/:uuid/:index', async (req, res) => {
  try {
    const img = await propresenters[req.params.id]?.thumbnail(req.params.uuid, req.params.index);
    if (!img) return res.status(404).end();
    res.set('content-type', img.type).set('cache-control', 'max-age=30').send(img.body);
  } catch { res.status(502).end(); }
});

app.post('/api/propresenter/:id/stage-message', requirePin, wrap(async (req, res) => {
  if (!cfg.control.propresenterStageMessage) throw new Error('Stage messages are disabled in config (control.propresenterStageMessage)');
  const pp = propresenters[req.params.id];
  if (!pp) throw new Error('Unknown ProPresenter');
  await pp.setStageMessage(String(req.body?.text || '').slice(0, 300));
  res.json({ ok: true });
}));

// Static files
const pub = path.join(ROOT, 'public');
for (const [route, file] of [['/', 'dashboard.html'], ['/d/:slug', 'dashboard.html'], ['/greenroom', 'greenroom.html'], ['/rf', 'rf.html'], ['/admin', 'admin.html']]) {
  app.get(route, (_req, res) => res.sendFile(path.join(pub, file)));
}
app.use('/uploads', express.static(store.uploads, { maxAge: '1h' }));
app.get('/vendor/hls.min.js', (_req, res) => res.sendFile(path.join(ROOT, 'node_modules/hls.js/dist/hls.min.js')));
app.get('/vendor/gridstack-all.js', (_req, res) => res.sendFile(path.join(ROOT, 'node_modules/gridstack/dist/gridstack-all.js')));
app.get('/vendor/gridstack.min.css', (_req, res) => res.sendFile(path.join(ROOT, 'node_modules/gridstack/dist/gridstack.min.css')));
if (cfg.org.logo && fs.existsSync(path.resolve(ROOT, cfg.org.logo))) {
  app.get('/logo', (_req, res) => res.sendFile(path.resolve(ROOT, cfg.org.logo)));
}
app.use(express.static(pub));

// ---------------------------------------------------------------- websocket

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function snapshot() {
  return {
    type: 'snapshot', state: hub.state, slots: micSlots, greenroom: store.data, alerts,
    service: service.state(), board: board.data, dashboards: dashboards.list(),
  };
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(data);
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify(snapshot()));
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000).unref();

hub.on('update', (u) => broadcast({ type: 'update', ...u }));
hub.on('meters', (meters) => broadcast({ type: 'meters', meters }));
store.on('change', (data) => { broadcast({ type: 'greenroom', greenroom: data }); refreshAlerts(); });
service.on('change', (data) => broadcast({ type: 'service', service: data }));
board.on('change', (data) => broadcast({ type: 'board', board: data }));
dashboards.on('change', () => broadcast({ type: 'dashboards', dashboards: dashboards.list() }));

// Auto-track the service: ProPresenter changing presentation moves the plan along.
const lastPresentation = {};
hub.on('update', ({ section, id, data }) => {
  if (section !== 'propresenter' || !data?.presentation?.name) return;
  if (lastPresentation[id] === data.presentation.name) return;
  lastPresentation[id] = data.presentation.name;
  service.onPresentation(data.presentation.name);
});
// A newly loaded plan picks up wherever ProPresenter already is.
service.on('planLoaded', () => {
  for (const pp of Object.values(hub.state.propresenter)) if (pp.online && pp.presentation?.name) service.onPresentation(pp.presentation.name);
});

// ---------------------------------------------------------------- start

for (const d of [...Object.values(receivers), ...Object.values(propresenters), ...Object.values(switchers)]) d.start();
service.start().catch((e) => console.error(`[service] ${e.message}`));

server.listen(cfg.server.port, cfg.server.host, () => {
  console.log(`WAVS Dashboard running: http://localhost:${cfg.server.port}  (config: ${path.relative(ROOT, cfg._file)})`);
  console.log(`  Dashboards  /   Green room  /greenroom   RF  /rf   Admin  /admin`);
  if (cfg.planningCenter) console.log('  Planning Center: connected (plans load in the background)');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const d of [...Object.values(receivers), ...Object.values(propresenters), ...Object.values(switchers)]) d.stop?.();
    service.stop();
    server.close();
    process.exit(0);
  });
}
