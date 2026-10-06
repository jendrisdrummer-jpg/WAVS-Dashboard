// Configurable mic views, used by the "Mics & gear" widget and the /greenroom page.
//
// Layouts:  board  - tall photo columns with a rolling RF/audio graph (fills a big screen)
//           rows   - one horizontal row per mic: photo, name, battery, graph (narrow side panels)
//           cards  - grid of cards with a round photo, battery and RF strength
//           tiles  - grid of photo tiles with the name over the picture
//           strip  - compact cards with live RF / audio meters (a row along the bottom)
// Every part (photo, role, battery, status, mic label, details, levels, hand-off buttons) can be
// switched on or off, and the list can be filtered and sorted. See MIC_OPTIONS.
import {
  store, esc, setHTML, micView, battery, battLevel, photoUrl, initials, rfPct, audioPct,
  meterRows, applyMeters, STATUS_LABEL, KIND_ICON, api, toast,
} from './common.js';

const PALETTE = ['#7c3aed', '#dc2626', '#2563eb', '#059669', '#d97706', '#db2777', '#0891b2', '#65a30d'];
const RATE = 4; // samples per second
const KEEP = 60 * RATE; // keep a minute of history
const history = new Map(); // mic id -> [{ rf, af } | null]
const views = new Set();
let sampler = null;

const STATUS_RANK = { 'on-stage': 0, 'picked-up': 1, assigned: 2, returned: 3 };
const KINDS = [['handheld', 'Handhelds'], ['headset', 'Headsets'], ['lav', 'Lavs'], ['iem', 'In-ears'], ['instrument', 'Instruments']];

/** Options shared by every place that shows mics (rendered by the dashboard settings dialog). */
export const MIC_OPTIONS = [
  { key: 'layout', label: 'Look', type: 'select', group: 'Layout', default: 'board', choices: () => [
    ['board', 'Board: tall photo columns with graph'],
    ['rows', 'Rows: one line per mic with graph'],
    ['cards', 'Cards: round photo, battery, RF'],
    ['tiles', 'Photo tiles: name over the picture'],
    ['strip', 'Strip: compact with live meters'],
  ] },
  { key: 'columns', label: 'Columns (0 = fit automatically)', type: 'number', group: 'Layout', default: 0 },
  { key: 'photoFit', label: 'Photo', type: 'select', group: 'Layout', default: 'cover', choices: () => [['cover', 'Fill the space (crop)'], ['contain', 'Show the whole photo (best for cut-outs)']] },
  { key: 'show', label: 'Which mics', type: 'select', group: 'Filter & order', default: 'all', choices: () => [['all', 'All mics'], ['assigned', 'Assigned to someone'], ['in-use', 'In use (picked up or on stage)']] },
  { key: 'kinds', label: 'Mic types (none ticked = all)', type: 'multi', group: 'Filter & order', choices: () => KINDS },
  { key: 'mics', label: 'Only these mics (none ticked = all)', type: 'mics', group: 'Filter & order' },
  { key: 'sort', label: 'Order', type: 'select', group: 'Filter & order', default: 'config', choices: () => [['config', 'Rack order (as configured)'], ['status', 'On stage first'], ['name', 'Name A–Z']] },
  { key: 'photo', label: 'Photo', type: 'checkbox', group: 'Show', default: true },
  { key: 'role', label: 'Surname & role', type: 'checkbox', group: 'Show', default: true },
  { key: 'micLabel', label: 'Mic label (HH 1, Lav 2…)', type: 'checkbox', group: 'Show', default: true },
  { key: 'status', label: 'Hand-off status', type: 'checkbox', group: 'Show', default: true },
  { key: 'battery', label: 'Battery', type: 'checkbox', group: 'Show', default: true },
  { key: 'details', label: 'Frequency & signal numbers', type: 'checkbox', group: 'Show', default: true },
  { key: 'handoff', label: 'Picked up / On stage / Returned buttons', type: 'checkbox', group: 'Show', default: false },
  { key: 'levels', label: 'Levels', type: 'select', group: 'Signal', default: 'graph', choices: () => [['graph', 'Rolling graph'], ['meters', 'Live meters (bars)'], ['none', 'None']] },
  { key: 'graph', label: 'Graph shows', type: 'select', group: 'Signal', default: 'both', choices: () => [['both', 'RF (bars) + audio (line)'], ['rf', 'RF only'], ['audio', 'Audio only']] },
  { key: 'seconds', label: 'Graph length', type: 'select', group: 'Signal', default: '40', choices: () => [['20', '20 seconds'], ['40', '40 seconds'], ['60', '1 minute']] },
  { key: 'flash', label: 'Flash red when a mic in use loses signal', type: 'checkbox', group: 'Signal', default: true },
];

