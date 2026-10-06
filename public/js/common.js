// Shared client: live connection, state, helpers and reusable bits of UI.

export const store = {
  config: null,
  state: { receivers: {}, mics: {}, propresenter: {}, switchers: {} },
  slots: [],
  greenroom: { service: {}, people: [], assignments: {} },
  service: { plan: null, current: null, actuals: {}, upcoming: [], pco: {} },
  board: { notes: {}, checklists: {} },
  dashboards: [],
  alerts: [],
  connected: false,
  ready: false,
};

const renderers = new Set();
const meterListeners = new Set();
let scheduled = false;

/** Register a render function. Called (batched per animation frame) whenever state changes. */
export function onRender(fn) { renderers.add(fn); }
export function onMeters(fn) { meterListeners.add(fn); }

export function requestRender() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    for (const fn of renderers) fn(store);
  });
}

export async function start({ page }) {
  store.config = await (await fetch('/api/config')).json();
  applyTheme(store.config);
  // ?kiosk=1 hides the header (TVs, confidence monitors); alerts stay visible.
  if (new URLSearchParams(location.search).get('kiosk') === '1') document.body.classList.add('kiosk');
  renderHeader(page);
  connect();
  setInterval(tickClock, 1000);
  tickClock();
  // Wait for the first snapshot so pages can build from real data.
  await new Promise((resolve) => {
    const check = () => (store.ready ? resolve() : setTimeout(check, 50));
    check();
  });
  setTimeout(requestRender); // pages register their renderers right after start() resolves
}

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => { store.connected = true; requestRender(); };
  ws.onclose = () => {
    store.connected = false;
    requestRender();
    setTimeout(connect, 2000);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case 'snapshot':
        Object.assign(store, {
          state: msg.state, slots: msg.slots, greenroom: msg.greenroom,
          service: msg.service, board: msg.board, dashboards: msg.dashboards, ready: true,
        });
        setAlerts(msg.alerts);
        break;
      case 'service': store.service = msg.service; break;
      case 'board': store.board = msg.board; break;
      case 'dashboards': store.dashboards = msg.dashboards; break;
      case 'update':
        if (msg.data) store.state[msg.section][msg.id] = msg.data;
        else delete store.state[msg.section][msg.id];
        break;
      case 'greenroom': store.greenroom = msg.greenroom; break;
      case 'alerts': setAlerts(msg.alerts); break;
      case 'meters':
        for (const [id, v] of Object.entries(msg.meters)) Object.assign(store.state.mics[id] ||= {}, v);
        for (const fn of meterListeners) fn(msg.meters);
        return; // meters don't trigger a full render
    }
    requestRender();
  };
}

// ---------------------------------------------------------------- alerts + chime

const seenCritical = new Set();
function setAlerts(alerts) {
  const fresh = alerts.filter((a) => a.level === 'critical' && !seenCritical.has(a.key));
  if (fresh.length && store.alerts !== undefined && store.config?.alerts?.sound && store.connected) chime();
  seenCritical.clear();
  alerts.filter((a) => a.level === 'critical').forEach((a) => seenCritical.add(a.key));
  store.alerts = alerts;
  const bar = document.querySelector('.alertbar');
  if (bar) bar.innerHTML = alerts.map((a) => `<span class="alert ${a.level}">${esc(a.text)}</span>`).join('');
}

let audioCtx;
function chime() {
  try {
    audioCtx ||= new AudioContext();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.5);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.5);
  } catch { /* audio blocked until the user interacts with the page */ }
}

// ---------------------------------------------------------------- header

function applyTheme(cfg) {
  const t = cfg.org?.theme || {};
  const root = document.documentElement.style;
  if (t.accent) root.setProperty('--accent', t.accent);
  if (t.background) root.setProperty('--bg', t.background);
  if (t.panel) root.setProperty('--panel', t.panel);
}

