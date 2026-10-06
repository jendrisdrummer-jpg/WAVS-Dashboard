import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const DEFAULTS = {
  server: { port: 8080, host: '0.0.0.0' },
  org: {
    name: 'WAVS Dashboard',
    serviceName: 'Sunday Service',
    logo: null,
    theme: { accent: '#3b82f6', background: '#0b0f17', panel: '#131a26' },
  },
  security: { adminPin: null },
  alerts: {
    batteryBars: 1, // alert at or below this many bars (0-5)
    batteryMinutes: 30, // alert at or below this runtime (if reported)
    rfLowDbm: -90, // alert when an active mic's RF drops below this
    audioClipDbfs: -2, // clip indicator threshold
    sound: true,
  },
  rf: { minSpacingKHz: 350 },
  propresenter: [],
  switchers: [],
  mics: { receivers: [], slots: {} },
  video: { sources: [] },
  planningCenter: null, // { appId, secret, serviceTypes: [] }
  service: { followProPresenter: true },
  control: { propresenterStageMessage: false, pushNamesToReceivers: false },
};

function merge(base, over) {
  if (Array.isArray(over) || typeof over !== 'object' || over === null) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) && base[k] !== null ? merge(base[k], v) : v;
  }
  return out;
}

export function loadConfig() {
  const candidates = [process.env.WAVS_CONFIG, 'config/config.yaml', 'config/demo.yaml'].filter(Boolean);
  for (const rel of candidates) {
    const file = path.resolve(ROOT, rel);
    if (fs.existsSync(file)) {
      const parsed = YAML.parse(fs.readFileSync(file, 'utf8')) || {};
      const cfg = merge(DEFAULTS, parsed);
      cfg._file = file;
      // `video.tiles` was the original name for video sources; accept both.
      cfg.video.sources = [...(cfg.video.sources || []), ...(cfg.video.tiles || [])];
      delete cfg.video.tiles;
      const pcoId = process.env.PCO_APP_ID || cfg.planningCenter?.appId;
      const pcoSecret = process.env.PCO_SECRET || cfg.planningCenter?.secret;
      cfg.planningCenter = pcoId && pcoSecret ? { serviceTypes: [], ...cfg.planningCenter, appId: pcoId, secret: pcoSecret } : null;
      if (process.env.PORT) cfg.server.port = Number(process.env.PORT);
      return cfg;
    }
  }
  throw new Error('No config found. Copy config/config.example.yaml to config/config.yaml (or set WAVS_CONFIG).');
}

/** Public subset of the config that the browser is allowed to see. */
export function publicConfig(cfg) {
  return {
    org: cfg.org,
    alerts: cfg.alerts,
    rf: cfg.rf,
    video: cfg.video,
    control: cfg.control,
    switchers: cfg.switchers.map((s) => ({ id: s.id, name: s.name || s.id, me: s.me || 1 })),
    propresenter: cfg.propresenter.map((p) => ({ id: p.id, name: p.name || p.id })),
    planningCenter: Boolean(cfg.planningCenter),
    pinRequired: Boolean(cfg.security.adminPin),
  };
}
