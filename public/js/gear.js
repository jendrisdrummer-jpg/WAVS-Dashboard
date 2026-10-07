// Gear page: is everything connected? Add, edit, test and remove devices.
import { start, store, onRender, esc, api, toast, icon, setHTML } from './common.js';
import { deviceForm, enhanceForm, readForm, runTest, KIND_LABEL } from './forms.js';

await start({ page: 'gear' });

let settings = await api('GET', '/api/settings');
const results = {}; // "kind-index" -> last Test result, kept across re-renders

const SECTIONS = [
  { kind: 'receiver', title: 'Wireless mics', icon: 'mic', list: (s) => s.mics.receivers, set: (s, l) => ({ mics: { ...s.mics, receivers: l } }), empty: 'No receivers yet. Add your Shure SLX-D / ULX-D receivers to see batteries, RF and who has which mic.' },
  { kind: 'switcher', title: 'Switchers', icon: 'grid', list: (s) => s.switchers, set: (_s, l) => ({ switchers: l }), empty: 'No switcher yet. Add your ATEM (or vMix) for program/preview tally.' },
  { kind: 'propresenter', title: 'ProPresenter', icon: 'list', list: (s) => s.propresenter, set: (_s, l) => ({ propresenter: l }), empty: 'No ProPresenter yet. Add it to show slides and follow the service automatically.' },
  { kind: 'stream', title: 'Live streams', icon: 'rf', list: (s) => s.streams || [], set: (_s, l) => ({ streams: l }), empty: 'No streams yet. Add YouTube or Facebook to see live viewer counts and comments.' },
  { kind: 'video', title: 'Video sources', icon: 'grid', list: (s) => s.video.sources, set: (s, l) => ({ video: { ...s.video, sources: l } }), empty: 'No video sources yet. Add a capture card or a MediaMTX stream for program and multiview tiles.' },
];

/** Live status for one device: { state: 'ok' | 'bad' | 'off' | 'unknown', text, detail } */
function status(kind, d) {
  if (!['video', 'stream'].includes(kind) && d.type !== 'simulator' && !d.host) return { state: 'off', text: 'Placeholder', detail: 'No IP address yet. Click Edit to add it when you have it.' };
  if (kind === 'receiver') {
    const st = store.state.receivers[d.id];
    if (!st) return { state: 'unknown', text: 'Starting…' };
    const slots = store.slots.filter((s) => s.receiverId === d.id);
    const on = slots.filter((s) => { const m = store.state.mics[s.id] || {}; return m.txType || (m.rfDbm != null && m.rfDbm > -110); }).length;
    return st.online
      ? { state: 'ok', text: 'Connected', detail: [st.model, st.firmware && `firmware ${st.firmware}`, `${on} of ${slots.length} transmitters on`].filter(Boolean).join(' · ') }
      : { state: 'bad', text: 'Not connected', detail: st.error || 'Trying to reconnect…' };
  }
  if (kind === 'switcher') {
    const st = store.state.switchers[d.id];
    if (!st) return { state: 'unknown', text: 'Starting…' };
    return st.online
      ? { state: 'ok', text: 'Connected', detail: [st.model, st.mes?.length && `${st.mes.length} M/E`, st.program && `PGM: ${st.program.name}`].filter(Boolean).join(' · ') }
      : { state: 'bad', text: 'Not connected', detail: st.error || 'Trying to reconnect…' };
  }
  if (kind === 'propresenter') {
    const st = store.state.propresenter[d.id];
    if (!st) return { state: 'unknown', text: 'Starting…' };
    return st.online
      ? { state: 'ok', text: 'Connected', detail: [st.version, st.presentation?.name && `Showing: ${st.presentation.name}`].filter(Boolean).join(' · ') }
      : { state: 'bad', text: 'Not connected', detail: st.error || 'Trying to reconnect…' };
  }
  if (kind === 'stream') {
    const st = store.state.streams?.[d.id];
    if (!st) return { state: 'unknown', text: 'Starting…' };
    if (st.error && !st.live) return { state: 'bad', text: 'Problem', detail: st.error };
    return st.live
      ? { state: 'ok', text: 'Live', detail: [st.title, `${(st.viewers ?? 0).toLocaleString()} watching`].filter(Boolean).join(' · ') }
      : { state: 'ok', text: 'Connected', detail: 'Not live right now. Viewers and comments appear when you go live.' };
  }
  return { state: 'unknown', text: d.type === 'capture' ? 'Checked by each browser' : 'Use Test to check', detail: d.type === 'capture' ? d.device : d.url };
}

