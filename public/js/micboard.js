// Mic board: one tall column per mic. Name, battery, a big photo on the person's colour, and a
// rolling graph of RF (bars) and audio (line), so anyone can tell at a glance who has which mic
// and whether it's healthy. Used by the "Mics & gear" widget (Board layout) and /greenroom.
import { store, esc, setHTML, micView, battery, battLevel, photoUrl, initials, rfPct, audioPct, STATUS_LABEL, KIND_ICON, api, toast } from './common.js';

const PALETTE = ['#7c3aed', '#dc2626', '#2563eb', '#059669', '#d97706', '#db2777', '#0891b2', '#65a30d'];
const SAMPLES = 160; // 40 s of history at 4 samples / s
const history = new Map(); // mic id -> [{ rf, af }]
const boards = new Set();
let sampler = null;

function sample() {
  for (const slot of store.slots) {
    const m = store.state.mics[slot.id] || {};
    const on = m.online && (Boolean(m.txType) || (m.rfDbm != null && m.rfDbm > -110));
    const h = history.get(slot.id) || [];
    h.push(on ? { rf: m.rfDbm, af: m.audioDbfs } : null);
    if (h.length > SAMPLES) h.shift();
    history.set(slot.id, h);
  }
  for (const b of boards) b.draw();
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

/**
 * Mount a board into `el`. `getSlots()` returns the mic slots to show, in order.
 * Returns { update(), destroy() }; update() is cheap and can run on every render.
 */
export function mountMicBoard(el, { getSlots, handoff = () => false }) {
  el.classList.add('mboard');
  const cols = new Map(); // mic id -> { root, info, canvas, foot }
  let order = '';

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-status]');
    if (!b) return;
    const current = store.greenroom.assignments[b.dataset.mic]?.status;
    // Tapping the highlighted status again steps it back to "assigned".
    const status = current === b.dataset.status ? 'assigned' : b.dataset.status;
    try { await api('PUT', `/api/assignments/${encodeURIComponent(b.dataset.mic)}`, { status }); } catch (err) { toast(err.message, true); }
  });

  function columnState(v) {
    const inUse = v.a && (v.a.status === 'picked-up' || v.a.status === 'on-stage');
    if (v.alerting || (inUse && !v.txOn) || (v.a && !v.mic.online)) return 'alert';
    if (!v.txOn) return 'off';
    return battLevel(v.mic) === 'critical' ? 'warn' : 'ok';
  }

  function update() {
    const slots = getSlots();
    const ids = slots.map((s) => s.id).join('|');
    if (ids !== order) {
      // Rebuild the column skeletons; canvases are kept per mic so graphs don't flicker.
      order = ids;
      for (const id of cols.keys()) if (!slots.some((s) => s.id === id)) cols.delete(id);
      el.replaceChildren(...slots.map((s) => {
        if (!cols.has(s.id)) {
          const root = document.createElement('div');
          root.className = 'mb-col';
          root.innerHTML = '<div class="mb-info"></div><div class="mb-graph"><canvas></canvas></div><div class="mb-foot mono"></div><div class="mb-actions"></div>';
          cols.set(s.id, { root, info: root.querySelector('.mb-info'), canvas: root.querySelector('canvas'), foot: root.querySelector('.mb-foot'), actions: root.querySelector('.mb-actions') });
        }
        return cols.get(s.id).root;
      }));
      if (!slots.length) el.innerHTML = '<div class="w-empty">Nobody to show yet. Assign people to mics on the <a href="/admin">Setup</a> page.</div>';
    }
    for (const slot of slots) {
      const c = cols.get(slot.id);
      const v = micView(slot);
      const { mic, a, person } = v;
      const state = columnState(v);
      const color = colorFor(person, slot);
      const url = photoUrl(person);
      const [first, ...rest] = person ? person.name.split(/\s+/) : [slot.label];
      c.state = state;
      c.root.className = `mb-col s-${state} ${person ? '' : 'empty'} ${a ? `st-${a.status}` : ''}`;
      c.root.style.setProperty('--c', color);
      setHTML(c.info, `
        <div class="mb-top">
          <b class="mb-first">${esc(first)}</b>
          <div class="mb-sub"><span>${esc(person ? [rest.join(' '), person.role].filter(Boolean).join(' · ') : 'Unassigned')}</span>${mic.online && v.txOn ? battery(mic) : ''}</div>
        </div>
        <div class="mb-photo" style="${url ? `background-image:url('${url}'), ` : 'background-image:'}radial-gradient(circle at 50% 45%, var(--c), transparent 75%)">
          ${url ? '' : `<span class="mb-initials">${esc(person ? initials(person.name) : KIND_ICON[slot.kind] || '🎤')}</span>`}
          <span class="mb-mic">${KIND_ICON[slot.kind] || ''} ${esc(slot.label)}</span>
          ${a ? `<span class="mb-status ${a.status}">${STATUS_LABEL[a.status]}</span>` : ''}
          ${state === 'alert' ? `<span class="mb-flag">${!mic.online ? 'RECEIVER OFFLINE' : !v.txOn ? 'NO SIGNAL' : 'CHECK MIC'}</span>` : ''}
        </div>`);
      setHTML(c.foot, !mic.online ? 'RX offline' : v.txOn
        ? `${mic.freqMHz ? `${mic.freqMHz.toFixed(3)}` : ''}<span>${mic.rfDbm != null ? `${mic.rfDbm} dBm` : ''}</span>`
        : `${mic.freqMHz ? mic.freqMHz.toFixed(3) : ''}<span>TX off</span>`);
      setHTML(c.actions, handoff() && a ? ['picked-up', 'on-stage', 'returned'].map((s) => `
        <button class="btn ${a.status === s ? `sel ${s}` : ''}" data-mic="${esc(slot.id)}" data-status="${s}">${STATUS_LABEL[s]}</button>`).join('') : '');
    }
  }

  function draw() {
    const low = store.config.alerts.rfLowDbm;
    const dpr = window.devicePixelRatio || 1;
    for (const [id, c] of cols) {
      const cv = c.canvas;
      const w = Math.round(cv.clientWidth * dpr);
      const h = Math.round(cv.clientHeight * dpr);
      if (!w || !h) continue;
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, w, h);
      const data = history.get(id) || [];
      const step = w / SAMPLES;
      const x0 = w - data.length * step; // newest sample at the right edge
      // RF level as bars
      data.forEach((s, i) => {
        if (!s || s.rf == null) return;
        const bh = (rfPct(s.rf) / 100) * h * 0.92;
        ctx.fillStyle = c.state === 'alert' ? '#ef4444' : s.rf < low ? '#f59e0b' : '#22c55e';
        ctx.fillRect(x0 + i * step, h - bh, Math.max(1, step - dpr * 0.6), bh);
      });
      // Audio level as a line (shows who is actually talking)
      ctx.strokeStyle = 'rgba(255,255,255,.8)';
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

  const board = { draw };
  boards.add(board);
  if (!sampler) sampler = setInterval(sample, 250);
  return {
    update,
    destroy() {
      boards.delete(board);
      if (!boards.size) { clearInterval(sampler); sampler = null; }
    },
  };
}
