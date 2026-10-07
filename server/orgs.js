import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULTS, merge } from './config.js';

/**
 * Organizations (e.g. "Acme Productions" and "Grace Church"). Each one has its own folder
 * under data/orgs/<id>/ holding its settings (gear, branding, PIN, Planning Center),
 * people and photos, dashboards, notes and service plan. One organization is active at a time
 * because it drives the physical gear; switching swaps everything.
 *
 *   data/orgs.json           { active, orgs: [{ id, name }] }
 *   data/orgs/<id>/settings.json
 *   data/orgs/<id>/greenroom.json, dashboards.json, board.json, service.json, uploads/, logo.*
 */

/** Everything an organization can configure in the browser (no server settings). */
const SETTINGS_DEFAULTS = (() => {
  const { server, ...rest } = structuredClone(DEFAULTS);
  return { ...rest, setupComplete: false };
})();

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';
const str = (v, max = 200) => (v == null ? '' : String(v).trim().slice(0, max));
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);
const isHost = (h) => /^[a-z0-9.-]+$/i.test(h) || /^\[?[0-9a-f:]+\]?$/i.test(h);
const KINDS = ['handheld', 'headset', 'lav', 'iem', 'instrument'];

function uniqueIds(list) {
  const seen = new Set();
  for (const item of list) {
    let id = slug(item.id || item.name || item.label);
    for (let i = 2; seen.has(id); i++) id = `${slug(item.id || item.name || item.label)}-${i}`;
    seen.add(id);
    item.id = id;
  }
  return list;
}

/** An IP or host name. Empty is allowed: the device is a placeholder until its address is added. */
function host(v, what) {
  const h = str(v, 120);
  if (!h) return '';
  if (!isHost(h)) throw new Error(`${what}: "${h}" doesn't look like an IP address or host name`);
  return h;
}

/**
 * Validate and tidy settings coming from the browser (or an imported config.yaml).
 * Throws with a readable message for anything a person would need to fix.
 */
