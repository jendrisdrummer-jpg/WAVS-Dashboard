import { start, store, onRender, onMeters, applyMeters, esc, micView, battery, meterRows, STATUS_LABEL } from './common.js';

await start({ page: 'rf' });

const body = document.getElementById('rows');
const rxEl = document.getElementById('receivers');
const spec = document.getElementById('spectrum');
let last = '';

/** Pairs of active carriers closer together than the configured spacing. */
function spacingConflicts(list) {
  const min = (store.config.rf?.minSpacingKHz || 350) / 1000;
  const sorted = list.filter((x) => x.mic.freqMHz).sort((a, b) => a.mic.freqMHz - b.mic.freqMHz);
  const bad = new Set();
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].mic.freqMHz - sorted[i - 1].mic.freqMHz < min) { bad.add(sorted[i].slot.id); bad.add(sorted[i - 1].slot.id); }
  }
  return bad;
}

function drawSpectrum(list, conflicts) {
  const freqs = list.filter((x) => x.mic.freqMHz);
  if (!freqs.length) { spec.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="var(--muted)">No frequencies reported yet</text>'; return; }
  const W = spec.clientWidth || 1000;
  const H = 200;
  const pad = 30;
  let lo = Math.min(...freqs.map((x) => x.mic.freqMHz));
  let hi = Math.max(...freqs.map((x) => x.mic.freqMHz));
  const margin = Math.max(1, (hi - lo) * 0.08);
  lo -= margin; hi += margin;
  const x = (f) => pad + ((f - lo) / (hi - lo)) * (W - pad * 2);
  const ticks = [];
  const step = (hi - lo) > 40 ? 10 : (hi - lo) > 15 ? 5 : (hi - lo) > 6 ? 2 : 1;
  for (let f = Math.ceil(lo / step) * step; f <= hi; f += step) ticks.push(f);
  spec.setAttribute('viewBox', `0 0 ${W} ${H}`);
  spec.innerHTML = `
    <line x1="${pad}" x2="${W - pad}" y1="${H - 24}" y2="${H - 24}" stroke="var(--line)"/>
    ${ticks.map((f) => `<g><line x1="${x(f)}" x2="${x(f)}" y1="${H - 24}" y2="${H - 20}" stroke="var(--muted)"/><text x="${x(f)}" y="${H - 6}" font-size="11" text-anchor="middle" fill="var(--muted)">${f} MHz</text></g>`).join('')}
    ${freqs.sort((p, q) => p.mic.freqMHz - q.mic.freqMHz).map(({ slot, mic, person, txOn }, i, all) => {
      const cx = x(mic.freqMHz);
      const h = txOn ? 30 + (Math.max(0, (mic.rfDbm ?? -100) + 100) / 60) * 80 : 14;
      const color = conflicts.has(slot.id) ? 'var(--warning)' : txOn ? 'var(--accent)' : 'var(--muted)';
      // Stagger labels of carriers that sit close together so they don't overprint.
      const crowded = (j) => j >= 0 && j < all.length && Math.abs(x(all[j].mic.freqMHz) - cx) < 60;
      let level = 0;
      for (let j = i - 1; crowded(j); j--) level++;
      const ly = 14 + (level % 3) * 14;
      return `<g><title>${esc(slot.label)}${person ? ` – ${esc(person.name)}` : ''}: ${mic.freqMHz.toFixed(3)} MHz${txOn ? `, ${mic.rfDbm} dBm` : ', TX off'}</title>
        <line x1="${cx}" x2="${cx}" y1="${ly + 4}" y2="${H - 24 - h}" stroke="var(--line)" stroke-dasharray="2 3"/>
        <rect x="${cx - 3}" y="${H - 24 - h}" width="6" height="${h}" rx="3" fill="${color}"/>
        <text x="${cx}" y="${ly}" font-size="11" text-anchor="middle" fill="var(--text-2)">${esc(slot.label)}</text></g>`;
    }).join('')}`;
}

function render() {
  const list = store.slots.map(micView);
  const conflicts = spacingConflicts(list);

  rxEl.innerHTML = Object.values(store.state.receivers).map((r) => `
    <span class="chip ${r.online ? 'good' : 'bad'}" title="${esc(r.error || '')}">${r.online ? '●' : '✕'} ${esc(r.name)} ${r.model ? `· ${esc(r.model)}` : ''} ${r.host ? `· ${esc(r.host)}` : ''}</span>`).join(' ');

  const html = list.map(({ slot, mic, a, person, txOn }) => `
    <tr class="${conflicts.has(slot.id) || mic.interference ? 'warn' : ''}">
      <td>${esc(slot.receiverName)} <span class="muted">ch ${slot.channel}</span></td>
      <td><strong>${esc(slot.label)}</strong></td>
      <td>${esc(mic.chanName || '')}</td>
      <td>${person ? esc(person.name) : '<span class="muted">—</span>'} ${a ? `<span class="status-pill ${a.status}">${STATUS_LABEL[a.status]}</span>` : ''}</td>
      <td>${!mic.online ? '<span class="txoff">RX OFFLINE</span>' : txOn ? esc(mic.txType || 'On') : '<span class="txoff">OFF</span>'}</td>
      <td class="mono">${mic.freqMHz ? mic.freqMHz.toFixed(3) : '—'}${conflicts.has(slot.id) ? ' <span title="Closer than minimum spacing">⚠</span>' : ''}</td>
      <td class="mono">${esc(mic.groupChan || '—')}</td>
      <td style="min-width:260px"><div class="meters">${meterRows(slot)}</div></td>
      <td>${txOn ? battery(mic) : '—'}${mic.battType ? ` <span class="muted">${esc(mic.battType)}</span>` : ''}</td>
      <td>${mic.interference ? '<span class="chip bad">⚠ Interference</span>' : ''}${mic.txMuted ? '<span class="chip bad">Muted</span>' : ''}</td>
    </tr>`).join('');
  if (html !== last) {
    last = html;
    body.innerHTML = html || '<tr><td colspan="10" class="muted">No receivers configured.</td></tr>';
    applyMeters(body);
    drawSpectrum(list, conflicts);
  }
}

onRender(render);
onMeters(() => applyMeters(body));
// Bar heights follow live RF, which arrives as meter updates rather than renders.
setInterval(() => {
  const list = store.slots.map(micView);
  drawSpectrum(list, spacingConflicts(list));
}, 1000);
window.addEventListener('resize', () => { last = ''; render(); });
