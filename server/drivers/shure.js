import net from 'node:net';

/**
 * Shure networked wireless receivers (SLX-D, ULX-D, QLX-D, Axient Digital)
 * using the TCP command-string protocol on port 2202:
 *   -> < GET 0 ALL >           <- < REP 1 CHAN_NAME {Pastor  } >
 *   -> < SET 0 METER_RATE 200 > <- < SAMPLE 1 ALL 102 095 085 >     (SLX-D)
 *                              <- < SAMPLE 1 ALL XB 095 030 >      (ULX-D / QLX-D)
 *
 * Key names and meter formats differ per product family (SLX-D reports its
 * transmitter battery as TX_BATT_BARS / TX_BATT_MINS and meters on a 0-120
 * scale). Unknown keys are ignored. Add mappings to FIELD_MAP for anything
 * else your receivers report.
 */

const UNKNOWN = new Set(['UNKN', 'UNKNOWN', 'NONE', '']);

/** Product family from the receiver's MODEL report or config ("SLXD4D" -> "slx"). */
export function familyOf(model) {
  const m = String(model || '').toUpperCase();
  if (m.startsWith('SLX')) return 'slx';
  if (m.startsWith('AD') || m.startsWith('ADX')) return 'ad';
  if (m.startsWith('ULX') || m.startsWith('QLX')) return 'ulx';
  return null;
}

const num = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

/** key -> (rawValue) => partial mic object */
export const FIELD_MAP = {
  CHAN_NAME: (v) => ({ chanName: v || null }),
  BATT_BARS: (v) => battBars(v),
  TX_BATT_BARS: (v) => battBars(v), // SLX-D, Axient Digital
  BATT_CHARGE: (v) => battPercent(v),
  TX_BATT_CHARGE_PERCENT: (v) => battPercent(v), // Axient Digital
  BATT_RUN_TIME: (v) => battMinutes(v),
  TX_BATT_MINS: (v) => battMinutes(v), // SLX-D, Axient Digital
  BATT_TYPE: (v) => ({ battType: UNKNOWN.has(v) ? null : v }),
  TX_BATT_TYPE: (v) => ({ battType: UNKNOWN.has(v) ? null : v }),
  FREQUENCY: (v) => { const n = num(v); return { freqMHz: n ? n / 1000 : null }; },
  GROUP_CHAN: (v) => ({ groupChan: /^\d+,\d+$/.test(v) ? v : null }),
  TX_TYPE: (v) => ({ txType: UNKNOWN.has(v) ? null : v }),
  TX_MODEL: (v) => ({ txType: UNKNOWN.has(v) ? null : v }), // Axient Digital
  TX_MUTE_STATUS: (v) => ({ txMuted: v === 'ON' ? true : v === 'OFF' ? false : null }),
  RF_ANTENNA: (v) => ({ antenna: v }),
  RX_RF_LVL: (v) => { const n = num(v); return { rfDbm: n === null ? null : n - 128 }; },
  AUDIO_LVL: (v) => { const n = num(v); return { audioDbfs: n === null ? null : n - 50 }; },
  AUDIO_GAIN: (v) => { const n = num(v); return { audioGain: n === null ? null : n - 18 }; },
  RF_INT_DET: (v) => ({ interference: v !== 'NONE' && !UNKNOWN.has(v) }),
  INTERFERENCE_STATUS: (v) => ({ interference: v !== 'NONE' && !UNKNOWN.has(v) }),
  ENCRYPTION_WARNING: (v) => ({ encryptionWarning: v === 'ON' }),
};

function battBars(v) { const n = num(v); return { battBars: n === null || n > 5 ? null : n }; }
function battPercent(v) { const n = num(v); return { battPercent: n === null || n > 100 ? null : n }; }
// 65535 = unknown, 65534 = calculating, 65533 = communication warning
function battMinutes(v) { const n = num(v); return { battMinutes: n === null || n >= 65533 ? null : n }; }

const DEVICE_FIELDS = { MODEL: 'model', DEVICE_ID: 'deviceId', FW_VER: 'firmware', RF_BAND: 'band' };

/**
 * Parse a single "< ... >" message body (without the angle brackets).
 * `family` ("slx" | "ulx" | "ad") selects the meter format; without it the
 * format is inferred from the shape of the sample.
 * Returns { kind: 'channel' | 'meter', channel, data } | { kind: 'device', data } | null
 */
export function parseMessage(body, family = null) {
  const text = body.trim();
  let m = text.match(/^SAMPLE\s+(\d+)\s+ALL\s+(.*)$/);
  if (m) return { kind: 'meter', channel: Number(m[1]), data: parseSample(m[2].trim().split(/\s+/), family) };
  // Channel report: REP <ch> KEY value   (value may be wrapped in {braces})
  m = text.match(/^(?:REP|REPORT)\s+(\d+)\s+([A-Z0-9_]+)\s*(.*)$/);
  if (m) {
    const key = m[2];
    const value = m[3].replace(/^\{|\}$/g, '').trim();
    const map = FIELD_MAP[key];
    if (!map) return null;
    return { kind: 'channel', channel: Number(m[1]), data: map(value) };
  }
  // Device report: REP KEY value
  m = text.match(/^(?:REP|REPORT)\s+([A-Z_]+)\s*(.*)$/);
  if (m && DEVICE_FIELDS[m[1]]) {
    return { kind: 'device', data: { [DEVICE_FIELDS[m[1]]]: m[2].replace(/^\{|\}$/g, '').trim() } };
  }
  return null;
}

