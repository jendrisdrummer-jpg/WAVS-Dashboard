// Forms for adding / editing gear, shared by the Gear page, Settings and the setup wizard.
import { esc, api, icon } from './common.js';

/** Shure models and how many channels each has, so picking a model fills in the channels. */
export const SHURE_MODELS = [
  ['', 'Detect automatically', 2],
  ['SLXD4', 'SLX-D4 (single)', 1], ['SLXD4D', 'SLX-D4D (dual)', 2], ['SLXD4Q', 'SLX-D4Q (quad)', 4],
  ['ULXD4', 'ULX-D4 (single)', 1], ['ULXD4D', 'ULX-D4D (dual)', 2], ['ULXD4Q', 'ULX-D4Q (quad)', 4],
  ['QLXD4', 'QLX-D4', 1], ['AD4D', 'Axient AD4D', 2], ['AD4Q', 'Axient AD4Q', 4],
];
const KINDS = [['handheld', 'Handheld'], ['headset', 'Headset'], ['lav', 'Lav'], ['iem', 'In-ear'], ['instrument', 'Instrument']];

export const KIND_LABEL = {
  receiver: 'Wireless receiver', switcher: 'Switcher', propresenter: 'ProPresenter', video: 'Video source', planningCenter: 'Planning Center',
};

const opt = (list, v) => list.map(([val, lab]) => `<option value="${esc(val)}" ${String(v ?? '') === String(val) ? 'selected' : ''}>${esc(lab)}</option>`).join('');
const field = (label, html, hint = '') => `<label class="f"><span>${esc(label)}</span>${html}${hint ? `<small class="muted">${hint}</small>` : ''}</label>`;
const input = (name, v, attrs = '') => `<input type="text" name="${name}" value="${esc(v ?? '')}" ${attrs}>`;

function channelRows(channels) {
  return channels.map((c, i) => `<div class="ch-row" data-ch>
    <span class="muted">Ch ${i + 1}</span>
    <input type="text" name="ch-label" value="${esc(c.label || '')}" placeholder="e.g. HH ${i + 1}, Pastor HS" aria-label="Channel ${i + 1} label">
    <select name="ch-kind" aria-label="Channel ${i + 1} type">${opt(KINDS, c.kind || 'handheld')}</select>
  </div>`).join('');
}

/** HTML for one device's form. `ctx.switchers` lists switchers for the video tally choice. */
export function deviceForm(kind, d = {}, ctx = {}) {
  switch (kind) {
    case 'receiver': {
      const chans = d.channels?.length ? d.channels : [{ label: 'HH 1' }, { label: 'HH 2' }];
      return `
        ${field('Name', input('name', d.name, 'placeholder="e.g. SLX-D Rack A" required'))}
        <div class="f-row">
          ${field('Type', `<select name="type">${opt([['shure', 'Shure (SLX-D, ULX-D, QLX-D, Axient)'], ['simulator', 'Simulated (for testing)']], d.type || 'shure')}</select>`)}
          ${field('Model', `<select name="model">${opt(SHURE_MODELS.map(([v, l]) => [v, l]), d.model || '')}</select>`)}
        </div>
        <div class="f-row" data-when="shure">
          ${field('IP address', input('host', d.host, 'placeholder="192.168.1.101" inputmode="decimal"'), 'Shown on the receiver: Menu → Network')}
          ${field('Port', input('port', d.port || 2202, 'inputmode="numeric"'))}
        </div>
        <div class="f"><span>Channels</span><div class="ch-list">${channelRows(chans)}</div>
          <div class="row-btns"><button type="button" class="btn small" data-ch-add>${icon('plus')} Channel</button><button type="button" class="btn small" data-ch-del>Remove last</button></div></div>`;
    }
    case 'switcher':
      return `
        ${field('Name', input('name', d.name, 'placeholder="e.g. ATEM Constellation" required'))}
        <div class="f-row">
          ${field('Type', `<select name="type">${opt([['atem', 'Blackmagic ATEM'], ['vmix', 'vMix'], ['simulator', 'Simulated (for testing)']], d.type || 'atem')}</select>`)}
          ${field('IP address', input('host', d.host, 'placeholder="192.168.1.240" inputmode="decimal"'), 'ATEM Setup → Network')}
        </div>
        <div class="f-row">
          ${field('Default M/E', `<input type="number" name="me" min="1" max="4" value="${esc(d.me || 1)}">`, 'Used for tally overlays')}
          ${field('vMix port', input('port', d.port || 8088, 'inputmode="numeric"'))}
        </div>
        ${field('M/E names (optional)', input('meNames', (d.meNames || []).join(', '), 'placeholder="Program, Stream, IMAG, Lobby"'), 'Comma-separated, in order')}
        ${field('Aux names (optional)', input('auxNames', Object.entries(d.auxNames || {}).sort((a, b) => a[0] - b[0]).map(([, v]) => v).join(', '), 'placeholder="Stream, Record, IMAG L, IMAG R"'), 'Comma-separated: Aux 1, Aux 2, …')}`;
    case 'propresenter':
      return `
        ${field('Name', input('name', d.name, 'placeholder="e.g. ProPresenter – Main" required'))}
        <div class="f-row">
          ${field('Type', `<select name="type">${opt([['propresenter', 'ProPresenter 7'], ['simulator', 'Simulated (for testing)']], d.type || 'propresenter')}</select>`)}
          ${field('IP address', input('host', d.host, 'placeholder="192.168.1.20" inputmode="decimal"'))}
          ${field('Port', input('port', d.port || 1025, 'inputmode="numeric"'), 'ProPresenter → Settings → Network')}
        </div>`;
    case 'video':
      return `
        ${field('Name', input('label', d.label, 'placeholder="e.g. Program, Multiview" required'))}
        ${field('Type', `<select name="type">${opt([
          ['capture', 'Capture card on the viewing computer'], ['webrtc', 'WebRTC / WHEP (MediaMTX)'], ['hls', 'HLS stream (.m3u8)'], ['mjpeg', 'MJPEG / snapshot URL'], ['iframe', 'Web page'],
        ], d.type || 'webrtc')}</select>`)}
        <div data-when="capture">${field('Device name contains', input('device', d.device, 'placeholder="UltraStudio, Magewell, Cam Link"'), 'You can also pick the device on the tile itself')}</div>
        <div data-when="url">${field('URL', input('url', d.url, 'placeholder="http://192.168.1.10:8889/program/whep"'))}</div>
        ${field('Show tally from', `<select name="switcher">${opt([['', 'None'], ...(ctx.switchers || []).map((s) => [s.id, s.name])], d.switcher || '')}</select>`)}`;
    case 'planningCenter':
      return `
        <p class="muted small">Create a Personal Access Token at <a href="https://api.planningcenteronline.com/oauth/applications" target="_blank" rel="noopener">api.planningcenteronline.com/oauth/applications</a> → Personal Access Tokens, then paste both parts here.</p>
        ${field('Application ID', input('appId', d.appId, 'autocomplete="off"'))}
        ${field('Secret', `<input type="password" name="secret" value="${esc(d.secret || '')}" autocomplete="off">`)}`;
    default: return '';
  }
}

