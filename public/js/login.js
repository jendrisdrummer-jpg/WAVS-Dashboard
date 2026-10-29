// Sign in, accept an invite (/join/<code>), create the owner account on first use, or (on the
// website) sign up with a new organization (/signup).
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const params = new URLSearchParams(location.search);
const next = /^\/(?!\/)/.test(params.get('next') || '') ? params.get('next') : '/';
const invite = location.pathname.match(/^\/join\/([\w-]+)/)?.[1];
const resetToken = location.pathname.match(/^\/reset\/([\w-]+)/)?.[1];
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
} else if (resetToken) {
  // From the email: choose a new password.
  mode = 'reset';
  try {
    const r = await (await fetch(`/api/auth/reset/${resetToken}`)).json();
    if (r.error) throw new Error(r.error);
    $('title').textContent = 'Choose a new password';
    $('lead').textContent = `For ${r.name} (${r.username}).`;
    form.elements.username.value = r.username;
    form.elements.username.closest('label').classList.add('hidden');
    form.elements.password.autocomplete = 'new-password';
    form.elements.password.minLength = 8;
    $('pw-label').textContent = 'New password (at least 8 characters)';
    $('submit').textContent = 'Save and sign in';
  } catch (e) {
    $('title').textContent = 'Reset link not valid';
    $('lead').innerHTML = `${esc(e.message)} <a href="/forgot">Send a new link</a>`;
    form.classList.add('hidden');
  }
} else if (location.pathname === '/forgot') {
  mode = 'forgot';
  $('title').textContent = 'Forgot your password?';
  if (!cfg?.mail) {
    $('lead').textContent = 'Ask an admin of your team to reset it (Settings → Accounts & sign-in). They\'ll give you a temporary password.';
    form.classList.add('hidden');
  } else {
    $('lead').textContent = 'Enter the email you sign in with and we\'ll send you a link to choose a new one.';
    form.elements.password.closest('label').classList.add('hidden');
    form.elements.password.required = false;
    form.elements.username.type = 'email';
    $('submit').textContent = 'Email me a link';
  }
  $('foot').innerHTML = '<a href="/login">Back to sign in</a>';
} else if (cfg?.hosted && location.pathname === '/signup') {
  mode = 'signup';
  if (cfg.signups === 'closed') {
    $('title').textContent = 'Sign-ups are closed for now';
    $('lead').textContent = 'Ask your team\'s admin for an invite link, or check back soon.';
    form.classList.add('hidden');
  } else {
    $('title').textContent = 'Create your account';
    $('lead').textContent = 'You get your own organization: people, schedules, dashboards and comms for your team.';
    for (const id of ['f-name', 'f-org']) show(id, true);
    show('f-code', cfg.signups === 'code');
    form.elements.name.required = true;
    form.elements.orgName.required = true;
    $('f-code').querySelector('span').textContent = 'Beta code (from the invitation you were sent)';
    form.elements.password.autocomplete = 'new-password';
    $('pw-label').textContent = 'Password (at least 8 characters)';
    $('submit').textContent = 'Create account';
    $('foot').innerHTML = 'Already have an account? <a href="/login">Sign in</a>. Joining an existing team? Use the invite link their admin sent you.';
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
  $('lead').textContent = cfg?.hosted && !cfg.auth?.role ? `Sign in to ${cfg.org?.name || 'WAVS Dashboard'}` : cfg?.org ? `${cfg.org.name} production dashboard` : '';
  $('foot').textContent = "Forgot your password? Ask an admin to reset it. New here? Ask an admin for an invite link.";
  if (cfg?.hosted && cfg.signups !== 'closed') $('foot').innerHTML = 'New here? <a href="/signup">Create an account</a>. Joining a team? Use the invite link from its admin.';
  $('forgot').classList.remove('hidden');
  if (cfg?.auth?.user && !cfg.auth.role && !cfg.hosted) $('err').textContent = `Signed in as ${cfg.auth.user.name}, but this account has no access to ${cfg.org.name}. Ask an admin, or sign in with another account.`;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  $('err').textContent = '';
  const f = form.elements;
  const body = { name: f.name.value, username: f.username.value, password: f.password.value, pin: f.pin.value, orgName: f.orgName.value, code: f.code.value };
  $('submit').disabled = true;
  try {
    if (mode === 'owner') await post('/api/auth/owner', body);
    else if (mode === 'signup') { await post('/api/auth/signup', body); location.replace('/welcome'); return; }
    else if (mode === 'forgot') {
      await post('/api/auth/forgot', { username: body.username });
      $('title').textContent = 'Check your email';
      $('lead').textContent = `If ${body.username} has an account, a link to choose a new password is on its way. It works for an hour. Nothing there? Check spam, or ask an admin.`;
      form.classList.add('hidden');
      return;
    } else if (mode === 'reset') { await post(`/api/auth/reset/${resetToken}`, { password: body.password }); location.replace('/'); return; }
    else if (mode === 'invite') await post(`/api/auth/invite/${invite}`, body);
    else await post('/api/auth/login', body);
    location.replace(mode === 'login' ? next : '/');
  } catch (err) {
    $('err').textContent = err.message;
    $('submit').disabled = false;
  }
});
