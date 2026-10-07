// Shared client: live connection, state, helpers and reusable bits of UI.

export const store = {
  config: null,
  state: { receivers: {}, mics: {}, propresenter: {}, switchers: {}, streams: {} },
  streams: { comments: [], pinned: null, history: [], peak: 0 },
  slots: [],
  greenroom: { service: {}, people: [], assignments: {} },
  service: { plan: null, current: null, actuals: {}, upcoming: [], pco: {} },
  board: { notes: {}, checklists: {} },
  dashboards: [],
  comms: { engine: false, channels: [], members: [] },
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
  const res = await fetch('/api/config');
  if (res.status === 401) { location.replace(`/login?next=${encodeURIComponent(location.pathname + location.search)}`); await new Promise(() => {}); }
  store.config = await res.json();
  // Pages for a higher role than this account has: back to Home (the server enforces it anyway).
  const need = PAGE_ROLE[page];
  if (need && !can(need)) {
    location.replace(store.config.auth?.user ? '/' : `/login?next=${encodeURIComponent(location.pathname)}`);
    await new Promise(() => {});
  }
  // A new organization goes through the setup wizard first (only admins can run it).
  if (!store.config.setupComplete && can('admin') && !['welcome', 'settings', 'gear'].includes(page) && !location.pathname.startsWith('/tv/')) {
    location.replace('/welcome');
    await new Promise(() => {});
  }
  applyTheme(store.config);
  // ?kiosk=1 (and TV links, /tv/...) hide the header (TVs, confidence monitors); alerts stay visible.
  if (new URLSearchParams(location.search).get('kiosk') === '1' || location.pathname.startsWith('/tv/')) document.body.classList.add('kiosk');
  renderHeader(page);
  watchFaces();
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
        // The dashboard restarted with a new version (e.g. after "Update now"): load it.
        if (store.boot && msg.boot && store.boot !== msg.boot && !store.holdReload) { location.reload(); return; }
        store.boot = msg.boot;
        Object.assign(store, {
          state: msg.state, slots: msg.slots, greenroom: msg.greenroom,
          service: msg.service, board: msg.board, dashboards: msg.dashboards, comms: msg.comms || store.comms, streams: msg.streams || store.streams, ready: true,
        });
        setAlerts(msg.alerts);
        break;
      case 'reload': if (!store.holdReload) location.reload(); return; // organization switched or gear changed
      case 'service': store.service = msg.service; break;
      case 'board': store.board = msg.board; break;
      case 'comms': store.comms = msg.comms; break;
      case 'stream-comments': store.streams.comments = [...store.streams.comments, ...msg.add].slice(-300); break;
      case 'stream-pin': store.streams.pinned = msg.pinned; break;
      case 'stream-hide': store.streams.comments = store.streams.comments.filter((c) => c.id !== msg.id); break;
      case 'stream-history': store.streams.history = msg.history; store.streams.peak = msg.peak; break;
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

/** Small line icons (24px grid) for the menu and pages. */
export const ICONS = {
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  grid: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v4"/>',
  rf: '<path d="M4.9 19.1a10 10 0 0 1 0-14.2"/><path d="M19.1 4.9a10 10 0 0 1 0 14.2"/><path d="M7.8 16.2a6 6 0 0 1 0-8.4"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4"/><circle cx="12" cy="12" r="2"/>',
  plug: '<path d="M9 2v6"/><path d="M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v5"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  x: '<path d="M18 6L6 18"/><path d="M6 6l12 12"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  headset: '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="2" y="14" width="5" height="7" rx="2"/><rect x="17" y="14" width="5" height="7" rx="2"/><path d="M20 21a4 4 0 0 1-4 2h-3"/>',
  swap: '<path d="M7 4L3 8l4 4"/><path d="M3 8h14"/><path d="M17 20l4-4-4-4"/><path d="M21 16H7"/>',
};
export const icon = (name, cls = 'ic') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

/** What the current account may do: 'crew' < 'producer' < 'admin'. Without accounts everyone is admin. */
const RANKS = { crew: 1, producer: 2, admin: 3 };
export function can(role) {
  const a = store.config?.auth;
  if (!a?.enabled) return true;
  return (RANKS[a.role] || 0) >= RANKS[role];
}
const PAGE_ROLE = { gear: 'admin', settings: 'admin', welcome: 'admin', admin: 'producer' };
// Comms control also opens for comms leads on their phones (checked by the comms server), so it's only hidden from the menu.
const NAV_ROLE = { ...PAGE_ROLE, comms: 'producer' };

export const NAV = [
  ['/', 'Home', 'home', 'home'],
  ['/dashboards', 'Dashboards', 'dash', 'grid'],
  ['/greenroom', 'Green Room', 'greenroom', 'mic'],
  ['/rf', 'RF', 'rf', 'rf'],
  ['/gear', 'Gear', 'gear', 'plug'],
  ['/admin', 'Service & People', 'admin', 'list'],
  ['/comms/control', 'Comms', 'comms', 'headset'],
  ['/settings', 'Settings', 'settings', 'settings'],
];

function renderHeader(page) {
  const cfg = store.config;
  const header = document.createElement('header');
  const badge = cfg.org.logo ? '<img src="/logo" alt="">' : `<span class="org-mark">${esc(initials(cfg.org.name))}</span>`;
  header.innerHTML = `
    <div class="topbar">
      <div class="org-wrap">
        <button class="org-btn" type="button" aria-haspopup="menu" aria-expanded="false" title="Organization: switch or add">
          ${badge}<span class="org-text"><b>${esc(cfg.org.name)}</b><small data-service></small></span><span class="caret">▾</span>
        </button>
        <div class="org-menu hidden" role="menu">
          <div class="org-menu-head">Organization</div>
          ${cfg.orgs.map((o) => `<button role="menuitem" data-org="${esc(o.id)}" class="${o.id === cfg.orgId ? 'cur' : ''}">
            <span class="org-dot" style="background:${esc(o.color)}"></span>${esc(o.name)}${o.id === cfg.orgId ? icon('check') : ''}</button>`).join('')}
          ${can('admin') ? `<hr><button role="menuitem" data-org-add>${icon('plus')} Add organization</button>
          <a role="menuitem" href="/settings">${icon('settings')} Organization settings</a>` : ''}
        </div>
      </div>
      <div data-slot class="slot"></div>
      <nav class="nav">
        ${NAV.filter(([, , id]) => !NAV_ROLE[id] || can(NAV_ROLE[id])).map(([href, label, id, ic]) => `<a href="${href}" class="${id === page ? 'active' : ''}" title="${label}">${icon(ic)}<span>${label}</span></a>`).join('')}
      </nav>
      <div class="spacer"></div>
      <div data-slot-right class="slot"></div>
      ${accountChip()}
      <span class="conn" data-conn>Offline</span>
      <span class="clock" data-clock></span>
    </div>
    <div class="alertbar" role="status" aria-live="polite"></div>`;
  document.body.prepend(header);

  const btn = header.querySelector('.org-btn');
  const menu = header.querySelector('.org-menu');
  const toggle = (open) => { menu.classList.toggle('hidden', !open); btn.setAttribute('aria-expanded', String(open)); };
  btn.onclick = (e) => { e.stopPropagation(); toggle(menu.classList.contains('hidden')); };
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) toggle(false); });
  menu.addEventListener('click', async (e) => {
    const sw = e.target.closest('[data-org]');
    if (sw && sw.dataset.org !== cfg.orgId) {
      const name = cfg.orgs.find((o) => o.id === sw.dataset.org)?.name;
      if (!confirm(`Switch to ${name}?\n\nEvery screen will change to ${name}'s gear, people and dashboards.`)) return;
      try { await api('POST', '/api/orgs/active', { id: sw.dataset.org }); } catch (err) { toast(err.message, true); }
    }
    if (e.target.closest('[data-org-add]')) {
      const name = prompt('Name of the new organization (e.g. "Acme Productions")');
      if (!name?.trim()) return;
      try { await api('POST', '/api/orgs', { name: name.trim() }); } catch (err) { toast(err.message, true); }
    }
  });

  onRender(() => {
    const conn = header.querySelector('[data-conn]');
    conn.classList.toggle('ok', store.connected);
    conn.textContent = store.connected ? 'Live' : 'Reconnecting…';
    header.querySelector('[data-service]').textContent = store.greenroom.service?.name || cfg.org.serviceName || '';
  });
}

