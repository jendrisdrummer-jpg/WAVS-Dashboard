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

// ---------------------------------------------------------------- accounts & sign-in
const ROLE_LABEL = { crew: 'Crew', producer: 'Producer', admin: 'Admin' };
const ROLE_HELP = {
  crew: 'Green room hand-offs, notes and checklists',
  producer: 'Service plan, people & mics, dashboards, comms control',
  admin: 'Everything, including gear, settings and accounts',
};
const acct = document.getElementById('acct-body');
let lastInvite = null;

if (!cfg.auth?.enabled) {
  acct.innerHTML = `<p>Give everyone their own sign-in instead of sharing a PIN. Start by creating the <b>owner</b> account (that's you); then invite your team with links.</p>
    <a class="btn primary" href="/login">Create the admin account</a>`;
} else {
  document.getElementById('security').classList.add('hidden'); // accounts replace the PIN
  drawAccounts();
}

async function drawAccounts() {
  let d;
  try { d = await api('GET', '/api/users'); } catch (err) { acct.innerHTML = `<p class="muted">${esc(err.message)}</p>`; return; }
  const me = cfg.auth.user;
  const roleSel = (u) => (u.owner ? '<span class="chip on">Owner</span>'
    : `<select data-role="${esc(u.id)}" ${u.id === me.id ? 'disabled' : ''} aria-label="Role for ${esc(u.name)}">
        <option value="">No access</option>${Object.entries(ROLE_LABEL).map(([v, l]) => `<option value="${v}" ${u.role === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`);
  acct.innerHTML = `
    <label class="cb"><input type="checkbox" id="require-login" ${d.requireLogin ? 'checked' : ''}> Require sign-in to view dashboards</label>
    <small class="muted">Off: anyone on your network can <i>view</i> (handy for TVs); changes always need an account. On: everyone signs in first. The comms phone page never needs an account.</small>

    <h3 class="sub-h">Invite people to ${esc(cfg.org.name)}</h3>
    <form class="acct-invite" id="invite-form">
      <select name="role" aria-label="Role">${Object.entries(ROLE_LABEL).map(([v, l]) => `<option value="${v}" ${v === 'crew' ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <input type="text" name="label" maxlength="60" placeholder="Label (optional), e.g. Sunday volunteers" aria-label="Label">
      <select name="days" aria-label="Valid for"><option value="1">1 day</option><option value="7" selected>7 days</option><option value="30">30 days</option></select>
      <button class="btn primary">Create invite link</button>
    </form>
    <small class="muted" id="role-help">${ROLE_HELP.crew}</small>
    <div id="invite-out">${lastInvite ? inviteBox(lastInvite) : ''}</div>
    ${d.invites.length ? `<div class="acct-invites">${d.invites.map((i) => `<div class="acct-row">
        <span class="chip">${ROLE_LABEL[i.role]}</span><span>${esc(i.label || 'Invite link')}</span>
        <small class="muted">used ${i.used}× · expires ${new Date(i.expires).toLocaleDateString()}</small>
        <button class="btn small" data-copy="${esc(i.url)}">Copy link</button><button class="btn small" data-show="${esc(i.code)}">QR</button>
        <button class="btn small danger" data-revoke="${esc(i.code)}">Cancel</button></div>`).join('')}</div>` : ''}

    <h3 class="sub-h">Accounts</h3>
    <div class="acct-list">${d.users.map((u) => `<div class="acct-row">
        <span class="acct-mark">${esc(u.name.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase())}</span>
        <span><b>${esc(u.name)}</b>${u.id === me.id ? ' <small class="muted">(you)</small>' : ''}<br><small class="muted">${esc(u.username)}${u.lastSeen ? ` · last signed in ${new Date(u.lastSeen).toLocaleDateString()}` : ''}</small></span>
        ${roleSel(u)}
        ${u.id === me.id ? '' : `<button class="btn small" data-reset="${esc(u.id)}">Reset password</button>`}
        ${me.owner && !u.owner ? `<button class="btn small danger" data-delete="${esc(u.id)}" aria-label="Delete account">Delete</button>` : ''}
      </div>`).join('')}</div>
    <small class="muted">Roles are per organization: the same person can be crew at the church and a producer for the company.</small>`;
  acct._invites = d.invites;
}

const inviteBox = (i) => `<div class="acct-newinvite">
    <img class="cc-qr" src="/api/comms/qr.svg?url=${encodeURIComponent(i.url)}" alt="QR code for the invite link">
    <div><b>${ROLE_LABEL[i.role]} invite${i.label ? ` · ${esc(i.label)}` : ''}</b>
      <a class="mono cc-url" href="${esc(i.url)}" target="_blank">${esc(i.url)}</a>
      <div class="row-btns"><button class="btn small" data-copy="${esc(i.url)}">Copy link</button></div>
      <small class="muted">Send it by text or email, or let people scan it. Anyone with the link can create an account until it expires, so share it only with your team.</small></div></div>`;

acct.addEventListener('change', async (e) => {
  if (e.target.id === 'require-login') {
    try { await api('PUT', '/api/auth/require-login', { on: e.target.checked }); toast(e.target.checked ? 'Sign-in now required to view' : 'Viewing open on your network'); } catch (err) { toast(err.message, true); }
  }
  if (e.target.name === 'role' && e.target.closest('#invite-form')) document.getElementById('role-help').textContent = ROLE_HELP[e.target.value];
  if (e.target.dataset.role) {
    try { await api('PUT', `/api/users/${e.target.dataset.role}/role`, { role: e.target.value || null }); toast('Role updated'); } catch (err) { toast(err.message, true); drawAccounts(); }
  }
});
acct.addEventListener('submit', async (e) => {
  if (e.target.id !== 'invite-form') return;
  e.preventDefault();
  const f = e.target.elements;
  try {
    lastInvite = await api('POST', '/api/users/invite', { role: f.role.value, label: f.label.value, days: Number(f.days.value) });
    drawAccounts();
  } catch (err) { toast(err.message, true); }
});
acct.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.copy) {
    try { await navigator.clipboard.writeText(b.dataset.copy); toast('Link copied'); } catch { prompt('Copy this link', b.dataset.copy); }
  }
  if (b.dataset.show) { lastInvite = acct._invites.find((i) => i.code === b.dataset.show); drawAccounts(); }
  if (b.dataset.revoke && confirm('Cancel this invite link? People who already joined keep their accounts.')) {
    await api('DELETE', `/api/users/invite/${b.dataset.revoke}`).catch((err) => toast(err.message, true));
    if (lastInvite?.code === b.dataset.revoke) lastInvite = null;
    drawAccounts();
  }
  if (b.dataset.reset && confirm('Reset this password? They are signed out everywhere and get a temporary password from you.')) {
    try {
      const r = await api('POST', `/api/users/${b.dataset.reset}/reset`);
      prompt('Temporary password. Give it to them; they can change it from their name in the top bar.', r.password);
    } catch (err) { toast(err.message, true); }
  }
  if (b.dataset.delete && confirm('Delete this account everywhere (all organizations)?')) {
    try { await api('DELETE', `/api/users/${b.dataset.delete}`); drawAccounts(); } catch (err) { toast(err.message, true); }
  }
});

// ---------------------------------------------------------------- this computer
const comp = document.getElementById('computer-body');
let sys = null;
let upd = null;

async function drawComputer() {
  try { sys = await api('GET', '/api/system'); } catch (err) { comp.innerHTML = `<p class="muted">${esc(err.message)}</p>`; return; }
  const svc = sys.service;
  const mac = svc.platform === 'darwin';
  comp.innerHTML = `
    <div class="sys-grid">
      <div><small class="muted">Open it on this network</small>
        <div>${sys.address.name ? `<a class="mono" href="${esc(sys.address.name)}">${esc(sys.address.name)}</a>` : ''}
        ${sys.address.ip ? `<div class="small muted">or <span class="mono">${esc(sys.address.ip)}</span> (some Android phones need this one)</div>` : ''}</div></div>
      <div><small class="muted">Starts by itself</small>
        <div>${svc.running ? '<b class="ok">✓ Yes</b>: running in the background, starts when this computer logs in'
          : svc.installed ? '<b>Set up</b>, but this copy was started from Terminal'
          : `<b>No</b>: it only runs while Terminal is open.<br><small class="muted">To fix that, open the dashboard folder (<span class="mono">${esc(sys.root)}</span>) and ${svc.platform === 'linux' ? 'run <span class="mono">npm run service:install</span> there once' : `double-click <b>${mac ? 'Install WAVS Dashboard (Mac).command' : 'Install WAVS Dashboard (Windows).cmd'}</b> once`}.</small>`}</div></div>
      <div><small class="muted">Version</small>
        <div>${sys.commit ? `<span class="mono">${esc(sys.commit)}</span> · ${esc(sys.date)}` : esc(sys.version)}</div></div>
    </div>
    <div class="sys-update">
      ${!sys.git ? `<p class="muted small">This copy was downloaded as a ZIP, so it can't update itself. Install it with git (see the README) to get the <b>Update now</b> button.</p>`
        : `<div class="row-btns"><button class="btn" id="check-upd" type="button">Check for updates</button>
            ${upd?.behind ? `<button class="btn primary" id="do-upd" type="button">Update now (${upd.behind} change${upd.behind > 1 ? 's' : ''})</button>` : ''}</div>
          <div id="upd-out" class="small">${updText()}</div>`}
    </div>
    <p class="muted small">Your setup is saved in <span class="mono">${esc(sys.dataDir)}</span>. Updating never touches it.</p>`;
}

function updText() {
  if (!upd) return '';
  if (upd.error) return `<span class="over">${esc(upd.error)}</span>`;
  if (upd.busy) return esc(upd.busy);
  if (!upd.behind) return '<span class="ok">✓ You have the latest version.</span>';
  return `<b>What's new:</b><ul class="upd-list">${upd.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
    ${sys.service.running ? '' : '<span class="muted">After updating, restart the dashboard (in Terminal: Control + C, then npm start).</span>'}`;
}

comp.addEventListener('click', async (e) => {
  if (e.target.id === 'check-upd') {
    upd = { busy: 'Checking…' };
    drawComputer();
    try { upd = await api('POST', '/api/system/check'); } catch (err) { upd = { error: err.message }; }
    drawComputer();
  }
  if (e.target.id === 'do-upd') {
    if (!confirm('Update now? Screens showing the dashboard will reload by themselves when it is back (about 30 seconds). Avoid doing this during a live event.')) return;
    upd = { ...upd, busy: 'Updating… downloading the new version and installing it.' };
    store.holdReload = true;
    drawComputer();
    try {
      const r = await api('POST', '/api/system/update');
      if (!r.restart) { upd = { behind: 0, changes: [] }; store.holdReload = false; toast('Updated. Restart the dashboard to finish.'); drawComputer(); return; }
      upd.busy = 'Restarting…';
      document.getElementById('upd-out').textContent = upd.busy;
      // Wait for it to come back, then load the new version.
      await new Promise((r2) => setTimeout(r2, 2500));
      for (let i = 0; i < 60; i++) {
        try { if ((await fetch('/api/auth/status', { cache: 'no-store' })).ok) { location.reload(); return; } } catch { /* still restarting */ }
        await new Promise((r2) => setTimeout(r2, 1000));
      }
      upd = { error: 'It is taking longer than expected. Reload this page in a minute.' };
    } catch (err) { upd = { error: err.message }; store.holdReload = false; }
    drawComputer();
  }
});
drawComputer();