/** Wire up dynamic bits (show/hide by type, channel add/remove, model → channel count). */
export function enhanceForm(kind, root) {
  const type = root.querySelector('[name=type]');
  const sync = () => {
    const t = type?.value;
    root.querySelectorAll('[data-when]').forEach((el) => {
      const w = el.dataset.when;
      const show = w === t || (w === 'url' && t && t !== 'capture') || (w === 'shure' && t === 'shure');
      el.classList.toggle('hidden', !show);
    });
    const port = root.querySelector('[name=port]');
    if (kind === 'switcher' && port) port.closest('.f').classList.toggle('hidden', t !== 'vmix');
  };
  type?.addEventListener('change', sync);
  sync();
  if (kind !== 'receiver') return;
  const list = root.querySelector('.ch-list');
  const rows = () => [...list.querySelectorAll('[data-ch]')].map((r) => ({ label: r.querySelector('[name=ch-label]').value, kind: r.querySelector('[name=ch-kind]').value }));
  const setCount = (n) => {
    const cur = rows();
    const next = Array.from({ length: n }, (_, i) => cur[i] || { label: `HH ${i + 1}`, kind: 'handheld' });
    list.innerHTML = channelRows(next);
  };
  root.querySelector('[data-ch-add]').onclick = () => setCount(Math.min(8, rows().length + 1));
  root.querySelector('[data-ch-del]').onclick = () => setCount(Math.max(1, rows().length - 1));
  root.querySelector('[name=model]').onchange = (e) => {
    const m = SHURE_MODELS.find(([v]) => v === e.target.value);
    if (m && m[0]) setCount(m[2]);
  };
}

/** Read a device form back into a settings object (keeps the id of an existing device). */
export function readForm(kind, root, existing = {}) {
  const v = (n) => root.querySelector(`[name="${n}"]`)?.value.trim() ?? '';
  switch (kind) {
    case 'receiver':
      return {
        ...existing, name: v('name'), type: v('type'), model: v('model') || undefined, host: v('host'), port: Number(v('port')) || 2202,
        channels: [...root.querySelectorAll('[data-ch]')].map((r) => ({ label: r.querySelector('[name=ch-label]').value.trim(), kind: r.querySelector('[name=ch-kind]').value })),
      };
    case 'switcher': {
      const auxNames = {};
      v('auxNames').split(',').map((x) => x.trim()).forEach((n, i) => { if (n) auxNames[i + 1] = n; });
      return { ...existing, name: v('name'), type: v('type'), host: v('host'), port: Number(v('port')) || 8088, me: Number(v('me')) || 1, meNames: v('meNames').split(',').map((x) => x.trim()).filter(Boolean), auxNames };
    }
    case 'propresenter':
      return { ...existing, name: v('name'), type: v('type'), host: v('host'), port: Number(v('port')) || 1025 };
    case 'video':
      return { ...existing, label: v('label'), type: v('type'), url: v('url'), device: v('device'), switcher: v('switcher') || undefined };
    case 'planningCenter':
      return { ...existing, appId: v('appId'), secret: root.querySelector('[name=secret]').value };
    default: return existing;
  }
}

/** Run the server-side connection test; shows the result in `out`. */
export async function runTest(kind, device, out) {
  out.className = 'test-result busy';
  out.textContent = 'Testing…';
  try {
    const r = await api('POST', '/api/settings/test', { kind, device });
    out.className = `test-result ${r.ok ? 'ok' : 'bad'}`;
    out.innerHTML = `${icon(r.ok ? 'check' : 'x')} ${esc(r.detail)}`;
    return r;
  } catch (err) {
    out.className = 'test-result bad';
    out.textContent = err.message;
    return { ok: false };
  }
}
