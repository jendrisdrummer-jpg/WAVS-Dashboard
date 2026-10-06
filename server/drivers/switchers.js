/**
 * Switcher tally/state. Produces, per switcher:
 *   { online, model, program: { input, name }, preview: { input, name }, ftb, streaming, recording }
 * so the dashboard can label the program feed with what's actually on air.
 */

/** Blackmagic ATEM via the `atem-connection` package (installed as an optional dependency). */
export class AtemSwitcher {
  constructor(cfg, hub) {
    this.cfg = { me: 0, ...cfg };
    this.hub = hub;
  }

  async start() {
    this.hub.update('switchers', this.cfg.id, { name: this.cfg.name || this.cfg.id, type: 'atem', host: this.cfg.host, online: false });
    let Atem;
    try {
      ({ Atem } = await import('atem-connection'));
    } catch {
      this.hub.update('switchers', this.cfg.id, { error: 'atem-connection not installed (npm install atem-connection)' });
      return;
    }
    this.atem = new Atem();
    this.atem.on('connected', () => { this.hub.update('switchers', this.cfg.id, { online: true, error: null }); this.publish(); });
    this.atem.on('disconnected', () => this.hub.update('switchers', this.cfg.id, { online: false }));
    this.atem.on('error', (e) => this.hub.update('switchers', this.cfg.id, { error: String(e) }));
    this.atem.on('stateChanged', () => this.publish());
    this.atem.connect(this.cfg.host);
  }

  publish() {
    const s = this.atem?.state;
    if (!s) return;
    const me = s.video?.mixEffects?.[this.cfg.me];
    const name = (n) => (n == null ? null : s.inputs?.[n]?.longName || s.inputs?.[n]?.shortName || `Input ${n}`);
    this.hub.update('switchers', this.cfg.id, {
      model: s.info?.productIdentifier || 'ATEM',
      program: me ? { input: me.programInput, name: name(me.programInput) } : null,
      preview: me ? { input: me.previewInput, name: name(me.previewInput) } : null,
      ftb: Boolean(me?.fadeToBlack?.isFullyBlack),
      streaming: s.streaming?.status?.state != null ? s.streaming.status.state === 4 : null, // 4 = Streaming
      recording: s.recording?.status?.state != null ? s.recording.status.state === 1 : null, // 1 = Recording
    });
  }

  stop() { this.atem?.disconnect(); }
}

/** vMix via its HTTP API (http://host:8088/api returns XML). */
export class VmixSwitcher {
  constructor(cfg, hub) {
    this.cfg = { port: 8088, pollMs: 500, ...cfg };
    this.hub = hub;
  }

  start() {
    this.hub.update('switchers', this.cfg.id, { name: this.cfg.name || this.cfg.id, type: 'vmix', host: this.cfg.host, online: false });
    this.tick();
  }

  async tick() {
    if (this.stopped) return;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2000);
      const xml = await (await fetch(`http://${this.cfg.host}:${this.cfg.port}/api`, { signal: ctrl.signal })).text();
      clearTimeout(t);
      this.hub.update('switchers', this.cfg.id, { online: true, error: null, ...parseVmix(xml) });
    } catch (err) {
      this.hub.update('switchers', this.cfg.id, { online: false, error: err.name === 'AbortError' ? 'Timed out' : err.message });
    }
    this.timer = setTimeout(() => this.tick(), this.cfg.pollMs);
  }

  stop() { this.stopped = true; clearTimeout(this.timer); }
}

export function parseVmix(xml) {
  const tag = (t) => xml.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1];
  const titles = {};
  for (const m of xml.matchAll(/<input\b([^>]*)>/g)) {
    const num = m[1].match(/number="(\d+)"/)?.[1];
    const title = m[1].match(/title="([^"]*)"/)?.[1];
    if (num) titles[num] = decode(title || `Input ${num}`);
  }
  const active = tag('active');
  const preview = tag('preview');
  return {
    model: `vMix ${tag('version') || ''}`.trim(),
    program: active ? { input: Number(active), name: titles[active] } : null,
    preview: preview ? { input: Number(preview), name: titles[preview] } : null,
    ftb: tag('fadeToBlack') === 'True',
    streaming: tag('streaming') ? tag('streaming') === 'True' : null,
    recording: tag('recording') ? tag('recording') === 'True' : null,
  };
}

function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
