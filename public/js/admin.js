import { start, store, onRender, esc, avatar, micView, api, toast, STATUS_LABEL, KIND_ICON, battery } from './common.js';
import { colorFor } from './micboard.js';

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
    ? `· now using ${svc.source === 'pco' ? 'Planning Center' : 'manual plan'}: ${svc.plan.title || ''} (${svc.plan.items.filter((i) => i.type !== 'header').length} items)`
    : '· no plan loaded';
  if (!manualFilled && svc.source === 'manual' && svc.plan) {
    manual.elements.title.value = svc.plan.title || '';
    manual.elements.start.value = svc.plan.start || '';
    manual.elements.text.value = svc.plan.text || '';
    manualFilled = true;
  }
  if (!store.config.planningCenter) {
    pcoEl.innerHTML = `<p class="muted">Not connected. Create a Personal Access Token at
      <a href="https://api.planningcenteronline.com/oauth/applications" target="_blank" rel="noopener">api.planningcenteronline.com/oauth/applications</a>
      and add it to <code>config/config.yaml</code> under <code>planningCenter: { appId, secret }</code>
      (or set the <code>PCO_APP_ID</code> / <code>PCO_SECRET</code> environment variables), then restart.</p>`;
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
        ${p.photo ? `<button class="btn small" data-act="remove-photo" data-id="${p.id}">No photo</button>` : ''}
        <button class="btn small danger" data-act="delete" data-id="${p.id}">Remove</button>
      </div>
    </div>`).join('') || `<div class="muted">${g.people.length ? 'No matches.' : 'No people yet – add your worship team, hosts and guests above.'}</div>`;
  if (ph !== lastPeople) { lastPeople = ph; peopleEl.innerHTML = ph; }

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
