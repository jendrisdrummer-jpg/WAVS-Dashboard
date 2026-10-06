/**
 * Switcher tally/state. Produces, per switcher:
 *   { online, model, program: { input, name }, preview: { input, name }, ftb, streaming, recording }
 * so the dashboard can label the program feed with what's actually on air.
 */

/**
 * Blackmagic ATEM via the `atem-connection` package (installed as an optional dependency).
 * Works with every ATEM model; multi-M/E switchers such as the Constellation 4 M/E report
 * every M/E, aux output and downstream keyer.
 *
 * Config: `me` is the 1-based M/E shown by default ("PGM" overlays, simple tally);
 * `meNames` / `auxNames` give friendly names, e.g. auxNames: { 1: "Stream", 2: "Lobby TV" }.
 */
export class AtemSwitcher {
  constructor(cfg, hub) {
    this.cfg = { me: 1, meNames: [], auxNames: {}, ...cfg };
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
    // State changes arrive many times per second during transitions; publish at most 10x/sec.
    this.atem.on('stateChanged', () => {
      if (this.pending) return;
      this.pending = setTimeout(() => { this.pending = null; this.publish(); }, 100);
    });
    this.atem.connect(this.cfg.host);
  }

  publish() {
    const s = this.atem?.state;
    if (!s) return;
    const name = (n) => (n == null ? null : s.inputs?.[n]?.longName || s.inputs?.[n]?.shortName || `Input ${n}`);
    const src = (n) => (n == null ? null : { input: n, name: name(n) });
    const visible = (mode, i) => { try { return this.atem.listVisibleInputs(mode, i); } catch { return []; } };

    const mes = (s.video?.mixEffects || []).map((me, i) => me && {
      index: i + 1,
      name: this.cfg.meNames[i] || `M/E ${i + 1}`,
      program: src(me.programInput),
      preview: src(me.previewInput),
      ftb: Boolean(me.fadeToBlack?.isFullyBlack),
      inTransition: Boolean(me.transitionPosition?.inTransition),
      keyers: (me.upstreamKeyers || []).map((k) => Boolean(k?.onAir)),
      onAir: visible('program', i),
      next: visible('preview', i),
    }).filter(Boolean);
    const primary = mes[this.cfg.me - 1] || mes[0];

    // Camera / external inputs, for tally lights (InternalPortType.External = 0)
    const inputs = Object.values(s.inputs || {})
      .filter((i) => i && i.internalPortType === 0)
      .map((i) => ({ input: i.inputId, name: i.longName || `Input ${i.inputId}`, short: i.shortName || String(i.inputId) }))
      .sort((a, b) => a.input - b.input);

    this.hub.update('switchers', this.cfg.id, {
      model: s.info?.productIdentifier || 'ATEM',
      inputs,
      mes,
      dsks: (s.video?.downstreamKeyers || []).map((k, i) => k && { index: i + 1, onAir: Boolean(k.onAir), tie: Boolean(k.properties?.tie) }).filter(Boolean),
      auxes: (s.video?.auxilliaries || []).map((input, i) => input != null && {
        index: i + 1, name: this.cfg.auxNames[i + 1] || `Aux ${i + 1}`, source: src(input),
      }).filter(Boolean),
      // Shortcuts for the default M/E (tile overlays, simple tally widgets)
      program: primary?.program || null,
      preview: primary?.preview || null,
      ftb: primary?.ftb || false,
      streaming: s.streaming?.status?.state != null ? s.streaming.status.state === 4 : null, // StreamingStatus.Streaming
      recording: s.recording?.status?.state != null ? s.recording.status.state === 1 : null, // RecordingStatus.Recording
    });
  }

  stop() { clearTimeout(this.pending); this.atem?.disconnect(); }
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
  const program = active ? { input: Number(active), name: titles[active] } : null;
  const pvw = preview ? { input: Number(preview), name: titles[preview] } : null;
  const ftb = tag('fadeToBlack') === 'True';
  return {
    model: `vMix ${tag('version') || ''}`.trim(),
    inputs: Object.entries(titles).map(([n, name]) => ({ input: Number(n), name, short: n })),
    mes: [{ index: 1, name: 'Output', program, preview: pvw, ftb, keyers: [], onAir: program ? [program.input] : [], next: pvw ? [pvw.input] : [] }],
    program,
    preview: pvw,
    ftb,
    streaming: tag('streaming') ? tag('streaming') === 'True' : null,
    recording: tag('recording') ? tag('recording') === 'True' : null,
  };
}

function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
