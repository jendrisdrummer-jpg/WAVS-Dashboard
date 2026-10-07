// Settings for the active organization: branding, PIN, Planning Center, alerts, organizations.
import { start, store, esc, api, toast, icon, confirmBox, askText } from './common.js';
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
document.getElementById('pin-remove').onclick = async () => { if (await confirmBox('Remove the PIN?')) save({ security: { adminPin: '' } }, 'PIN removed'); };

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
document.getElementById('pco-remove').onclick = async () => { if (await confirmBox('Disconnect Planning Center?')) save({ planningCenter: null }, 'Planning Center disconnected'); };

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
    if (b.dataset.switch && await confirmBox(`Switch every screen to ${o.name}?`)) await api('POST', '/api/orgs/active', { id: o.id });
    if (b.dataset.del && await confirmBox(`Delete ${o.name}? Its gear, people, photos, dashboards and plans are removed for good.`)) {
      await api('DELETE', `/api/orgs/${encodeURIComponent(o.id)}`);
    }
  } catch (err) { toast(err.message, true); }
});
document.getElementById('org-add').onclick = async () => {
  const name = await askText('Name of the new organization (e.g. "Acme Productions")');
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
        <button class="btn small" data-copy="${esc(i.anywhereUrl || i.url)}">Copy link</button><button class="btn small" data-show="${esc(i.code)}">QR</button>
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

// The "anywhere" link (through the off-site connection) works on mobile data too, so it's the one to share.
const inviteBox = (i) => `<div class="acct-newinvite">
    <img class="cc-qr" src="/api/comms/qr.svg?url=${encodeURIComponent(i.anywhereUrl || i.url)}" alt="QR code for the invite link">
    <div><b>${ROLE_LABEL[i.role]} invite${i.label ? ` · ${esc(i.label)}` : ''}</b>
      ${i.anywhereUrl ? `<small class="ok">Works anywhere (Wi-Fi or mobile data)</small>
        <a class="mono cc-url" href="${esc(i.anywhereUrl)}" target="_blank">${esc(i.anywhereUrl)}</a>
        <small class="muted">Same Wi-Fi only: <span class="mono">${esc(i.url)}</span></small>`
        : `<a class="mono cc-url" href="${esc(i.url)}" target="_blank">${esc(i.url)}</a>
        <small class="warn-text">Only works on the same Wi-Fi as this computer. For phones on mobile data, turn on <b>Use from anywhere</b> under This computer below.</small>`}
      <div class="row-btns"><button class="btn small" data-copy="${esc(i.anywhereUrl || i.url)}">Copy link</button></div>
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
    try { await navigator.clipboard.writeText(b.dataset.copy); toast('Link copied'); } catch { await askText('Copy this link', b.dataset.copy); }
  }
  if (b.dataset.show) { lastInvite = acct._invites.find((i) => i.code === b.dataset.show); drawAccounts(); }
  if (b.dataset.revoke && await confirmBox('Cancel this invite link? People who already joined keep their accounts.')) {
    await api('DELETE', `/api/users/invite/${b.dataset.revoke}`).catch((err) => toast(err.message, true));
    if (lastInvite?.code === b.dataset.revoke) lastInvite = null;
    drawAccounts();
  }
  if (b.dataset.reset && await confirmBox('Reset this password? They are signed out everywhere and get a temporary password from you.')) {
    try {
      const r = await api('POST', `/api/users/${b.dataset.reset}/reset`);
      await askText('Temporary password. Give it to them; they can change it from their name in the top bar.', r.password);
    } catch (err) { toast(err.message, true); }
  }
  if (b.dataset.delete && await confirmBox('Delete this account everywhere (all organizations)?')) {
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
      <div><small class="muted">This computer's name</small>
        <form class="name-form" id="name-form"><input type="text" name="name" value="${esc(sys.computerName || 'wavs')}" maxlength="40" ${sys.nameFixed ? 'disabled' : ''} aria-label="Computer name"><span class="muted">.local</span>
          <button class="btn small" ${sys.nameFixed ? 'disabled' : ''}>Save</button></form>
        ${sys.nameConflict ? `<small class="over">⚠ Another device (${esc(sys.nameConflict)}) already uses this name. Pick a different one.</small>`
          : '<small class="muted">Each host computer needs its own name, e.g. <b>wavs</b> on your Mac and <b>grace</b> at church.</small>'}</div>
      <div><small class="muted">Version</small>
        <div>${sys.commit ? `<span class="mono">${esc(sys.commit)}</span> · ${esc(sys.date)}` : esc(sys.version)}</div></div>
    </div>
    <div class="sys-offsite" id="offsite">${offsiteBlock()}</div>
    <div class="sys-update">
      ${!sys.git ? `<p class="muted small">This copy was downloaded as a ZIP, so it can't update itself. Install it with git (see the README) to get the <b>Update now</b> button.</p>`
        : `<div class="row-btns"><button class="btn" id="check-upd" type="button">Check for updates</button>
            ${upd?.behind ? `<button class="btn primary" id="do-upd" type="button">Update now (${upd.behind} change${upd.behind > 1 ? 's' : ''})</button>` : ''}</div>
          <div id="upd-out" class="small">${updText()}</div>`}
    </div>
    <p class="muted small">Your setup is saved in <span class="mono">${esc(sys.dataDir)}</span>. Updating never touches it.</p>`;
}

// ---- use from anywhere (mobile data): the Cloudflare link
let remote = null;
let remoteEdit = false;
async function loadRemote() {
  try { remote = await api('GET', '/api/remote'); } catch { remote = null; }
  const el = document.getElementById('offsite');
  if (el && !remoteEdit) el.innerHTML = offsiteBlock();
}
setInterval(() => { if (remote?.enabled && remote.status !== 'on') loadRemote(); }, 3000);

function offsiteBlock() {
  if (!remote) return '<small class="muted">Loading…</small>';
  const st = { off: 'Off', installing: 'Setting up (first time only)…', starting: 'Connecting…', on: 'On', error: 'Problem' }[remote.status] || remote.status;
  const named = remote.mode === 'named';
  return `<div class="off-head"><b>Use from anywhere</b> <span class="chip ${remote.status === 'on' ? 'good' : remote.status === 'error' ? 'bad' : ''}">${remote.enabled ? esc(st) : 'Off'}</span>
      <button class="btn small ${remote.enabled ? '' : 'primary'}" type="button" data-off="${remote.enabled ? 'off' : 'on'}">${remote.enabled ? 'Turn off' : 'Turn on'}</button></div>
    <small class="muted">Phones and computers on <b>any</b> network (mobile data, a hotspot, home Wi-Fi) can open the dashboard and comms through a secure Cloudflare link. Everyone must sign in with their account. Video feeds from this building's network (capture cards, local streams) only show here.</small>
    ${!remote.accounts ? '<small class="warn-text">Create accounts first (above): off-site, everyone signs in. Until then only the comms page works off-site.</small>' : ''}
    ${remote.status === 'error' ? `<small class="over">${esc(remote.error || '')}</small>` : ''}
    ${remote.url ? `<div class="off-link"><img class="cc-qr" src="/api/comms/qr.svg?url=${encodeURIComponent(remote.url)}" alt="QR code for the off-site address">
        <div><a class="mono cc-url" href="${esc(remote.url)}" target="_blank">${esc(remote.url)}</a>
        <div class="row-btns"><button class="btn small" type="button" data-copy-off="${esc(remote.url)}">Copy</button></div>
        ${named ? '' : '<small class="muted">This free address changes whenever this computer restarts. For an address that never changes, use your own below.</small>'}</div></div>` : ''}
    <details class="off-own" ${named ? 'open' : ''}><summary>${named ? 'Your own address' : 'Use your own address (never changes)'}</summary>
      <form class="form" id="off-form">
        <small class="muted">Needs a domain on a free Cloudflare account (e.g. <b>dashboard.yourchurch.org</b>).
          In Cloudflare: <b>Zero Trust → Networks → Tunnels → Create a tunnel</b> (Cloudflared), copy its <b>token</b>, then add a <b>public hostname</b> pointing to <span class="mono">http://localhost:${esc(String(remote.port || 8090))}</span>.</small>
        <label class="f"><span>Address</span><input type="text" name="hostname" value="${esc(remote.hostname || '')}" placeholder="dashboard.yourchurch.org"></label>
        <label class="f"><span>Tunnel token</span><input type="password" name="token" placeholder="${remote.hasToken ? '•••••••• (saved)' : 'eyJh…'}" autocomplete="off"></label>
        <div class="row-btns"><button class="btn small primary">Use my address</button>${named ? '<button class="btn small" type="button" data-off-quick>Switch back to the free address</button>' : ''}</div>
      </form></details>`;
}

comp.addEventListener('focusin', (e) => { if (e.target.closest('#off-form')) remoteEdit = true; });
comp.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-off],[data-copy-off],[data-off-quick]');
  if (!t) return;
  try {
    if (t.dataset.off) {
      if (t.dataset.off === 'on' && !await confirmBox('Turn on access from anywhere?\n\nThe dashboard gets a secure web address that works on mobile data. Everyone must sign in with their account.')) return;
      await api('POST', '/api/comms/remote', { on: t.dataset.off === 'on' });
    }
    if (t.dataset.copyOff) { try { await navigator.clipboard.writeText(t.dataset.copyOff); toast('Copied'); } catch { await askText('Copy this address', t.dataset.copyOff); } }
    if (t.hasAttribute('data-off-quick')) await api('POST', '/api/comms/remote', { mode: 'quick' });
  } catch (err) { toast(err.message, true); }
  remoteEdit = false;
  loadRemote();
});
comp.addEventListener('submit', async (e) => {
  if (e.target.id !== 'off-form') return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const f = e.target.elements;
  try {
    await api('POST', '/api/comms/remote', { mode: 'named', hostname: f.hostname.value, token: f.token.value, on: true });
    toast('Connecting to your address…');
  } catch (err) { toast(err.message, true); }
  remoteEdit = false;
  loadRemote();
}, true);

function updText() {
  if (!upd) return '';
  if (upd.error) return `<span class="over">${esc(upd.error)}</span>`;
  if (upd.busy) return esc(upd.busy);
  if (!upd.behind) return '<span class="ok">✓ You have the latest version.</span>';
  return `<b>What's new:</b><ul class="upd-list">${upd.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
    ${sys.service.running ? '' : '<span class="muted">After updating, restart the dashboard (in Terminal: Control + C, then npm start).</span>'}`;
}

comp.addEventListener('submit', async (e) => {
  if (e.target.id !== 'name-form') return;
  e.preventDefault();
  try {
    const r = await api('PUT', '/api/system/name', { name: e.target.elements.name.value });
    toast(r.conflict ? `Saved, but another device already uses ${r.name}.local` : `This computer is now http://${r.name}.local`, Boolean(r.conflict));
    drawComputer();
  } catch (err) { toast(err.message, true); }
});

