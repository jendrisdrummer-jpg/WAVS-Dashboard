// People: your team, their photos (and where their face is), and the colour behind each photo.
// Who has which mic for a service is on the Live service page (and planned ahead on Schedule).
import { start, store, onRender, esc, avatar, api, toast, fitFace, photoUrl, ask, askText, confirmBox } from './common.js';
import { colorFor } from './micviews.js';
import { findFace, scanFaces, faceSummary, scan } from './faces.js';

await start({ page: 'people' });

const peopleEl = document.getElementById('people');
const addForm = document.getElementById('add-person');
const search = document.getElementById('search');

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
      if (!await confirmBox(`Remove ${person.name}? Their photo and any mic assignment are removed too.`)) return;
      await api('DELETE', `/api/people/${id}`);
    } else if (btn.dataset.act === 'edit') {
      const r = await ask({ title: `Edit ${person.name}`, fields: [
        { name: 'name', label: 'Name', value: person.name, required: true, maxlength: 80 },
        { name: 'role', label: 'Role', value: person.role || '', placeholder: 'Worship Leader, Host, Guest Speaker…', maxlength: 80 },
      ] });
      if (!r) return;
      const fd = new FormData();
      fd.set('name', r.name);
      fd.set('role', r.role);
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

// ---------------------------------------------------------------- face status

const faceStatus = document.getElementById('face-status');
let lastFaceStatus = '';
function renderFaceStatus() {
  const f = faceSummary(store.greenroom.people);
  let html = '';
  if (scan.busy) html = `🔍 Finding faces… ${scan.done} of ${scan.total}`;
  else if (scan.error) html = `<span class="bad-text">⚠ ${esc(scan.error)}</span> <button class="btn small" data-faces-again>Try again</button>`;
  else if (f.photos) {
    html = `🙂 Faces found in ${f.found} of ${f.photos} photo${f.photos === 1 ? '' : 's'}`;
    if (f.none.length) html += ` · <span title="${esc(f.none.join(', '))}">not found: ${esc(f.none.slice(0, 3).join(', '))}${f.none.length > 3 ? ` +${f.none.length - 3}` : ''} (use 🎯 Adjust)</span>`;
    html += ' <button class="btn small" data-faces-again title="Look for the face in every photo again (hand-adjusted ones are kept)">Check photos again</button>';
  }
  if (html !== lastFaceStatus) { lastFaceStatus = html; faceStatus.innerHTML = html; }
}
faceStatus.addEventListener('click', (e) => {
  if (!e.target.closest('[data-faces-again]')) return;
  scan.error = null;
  scanFaces(store.greenroom.people, { force: true, onChange: renderFaceStatus });
});

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

// ---------------------------------------------------------------- render

let lastPeople = '';

function render() {
  const g = store.greenroom;
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
  if (store.connected) scanFaces(g.people, { onChange: renderFaceStatus });
  renderFaceStatus();

}

onRender(render);
