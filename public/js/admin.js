// Live service: what's running now, its order of service (Planning Center, the ProPresenter
// playlist or typed in), matching ProPresenter, and who has which mic.
import { start, store, onRender, esc, avatar, micView, api, toast, STATUS_LABEL, KIND_ICON, battery, confirmBox } from './common.js';
import { planSource } from './plan.js';

await start({ page: 'admin' });

const assignEl = document.getElementById('assign');
const serviceForm = document.getElementById('service');

// ---------------------------------------------------------------- service

serviceForm.onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api('PUT', '/api/service', { name: serviceForm.sname.value.trim() || null });
    toast('Service updated');
  } catch (err) { toast(err.message, true); }
};
document.getElementById('clear-all').onclick = async () => {
  if (!await confirmBox('Clear every mic assignment? (People and photos are kept.)')) return;
  try { await api('POST', '/api/assignments/clear'); toast('All assignments cleared'); } catch (err) { toast(err.message, true); }
};

// ---------------------------------------------------------------- service plan

const pcoEl = document.getElementById('pco');
const manual = document.getElementById('manual');
let manualFilled = false;

manual.onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api('PUT', '/api/service/manual', { title: manual.elements.title.value, start: manual.elements.start.value, text: manual.elements.text.value });
    toast('Plan loaded');
  } catch (err) { toast(err.message, true); }
};
document.getElementById('use-pp').onclick = async () => {
  try { await api('POST', '/api/service/propresenter'); toast('Following the ProPresenter playlist'); } catch (err) { toast(err.message, true); }
};
document.getElementById('reset-progress').onclick = async () => {
  if (!await confirmBox('Clear the current item and recorded item times?')) return;
  try { await api('POST', '/api/service/reset'); toast('Progress reset'); } catch (err) { toast(err.message, true); }
};
pcoEl.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-pco]');
  if (!b) return;
  try {
    if (b.dataset.pco === 'refresh') await api('POST', '/api/service/pco/refresh');
    else {
      const [serviceTypeId, planId] = b.dataset.pco.split('/');
      await api('POST', '/api/service/pco', { serviceTypeId, planId });
      toast('Following this Planning Center plan');
    }
  } catch (err) { toast(err.message, true); }
});

function renderPlan() {
  const svc = store.service;
  document.getElementById('plan-status').textContent = svc.plan
    ? `· now using ${planSource(svc)}: ${svc.plan.title || ''} (${svc.plan.items.filter((i) => i.type !== 'header').length} items)`
    : '· no plan loaded';
  if (!manualFilled && svc.source === 'manual' && svc.plan) {
    manual.elements.title.value = svc.plan.title || '';
    manual.elements.start.value = svc.plan.start || '';
    manual.elements.text.value = svc.plan.text || '';
    manualFilled = true;
  }
  if (!store.config.planningCenter) {
    pcoEl.innerHTML = `<p class="muted">Not connected. Add your Planning Center token in <a href="/settings#pco">Settings → Planning Center</a>, or use the ProPresenter playlist or a typed plan below.</p>`;
    return;
  }
  const st = svc.pco || {};
  const html = `<div class="muted small" style="margin-bottom:8px">${st.ok === false ? `<span class="over">⚠ ${esc(st.error)}</span>` : st.lastSync ? `✓ Synced ${new Date(st.lastSync).toLocaleTimeString()}` : 'Connecting…'}
      ${svc.followProPresenter ? ' · auto-advances when ProPresenter shows a matching song or presentation, and follows Services LIVE' : ''}
      <button class="btn small" data-pco="refresh" style="margin-left:8px">Refresh</button></div>
    <div class="plans">${(svc.upcoming || []).map((p) => {
      const on = svc.source === 'pco' && svc.planId === p.id;
      return `<div class="plan-row ${on ? 'on' : ''}"><div><b>${esc(p.serviceTypeName)}</b> · ${esc(p.dates || '')}<div class="muted small">${esc(p.title || '')}${p.seriesTitle ? ` · ${esc(p.seriesTitle)}` : ''}</div></div>
        ${on ? '<span class="chip good">In use</span>' : `<button class="btn small" data-pco="${esc(p.serviceTypeId)}/${esc(p.id)}">Use</button>`}</div>`;
    }).join('') || '<div class="muted">No upcoming plans found.</div>'}</div>`;
  if (pcoEl._html !== html) { pcoEl._html = html; pcoEl.innerHTML = html; }
}

// ---------------------------------------------------------------- assignments
// Tap a mic, then tap who has it. After choosing, the next mic is selected, so a whole
// changeover is tap, tap, tap. The status buttons (Picked up / On stage / Returned) are on
// the selected mic.

const pickEl = document.getElementById('pick');
let selected = null; // mic slot id
let pickQuery = '';
const visible = () => store.slots.filter((s) => !s.hidden);
const assign = (micId, body) => api('PUT', `/api/assignments/${encodeURIComponent(micId)}`, body).catch((err) => toast(err.message, true));