function accountChip() {
  const a = store.config.auth;
  if (!a?.enabled) return '';
  if (!a.user) return `<a class="btn small acct-signin" href="/login?next=${encodeURIComponent(location.pathname)}">Sign in</a>`;
  return `<div class="acct-wrap"><button class="acct-btn" type="button" aria-haspopup="menu" title="${esc(a.user.name)}">
      <span class="acct-mark">${esc(initials(a.user.name))}</span><span class="acct-text"><b>${esc(a.user.name.split(' ')[0])}</b><small>${esc(a.role || 'no access')}</small></span></button>
    <div class="acct-menu hidden" role="menu">
      <div class="org-menu-head">${esc(a.user.username)}</div>
      ${can('admin') ? '<a role="menuitem" href="/settings#accounts">Accounts &amp; invites</a>' : ''}
      <button role="menuitem" data-acct="password">Change password</button>
      <button role="menuitem" data-acct="logout">Sign out</button>
    </div></div>`;
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.acct-btn');
  const menu = document.querySelector('.acct-menu');
  if (!menu) return;
  if (btn) { menu.classList.toggle('hidden'); return; }
  if (!menu.contains(e.target)) { menu.classList.add('hidden'); return; }
  const act = e.target.closest('[data-acct]')?.dataset.acct;
  if (act === 'logout') {
    await fetch('/api/auth/logout', { method: 'POST' });
    location.href = '/login';
  }
  if (act === 'password') {
    const current = prompt('Your current password');
    if (current == null) return;
    const next = prompt('New password (at least 8 characters)');
    if (!next) return;
    try { await api('POST', '/api/auth/password', { current, next }); toast('Password changed'); } catch (err) { toast(err.message, true); }
  }
});

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
  return `<div class="${cls}"${faceAttr(person)} style="${url ? `background-image:url('${url}')` : ''}">${url ? '' : esc(person ? initials(person.name) : '—')}</div>`;
}

