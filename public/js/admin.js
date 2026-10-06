import { start, store, onRender, esc, avatar, micView, api, toast, STATUS_LABEL, KIND_ICON, battery } from './common.js';

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
