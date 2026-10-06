import { store, esc, avatar, micView, battery, meterRows, STATUS_LABEL, KIND_ICON } from './common.js';

/** Compact mic card used on the main dashboard strip. */
export function micCard(slot) {
  const { mic, a, person, txOn, alerting } = micView(slot);
  const cls = ['mic', txOn ? '' : 'off', a ? `status-${a.status}` : '', alerting ? 'alerting' : ''].join(' ');
  return `<div class="${cls}" data-mid="${esc(slot.id)}">
    ${avatar(person)}
    <div class="who">
      <div class="name">${esc(person?.name || slot.label)}</div>
      <div class="sub">${KIND_ICON[slot.kind] || ''} ${esc(slot.label)}${mic.freqMHz ? ` · <span class="mono">${mic.freqMHz.toFixed(3)}</span>` : ''}</div>
      <div class="sub">
        ${a ? `<span class="status-pill ${a.status}">${STATUS_LABEL[a.status]}</span>` : ''}
        ${!mic.online ? '<span class="txoff">RX OFFLINE</span>' : txOn ? battery(mic) : '<span class="txoff">TX OFF</span>'}
        ${mic.txMuted ? '<span class="txoff">MUTED</span>' : ''}
      </div>
    </div>
    <div class="meters">${meterRows(slot)}</div>
  </div>`;
}

export function visibleSlots() {
  return store.slots.filter((s) => !s.hidden);
}