comp.addEventListener('click', async (e) => {
  if (e.target.id === 'check-upd') {
    upd = { busy: 'Checking…' };
    drawComputer();
    try { upd = await api('POST', '/api/system/check'); } catch (err) { upd = { error: err.message }; }
    drawComputer();
  }
  if (e.target.id === 'do-upd') {
    if (!await confirmBox('Update now? Screens showing the dashboard will reload by themselves when it is back (about 30 seconds). Avoid doing this during a live event.')) return;
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
loadRemote();

// ---------------------------------------------------------------- move to another computer
const move = document.getElementById('move-body');
let imp = null; // { token, orgs, needsPassword, password, result }

function drawMove() {
  const mine = cfg.orgs.filter((o) => !cfg.auth?.enabled || cfg.auth.user?.owner || cfg.auth.user?.roles?.[o.id] === 'admin');
  move.innerHTML = `
    <p class="muted small">Host on a different computer (for example the church's computer instead of your Mac): download a backup here, then import it on the other computer in <b>Settings → Move to another computer</b>. It includes gear, people and photos, dashboards, plans, comms, branding and the accounts that can use them. Several computers can host at the same time, each with its own organizations and name.</p>
    <div class="move-cols">
      <form class="form" id="export-form">
        <b>1. Download a backup</b>
        <div class="move-orgs">${mine.map((o) => `<label class="cb"><input type="checkbox" name="org" value="${esc(o.id)}" ${o.id === cfg.orgId ? 'checked' : ''}> ${esc(o.name)}</label>`).join('')}</div>
        <label class="f"><span>Protect it with a password (recommended)</span><input type="password" name="password" autocomplete="new-password" placeholder="Leave empty for no password"></label>
        <small class="muted">The file holds your Planning Center key and everyone's (scrambled) passwords. Keep it private.</small>
        <div class="row-btns"><button class="btn primary">Download backup</button></div>
      </form>
      <form class="form" id="import-form">
        <b>2. Import on this computer</b>
        ${!imp ? `<label class="btn"><input type="file" id="import-file" accept=".wavsbackup,application/octet-stream" hidden>Choose backup file…</label>`
          : imp.result ? importResult()
          : imp.needsPassword ? `<label class="f"><span>This backup has a password</span><input type="password" id="import-pw" autocomplete="off"></label>
              ${imp.error ? `<small class="over">${esc(imp.error)}</small>` : ''}
              <div class="row-btns"><button class="btn primary" type="button" id="import-unlock">Open</button><button class="btn" type="button" id="import-cancel">Cancel</button></div>`
          : `<div class="move-orgs">${imp.orgs.map((o) => `<div class="move-org"><b>${esc(o.name)}</b> <small class="muted">${o.files} files</small>
                <select data-choice="${esc(o.id)}">${o.exists
                  ? `<option value="replace">Replace the one on this computer</option><option value="new">Add as a separate copy</option><option value="skip">Skip</option>`
                  : '<option value="new">Add</option><option value="skip">Skip</option>'}</select></div>`).join('')}</div>
              <small class="muted">Backup from ${new Date(imp.createdAt).toLocaleString()} · ${imp.users} account${imp.users === 1 ? '' : 's'}. Accounts that already exist here keep their password here.</small>
              <div class="row-btns"><button class="btn primary" type="button" id="import-go">Import</button><button class="btn" type="button" id="import-cancel">Cancel</button></div>`}
      </form>
    </div>`;
}

function importResult() {
  const r = imp.result;
  return `<div class="ok"><b>✓ Imported</b></div><ul class="small">${r.imported.map((o) => `<li>${esc(o.name)} (${o.mode === 'replace' ? 'replaced' : 'added'})</li>`).join('')}
      <li>${r.users.added} account${r.users.added === 1 ? '' : 's'} added, ${r.users.updated} updated</li></ul>
    <p class="small muted">Switch to it with the organization menu at the top left. The gear's IP addresses came along; if this computer is at a different venue, check the <b>Gear</b> page.</p>
    ${r.signInNeeded ? '<a class="btn primary" href="/login">Sign in with your account</a>' : '<button class="btn" type="button" id="import-cancel">Done</button>'}`;
}

move.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (e.target.id !== 'export-form') return;
  const f = e.target;
  const ids = [...f.querySelectorAll('[name=org]:checked')].map((x) => x.value);
  if (!ids.length) return toast('Pick at least one organization', true);
  try {
    const res = await fetch('/api/backup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgs: ids, password: f.elements.password.value }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Backup failed');
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'WAVS backup.wavsbackup';
    const url = URL.createObjectURL(await res.blob());
    Object.assign(document.createElement('a'), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('Backup downloaded');
  } catch (err) { toast(err.message, true); }
});

async function inspect(file, password = '') {
  const res = await fetch('/api/backup/inspect', { method: 'POST', headers: { 'content-type': 'application/octet-stream', ...(password ? { 'x-backup-password': password } : {}) }, body: file });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Could not read that file');
  return d;
}

move.addEventListener('change', async (e) => {
  if (e.target.id !== 'import-file' || !e.target.files[0]) return;
  const file = e.target.files[0];
  try { imp = { ...(await inspect(file)), file }; } catch (err) { toast(err.message, true); imp = null; }
  drawMove();
});
move.addEventListener('click', async (e) => {
  if (e.target.id === 'import-cancel') { imp = null; drawMove(); }
  if (e.target.id === 'import-unlock') {
    const pw = document.getElementById('import-pw').value;
    try { imp = { ...(await inspect(imp.file, pw)), file: imp.file, password: pw }; } catch (err) { toast(err.message, true); }
    drawMove();
  }
  if (e.target.id === 'import-go') {
    const choices = Object.fromEntries([...move.querySelectorAll('[data-choice]')].map((s) => [s.dataset.choice, s.value]));
    if (Object.values(choices).includes('replace') && !await confirmBox('Replace the organization on this computer with the one in the backup? Its current gear, people and dashboards here are overwritten.')) return;
    store.holdReload = true;
    try {
      imp.result = await api('POST', '/api/backup/import', { token: imp.token, password: imp.password || '', choices });
    } catch (err) { toast(err.message, true); }
    drawMove();
  }
});
drawMove();
