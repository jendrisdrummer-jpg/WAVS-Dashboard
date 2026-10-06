// Dashboard page: shows one saved dashboard (a grid of widgets) and lets you build / edit them.
import { start, store, onRender, onMeters, esc, api, toast } from './common.js';
import { WIDGETS, CATEGORIES } from './widgets.js';

await start({ page: 'dash' });

const gridEl = document.getElementById('grid');
const palette = document.getElementById('palette');
const slot = document.querySelector('[data-slot]');
const slotRight = document.querySelector('[data-slot-right]');
const narrow = () => window.innerWidth < 800;

let current = null; // the dashboard object being shown
let builtFrom = ''; // JSON of the layout currently on screen (to spot remote changes)
let editing = false;
const live = new Map(); // widget id -> { def, widget, el, inst }

// ---------------------------------------------------------------- choose a dashboard

function pickDashboard() {
  const slug = location.pathname.startsWith('/d/') ? decodeURIComponent(location.pathname.slice(3)) : null;
  let saved = null;
  try { saved = localStorage.getItem('wavs-dashboard'); } catch { /* storage unavailable */ }
  return store.dashboards.find((d) => d.slug === slug)
    || store.dashboards.find((d) => d.id === saved)
    || store.dashboards[0];
}

function go(d) {
  try { localStorage.setItem('wavs-dashboard', d.id); } catch { /* ignore */ }
  history.replaceState(null, '', `/d/${encodeURIComponent(d.slug)}${location.search}`);
  current = d;
  build();
  renderHeader();
}

// ---------------------------------------------------------------- grid

const grid = window.GridStack.init({
  column: 12,
  margin: 5,
  float: true,
  staticGrid: true,
  handle: '.whead',
  cellHeight: 60,
  columnOpts: { breakpointForWindow: true, breakpoints: [{ w: 800, c: 1 }], layout: 'list' },
}, gridEl);

function fitRows() {
  if (!current) return;
  if (narrow()) { grid.cellHeight(70); return; }
  const top = gridEl.getBoundingClientRect().top + window.scrollY;
  const avail = window.innerHeight - top - 10;
  grid.cellHeight(Math.max(36, Math.floor(avail / (current.rows || 12))));
}
window.addEventListener('resize', () => fitRows());

function build() {
  for (const w of live.values()) w.inst?.destroy?.();
  live.clear();
  grid.removeAll(true);
  builtFrom = JSON.stringify(current);
  grid.batchUpdate();
  for (const def of current.widgets) addWidget(structuredClone(def));
  grid.batchUpdate(false);
  fitRows();
}

function addWidget(def) {
  const el = grid.addWidget(def.x == null
    ? { id: def.id, w: def.w, h: def.h, autoPosition: true }
    : { id: def.id, x: def.x, y: def.y, w: def.w, h: def.h });
  const content = el.querySelector('.grid-stack-item-content');
  const entry = { def, el };
  live.set(def.id, entry);
  mount(entry, content);
  return el;
}

function mount(entry, content) {
  const widget = WIDGETS[entry.def.type];
  const opts = { ...defaultsFor(entry.def.type), ...entry.def.options };
  content.innerHTML = `<div class="w ${widget?.chrome === false ? 'nochrome' : ''}">
    <div class="whead"><span class="wtitle">${esc(opts.title || widget?.title || entry.def.type)}</span>
      <span class="wactions"></span>
      <span class="wedit"><button data-act="settings" title="Settings">⚙</button><button data-act="remove" title="Remove">✕</button></span></div>
    <div class="wbody"></div></div>`;
  const body = content.querySelector('.wbody');
  const actions = content.querySelector('.wactions');
  const ctx = {
    editing: () => editing,
    addAction(label, title, fn) {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.onclick = fn;
      actions.append(b);
    },
  };
  entry.widget = widget;
  try {
    entry.inst = widget ? widget.mount(body, opts, ctx) : null;
    if (!widget) body.innerHTML = `<div class="w-empty">Unknown widget “${esc(entry.def.type)}”</div>`;
    entry.inst?.update?.();
  } catch (err) {
    console.error(err);
    body.innerHTML = `<div class="w-empty">This widget failed to load<br><small>${esc(err.message)}</small></div>`;
  }
}

