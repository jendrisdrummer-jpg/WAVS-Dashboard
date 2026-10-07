// Settings for the active organization: branding, PIN, Planning Center, alerts, organizations.
import { start, store, esc, api, toast, icon } from './common.js';
import { deviceForm, readForm, runTest } from './forms.js';

await start({ page: 'settings' });

let s = await api('GET', '/api/settings');
const cfg = store.config;
document.getElementById('sub').textContent = `For ${cfg.org.name}`;

const COLORS = ['#3b82f6', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#d97706', '#16a34a', '#0891b2', '#475569'];

async function save(patch, msg = 'Saved') {
  try {
    s = await api('PUT', '/api/settings', patch);
    toast(msg);
  } catch (err) { toast(err.message, true); }
}

// ---------------------------------------------------------------- organization
const orgForm = document.getElementById('org-form');
orgForm.elements.name.value = s.org.name;
orgForm.elements.serviceName.value = s.org.serviceName || '';
let accent = s.org.theme.accent;
const sw = document.getElementById('swatches');
const drawSwatches = () => {
  sw.innerHTML = [...new Set([...COLORS, accent])].map((c) => `<button type="button" class="swatch-btn ${c === accent ? 'on' : ''}" style="background:${c}" data-c="${c}" aria-label="Colour ${c}"></button>`).join('')
    + `<label class="swatch-btn custom" title="Custom colour"><input type="color" value="${accent}"></label>`;
};
drawSwatches();
sw.addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (b) { accent = b.dataset.c; drawSwatches(); } });
sw.addEventListener('change', (e) => { if (e.target.type === 'color') { accent = e.target.value; drawSwatches(); } });
orgForm.onsubmit = (e) => {
  e.preventDefault();
  save({ org: { ...s.org, name: orgForm.elements.name.value, serviceName: orgForm.elements.serviceName.value, theme: { ...s.org.theme, accent } } });
};

const preview = document.getElementById('logo-preview');
preview.innerHTML = cfg.org.logo ? `<img src="/logo?${Date.now()}" alt="">` : '<span class="muted small">No logo</span>';
document.getElementById('logo-file').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const fd = new FormData();
  fd.set('logo', f);
  try { await api('POST', '/api/settings/logo', fd); } catch (err) { toast(err.message, true); }
};
document.getElementById('logo-remove').onclick = () => api('DELETE', '/api/settings/logo').catch((err) => toast(err.message, true));

// ---------------------------------------------------------------- PIN
const pinForm = document.getElementById('pin-form');
document.getElementById('pin-state').textContent = s.security.hasPin ? 'A PIN is set.' : 'No PIN: anyone on the network can change things.';
pinForm.onsubmit = (e) => {
  e.preventDefault();
  const pin = pinForm.elements.pin.value.trim();
  if (pin.length < 4) return toast('Use at least 4 digits', true);
  save({ security: { adminPin: pin } }, 'PIN set').then(() => { try { localStorage.setItem('wavs-pin', pin); } catch { /* ignore */ } });
};
document.getElementById('pin-remove').onclick = () => { if (confirm('Remove the PIN?')) save({ security: { adminPin: '' } }, 'PIN removed'); };

// ---------------------------------------------------------------- Planning Center
const pcoFields = document.getElementById('pco-fields');
const pcoOut = document.getElementById('pco-test');
const typesEl = document.getElementById('pco-types');
pcoFields.innerHTML = deviceForm('planningCenter', s.planningCenter || {});
const drawTypes = (types) => {
  const chosen = s.planningCenter?.serviceTypes || [];
  typesEl.innerHTML = types.length ? `<div class="f"><span>Service types to follow (none ticked = all)</span><div class="mic-picks">${types.map((t) => `
    <label class="cb"><input type="checkbox" data-st="${esc(t.id)}" ${chosen.includes(String(t.id)) ? 'checked' : ''}> ${esc(t.name)}</label>`).join('')}</div></div>` : '';
};
document.getElementById('pco-testbtn').onclick = async () => {
  const r = await runTest('planningCenter', readForm('planningCenter', pcoFields), pcoOut);
  if (r.serviceTypes) drawTypes(r.serviceTypes);
};
document.getElementById('pco-form').onsubmit = (e) => {
  e.preventDefault();
  const pco = readForm('planningCenter', pcoFields);
  const picked = [...typesEl.querySelectorAll('[data-st]:checked')].map((c) => c.dataset.st);
  save({ planningCenter: { ...pco, serviceTypes: typesEl.innerHTML ? picked : s.planningCenter?.serviceTypes || [] } }, 'Planning Center saved');
};
document.getElementById('pco-remove').onclick = () => { if (confirm('Disconnect Planning Center?')) save({ planningCenter: null }, 'Planning Center disconnected'); };

// ---------------------------------------------------------------- alerts & automation
const beh = document.getElementById('beh-form').elements;
beh.batteryMinutes.value = s.alerts.batteryMinutes;
beh.batteryBars.value = s.alerts.batteryBars;
beh.rfLowDbm.value = s.alerts.rfLowDbm;
beh.sound.checked = s.alerts.sound;
beh.followProPresenter.checked = s.service.followProPresenter;
beh.stage.checked = s.control.propresenterStageMessage;
beh.pushNames.checked = s.control.pushNamesToReceivers;
document.getElementById('beh-form').onsubmit = (e) => {
  e.preventDefault();
  save({
    alerts: { ...s.alerts, batteryMinutes: Number(beh.batteryMinutes.value), batteryBars: Number(beh.batteryBars.value), rfLowDbm: Number(beh.rfLowDbm.value), sound: beh.sound.checked },
    service: { followProPresenter: beh.followProPresenter.checked },
    control: { propresenterStageMessage: beh.stage.checked, pushNamesToReceivers: beh.pushNames.checked },
  });
};

// ---------------------------------------------------------------- organizations
document.getElementById('data-dir').textContent = store.config.dataDir || '';
const list = document.getElementById('org-list');
list.innerHTML = cfg.orgs.map((o) => `<div class="org-row ${o.id === cfg.orgId ? 'cur' : ''}">
  <span class="org-dot" style="background:${esc(o.color)}"></span><b>${esc(o.name)}</b>
  ${o.id === cfg.orgId ? '<span class="chip good">Active</span>' : `<button class="btn small" data-switch="${esc(o.id)}">${icon('swap')} Switch to</button><button class="btn small danger" data-del="${esc(o.id)}">Delete</button>`}
</div>`).join('');
list.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const o = cfg.orgs.find((x) => x.id === (b.dataset.switch || b.dataset.del));
  try {
    if (b.dataset.switch && confirm(`Switch every screen to ${o.name}?`)) await api('POST', '/api/orgs/active', { id: o.id });
    if (b.dataset.del && confirm(`Delete ${o.name}? Its gear, people, photos, dashboards and plans are removed for good.`)) {
      await api('DELETE', `/api/orgs/${encodeURIComponent(o.id)}`);
    }
  } catch (err) { toast(err.message, true); }
});
document.getElementById('org-add').onclick = async () => {
  const name = prompt('Name of the new organization (e.g. "Acme Productions")');
  if (!name?.trim()) return;
  try { await api('POST', '/api/orgs', { name: name.trim() }); } catch (err) { toast(err.message, true); }
};

if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