function renderHeader(page) {
  const cfg = store.config;
  const header = document.createElement('header');
  header.innerHTML = `
    <div class="topbar">
      <div class="brand">
        ${cfg.org.logo ? '<img src="/logo" alt="">' : ''}
        <span>${esc(cfg.org.name)}</span>
        <span class="service" data-service></span>
      </div>
      <div data-slot class="slot"></div>
      <nav class="nav">
        ${[['/', 'Dashboards', 'dash'], ['/greenroom', 'Green Room', 'greenroom'], ['/rf', 'RF & Batteries', 'rf'], ['/admin', 'Setup', 'admin']]
          .map(([href, label, id]) => `<a href="${href}" class="${id === page ? 'active' : ''}">${label}</a>`).join('')}
      </nav>
      <div class="spacer"></div>
      <div data-slot-right class="slot"></div>
      <span class="conn" data-conn>Offline</span>
      <span class="clock" data-clock></span>
    </div>
    <div class="alertbar" role="status" aria-live="polite"></div>`;
  document.body.prepend(header);
  onRender(() => {
    const conn = header.querySelector('[data-conn]');
    conn.classList.toggle('ok', store.connected);
    conn.textContent = store.connected ? 'Live' : 'Reconnecting…';
    header.querySelector('[data-service]').textContent = store.greenroom.service?.name || cfg.org.serviceName || '';
  });
}