export function micDefaults() {
  return Object.fromEntries(MIC_OPTIONS.filter((o) => o.default !== undefined).map((o) => [o.key, o.default]));
}

function sample() {
  for (const slot of store.slots) {
    const m = store.state.mics[slot.id] || {};
    const on = m.online && (Boolean(m.txType) || (m.rfDbm != null && m.rfDbm > -110));
    const h = history.get(slot.id) || [];
    h.push(on ? { rf: m.rfDbm, af: m.audioDbfs } : null);
    if (h.length > KEEP) h.shift();
    history.set(slot.id, h);
  }
  for (const v of views) v.draw();
}

/** Stable colour per person (their chosen colour, else the mic's, else one picked from their id). */
export function colorFor(person, slot) {
  if (person?.color) return person.color;
  if (slot.color) return slot.color;
  const key = person?.id || slot.id;
  let n = 0;
  for (const ch of key) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[n % PALETTE.length];
}

/** Mics to show for a set of options, filtered and sorted. */
export function selectSlots(o) {
  const asg = store.greenroom.assignments;
  const list = store.slots.filter((s) => {
    if (s.hidden) return false;
    if (o.mics?.length && !o.mics.includes(s.id)) return false;
    if (o.kinds?.length && !o.kinds.includes(s.kind)) return false;
    const a = asg[s.id];
    if (o.show === 'assigned') return a && a.status !== 'returned';
    if (o.show === 'in-use') return a && (a.status === 'picked-up' || a.status === 'on-stage');
    return true;
  });
  const person = (s) => store.greenroom.people.find((p) => p.id === asg[s.id]?.personId);
  if (o.sort === 'status') list.sort((x, y) => (STATUS_RANK[asg[x.id]?.status] ?? 4) - (STATUS_RANK[asg[y.id]?.status] ?? 4));
  if (o.sort === 'name') list.sort((x, y) => (person(x)?.name || `~${x.label}`).localeCompare(person(y)?.name || `~${y.label}`));
  return list;
}

/**
 * Mount a mic view into `el`. `options` are MIC_OPTIONS values; `getSlots` overrides the
 * filtering (the /greenroom page has its own filter controls).
 * Returns { update(), meters(), destroy() }. update() is cheap and can run on every render.
 */
