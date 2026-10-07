import { start, store, onRender, esc, avatar, micView, api, toast, STATUS_LABEL, KIND_ICON, battery, fitFace, photoUrl } from './common.js';
import { colorFor } from './micviews.js';
import { findFace, scanFaces } from './faces.js';
import { planSource } from './plan.js';

await start({ page: 'admin' });

const peopleEl = document.getElementById('people');
const assignEl = document.getElementById('assign');
const addForm = document.getElementById('add-person');
const serviceForm = document.getElementById('service');
const search = document.getElementById('search');

// ---------------------------------------------------------------- service

serviceForm.onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api('PUT', '/api/service', { name: serviceForm.sname.value.trim() || null });
    toast('Service updated');
  } catch (err) { toast(err.message, true); }
};
document.getElementById('clear-all').onclick = async () => {
  if (!confirm('Clear every mic assignment? (People and photos are kept.)')) return;
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
  if (!confirm('Clear the current item and recorded item times?')) return;
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

// ---------------------------------------------------------------- people

addForm.onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(addForm);
  if (!fd.get('photo')?.size) fd.delete('photo');
  try {
    await api('POST', '/api/people', fd);
    addForm.reset();
    toast('Person added');
  } catch (err) { toast(err.message, true); }
};

peopleEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  const person = store.greenroom.people.find((p) => p.id === id);
  try {
    if (btn.dataset.act === 'delete') {
      if (!confirm(`Remove ${person.name}? Their photo and any mic assignment are removed too.`)) return;
      await api('DELETE', `/api/people/${id}`);
    } else if (btn.dataset.act === 'edit') {
      const name = prompt('Name', person.name);
      if (name == null) return;
      const role = prompt('Role (e.g. Worship Leader, Host, Guest Speaker)', person.role || '');
      if (role == null) return;
      const fd = new FormData();
      fd.set('name', name);
      fd.set('role', role);
      await api('PUT', `/api/people/${id}`, fd);
    } else if (btn.dataset.act === 'face') {
      adjustFace(person);
    } else if (btn.dataset.act === 'remove-photo') {
      const fd = new FormData();
      fd.set('removePhoto', 'true');
      await api('PUT', `/api/people/${id}`, fd);
    }
  } catch (err) { toast(err.message, true); }
});

// Photo replace: hidden file input per person
peopleEl.addEventListener('change', async (e) => {
  const swatch = e.target.closest('input[type=color][data-color]');
  if (swatch) {
    const fd = new FormData();
    fd.set('color', swatch.value);
    try { await api('PUT', `/api/people/${swatch.dataset.color}`, fd); } catch (err) { toast(err.message, true); }
    return;
  }
  const input = e.target.closest('input[type=file][data-id]');
  if (!input?.files[0]) return;
  const fd = new FormData();
  fd.set('photo', input.files[0]);
  try { await api('PUT', `/api/people/${input.dataset.id}`, fd); toast('Photo updated'); } catch (err) { toast(err.message, true); }
});

search.oninput = () => { lastPeople = ''; render(); };

// ---------------------------------------------------------------- face position (photo crops)

/**
 * Show where the face is and let a person move / resize it, with the circle, square and tall
 * card previews updating live. Saved as "manual", so automatic passes never change it.
 */
async function adjustFace(person) {
  const url = photoUrl(person);
  const f0 = person.face?.photo === person.photo ? person.face : null;
  const img = await new Promise((resolve) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => resolve(null); i.src = url; });
  if (!img) { toast("Couldn't open the photo", true); return; }
  const ar = img.naturalWidth / img.naturalHeight;
  let face = f0 && !f0.none ? { x: f0.x, y: f0.y, s: f0.s } : { x: 0.5, y: 0.3, s: 0.25 };

  const dlg = document.createElement('dialog');
  dlg.className = 'dlg face-dlg';
  dlg.innerHTML = `<form method="dialog">
    <h3>${esc(person.name)}: face position</h3>
    <p class="muted small" style="margin:0">Drag the circle onto their face and set its size. The previews show how each card shape will look.
      ${f0?.none ? '<br><b>No face was found automatically in this photo.</b>' : ''}</p>
    <div class="face-edit">
      <div class="face-src" style="aspect-ratio:${ar};width:min(100%, ${(52 * ar).toFixed(1)}vh)"><img src="${esc(url)}" alt=""><i class="face-ring"></i></div>
      <div class="face-previews">
        <div><div class="fp fp-circle" style="background-image:url('${esc(url)}')"></div><small>Circle</small></div>
        <div><div class="fp fp-square" style="background-image:url('${esc(url)}')"></div><small>Tile</small></div>
        <div><div class="fp fp-tall" style="background-image:url('${esc(url)}')"></div><small>Tall strip</small></div>
      </div>
    </div>
    <label class="small">Face size <input type="range" min="0.03" max="0.9" step="0.005" value="${face.s}" data-size style="width:100%"></label>
    <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
      <button type="button" class="btn small" data-auto>Find face again</button>
      <span style="display:flex;gap:8px"><button value="cancel" class="btn">Cancel</button><button value="save" class="btn primary">Save</button></span>
    </div>
  </form>`;
  document.body.append(dlg);
  const src = dlg.querySelector('.face-src');
  const ring = dlg.querySelector('.face-ring');
  const size = dlg.querySelector('[data-size]');
  const previews = [...dlg.querySelectorAll('.fp')];
  const draw = () => {
    ring.style.left = `${face.x * 100}%`;
    ring.style.top = `${face.y * 100}%`;
    ring.style.height = `${face.s * 100}%`;
    for (const el of previews) { el.dataset.face = `${face.x},${face.y},${face.s},${ar}`; fitFace(el); }
  };
  const moveTo = (e) => {
    const r = src.getBoundingClientRect();
    face.x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    face.y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    draw();
  };
  src.onpointerdown = (e) => { src.setPointerCapture(e.pointerId); moveTo(e); src.onpointermove = moveTo; };
  src.onpointerup = () => { src.onpointermove = null; };
  size.oninput = () => { face.s = Number(size.value); draw(); };
  dlg.querySelector('[data-auto]').onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Looking…';
    try {
      const found = await findFace(url);
      if (found.none) toast('No face found. Drag the circle onto it instead.', true);
      else { face = { x: found.x, y: found.y, s: found.s }; size.value = face.s; draw(); }
    } catch (err) { toast(err.message, true); }
    e.target.disabled = false;
    e.target.textContent = 'Find face again';
  };
  dlg.onclose = async () => {
    dlg.remove();
    if (dlg.returnValue !== 'save') return;
    try {
      await api('PUT', `/api/people/${person.id}/face`, { photo: person.photo, face: { ...face, ar }, manual: true });
      toast('Face position saved');
    } catch (err) { toast(err.message, true); }
  };
  dlg.showModal();
  requestAnimationFrame(draw);
}

