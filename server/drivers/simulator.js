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
    this.hub.update('receivers', id, { name: name || id, type: 'simulator', model: this.cfg.model || 'SLXD4D (sim)', online: true, error: null });
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
        txType: s.on ? (this.cfg.txTypes?.[c - 1] || 'SLXD2') : null,
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
      if (!s.on) { this.hub.meter(id, { rfDbm: -120, audioDbfs: -120 }); return; }
      if (Math.random() < 0.03) s.talking = !s.talking;
      s.rf = Math.max(-100, Math.min(-35, s.rf + rand(-2, 2)));
      const level = s.talking ? rand(-28, -4) : rand(-50, -38);
      this.hub.meter(id, { rfDbm: Math.round(s.rf), audioDbfs: Math.round(level) });
    });
  }

  slowTick() {
    this.ch.forEach((s, i) => {
      const id = this.micIdFor(this.cfg.id, i + 1);
      if (Math.random() < 0.04) s.on = !s.on; // someone switches a pack on/off
      if (s.on) s.mins = Math.max(0, s.mins - 1);
      s.batt = Math.min(5, Math.ceil(s.mins / 80));
      this.hub.update('mics', id, {
        txType: s.on ? this.cfg.txTypes?.[i] || 'SLXD2' : null,
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

const PLAYLIST = [
  { name: 'Walk-in Loop', type: 'media' },
  { name: 'Worship', type: 'header' },
  { name: 'Great Is Thy Faithfulness', type: 'presentation' },
  { name: 'Holy Forever', type: 'presentation' },
  { name: 'Message', type: 'header' },
  { name: 'Sermon Slides', type: 'presentation' },
  { name: 'Closing', type: 'presentation' },
];

export class SimProPresenter {
  constructor(cfg, hub) { this.cfg = cfg; this.hub = hub; this.i = 0; this.t0 = Date.now(); this.pl = 2; }

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
        presentation: { uuid: 'sim', name: PLAYLIST[this.pl].name, index: this.i },
        playlist: { uuid: 'sim-playlist', name: 'Sunday Service', items: PLAYLIST, index: this.pl, itemName: PLAYLIST[this.pl].name },
        slideCount: slides.length,
        groups,
        current: { text: slides[this.i], notes: '' },
        next: { text: slides[(this.i + 1) % slides.length], notes: '' },
        layers: { video_input: false, media: true, slide: true, announcements: false, props: this.i === 0, messages: false, audio: false },
        screens: { audience: true, stage: true },
        timers: [{ name: 'Service', time: fmt(left), state: 'running' }, { name: 'Sermon', time: '35:00', state: 'stopped' }, { name: 'Walk-in', time: fmt(Math.max(0, 300 - (elapsed % 330))), state: elapsed % 330 < 300 ? 'running' : 'stopped' }],
        // A countdown video playing on the presentation layer, restarting every 5.5 minutes.
        media: elapsed % 330 < 300 ? { presentation: { name: 'Countdown 5 min.mp4', playing: true, time: elapsed % 330, duration: 300, at: Date.now() } } : {},
        capture: { status: 'active', destination: 'Disk' },
        look: 'Main',
        videoInputs: ['Camera 1', 'IMAG'],
        stageMessage: null,
      });
    };
    push();
    this.timer = setInterval(() => {
      if (Math.random() < 0.25) this.i = (this.i + 1) % slides.length;
      // Move to the next playlist item every ~45 s so the demo plan advances.
      if (Math.random() < 1 / 45) do { this.pl = (this.pl + 1) % PLAYLIST.length; } while (PLAYLIST[this.pl].type === 'header');
      push();
    }, 1000);
  }

  async thumbnail() { return null; }
  async setStageMessage(text) { this.hub.update('propresenter', this.cfg.id, { stageMessage: text || null }); }
  stop() { clearInterval(this.timer); }
}

/** Simulated ATEM Constellation 4 M/E: four M/Es, aux outputs and keyers. */
export class SimSwitcher {
  constructor(cfg, hub) { this.cfg = { me: 1, meNames: [], auxNames: {}, ...cfg }; this.hub = hub; }

  start() {
    const names = this.cfg.inputs || ['Wide', 'Pastor', 'Worship Lead', 'Keys', 'Drums', 'Crowd', 'Jib', 'Handheld', 'ProPresenter', 'Lower Thirds'];
    const mes = [0, 1, 2, 3].map((i) => ({ pgm: i, pvw: (i + 1) % 6, keyers: [i === 0, false] }));
    const auxes = [9, 0, 1, 2, 8, 5];
    const src = (n) => ({ input: n + 1, name: names[n] });
    const push = () => {
      const meStates = mes.map((m, i) => ({
        index: i + 1,
        name: this.cfg.meNames[i] || ['Program', 'Stream', 'IMAG', 'Lobby'][i],
        program: src(m.pgm),
        preview: src(m.pvw),
        ftb: false,
        inTransition: false,
        keyers: m.keyers,
        onAir: [m.pgm + 1, ...(m.keyers[0] ? [10] : [])],
        next: [m.pvw + 1],
      }));
      const primary = meStates[this.cfg.me - 1] || meStates[0];
      this.hub.update('switchers', this.cfg.id, {
        name: this.cfg.name || this.cfg.id, type: 'simulator', model: 'ATEM Constellation 4 M/E (sim)', online: true, error: null,
        inputs: names.map((n, i) => ({ input: i + 1, name: n, short: n.slice(0, 4).toUpperCase() })),
        mes: meStates,
        dsks: [{ index: 1, onAir: true, tie: false }, { index: 2, onAir: false, tie: false }],
        auxes: auxes.map((n, i) => ({ index: i + 1, name: this.cfg.auxNames[i + 1] || ['Stream', 'Record', 'IMAG L', 'IMAG R', 'Stage Display', 'Lobby'][i], source: src(n) })),
        program: primary.program, preview: primary.preview, ftb: false, streaming: true, recording: true,
      });
    };
    push();
    this.timer = setInterval(() => {
      for (const m of mes) if (Math.random() < 0.15) [m.pgm, m.pvw] = [m.pvw, Math.floor(Math.random() * 8)];
      push();
    }, 2000);
  }

  stop() { clearInterval(this.timer); }
}

function fmt(s) {
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