const where = (kind, d) => (d.type === 'simulator' || d.platform === 'simulator' ? 'Simulated' : kind === 'stream' ? { youtube: 'YouTube', facebook: 'Facebook' }[d.platform] : kind === 'video' ? '' : `${d.host || ''}${d.port && !['receiver'].includes(kind) ? `:${d.port}` : ''}`);

function render() {
  let total = 0;
  let ok = 0;
  const html = SECTIONS.map((sec) => {
    const list = sec.list(settings);
    const cards = list.map((d, i) => {
      const st = status(sec.kind, d);
      if (sec.kind !== 'video' && st.state !== 'off') { total++; if (st.state === 'ok') ok++; }
      return `<div class="dev s-${st.state}">
        <span class="dev-dot" aria-hidden="true"></span>
        <div class="dev-main">
          <div class="dev-name">${esc(d.name || d.label)} <span class="muted small">${esc(where(sec.kind, d))}</span></div>
          <div class="dev-state"><b>${esc(st.text)}</b>${st.detail ? ` · <span class="muted">${esc(st.detail)}</span>` : ''}</div>
          <div class="${results[`${sec.kind}-${i}`]?.cls || 'test-result'}" data-result="${sec.kind}-${i}">${results[`${sec.kind}-${i}`]?.html || ''}</div>
        </div>
        <div class="dev-btns">
          <button class="btn small" data-act="test" data-kind="${sec.kind}" data-i="${i}">Test</button>
          <button class="btn small" data-act="edit" data-kind="${sec.kind}" data-i="${i}">Edit</button>
          <button class="btn small danger" data-act="remove" data-kind="${sec.kind}" data-i="${i}" aria-label="Remove">${icon('x')}</button>
        </div>
      </div>`;
    }).join('');
    return `<section class="panel">
      <h2>${icon(sec.icon)} ${sec.title} <span class="muted">${list.length || ''}</span>
        <button class="btn small primary" data-act="add" data-kind="${sec.kind}" style="margin-left:auto">${icon('plus')} Add</button></h2>
      <div class="panel-body dev-list">${cards || `<div class="dev-empty"><p class="muted">${sec.empty}</p>
        <button class="btn primary" data-act="add" data-kind="${sec.kind}">${icon('plus')} Add ${sec.kind === 'propresenter' ? 'ProPresenter' : KIND_LABEL[sec.kind].toLowerCase()}</button></div>`}</div>
    </section>`;
  }).join('');

  const pco = store.service.pco || {};
  const pcoCard = `<section class="panel"><h2>${icon('list')} Planning Center <a class="btn small" href="/settings#pco" style="margin-left:auto">Set up</a></h2>
    <div class="panel-body dev-list">${!settings.planningCenter ? '<p class="muted">Not connected. Add a token in Settings to pull service plans.</p>'
      : `<div class="dev s-${pco.ok === false ? 'bad' : pco.ok ? 'ok' : 'unknown'}"><span class="dev-dot"></span><div class="dev-main"><div class="dev-name">Planning Center Services</div>
        <div class="dev-state"><b>${pco.ok === false ? 'Problem' : pco.ok ? 'Connected' : 'Connecting…'}</b> · <span class="muted">${esc(pco.ok === false ? pco.error : pco.lastSync ? `last synced ${new Date(pco.lastSync).toLocaleTimeString()}` : '')}</span></div></div></div>`}</div></section>`;
  if (settings.planningCenter) { total++; if (pco.ok) ok++; }

  setHTML(document.getElementById('sections'), html + pcoCard);
  document.getElementById('reconnect').classList.toggle('hidden', !total);
  const placeholders = SECTIONS.reduce((n, sec) => n + (['video', 'stream'].includes(sec.kind) ? 0 : sec.list(settings).filter((d) => d.type !== 'simulator' && !d.host).length), 0);
  document.getElementById('summary').innerHTML = total
    ? `<b class="${ok === total ? 'ok' : 'over'}">${ok} of ${total}</b> connected${ok === total ? ' · everything looks good' : ''}`
    + (placeholders ? ` · ${placeholders} waiting for an IP address` : '')
    : placeholders ? `${placeholders} placeholder${placeholders > 1 ? 's' : ''} waiting for an IP address. Click <b>Edit</b> on each to add it.` : 'Nothing added yet. Click <b>+ Add gear</b> to add your receivers, switcher and ProPresenter. You don\'t need the IP addresses yet.';
}