// ---------------------------------------------------------------- assignments

assignEl.addEventListener('change', async (e) => {
  const sel = e.target.closest('select[data-mic]');
  if (!sel) return;
  const body = sel.dataset.field === 'person' ? { personId: sel.value || null } : { status: sel.value };
  try { await api('PUT', `/api/assignments/${encodeURIComponent(sel.dataset.mic)}`, body); } catch (err) { toast(err.message, true); }
});
assignEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-push]');
  if (!btn) return;
  try { await api('POST', `/api/mics/${encodeURIComponent(btn.dataset.push)}/push-name`); toast('Name sent to receiver'); } catch (err) { toast(err.message, true); }
});

// ---------------------------------------------------------------- render

let lastPeople = '';
let lastAssign = '';
let serviceSet = false;

function render() {
  renderPlan();
  const g = store.greenroom;
  if (!serviceSet && store.connected) {
    serviceForm.sname.value = g.service?.name || '';
    serviceSet = true;
  }

  // Which mic does each person hold?
  const micOf = {};
  for (const [micId, a] of Object.entries(g.assignments)) (micOf[a.personId] ||= []).push(store.slots.find((s) => s.id === micId)?.label || micId);

  const q = search.value.trim().toLowerCase();
  const people = g.people
    .filter((p) => !q || `${p.name} ${p.role}`.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
  const ph = people.map((p) => `
    <div class="person">
      ${avatar(p)}
      <div style="min-width:0">
        <div style="font-weight:700">${esc(p.name)}</div>
        <div class="muted" style="font-size:12px">${esc(p.role || '')}</div>
        ${micOf[p.id] ? `<div style="font-size:12px">🎤 ${esc(micOf[p.id].join(', '))}</div>` : ''}
      </div>
      <div class="acts">
        <label class="btn small" style="cursor:pointer">📷 Photo<input type="file" accept="image/*" data-id="${p.id}" hidden></label>
        <label class="btn small swatch" title="Colour behind their photo on the mic board"><input type="color" data-color="${p.id}" value="${colorFor(p, { id: p.id })}"></label>
        <button class="btn small" data-act="edit" data-id="${p.id}">Edit</button>
        ${p.photo ? `<button class="btn small" data-act="face" data-id="${p.id}" title="Where their face is, so it stays in frame on every card shape">🎯 Adjust</button>` : ''}
        ${p.photo ? `<button class="btn small" data-act="remove-photo" data-id="${p.id}">No photo</button>` : ''}
        <button class="btn small danger" data-act="delete" data-id="${p.id}">Remove</button>
      </div>
    </div>`).join('') || `<div class="muted">${g.people.length ? 'No matches.' : 'No people yet – add your worship team, hosts and guests above.'}</div>`;
  if (ph !== lastPeople) { lastPeople = ph; peopleEl.innerHTML = ph; }
  if (store.connected) scanFaces(g.people);

  const options = [...g.people].sort((a, b) => a.name.localeCompare(b.name));
  const ah = store.slots.map((slot) => {
    const { mic, a, person, txOn } = micView(slot);
    return `<div class="assign">
      ${avatar(person)}
      <div style="min-width:0">
        <div style="font-weight:700">${KIND_ICON[slot.kind] || ''} ${esc(slot.label)}</div>
        <div class="muted" style="font-size:12px">${esc(slot.receiverName)} ch ${slot.channel}${mic.freqMHz ? ` · ${mic.freqMHz.toFixed(3)} MHz` : ''} · ${txOn ? battery(mic) : 'TX off'}</div>
      </div>
      <div class="ctl">
        <select data-mic="${esc(slot.id)}" data-field="person" aria-label="Person for ${esc(slot.label)}">
          <option value="">— Unassigned —</option>
          ${options.map((p) => `<option value="${p.id}" ${person?.id === p.id ? 'selected' : ''}>${esc(p.name)}${p.role ? ` (${esc(p.role)})` : ''}</option>`).join('')}
        </select>
        <select data-mic="${esc(slot.id)}" data-field="status" ${a ? '' : 'disabled'} aria-label="Status">
          ${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${a?.status === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
        ${store.config.control.pushNamesToReceivers ? `<button class="btn small" data-push="${esc(slot.id)}" title="Write name to the receiver's display">→ RX</button>` : ''}
      </div>
    </div>`;
  }).join('') || '<div class="muted">No receivers configured in config.yaml.</div>';
  // Don't rebuild while someone has a dropdown open.
  if (ah !== lastAssign && !assignEl.contains(document.activeElement)) { lastAssign = ah; assignEl.innerHTML = ah; }
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