function tickClock() {
  const el = document.querySelector('[data-clock]');
  if (el) el.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ---------------------------------------------------------------- helpers

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

export function photoUrl(person) {
  return person?.photo ? `/uploads/${encodeURIComponent(person.photo)}` : null;
}

export function avatar(person, cls = 'avatar') {
  const url = photoUrl(person);
  return `<div class="${cls}" style="${url ? `background-image:url('${url}')` : ''}">${url ? '' : esc(person ? initials(person.name) : '—')}</div>`;
}

/** Everything about one mic slot: static config, live receiver data, assignment and person. */
export function micView(slot) {
  const mic = store.state.mics[slot.id] || {};
  const a = store.greenroom.assignments[slot.id] || null;
  const person = a ? store.greenroom.people.find((p) => p.id === a.personId) : null;
  const txOn = Boolean(mic.txType) || (mic.rfDbm != null && mic.rfDbm > -110);
  const alerting = store.alerts.some((al) => al.key.endsWith(`:${slot.id}`) && al.level !== 'warning');
  return { slot, mic, a, person, txOn, alerting };
}

export const STATUS_LABEL = { assigned: 'Assigned', 'picked-up': 'Picked up', 'on-stage': 'On stage', returned: 'Returned' };
export const KIND_ICON = { handheld: '🎤', lav: '🔸', headset: '🎧', iem: '👂', instrument: '🎸' };

export function battLevel(m) {
  if (m.battBars == null && m.battMinutes == null && m.battPercent == null) return 'unknown';
  const t = store.config.alerts;
  // Same rule as the server (alerts.js): runtime wins over percent, percent over bars.
  if (m.battMinutes != null) return m.battMinutes <= t.batteryMinutes ? 'critical' : m.battMinutes <= t.batteryMinutes * 3 ? 'warning' : 'good';
  const bars = m.battPercent != null ? m.battPercent / 20 : m.battBars;
  return bars <= t.batteryBars ? 'critical' : bars <= 2 ? 'warning' : 'good';
}

export function battery(m, { showText = true } = {}) {
  const level = battLevel(m);
  const bars = m.battBars ?? (m.battPercent != null ? Math.ceil(m.battPercent / 20) : 0);
  let text = '—';
  if (m.battMinutes != null) text = m.battMinutes >= 60 ? `${Math.floor(m.battMinutes / 60)}h${String(m.battMinutes % 60).padStart(2, '0')}` : `${m.battMinutes}m`;
  else if (m.battPercent != null) text = `${m.battPercent}%`;
  else if (m.battBars != null) text = `${m.battBars}/5`;
  const label = level === 'unknown' ? 'Battery unknown' : `Battery ${text}`;
  return `<span class="batt ${level}" title="${label}" aria-label="${label}">
    <span class="cells">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= bars ? 'f' : ''}"></i>`).join('')}</span>
    ${showText ? `<span class="mono">${text}</span>` : ''}</span>`;
}

export const rfPct = (dbm) => (dbm == null ? 0 : Math.max(0, Math.min(100, ((dbm + 100) / 60) * 100)));
export const audioPct = (dbfs) => (dbfs == null ? 0 : Math.max(0, Math.min(100, ((dbfs + 60) / 60) * 100)));

/** Meter rows; they're updated in place by applyMeters() without re-rendering the card. */
export function meterRows(slot) {
  return `<div class="row"><span class="k">RF</span><span class="bar rf" data-rf="${slot.id}"><i></i></span><span class="v mono" data-rfv="${slot.id}"></span></div>
    <div class="row"><span class="k">AF</span><span class="bar audio" data-af="${slot.id}"><i></i></span><span class="v mono" data-afv="${slot.id}"></span></div>`;
}

export function applyMeters(root = document) {
  const low = store.config.alerts.rfLowDbm;
  for (const el of root.querySelectorAll('[data-rf]')) {
    const m = store.state.mics[el.dataset.rf] || {};
    const on = Boolean(m.txType) || (m.rfDbm != null && m.rfDbm > -110);
    el.firstElementChild.style.width = `${on ? rfPct(m.rfDbm) : 0}%`;
    el.classList.toggle('low', on && m.rfDbm < low);
    const v = root.querySelector(`[data-rfv="${CSS.escape(el.dataset.rf)}"]`);
    if (v) v.textContent = on && m.rfDbm != null ? `${m.rfDbm}dBm` : '—';
  }
  for (const el of root.querySelectorAll('[data-af]')) {
    const m = store.state.mics[el.dataset.af] || {};
    const on = Boolean(m.txType) || (m.rfDbm != null && m.rfDbm > -110);
    const pct = on ? audioPct(m.audioDbfs) : 0;
    const bar = el.firstElementChild;
    bar.style.width = `${pct}%`;
    bar.style.backgroundSize = pct > 0 ? `${(100 / pct) * 100}% 100%` : '';
    const v = root.querySelector(`[data-afv="${CSS.escape(el.dataset.af)}"]`);
    if (v) v.textContent = on && m.audioDbfs != null ? `${m.audioDbfs}dB` : '—';
  }
}

// ---------------------------------------------------------------- API (with optional admin PIN)

export async function api(method, url, body) {
  const headers = {};
  const pin = localStorage.getItem('wavs-pin');
  if (pin) headers['x-admin-pin'] = pin;
  let payload = body;
  if (body && !(body instanceof FormData)) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload });
  if (res.status === 401) {
    const entered = prompt('Enter the admin PIN');
    if (entered == null) throw new Error('PIN required');
    localStorage.setItem('wavs-pin', entered);
    return api(method, url, body);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** Set innerHTML only when it changed (keeps focus, scroll and animations intact). */
export function setHTML(el, html) {
  if (el._html === html) return false;
  el._html = html;
  el.innerHTML = html;
  return true;
}

export const pad2 = (n) => String(n).padStart(2, '0');

/** 125 -> "2:05", -40 -> "-0:40", 3700 -> "1:01:40" */
export function fmtDuration(sec) {
  const neg = sec < 0;
  let s = Math.abs(Math.round(sec));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  const out = h ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${m}:${pad2(s % 60)}`;
  return neg ? `-${out}` : out;
}

export function toast(text, isError = false) {
  const t = document.createElement('div');
  t.className = `toast${isError ? ' err' : ''}`;
  t.textContent = text;
  document.body.append(t);
  setTimeout(() => t.remove(), 3000);
}