function defaultsFor(type) {
  const out = {};
  for (const o of WIDGETS[type]?.options || []) {
    if (o.default !== undefined) out[o.key] = o.default;
    else if (o.type === 'select' && o.choices) out[o.key] = o.choices()[0]?.[0] ?? '';
  }
  return out;
}

gridEl.addEventListener('click', (e) => {
  const b = e.target.closest('.wedit button');
  if (!b) return;
  const id = b.closest('.grid-stack-item').getAttribute('gs-id');
  const entry = live.get(id);
  if (b.dataset.act === 'remove') {
    grid.removeWidget(entry.el);
    entry.inst?.destroy?.();
    live.delete(id);
  } else openSettings(entry);
});

// ---------------------------------------------------------------- widget settings dialog

const dlg = document.getElementById('settings');
const fieldsEl = document.getElementById('settings-fields');

function openSettings(entry) {
  const widget = entry.widget;
  const opts = { ...defaultsFor(entry.def.type), ...entry.def.options };
  document.getElementById('settings-title').textContent = `${widget?.title || entry.def.type} settings`;
  const fields = [{ key: 'title', label: 'Title', type: 'text', placeholder: widget?.title }, ...(widget?.options || [])];
  fieldsEl.innerHTML = fields.map((f) => {
    const v = opts[f.key];
    const id = `f-${f.key}`;
    switch (f.type) {
      case 'checkbox':
        return `<label class="cb"><input type="checkbox" id="${id}" ${v ? 'checked' : ''}> ${esc(f.label)}</label>`;
      case 'select':
        return `<label>${esc(f.label)}<select id="${id}">${f.choices().map(([val, lab]) => `<option value="${esc(val)}" ${String(v ?? '') === String(val) ? 'selected' : ''}>${esc(lab)}</option>`).join('')}</select></label>`;
      case 'textarea':
        return `<label>${esc(f.label)}<textarea id="${id}" rows="4">${esc(v ?? '')}</textarea></label>`;
      case 'number':
        return `<label>${esc(f.label)}<input type="number" id="${id}" value="${esc(v ?? '')}"></label>`;
      case 'mics':
        return `<fieldset><legend>${esc(f.label)}</legend><div class="mic-picks">${store.slots.map((s) => `
          <label class="cb"><input type="checkbox" data-mic="${esc(s.id)}" ${(v || []).includes(s.id) ? 'checked' : ''}> ${esc(s.label)} <span class="muted small">${esc(s.receiverName)}</span></label>`).join('')}</div></fieldset>`;
      default:
        return `<label>${esc(f.label)}<input type="text" id="${id}" value="${esc(v ?? '')}" placeholder="${esc(f.placeholder || '')}"></label>`;
    }
  }).join('');
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const next = {};
    for (const f of fields) {
      if (f.type === 'mics') { next[f.key] = [...fieldsEl.querySelectorAll('[data-mic]:checked')].map((c) => c.dataset.mic); continue; }
      const input = fieldsEl.querySelector(`#f-${f.key}`);
      next[f.key] = f.type === 'checkbox' ? input.checked : f.type === 'number' ? Number(input.value) : input.value;
    }
    if (!next.title) delete next.title;
    entry.def.options = next;
    entry.inst?.destroy?.();
    mount(entry, entry.el.querySelector('.grid-stack-item-content'));
  };
  dlg.returnValue = '';
  dlg.showModal();
}

// ---------------------------------------------------------------- palette (edit mode)

document.getElementById('pal-list').innerHTML = CATEGORIES.map((cat) => `
  <div class="pal-cat">${esc(cat)}</div>
  ${Object.entries(WIDGETS).filter(([, w]) => w.category === cat).map(([type, w]) => `
    <button class="pal-item" data-type="${type}"><span>${w.icon}</span>${esc(w.title)}</button>`).join('')}`).join('');

palette.addEventListener('click', (e) => {
  const b = e.target.closest('[data-type]');
  if (!b) return;
  const w = WIDGETS[b.dataset.type];
  const def = { id: crypto.randomUUID(), type: b.dataset.type, w: Math.min(w.size.w, 12), h: w.size.h, options: {} };
  const el = addWidget(def);
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});

function setEditing(on) {
  editing = on;
  document.body.classList.toggle('editing', on);
  palette.classList.toggle('hidden', !on);
  grid.setStatic(!on);
  renderHeader();
  setTimeout(fitRows);
}

