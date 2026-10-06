import { start, store, onRender, onMeters, applyMeters, api, toast } from './common.js';
import { greenroomCard } from './views.js';
import { visibleSlots } from './micstrip.js';

await start({ page: 'greenroom' });

// Hand-off mode adds big Picked up / On stage / Returned buttons for the green room volunteer.
// It can be locked on with /greenroom?handoff=1 (e.g. for a wall-mounted tablet).
const params = new URLSearchParams(location.search);
const toggle = document.getElementById('handoff');
let handoff = params.get('handoff') === '1';
toggle.checked = handoff;
toggle.onchange = () => { handoff = toggle.checked; last = ''; render(); };
const filterSel = document.getElementById('filter');
filterSel.value = params.get('show') || 'assigned';
filterSel.onchange = () => { last = ''; render(); };

const grid = document.getElementById('gr');
let last = '';

function render() {
  const show = filterSel.value;
  const slots = visibleSlots().filter((s) => {
    const a = store.greenroom.assignments[s.id];
    if (show === 'assigned') return a && a.status !== 'returned';
    if (show === 'out') return a && (a.status === 'picked-up' || a.status === 'on-stage');
    return true;
  });
  // Stable, useful order: on stage, picked up, assigned, returned, unassigned
  const rank = { 'on-stage': 0, 'picked-up': 1, assigned: 2, returned: 3 };
  slots.sort((x, y) => (rank[store.greenroom.assignments[x.id]?.status] ?? 4) - (rank[store.greenroom.assignments[y.id]?.status] ?? 4));
  const html = slots.map((s) => greenroomCard(s, { handoff })).join('')
    || `<div class="panel panel-body muted">Nothing to show. Assign people to mics on the <a href="/admin">People &amp; Mics</a> page.</div>`;
  if (html === last) return;
  last = html;
  grid.innerHTML = html;
  applyMeters(grid);
  document.getElementById('count').textContent = `${Object.values(store.greenroom.assignments).filter((a) => a.status === 'on-stage').length} on stage · ${Object.values(store.greenroom.assignments).filter((a) => a.status === 'picked-up').length} picked up · ${Object.keys(store.greenroom.assignments).length} assigned`;
}

grid.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-status]');
  if (!b) return;
  const current = store.greenroom.assignments[b.dataset.mic]?.status;
  // Tapping the active status again steps it back to "assigned".
  const status = current === b.dataset.status ? 'assigned' : b.dataset.status;
  try { await api('PUT', `/api/assignments/${encodeURIComponent(b.dataset.mic)}`, { status }); } catch (err) { toast(err.message, true); }
});

onRender(render);
onMeters(() => applyMeters(grid));
