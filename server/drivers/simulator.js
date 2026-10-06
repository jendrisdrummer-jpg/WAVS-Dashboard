/**
 * Simulated devices so the dashboard can be demoed, styled and trained on
 * without any hardware. Use `type: simulator` for any receiver, ProPresenter or switcher.
 */

const rand = (a, b) => a + Math.random() * (b - a);

export class SimReceiver {
  constructor(cfg, hub, micIdFor) {
    this.cfg = { channels: 4, baseMHz: 470 + Math.floor(Math.random() * 60), ...cfg };
    this.hub = hub;
    this.micIdFor = micIdFor;
    this.ch = [];
  }

  start() {
    const { id, name, channels, baseMHz } = this.cfg;
    this.hub.update('receivers', id, { name: name || id, type: 'simulator', model: this.cfg.model || 'ULXD4Q (sim)', online: true, error: null });
    for (let c = 1; c <= channels; c++) {
      const s = {
        on: Math.random() > 0.15,
        batt: Math.floor(rand(1, 6)),
        mins: 0,
        rf: rand(-70, -45),
        talking: false,
      };
      s.mins = s.batt * 80 + Math.floor(rand(-20, 20));
      this.ch.push(s);
      this.hub.update('mics', this.micIdFor(id, c), {
        online: true,
        chanName: `CH ${c}`,
        freqMHz: Math.round((baseMHz + c * 0.725 + rand(0, 0.4)) * 40) / 40,
        groupChan: `${1 + (c % 3)},${c}`,
        txType: s.on ? (c % 2 ? 'ULXD2' : 'ULXD1') : null,
        battBars: s.on ? s.batt : null,
        battMinutes: s.on ? s.mins : null,
        battType: 'LION',
        txMuted: false,
        interference: false,
      });
    }
    this.fast = setInterval(() => this.meters(), 150);
    this.slowTimer = setInterval(() => this.slowTick(), 4000);
  }

  meters() {
    this.ch.forEach((s, i) => {
      const id = this.micIdFor(this.cfg.id, i + 1);
      if (!s.on) { this.hub.meter(id, { rfDbm: -128, audioDbfs: -50, antenna: 'XX' }); return; }
      if (Math.random() < 0.03) s.talking = !s.talking;
      s.rf = Math.max(-100, Math.min(-35, s.rf + rand(-2, 2)));
      const level = s.talking ? rand(-28, -4) : rand(-50, -38);
      this.hub.meter(id, { rfDbm: Math.round(s.rf), audioDbfs: Math.round(level), antenna: Math.random() > 0.5 ? 'AX' : 'XB' });
    });
  }

  slowTick() {
    this.ch.forEach((s, i) => {
      const id = this.micIdFor(this.cfg.id, i + 1);
      if (Math.random() < 0.04) s.on = !s.on; // someone switches a pack on/off
      if (s.on) s.mins = Math.max(0, s.mins - 1);
      s.batt = Math.min(5, Math.ceil(s.mins / 80));
      this.hub.update('mics', id, {
        txType: s.on ? this.hub.state.mics[id]?.txType || 'ULXD2' : null,
        battBars: s.on ? s.batt : null,
        battMinutes: s.on ? s.mins : null,
      });
    });
  }

  setChannelName(channel, name) {
    this.hub.update('mics', this.micIdFor(this.cfg.id, channel), { chanName: String(name).slice(0, 8) });
  }

  stop() { clearInterval(this.fast); clearInterval(this.slowTimer); }
}

const SONG = {
  name: 'Great Is Thy Faithfulness',
  groups: [
    { name: 'Verse 1', color: 'rgb(60,130,246)', slides: ['Great is Thy faithfulness\nO God my Father', 'There is no shadow of turning with Thee'] },
    { name: 'Chorus', color: 'rgb(220,60,90)', slides: ['Great is Thy faithfulness\nGreat is Thy faithfulness', 'Morning by morning\nnew mercies I see', 'All I have needed\nThy hand hath provided'] },
    { name: 'Verse 2', color: 'rgb(60,130,246)', slides: ['Summer and winter\nand springtime and harvest', 'Sun, moon and stars\nin their courses above'] },
    { name: 'Ending', color: 'rgb(140,90,220)', slides: ['Great is Thy faithfulness\nLord unto me', ''] },
  ],
};

export class SimProPresenter {
  constructor(cfg, hub) { this.cfg = cfg; this.hub = hub; this.i = 0; this.t0 = Date.now(); }

  start() {
    const slides = SONG.groups.flatMap((g) => g.slides);
    let start = 0;
    const groups = SONG.groups.map((g) => { const o = { name: g.name, color: g.color, start, count: g.slides.length }; start += g.slides.length; return o; });
    const push = () => {
      const elapsed = Math.floor((Date.now() - this.t0) / 1000);
      const left = Math.max(0, 25 * 60 - elapsed);
      this.hub.update('propresenter', this.cfg.id, {
        name: this.cfg.name || this.cfg.id,
        online: true,
        error: null,
        version: 'ProPresenter 7 (sim)',
        presentation: { uuid: 'sim', name: SONG.name, index: this.i },
        slideCount: slides.length,
        groups,
        current: { text: slides[this.i], notes: '' },
        next: { text: slides[(this.i + 1) % slides.length], notes: '' },
        layers: { video_input: false, media: true, slide: true, announcements: false, props: this.i === 0, messages: false, audio: false },
        screens: { audience: true, stage: true },
        timers: [{ name: 'Service', time: fmt(left), state: 'running' }, { name: 'Sermon', time: '35:00', state: 'stopped' }],
        capture: { status: 'active', destination: 'Disk' },
        look: 'Main',
        videoInputs: ['Camera 1', 'IMAG'],
        stageMessage: null,
      });
    };
    push();
    this.timer = setInterval(() => { if (Math.random() < 0.25) this.i = (this.i + 1) % slides.length; push(); }, 1000);
  }

  async thumbnail() { return null; }
  async setStageMessage(text) { this.hub.update('propresenter', this.cfg.id, { stageMessage: text || null }); }
  stop() { clearInterval(this.timer); }
}

export class SimSwitcher {
  constructor(cfg, hub) { this.cfg = cfg; this.hub = hub; }

  start() {
    const names = this.cfg.inputs || ['Wide', 'Pastor', 'Worship Lead', 'Keys', 'ProPresenter', 'Crowd'];
    let pgm = 0;
    let pvw = 1;
    const push = () => this.hub.update('switchers', this.cfg.id, {
      name: this.cfg.name || this.cfg.id, type: 'simulator', model: 'ATEM (sim)', online: true, error: null,
      program: { input: pgm + 1, name: names[pgm] }, preview: { input: pvw + 1, name: names[pvw] },
      ftb: false, streaming: true, recording: true,
    });
    push();
    this.timer = setInterval(() => {
      if (Math.random() < 0.3) { [pgm, pvw] = [pvw, Math.floor(Math.random() * names.length)]; push(); }
    }, 2000);
  }

  stop() { clearInterval(this.timer); }
}

function fmt(s) {
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
