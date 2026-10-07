// Sign in, accept an invite (/join/<code>), or create the owner account on first use.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const params = new URLSearchParams(location.search);
const next = /^\/(?!\/)/.test(params.get('next') || '') ? params.get('next') : '/';
const invite = location.pathname.match(/^\/join\/([\w-]+)/)?.[1];
const ROLE_TEXT = { admin: 'an admin', producer: 'a producer', crew: 'crew' };

const cfg = await (await fetch('/api/auth/status')).json().catch(() => null);
if (cfg?.org) {
  $('brand').innerHTML = cfg.org.logo ? '<img src="/logo" alt="">' : `<span class="org-mark">${esc(cfg.org.name.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase())}</span>`;
  if (cfg.org.theme?.accent) document.documentElement.style.setProperty('--accent', cfg.org.theme.accent);
}

let mode = 'login';
const show = (id, on) => $(id).classList.toggle('hidden', !on);
const form = $('form');

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status})`);
  return data;
}

if (invite) {
  mode = 'invite';
  try {
    const inv = await (await fetch(`/api/auth/invite/${invite}`)).json();
    if (inv.error) throw new Error(inv.error);
    $('title').textContent = `Join ${inv.org}`;
    $('lead').textContent = `You've been invited as ${ROLE_TEXT[inv.role] || inv.role}. Create your account, or use an account you already have.`;
    show('f-name', true);
    form.elements.name.required = true;
    form.elements.password.autocomplete = 'new-password';
    $('pw-label').textContent = 'Password (at least 8 characters)';
    $('submit').textContent = 'Join';
    $('foot').textContent = 'Already have an account on this dashboard? Enter its email/username and password; your name is ignored.';
  } catch (e) {
    $('title').textContent = 'Invite link not valid';
    $('lead').textContent = e.message;
    form.classList.add('hidden');
  }
} else if (cfg && !cfg.auth?.enabled) {
  mode = 'owner';
  $('title').textContent = 'Create the admin account';
  $('lead').textContent = 'This becomes the owner account: an admin in every organization. You can then invite your team.';
  show('f-name', true);
  form.elements.name.required = true;
  form.elements.password.autocomplete = 'new-password';
  $('pw-label').textContent = 'Password (at least 8 characters)';
  show('f-pin', Boolean(cfg.pinRequired));
  $('submit').textContent = 'Create account';
} else {
  $('lead').textContent = cfg?.org ? `${cfg.org.name} production dashboard` : '';
  $('foot').textContent = "Forgot your password? Ask an admin to reset it. New here? Ask an admin for an invite link.";
  if (cfg?.auth?.user && !cfg.auth.role) $('err').textContent = `Signed in as ${cfg.auth.user.name}, but this account has no access to ${cfg.org.name}. Ask an admin, or sign in with another account.`;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  $('err').textContent = '';
  const f = form.elements;
  const body = { name: f.name.value, username: f.username.value, password: f.password.value, pin: f.pin.value };
  $('submit').disabled = true;
  try {
    if (mode === 'owner') await post('/api/auth/owner', body);
    else if (mode === 'invite') await post(`/api/auth/invite/${invite}`, body);
    else await post('/api/auth/login', body);
    location.replace(mode === 'login' ? next : '/');
  } catch (err) {
    $('err').textContent = err.message;
    $('submit').disabled = false;
  }
});