/**
 * Keep faces in frame: an element showing a person's photo as its background gets
 * data-face="x,y,s,ar" (from faces.js), and fitFace() places the photo for that element's shape.
 * glow: the element has a second background layer (the colour glow behind cut-out photos).
 */
export function faceAttr(person, { glow = false } = {}) {
  const f = person?.photo && person.face;
  if (!f || f.photo !== person.photo || f.none) return '';
  return ` data-face="${f.x},${f.y},${f.s},${f.ar}"${glow ? ' data-face-glow' : ''}`;
}

/**
 * Place the photo so the face sits well in this shape. Small circles and squares zoom in to head
 * and shoulders; square-ish and wide cards zoom in a little; tall strips keep the whole photo
 * (as before) and just make sure the face isn't cut off.
 */
export function fitFace(el) {
  const W = el.clientWidth;
  const H = el.clientHeight;
  const rest = el.hasAttribute('data-face-glow') ? ', cover' : '';
  const rest2 = rest ? ', center' : '';
  if (!W || !H || el.closest('.mv-fit-contain')) { el.style.backgroundSize = ''; el.style.backgroundPosition = ''; return; }
  const [x, y, s, ar] = el.dataset.face.split(',').map(Number);
  if (![x, y, s, ar].every(Number.isFinite) || !s || !ar) return;
  const cover = Math.max(H, W / ar); // photo height when it just fills the element
  const [faceH, faceY, maxZoom] = W / H < 0.7 ? [0, 0.3, 1] // tall strips
    : Math.max(W, H) < 160 ? [0.5, 0.47, 5] // avatars and small circles
      : [0.36, 0.42, 3]; // tiles and cards
  const h = faceH ? Math.min(Math.max(cover, (H * faceH) / s), cover * maxZoom) : cover;
  const w = h * ar;
  const left = Math.min(0, Math.max(W - w, W / 2 - x * w));
  const top = Math.min(0, Math.max(H - h, H * faceY - y * h));
  el.style.backgroundSize = `${w.toFixed(1)}px ${h.toFixed(1)}px${rest}`;
  el.style.backgroundPosition = `${left.toFixed(1)}px ${top.toFixed(1)}px${rest2}`;
}

let faceSizes = null;
function watchFaces() {
  faceSizes = new ResizeObserver((entries) => { for (const e of entries) fitFace(e.target); });
  const each = (node, fn) => {
    if (node.nodeType !== 1) return;
    if (node.hasAttribute('data-face')) fn(node);
    for (const el of node.querySelectorAll('[data-face]')) fn(el);
  };
  new MutationObserver((changes) => {
    for (const c of changes) {
      for (const n of c.removedNodes) each(n, (el) => faceSizes.unobserve(el));
      for (const n of c.addedNodes) each(n, (el) => faceSizes.observe(el));
    }
  }).observe(document.body, { childList: true, subtree: true });
  each(document.body, (el) => faceSizes.observe(el));
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
  if (res.status === 401 && store.config?.auth?.enabled) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    await new Promise(() => {});
  }
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