// ---------------------------------------------------------------- add / edit dialog

const dlg = document.getElementById('dev-dlg');
const fields = document.getElementById('dev-fields');
const testOut = document.getElementById('dev-test');
let editing = null; // { kind, index }

function openDialog(kind, index) {
  const sec = SECTIONS.find((s) => s.kind === kind);
  const d = index != null ? sec.list(settings)[index] : {};
  editing = { kind, index, existing: d };
  document.getElementById('dev-title').textContent = `${index != null ? 'Edit' : 'Add'} ${KIND_LABEL[kind].toLowerCase()}`;
  fields.innerHTML = deviceForm(kind, d, { switchers: settings.switchers });
  enhanceForm(kind, fields);
  testOut.className = 'test-result';
  testOut.textContent = '';
  dlg.returnValue = '';
  dlg.showModal();
}

document.getElementById('dev-testbtn').onclick = () => runTest(editing.kind, readForm(editing.kind, fields, editing.existing), testOut);

dlg.addEventListener('close', async () => {
  if (dlg.returnValue !== 'ok') return;
  const sec = SECTIONS.find((s) => s.kind === editing.kind);
  const list = [...sec.list(settings)];
  const dev = readForm(editing.kind, fields, editing.existing);
  if (editing.index != null) list[editing.index] = dev; else list.push(dev);
  await save(sec.set(settings, list), `${dev.name || dev.label} saved. Reconnecting…`);
});

async function save(patch, msg) {
  try {
    settings = await api('PUT', '/api/settings', patch);
    toast(msg);
  } catch (err) {
    toast(err.message, true);
  }
}

document.getElementById('sections').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const { act, kind } = b.dataset;
  const i = b.dataset.i != null ? Number(b.dataset.i) : null;
  const sec = SECTIONS.find((s) => s.kind === kind);
  if (act === 'add') openDialog(kind, null);
  if (act === 'edit') openDialog(kind, i);
  if (act === 'test') {
    const el = document.querySelector(`[data-result="${kind}-${i}"]`);
    await runTest(kind, sec.list(settings)[i], el);
    results[`${kind}-${i}`] = { cls: el.className, html: el.innerHTML };
    render();
  }
  if (act === 'remove') {
    const d = sec.list(settings)[i];
    if (!confirm(`Remove ${d.name || d.label}?`)) return;
    await save(sec.set(settings, sec.list(settings).filter((_, j) => j !== i)), 'Removed');
  }
});

// "+ Add gear" menu
const addBtn = document.getElementById('add-gear');
const addMenu = document.getElementById('add-gear-menu');
const toggleAdd = (open) => { addMenu.classList.toggle('hidden', !open); addBtn.setAttribute('aria-expanded', String(open)); };
addBtn.onclick = (e) => { e.stopPropagation(); toggleAdd(addMenu.classList.contains('hidden')); };
document.addEventListener('click', (e) => { if (!addMenu.contains(e.target)) toggleAdd(false); });
addMenu.addEventListener('click', (e) => {
  const b = e.target.closest('[data-add]');
  if (!b) return;
  toggleAdd(false);
  openDialog(b.dataset.add, null);
});
if (new URLSearchParams(location.search).get('add')) openDialog(new URLSearchParams(location.search).get('add'), null);

document.getElementById('reconnect').onclick = async () => {
  try { await api('POST', '/api/gear/reconnect'); } catch (err) { toast(err.message, true); }
};

onRender(render);