assignEl.addEventListener('click', (e) => {
  const m = e.target.closest('[data-mic]');
  if (!m) return;
  selected = selected === m.dataset.mic ? null : m.dataset.mic;
  pickQuery = '';
  render(true);
  // (Not on phones / tablets: the keyboard would cover the faces.)
  if (selected && matchMedia('(hover: hover)').matches) pickEl.querySelector('input')?.focus({ preventScroll: true });
});

pickEl.addEventListener('input', (e) => {
  if (e.target.matches('[data-q]')) { pickQuery = e.target.value; renderPeople(); }
});
pickEl.addEventListener('click', async (e) => {
  const who = e.target.closest('[data-person]');
  const st = e.target.closest('[data-status]');
  const push = e.target.closest('[data-push]');
  const close = e.target.closest('[data-close]');
  if (close) { selected = null; render(true); return; }
  if (push) {
    try { await api('POST', `/api/mics/${encodeURIComponent(push.dataset.push)}/push-name`); toast('Name sent to receiver'); } catch (err) { toast(err.message, true); }
    return;
  }
  if (st && selected) { await assign(selected, { status: st.dataset.status }); return; }
  if (!who || !selected) return;
  const personId = who.dataset.person || null;
  const elsewhere = personId && Object.entries(store.greenroom.assignments).find(([mic, a]) => a.personId === personId && mic !== selected);
  if (elsewhere) {
    const other = store.slots.find((x) => x.id === elsewhere[0])?.label || elsewhere[0];
    const name = store.greenroom.people.find((x) => x.id === personId)?.name;
    if (!await confirmBox(`${name} already has ${other}. Give them ${store.slots.find((x) => x.id === selected)?.label} as well?`, { ok: 'Yes, both', danger: false })) return;
  }
  await assign(selected, { personId });
  // On to the next mic (a changeover is one tap per mic).
  const list = visible();
  const i = list.findIndex((x) => x.id === selected);
  selected = list[i + 1]?.id || null;
  pickQuery = '';
  render(true);
});

function renderPeople() {
  const box = pickEl.querySelector('[data-people]');
  if (!box) return;
  const g = store.greenroom;
  const holder = {};
  for (const [mic, a] of Object.entries(g.assignments)) if (a.personId) (holder[a.personId] ||= []).push(store.slots.find((x) => x.id === mic)?.label || mic);
  const cur = g.assignments[selected]?.personId || '';
  const q = pickQuery.trim().toLowerCase();
  const people = [...g.people].filter((p) => !q || `${p.name} ${p.role}`.toLowerCase().includes(q)).sort((x, y) => x.name.localeCompare(y.name));
  box.innerHTML = `<button class="ta-person nobody ${cur ? '' : 'cur'}" data-person=""><span class="avatar">—</span><b>Nobody</b></button>`
    + people.map((p) => `<button class="ta-person ${p.id === cur ? 'cur' : ''}" data-person="${p.id}">${avatar(p)}<b>${esc(p.name)}</b>
      <small>${esc(p.role || '')}${holder[p.id] ? ` · 🎤 ${esc(holder[p.id].join(', '))}` : ''}</small></button>`).join('')
    + (people.length ? '' : `<p class="muted">${g.people.length ? 'No matches.' : 'No people yet. Add your team on <a href="/people">People</a>.'}</p>`);
}

function renderPick(force) {
  const slot = store.slots.find((x) => x.id === selected);
  const key = slot ? `${slot.id}:${JSON.stringify(store.greenroom.assignments[slot.id] || {})}` : '';
  if (!force && pickEl._key === key) { renderPeople(); return; }
  pickEl._key = key;
  if (!slot) {
    pickEl.innerHTML = '<div class="ta-hint">👈 Tap a mic, then tap who has it.<br><small class="muted">After each one the next mic is selected, so a changeover is tap, tap, tap.</small></div>';
    return;
  }
  const a = store.greenroom.assignments[slot.id];
  pickEl.innerHTML = `<div class="ta-pick-head"><b>${KIND_ICON[slot.kind] || ''} ${esc(slot.label)}</b><span class="muted small">who has it?</span>
      <button class="btn small" data-close aria-label="Close">✕</button></div>
    ${a ? `<div class="ta-status">${Object.entries(STATUS_LABEL).map(([k, v]) => `<button class="btn small ${a.status === k ? 'sel' : ''}" data-status="${k}">${v}</button>`).join('')}
      ${store.config.control.pushNamesToReceivers ? `<button class="btn small" data-push="${esc(slot.id)}" title="Write the name to the receiver's display">→ RX</button>` : ''}</div>` : ''}
    <input type="search" data-q placeholder="Search people…" value="${esc(pickQuery)}" aria-label="Search people">
    <div class="ta-people" data-people></div>`;
  renderPeople();
}

// ---------------------------------------------------------------- render

let lastAssign = '';
let serviceSet = false;