export function mountMicView(el, options = {}, { getSlots } = {}) {
  const o = { ...micDefaults(), ...options };
  if (options.assignedOnly && !options.show) o.show = 'assigned'; // older saved widgets
  const items = new Map(); // mic id -> { root, info, level, canvas, foot, actions }
  let order = '';
  el.classList.add('mv', `mv-${o.layout}`, `mv-fit-${o.photoFit}`);
  if (Number(o.columns) > 0) { el.classList.add('mv-cols'); el.style.setProperty('--cols', Number(o.columns)); }

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-status]');
    if (!b) return;
    const current = store.greenroom.assignments[b.dataset.mic]?.status;
    // Tapping the highlighted status again steps it back to "assigned".
    const status = current === b.dataset.status ? 'assigned' : b.dataset.status;
    try { await api('PUT', `/api/assignments/${encodeURIComponent(b.dataset.mic)}`, { status }); } catch (err) { toast(err.message, true); }
  });

  function stateOf(v) {
    const inUse = v.a && (v.a.status === 'picked-up' || v.a.status === 'on-stage');
    if (v.alerting || (inUse && !v.txOn) || (v.a && !v.mic.online)) return 'alert';
    if (!v.txOn) return 'off';
    return battLevel(v.mic) === 'critical' ? 'warn' : 'ok';
  }

  function skeleton(slot) {
    const root = document.createElement('div');
    root.innerHTML = `<div class="mv-info"></div>${o.levels === 'none' ? '' : `<div class="mv-level">${o.levels === 'meters' ? `<div class="meters">${meterRows(slot)}</div>` : '<canvas></canvas>'}</div>`}<div class="mv-foot mono"></div><div class="mv-actions"></div>`;
    return { root, info: root.querySelector('.mv-info'), canvas: root.querySelector('canvas'), foot: root.querySelector('.mv-foot'), actions: root.querySelector('.mv-actions') };
  }

  function update() {
    const slots = getSlots ? getSlots() : selectSlots(o);
    const ids = slots.map((s) => s.id).join('|');
    if (ids !== order) {
      order = ids;
      for (const id of items.keys()) if (!slots.some((s) => s.id === id)) items.delete(id);
      for (const s of slots) if (!items.has(s.id)) items.set(s.id, skeleton(s));
      el.replaceChildren(...slots.map((s) => items.get(s.id).root));
      if (!slots.length) el.innerHTML = `<div class="w-empty">${o.show === 'all' ? 'No mics configured' : 'Nobody to show yet. Assign people to mics on the <a href="/admin">Setup</a> page.'}</div>`;
      if (o.levels === 'meters') applyMeters(el);
    }
    for (const slot of slots) {
      const it = items.get(slot.id);
      const v = micView(slot);
      const state = stateOf(v);
      it.state = state;
      it.root.className = `mv-item s-${state} ${v.person ? '' : 'empty'} ${v.a ? `st-${v.a.status}` : ''} ${o.flash ? 'flash' : ''}`;
      it.root.style.setProperty('--c', colorFor(v.person, slot));
      setHTML(it.info, info(slot, v, state));
      const { mic } = v;
      setHTML(it.foot, !o.details ? '' : !mic.online ? 'RX offline' : `${mic.freqMHz ? mic.freqMHz.toFixed(3) : ''}<span>${v.txOn ? (mic.rfDbm != null ? `${mic.rfDbm} dBm` : '') : 'TX off'}</span>`);
      setHTML(it.actions, o.handoff && v.a ? ['picked-up', 'on-stage', 'returned'].map((s) => `
        <button class="btn ${v.a.status === s ? `sel ${s}` : ''}" data-mic="${esc(slot.id)}" data-status="${s}">${STATUS_LABEL[s]}</button>`).join('') : '');
    }
  }

  /** The person / mic part of an item; its shape depends on the layout. */
  function info(slot, v, state) {
    const { mic, a, person } = v;
    const url = o.photo ? photoUrl(person) : null;
    const [first, ...rest] = person ? person.name.split(/\s+/) : [slot.label];
    const sub = person ? [rest.join(' '), person.role].filter(Boolean).join(' · ') : 'Unassigned';
    const batt = o.battery && mic.online && v.txOn ? battery(mic) : '';
    const status = o.status && a ? `<span class="mv-status ${a.status}">${STATUS_LABEL[a.status]}</span>` : '';
    const label = o.micLabel ? `<span class="mv-mic">${KIND_ICON[slot.kind] || ''} ${esc(slot.label)}</span>` : '';
    const flag = state === 'alert' ? `<span class="mv-flag">${!mic.online ? 'RECEIVER OFFLINE' : !v.txOn ? 'NO SIGNAL' : 'CHECK MIC'}</span>` : '';
    const glow = 'radial-gradient(circle at 50% 45%, var(--c), transparent 75%)';
    const photoBox = (cls) => `<div class="${cls}" style="background-image:${url ? `url('${url}'), ` : ''}${glow}">${url ? '' : `<span class="mv-initials">${esc(person ? initials(person.name) : KIND_ICON[slot.kind] || '🎤')}</span>`}`;
    const avatar = o.photo ? `<div class="mv-avatar" style="${url ? `background-image:url('${url}')` : ''}">${url ? '' : esc(person ? initials(person.name) : '—')}</div>` : '';
    const nameBlock = `<b class="mv-first">${esc(first)}</b>${o.role ? `<span class="mv-sub">${esc(sub)}</span>` : ''}`;

    switch (o.layout) {
      case 'rows':
        return `${avatar}<div class="mv-who">${nameBlock}<div class="mv-tags">${label}${status}</div></div><div class="mv-side">${batt}</div>${flag}`;
      case 'cards': {
        const bars = !v.txOn ? 0 : mic.rfDbm > -60 ? 4 : mic.rfDbm > -70 ? 3 : mic.rfDbm > -80 ? 2 : 1;
        return `${status || '<span class="mv-status">Spare</span>'}<div class="mv-who">${nameBlock}</div>${avatar}${label}
          <div class="mv-stats">${batt || (v.txOn ? '' : '<span class="txoff">TX OFF</span>')}<span class="rfbars b${bars}" title="RF"><i></i><i></i><i></i><i></i></span></div>${flag}`;
      }
      case 'tiles':
        return `${photoBox('mv-photo')}${status}<div class="mv-batt">${batt}</div>${label}<div class="mv-overlay">${nameBlock}</div>${flag}</div>`;
      case 'strip':
        return `${avatar}<div class="mv-who">${nameBlock}<div class="mv-tags">${label}${status}${batt}</div></div>${flag}`;
      default: // board
        return `<div class="mv-top"><b class="mv-first">${esc(first)}</b><div class="mv-subrow">${o.role ? `<span class="mv-sub">${esc(sub)}</span>` : '<span></span>'}${batt}</div></div>
          ${o.photo ? `${photoBox('mv-photo')}${label}${status}${flag}</div>` : `<div class="mv-photo mv-nophoto">${label}${status}${flag}</div>`}`;
    }
  }

  function draw() {
    if (o.levels !== 'graph') return;
    const low = store.config.alerts.rfLowDbm;
    const dpr = window.devicePixelRatio || 1;
    const n = Number(o.seconds || 40) * RATE;
    for (const [id, it] of items) {
      const cv = it.canvas;
      if (!cv) continue;
      const w = Math.round(cv.clientWidth * dpr);
      const h = Math.round(cv.clientHeight * dpr);
      if (!w || !h) continue;
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, w, h);
      const data = (history.get(id) || []).slice(-n);
      const step = w / n;
      const x0 = w - data.length * step; // newest sample at the right edge
      if (o.graph !== 'audio') {
        data.forEach((s, i) => {
          if (!s || s.rf == null) return;
          const bh = (rfPct(s.rf) / 100) * h * 0.92;
          ctx.fillStyle = it.state === 'alert' ? '#ef4444' : s.rf < low ? '#f59e0b' : '#22c55e';
          ctx.fillRect(x0 + i * step, h - bh, Math.max(1, step - dpr * 0.6), bh);
        });
      }
      if (o.graph !== 'rf') {
        ctx.strokeStyle = o.graph === 'audio' ? '#22c55e' : 'rgba(255,255,255,.8)';
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath();
        let pen = false;
        data.forEach((s, i) => {
          if (!s || s.af == null) { pen = false; return; }
          const y = h - (audioPct(s.af) / 100) * h * 0.92;
          const x = x0 + i * step + step / 2;
          if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y);
          pen = true;
        });
        ctx.stroke();
      }
    }
  }

  const view = { draw };
  views.add(view);
  if (!sampler) sampler = setInterval(sample, 1000 / RATE);
  return {
    update,
    meters: () => { if (o.levels === 'meters') applyMeters(el); },
    destroy() {
      views.delete(view);
      if (!views.size) { clearInterval(sampler); sampler = null; }
    },
  };
}
