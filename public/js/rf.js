import { start, store, onRender, onMeters, applyMeters, micView } from './common.js';
import { spacingConflicts, drawSpectrum, rfRows, receiverChips } from './views.js';

await start({ page: 'rf' });

const body = document.getElementById('rows');
const rxEl = document.getElementById('receivers');
const spec = document.getElementById('spectrum');
let last = '';

function render() {
  const list = store.slots.map(micView);
  const conflicts = spacingConflicts(list);
  rxEl.innerHTML = receiverChips();
  const html = rfRows(list, conflicts);
  if (html !== last) {
    last = html;
    body.innerHTML = html || '<tr><td colspan="10" class="muted">No receivers configured.</td></tr>';
    applyMeters(body);
    drawSpectrum(spec, list, conflicts);
  }
}

onRender(render);
onMeters(() => applyMeters(body));
// Bar heights follow live RF, which arrives as meter updates rather than renders.
setInterval(() => {
  const list = store.slots.map(micView);
  drawSpectrum(spec, list, spacingConflicts(list));
}, 1000);
window.addEventListener('resize', () => { last = ''; render(); });