function render(force = false) {
  renderPlan();
  const g = store.greenroom;
  if (!serviceSet && store.connected) {
    serviceForm.sname.value = g.service?.name || '';
    serviceSet = true;
  }

  const ah = visible().map((slot) => {
    const { mic, a, person, txOn } = micView(slot);
    return `<button class="ta-mic ${slot.id === selected ? 'selected' : ''} ${person ? 'has' : ''}" data-mic="${esc(slot.id)}" aria-pressed="${slot.id === selected}">
      ${avatar(person)}
      <span class="ta-mic-text"><b>${KIND_ICON[slot.kind] || ''} ${esc(slot.label)}</b><span>${person ? esc(person.name) : '<i class="muted">Unassigned</i>'}</span>
        <small class="muted">${txOn ? battery(mic) : 'TX off'}${a ? ` · ${STATUS_LABEL[a.status]}` : ''}</small></span>
    </button>`;
  }).join('') || '<div class="muted">No mics yet. Add receivers on the <a href="/gear">Gear</a> page.</div>';
  if (ah !== lastAssign || force) { lastAssign = ah; assignEl.innerHTML = ah; }
  renderPick(force);
}

onRender(render);

// ---------------------------------------------------------------- match with ProPresenter
const HOW = {
  link: ['Linked', 'good'], remembered: ['Remembered', 'good'], name: ['Same name', ''], position: ['By position', ''],
  ignore: ["Doesn't move the plan", ''], null: ['No match: the plan stays put', 'bad'],
};
const matchEl = document.getElementById('ppmatch-list');
let matchKey = '';
async function loadMatch() {
  let d;
  try { d = await api('GET', '/api/service/pp-match'); } catch (err) { matchEl.innerHTML = `<p class="muted">${esc(err.message)}</p>`; return; }
  const svc = store.service;
  if (d.source === 'propresenter') { setMatch('<p class="muted">The plan <i>is</i> the ProPresenter playlist, so it always follows it.</p>'); return; }
  if (!d.playlist) { setMatch(`<p class="muted">${d.pp === null ? 'No ProPresenter with an active playlist right now. Open the playlist in ProPresenter and this fills in.' : 'Waiting for ProPresenter…'}</p>`); return; }
  if (!svc.plan) { setMatch('<p class="muted">Load a service plan above first.</p>'); return; }
  const plan = svc.plan.items;
  const opts = (sel) => `<option value="" ${!sel ? 'selected' : ''}>Auto</option>
    <option value="ignore" ${sel === 'ignore' ? 'selected' : ''}>Don't move the plan</option>
    <optgroup label="Plan items">${plan.map((i) => (i.type === 'header' ? `</optgroup><optgroup label="${esc(i.title)}">` : `<option value="${esc(i.id)}" ${sel === i.id ? 'selected' : ''}>${esc(i.title)}</option>`)).join('')}</optgroup>`;
  const title = (id) => plan.find((i) => i.id === id)?.title || '';
  setMatch(`<div class="ppm-head muted small"><span>In ProPresenter: <b>${esc(d.playlist.name)}</b></span><span>Matches plan item</span><span></span></div>
    ${d.playlist.items.map((it) => it.type === 'header'
      ? `<div class="ppm-hdr">${esc(it.name)}</div>`
      : `<div class="ppm-row ${it.cued ? 'cued' : ''}">
          <span class="ppm-name">${it.cued ? '<span class="chip live">Cued</span> ' : ''}${esc(it.name)}</span>
          <select data-ppkey="${esc(it.key)}" data-ppname="${esc(it.name)}" aria-label="Plan item for ${esc(it.name)}">${opts(it.link)}</select>
          <small class="ppm-how ${HOW[it.how]?.[1] || ''}">${HOW[it.how]?.[0] || ''}${it.itemId && it.how !== 'link' ? ` → ${esc(title(it.itemId))}` : ''}</small>
        </div>`).join('')}`);
}
function setMatch(html) {
  if (matchEl.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return; // don't redraw under an open menu
  if (matchEl._html !== html) { matchEl._html = html; matchEl.innerHTML = html; }
}
matchEl.addEventListener('change', async (e) => {
  const sel = e.target.closest('[data-ppkey]');
  if (!sel) return;
  try {
    await api('PUT', '/api/service/links', { key: sel.dataset.ppkey, name: sel.dataset.ppname, itemId: sel.value || null });
    toast(sel.value ? 'Linked. Remembered for future plans too.' : 'Back to automatic');
  } catch (err) { toast(err.message, true); }
  sel.blur();
  loadMatch();
});
// Refresh when ProPresenter's playlist or the plan changes.
onRender(() => {
  const pls = Object.values(store.state.propresenter || {}).map((p) => p.playlist && `${p.playlist.uuid}:${p.playlist.index}:${p.playlist.items.length}`).join('|');
  const key = `${pls}#${store.service.source}:${store.service.planId}:${store.service.plan?.items.length}:${JSON.stringify(store.service.links || {})}`;
  if (key !== matchKey) { matchKey = key; loadMatch(); }
});