export function normalizeSettings(input) {
  const s = merge(SETTINGS_DEFAULTS, structuredClone(input || {}));
  s.org.name = str(s.org.name, 60) || 'My organization';
  s.org.serviceName = str(s.org.serviceName, 80);
  for (const k of ['accent', 'background', 'panel']) if (!/^#[0-9a-f]{6}$/i.test(s.org.theme?.[k] || '')) s.org.theme[k] = SETTINGS_DEFAULTS.org.theme[k];
  s.security.adminPin = str(s.security.adminPin, 20) || null;
  for (const k of ['batteryBars', 'batteryMinutes', 'rfLowDbm', 'audioClipDbfs']) s.alerts[k] = num(s.alerts[k], SETTINGS_DEFAULTS.alerts[k]);
  s.alerts.sound = s.alerts.sound !== false;
  s.rf.minSpacingKHz = num(s.rf.minSpacingKHz, 350);
  s.control = { propresenterStageMessage: Boolean(s.control.propresenterStageMessage), pushNamesToReceivers: Boolean(s.control.pushNamesToReceivers) };
  s.service = { followProPresenter: s.service?.followProPresenter !== false };

  s.mics.receivers = uniqueIds((s.mics.receivers || []).map((rx, i) => {
    const type = ['shure', 'simulator'].includes(rx.type) ? rx.type : 'shure';
    const name = str(rx.name, 60) || `Receiver ${i + 1}`;
    const chans = Array.isArray(rx.channels) ? rx.channels : Array.from({ length: Math.min(8, Math.max(1, num(rx.channels, 2))) }, () => ({}));
    if (!chans.length) throw new Error(`${name}: add at least one channel`);
    return {
      id: rx.id, name, type,
      ...(type === 'shure' ? { host: host(rx.host, name), port: num(rx.port, 2202), model: str(rx.model, 20) || undefined } : {}),
      meterRateMs: Math.max(100, num(rx.meterRateMs, 200)),
      nameLength: num(rx.nameLength, 8),
      channels: chans.slice(0, 8).map((c, j) => {
        const o = typeof c === 'string' ? { label: c } : c || {};
        return { label: str(o.label, 30) || `${name} ${j + 1}`, kind: KINDS.includes(o.kind) ? o.kind : 'handheld', ...(o.hidden ? { hidden: true } : {}) };
      }),
    };
  }));

  s.switchers = uniqueIds((s.switchers || []).map((sw, i) => {
    const type = ['atem', 'vmix', 'simulator'].includes(sw.type) ? sw.type : 'atem';
    const name = str(sw.name, 60) || `Switcher ${i + 1}`;
    const auxNames = {};
    for (const [k, v] of Object.entries(sw.auxNames || {})) if (str(v)) auxNames[Number(k)] = str(v, 30);
    return {
      id: sw.id, name, type,
      ...(type !== 'simulator' ? { host: host(sw.host, name) } : {}),
      ...(type === 'vmix' ? { port: num(sw.port, 8088) } : {}),
      me: Math.max(1, num(sw.me, 1)),
      meNames: (Array.isArray(sw.meNames) ? sw.meNames : String(sw.meNames || '').split(',')).map((n) => str(n, 30)).filter(Boolean),
      auxNames,
    };
  }));

  s.propresenter = uniqueIds((s.propresenter || []).map((pp, i) => {
    const type = pp.type === 'simulator' ? 'simulator' : 'propresenter';
    const name = str(pp.name, 60) || `ProPresenter ${i + 1}`;
    return { id: pp.id, name, type, ...(type === 'propresenter' ? { host: host(pp.host, name), port: num(pp.port, 1025) } : {}) };
  }));

  s.video.sources = uniqueIds((s.video.sources || []).map((v, i) => {
    const type = ['capture', 'webrtc', 'hls', 'mjpeg', 'iframe'].includes(v.type) ? v.type : 'webrtc';
    const label = str(v.label, 60) || `Video ${i + 1}`;
    const url = str(v.url, 500);
    if (type !== 'capture' && !/^https?:\/\//i.test(url)) throw new Error(`${label}: the URL must start with http:// or https://`);
    return {
      id: v.id || label, label, type,
      ...(type === 'capture' ? { device: str(v.device, 80), audio: Boolean(v.audio) } : { url }),
      ...(type === 'mjpeg' && v.refreshMs ? { refreshMs: num(v.refreshMs, 0) } : {}),
      ...(v.switcher ? { switcher: str(v.switcher, 60) } : {}),
    };
  }));

  // Live streams: viewer counts and comments (YouTube API key / Facebook Page token).
  s.streams = uniqueIds((s.streams || []).map((st, i) => {
    const platform = ['youtube', 'facebook', 'simulator'].includes(st.platform) ? st.platform : 'youtube';
    const name = str(st.name, 60) || `${{ youtube: 'YouTube', facebook: 'Facebook', simulator: 'Simulated' }[platform]} ${i + 1}`;
    if (platform === 'youtube') {
      if (!str(st.channel, 200)) throw new Error(`${name}: enter your YouTube channel (or a video link)`);
      if (!str(st.apiKey, 100)) throw new Error(`${name}: a YouTube API key is needed`);
      return { id: st.id, name, platform, channel: str(st.channel, 200), apiKey: str(st.apiKey, 100) };
    }
    if (platform === 'facebook') {
      if (!str(st.pageId, 60)) throw new Error(`${name}: enter the Facebook Page ID`);
      if (!str(st.token, 600)) throw new Error(`${name}: a Facebook Page access token is needed`);
      return { id: st.id, name, platform, pageId: str(st.pageId, 60), token: str(st.token, 600) };
    }
    return { id: st.id, name, platform, simPlatform: st.simPlatform === 'facebook' ? 'facebook' : 'youtube' };
  }));

  const pco = s.planningCenter;
  s.planningCenter = pco && str(pco.appId) && str(pco.secret)
    ? { appId: str(pco.appId), secret: str(pco.secret), serviceTypes: (pco.serviceTypes || []).map(String).filter(Boolean) }
    : null;
  s.setupComplete = Boolean(s.setupComplete);
  return s;
}

/** The browser never receives secrets. */
export function maskSettings(s) {
  const out = structuredClone(s);
  if (out.planningCenter) out.planningCenter = { ...out.planningCenter, secret: '••••••••', hasSecret: true };
  if (out.security.adminPin) out.security = { adminPin: null, hasPin: true };
  out.streams = (out.streams || []).map((st) => ({ ...st, ...(st.apiKey ? { apiKey: '••••••••' } : {}), ...(st.token ? { token: '••••••••' } : {}) }));
  return out;
}

/** Merge settings from the browser over the saved ones, keeping secrets that came back masked. */
export function mergeIncoming(saved, incoming) {
  const next = { ...saved, ...incoming };
  if (incoming.planningCenter && incoming.planningCenter.secret === '••••••••') {
    next.planningCenter = { ...incoming.planningCenter, secret: saved.planningCenter?.secret };
  }
  // Stream keys come back masked from the browser: keep the saved ones.
  if (Array.isArray(incoming.streams)) {
    next.streams = incoming.streams.map((st) => {
      const old = (saved.streams || []).find((o) => o.id === st.id) || {};
      return { ...st, ...(st.apiKey === '••••••••' ? { apiKey: old.apiKey } : {}), ...(st.token === '••••••••' ? { token: old.token } : {}) };
    });
  }
  // The PIN only changes when a new one (or "" to remove it) is sent explicitly.
  next.security = { adminPin: typeof incoming.security?.adminPin === 'string' ? incoming.security.adminPin : saved.security.adminPin };
  return normalizeSettings(next);
}

export class OrgRegistry {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'orgs.json');
    fs.mkdirSync(path.join(dataDir, 'orgs'), { recursive: true });
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { active: null, orgs: [] };
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  dir(id) { return path.join(this.dataDir, 'orgs', id); }

  list() { return this.data.orgs.map(({ id, name }) => ({ id, name, color: this.read(id).org.theme.accent })); }

  read(id) {
    const f = path.join(this.dir(id), 'settings.json');
    return normalizeSettings(fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {});
  }

  write(id, settings) {
    const s = normalizeSettings(settings);
    fs.mkdirSync(this.dir(id), { recursive: true });
    const f = path.join(this.dir(id), 'settings.json');
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(s, null, 2));
    fs.renameSync(`${f}.tmp`, f);
    const entry = this.data.orgs.find((o) => o.id === id);
    if (entry && entry.name !== s.org.name) { entry.name = s.org.name; this.save(); }
    return s;
  }

  create(name, settings = {}) {
    let id = slug(name);
    for (let i = 2; this.data.orgs.some((o) => o.id === id); i++) id = `${slug(name)}-${i}`;
    this.data.orgs.push({ id, name: str(name, 60) || 'My organization' });
    this.save();
    this.write(id, merge(settings, { org: { name } }));
    return id;
  }

  remove(id) {
    if (this.data.orgs.length <= 1) throw new Error('Keep at least one organization');
    if (id === this.data.active) throw new Error('Switch to another organization before deleting this one');
    this.data.orgs = this.data.orgs.filter((o) => o.id !== id);
    this.save();
    fs.rmSync(this.dir(id), { recursive: true, force: true });
  }

  setActive(id) {
    if (!this.data.orgs.some((o) => o.id === id)) throw new Error('Unknown organization');
    this.data.active = id;
    this.save();
  }

  /**
   * First run of this version: create the first organization from config.yaml (or the demo
   * config) and move any existing people, photos, dashboards and notes into it.
   */
  migrate(cfg) {
    if (this.data.orgs.length) return;
    const { server, _file, ...settings } = cfg;
    const isDemo = /demo\.yaml$/.test(_file || '');
    let id;
    try {
      id = this.create(cfg.org.name, { ...settings, setupComplete: isDemo || settings.mics.receivers.length > 0 });
    } catch (e) {
      // Bad gear entries in config.yaml: keep the branding, add the gear in the browser instead.
      console.error(`[orgs] could not import gear from config: ${e.message}`);
      this.data.orgs = [];
      id = this.create(cfg.org.name, { org: settings.org, alerts: settings.alerts });
    }
    for (const f of ['greenroom.json', 'dashboards.json', 'board.json', 'service.json', 'uploads']) {
      const from = path.join(this.dataDir, f);
      if (fs.existsSync(from)) fs.renameSync(from, path.join(this.dir(id), f));
    }
    if (cfg.org.logo) {
      const logo = path.resolve(path.dirname(_file || '.'), '..', cfg.org.logo);
      if (fs.existsSync(logo)) fs.copyFileSync(logo, path.join(this.dir(id), `logo${path.extname(logo).toLowerCase()}`));
    }
    this.setActive(id);
    console.log(`[orgs] created organization "${cfg.org.name}" from ${path.basename(_file || 'config')}`);
  }

  logoFile(id) {
    const dir = this.dir(id);
    return fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => /^logo\.(png|jpe?g|svg|webp)$/i.test(f)) : null;
  }
}

export const newId = () => crypto.randomUUID();