function parseSample(parts, family) {
  const f = family || (/^[A-Z]+$/i.test(parts[0]) ? 'ulx' : parts.length >= 8 ? 'ad' : 'slx');
  const n = parts.map(num);
  if (f === 'slx') {
    // SLX-D: <audio peak> <audio rms> <rf level>, all 0-120 with a -120 offset
    if (n.length < 3) return {};
    return { audioDbfs: n[0] - 120, audioRms: n[1] - 120, rfDbm: n[2] - 120 };
  }
  if (f === 'ad') {
    // Axient Digital: <quality> <audio LED> <peak> <rms> <antennas> <bitmapA> <rfA> <bitmapB> <rfB> ...
    const rf = [n[6], n[8]].filter((x) => x != null).map((x) => x - 120);
    return { audioDbfs: n[2] - 120, audioRms: n[3] - 120, antenna: parts[4], rfDbm: rf.length ? Math.max(...rf) : null };
  }
  // ULX-D / QLX-D: <antenna> <rf 0-115, -128> <audio 0-50, -50>
  const data = {};
  if (/^[A-Z]+$/i.test(parts[0])) data.antenna = parts.shift();
  const nums = parts.map(num).filter((x) => x !== null);
  if (nums.length >= 2) {
    data.rfDbm = nums[0] - 128;
    data.audioDbfs = nums[1] - 50;
  }
  return data;
}

/** Split a TCP stream buffer into complete "< ... >" bodies plus leftover text. */
export function splitMessages(buffer) {
  const out = [];
  let rest = buffer;
  for (;;) {
    const start = rest.indexOf('<');
    if (start === -1) return { messages: out, rest: '' };
    const end = rest.indexOf('>', start);
    if (end === -1) return { messages: out, rest: rest.slice(start) };
    out.push(rest.slice(start + 1, end));
    rest = rest.slice(end + 1);
  }
}

export class ShureReceiver {
  constructor(cfg, hub, micIdFor) {
    this.cfg = { port: 2202, channels: 4, meterRateMs: 200, pollMs: 5000, ...cfg };
    this.family = familyOf(this.cfg.model);
    this.hub = hub;
    this.micIdFor = micIdFor;
    this.buffer = '';
    this.backoff = 1000;
    this.stopped = false;
  }

  start() {
    this.hub.update('receivers', this.cfg.id, {
      name: this.cfg.name || this.cfg.id, type: 'shure', host: this.cfg.host, online: false, error: null,
    });
    for (let ch = 1; ch <= this.cfg.channels; ch++) this.hub.update('mics', this.micIdFor(this.cfg.id, ch), { online: false });
    this.connect();
  }

  connect() {
    if (this.stopped) return;
    const sock = net.createConnection({ host: this.cfg.host, port: this.cfg.port });
    this.sock = sock;
    sock.setEncoding('utf8');
    sock.setKeepAlive(true, 5000);
    sock.setTimeout(15000);

    sock.on('connect', () => {
      this.backoff = 1000;
      this.lastData = Date.now();
      this.setOnline(true, null);
      this.send('< GET 0 ALL >');
      this.send('< GET MODEL >');
      this.send('< GET FW_VER >');
      if (this.cfg.meterRateMs) this.send(`< SET 0 METER_RATE ${Math.max(100, this.cfg.meterRateMs)} >`);
      // Some models don't push every change; a slow re-poll keeps battery/frequency fresh.
      this.poll = setInterval(() => this.send('< GET 0 ALL >'), this.cfg.pollMs);
    });
    sock.on('data', (chunk) => this.onData(chunk));
    sock.on('timeout', () => sock.destroy(new Error('No data from receiver (timeout)')));
    sock.on('error', (err) => this.setOnline(false, err.message));
    sock.on('close', () => {
      clearInterval(this.poll);
      this.setOnline(false);
      if (this.stopped) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 15000);
    });
  }

  send(cmd) {
    if (this.sock && !this.sock.destroyed && this.sock.writable) this.sock.write(cmd);
  }

  setOnline(online, error) {
    const rx = this.hub.state.receivers[this.cfg.id] || {};
    this.hub.update('receivers', this.cfg.id, { online, error: error === undefined ? rx.error : error });
    for (let ch = 1; ch <= this.cfg.channels; ch++) this.hub.update('mics', this.micIdFor(this.cfg.id, ch), { online });
  }

  onData(chunk) {
    const { messages, rest } = splitMessages(this.buffer + chunk);
    this.buffer = rest.length > 4096 ? '' : rest;
    for (const body of messages) {
      const msg = parseMessage(body, this.family);
      if (!msg) continue;
      if (msg.kind === 'device') {
        if (msg.data.model && !this.cfg.model) this.family = familyOf(msg.data.model);
        this.hub.update('receivers', this.cfg.id, msg.data);
      } else if (msg.channel >= 1 && msg.channel <= this.cfg.channels) {
        const id = this.micIdFor(this.cfg.id, msg.channel);
        if (msg.kind === 'meter') this.hub.meter(id, msg.data);
        else this.hub.update('mics', id, msg.data);
      }
    }
  }

  /** Write a channel name to the receiver display (pushed from green room assignments). */
  setChannelName(channel, name) {
    const max = this.cfg.nameLength || 8;
    const clean = String(name).replace(/[{}<>]/g, '').slice(0, max);
    this.send(`< SET ${channel} CHAN_NAME {${clean}} >`);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.poll);
    this.sock?.destroy();
  }
}
