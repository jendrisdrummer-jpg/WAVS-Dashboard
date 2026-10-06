import { start, store, onRender, onMeters, applyMeters, esc, api, toast } from './common.js';
import { buildTile } from './video.js';
import { micCard, visibleSlots } from './micstrip.js';

await start({ page: 'dash' });

const tilesEl = document.getElementById('tiles');
const tiles = (store.config.video.tiles || []).map((cfg) => {
  const t = buildTile(cfg);
  tilesEl.append(t.el);
  return t;
});
if (!tiles.length) tilesEl.innerHTML = '<div class="panel panel-body muted">No video tiles configured. Add some under <code>video.tiles</code> in your config.</div>';

const onAirEl = document.getElementById('onair');
const alertsEl = document.getElementById('alerts');
const stripEl = document.getElementById('strip');
const stageEl = document.getElementById('stage');

// Stage message (optional, config: control.propresenterStageMessage)
const pps = () => Object.values(store.state.propresenter);
if (store.config.control.propresenterStageMessage) {
  stageEl.classList.remove('hidden');
  stageEl.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    const text = e.submitter?.dataset.clear ? '' : form.text.value.trim();
    try {
      await api('POST', `/api/propresenter/${encodeURIComponent(form.pp.value)}/stage-message`, { text });
      toast(text ? 'Stage message sent' : 'Stage message cleared');
      if (!text) form.text.value = '';
    } catch (err) { toast(err.message, true); }
  };
}

let stripKey = '';
onRender(() => {
  tiles.forEach((t) => t.update());

  // On-air panel: one block per switcher
  onAirEl.innerHTML = Object.values(store.state.switchers).map((sw) => `
    <div style="margin-bottom:10px">
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
        <span class="dot ${sw.online ? 'ok' : 'bad'}"></span><strong>${esc(sw.name)}</strong>
        <span class="muted" style="font-size:12px">${esc(sw.model || '')}</span>
      </div>
      ${sw.online ? `
        <div class="tally-row"><span class="lbl">PROGRAM</span><div class="tally-box pgm">${esc(sw.program?.name || '—')}</div></div>
        <div class="tally-row"><span class="lbl">PREVIEW</span><div class="tally-box pvw">${esc(sw.preview?.name || '—')}</div></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${sw.streaming != null ? `<span class="chip ${sw.streaming ? 'live' : ''}">${sw.streaming ? '● STREAMING' : 'Not streaming'}</span>` : ''}
          ${sw.recording != null ? `<span class="chip ${sw.recording ? 'live' : ''}">${sw.recording ? '● RECORDING' : 'Not recording'}</span>` : ''}
          ${sw.ftb ? '<span class="chip bad">FADE TO BLACK</span>' : ''}
        </div>` : `<div class="muted">${esc(sw.error || 'Offline')}</div>`}
    </div>`).join('') || '<div class="muted">No switchers configured.</div>';

  // ProPresenter connection list
  const ppStatus = pps().map((p) => `<div style="display:flex;gap:6px;align-items:center"><span class="dot ${p.online ? 'ok' : 'bad'}"></span>${esc(p.name)}<span class="muted" style="font-size:12px;margin-left:auto">${esc(p.online ? p.version || '' : p.error || 'offline')}</span></div>`).join('');
  document.getElementById('pplist').innerHTML = ppStatus || '<div class="muted">No ProPresenter configured.</div>';
  const sel = stageEl.querySelector('select');
  const ids = pps().map((p) => p.id).join();
  if (sel.dataset.ids !== ids) {
    sel.dataset.ids = ids;
    sel.innerHTML = pps().map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  }

  alertsEl.innerHTML = store.alerts.length
    ? store.alerts.map((a) => `<span class="alert ${a.level}">${esc(a.text)}</span>`).join('')
    : '<div class="muted">✓ All clear</div>';

  // Mic strip – only rebuild when something other than meters changed
  const slots = visibleSlots();
  const html = slots.map(micCard).join('');
  if (html !== stripKey) {
    stripKey = html;
    stripEl.innerHTML = html || '<div class="muted">No wireless receivers configured.</div>';
    applyMeters(stripEl);
  }
});

onMeters(() => applyMeters(stripEl));