async function save() {
  const pos = new Map(grid.save(false).map((n) => [String(n.id), n]));
  const widgets = [...live.values()].map(({ def }) => {
    const n = pos.get(def.id) || {};
    return { ...def, x: n.x ?? 0, y: n.y ?? 0, w: n.w ?? def.w, h: n.h ?? def.h };
  });
  try {
    current = await api('PUT', `/api/dashboards/${current.id}`, { widgets, rows: current.rows, name: current.name });
    builtFrom = JSON.stringify(current);
    setEditing(false);
    toast('Dashboard saved');
  } catch (err) { toast(err.message, true); }
}

// ---------------------------------------------------------------- header controls

function renderHeader() {
  slot.innerHTML = `<select id="dash-pick" class="dash-pick" aria-label="Dashboard" ${editing ? 'disabled' : ''}>
      ${store.dashboards.map((d) => `<option value="${d.id}" ${d.id === current?.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
    </select>`;
  slotRight.innerHTML = editing
    ? `<label class="small muted">Rows <input id="rows" type="number" min="4" max="40" value="${current.rows || 12}" style="width:56px"></label>
       <button class="btn small" id="rename">Rename</button>
       <button class="btn small" id="dup">Duplicate</button>
       <button class="btn small" id="new">New</button>
       <button class="btn small danger" id="del">Delete</button>
       <button class="btn small" id="cancel">Cancel</button>
       <button class="btn small primary" id="save">Save</button>`
    : `<button class="btn small" id="edit" title="Add, move and resize widgets">✎ Edit</button>
       <button class="btn small" id="kiosk" title="Full screen without the header (for TVs)">⛶</button>`;
  slot.querySelector('#dash-pick').onchange = (e) => go(store.dashboards.find((d) => d.id === e.target.value));
  const on = (id, fn) => { const el = slotRight.querySelector(`#${id}`); if (el) el.onclick = fn; };
  on('edit', () => setEditing(true));
  on('kiosk', () => { const u = new URL(location.href); u.searchParams.set('kiosk', '1'); location.href = u; });
  on('save', save);
  on('cancel', () => { setEditing(false); current = store.dashboards.find((d) => d.id === current.id) || current; build(); });
  on('rename', () => {
    const name = prompt('Dashboard name', current.name);
    if (name?.trim()) { current.name = name.trim(); renderHeader(); toast('Name changes when you Save'); }
  });
  on('dup', () => createDashboard(`${current.name} copy`, current.id));
  on('new', () => createDashboard('New dashboard'));
  on('del', async () => {
    if (!confirm(`Delete the “${current.name}” dashboard?`)) return;
    try {
      await api('DELETE', `/api/dashboards/${current.id}`);
      setEditing(false);
      go(store.dashboards.find((d) => d.id !== current.id));
    } catch (err) { toast(err.message, true); }
  });
  const rows = slotRight.querySelector('#rows');
  if (rows) rows.onchange = () => { current.rows = Math.min(40, Math.max(4, Number(rows.value) || 12)); fitRows(); };
}

async function createDashboard(name, copyFrom) {
  const n = prompt('Name for the new dashboard (e.g. "Camera Ops", "Lobby TV")', name);
  if (!n?.trim()) return;
  try {
    const d = await api('POST', '/api/dashboards', { name: n.trim(), copyFrom });
    setEditing(false);
    store.dashboards = [...store.dashboards.filter((x) => x.id !== d.id), d];
    go(d);
    setEditing(true);
  } catch (err) { toast(err.message, true); }
}

// ---------------------------------------------------------------- live updates

let namesKey = '';
onRender(() => {
  const names = store.dashboards.map((d) => `${d.id}:${d.name}`).join();
  if (names !== namesKey) { namesKey = names; if (current) renderHeader(); }
  // Someone else saved this dashboard: show their version (unless we're mid-edit).
  if (!editing && current) {
    const fresh = store.dashboards.find((d) => d.id === current.id);
    if (!fresh) { go(store.dashboards[0]); return; }
    if (JSON.stringify(fresh) !== builtFrom) { current = fresh; build(); renderHeader(); }
  }
  for (const w of live.values()) w.inst?.update?.();
});
onMeters(() => { for (const w of live.values()) w.inst?.meters?.(); });
setInterval(() => { for (const w of live.values()) w.inst?.update?.(); }, 1000);

go(pickDashboard());
