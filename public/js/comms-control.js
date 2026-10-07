// Comms control: for the producer (admin PIN) or a lead (signed in on comms as a lead).
import { start, store, esc, setHTML, toast, api, confirmBox, askText } from './common.js';

await start({ page: 'comms' });

const $ = (id) => document.getElementById(id);
let ws;
let state = null;
let asLead = false; // leads can run comms but not change sign-in rules or choose leads
let levels = {};

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/comms-ws`);
  ws.onopen = () => hello();
  ws.onclose = () => setTimeout(connect, 1500);
  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.t === 'state') { state = msg.state; if (msg.levels) levels = msg.levels; if ('asLead' in msg) asLead = msg.asLead; render(); }
    else if (msg.t === 'levels') { levels = msg.levels; meters(); }
    else if (msg.t === 'reload') location.reload();
    else if (msg.t === 'error') {
      if (msg.error === 'PIN required' && store.config.auth?.enabled) {
        $('sub').innerHTML = 'Comms control needs a producer or admin account. <a href="/login?next=/comms/control">Sign in</a>';
        return;
      }
      if (msg.error === 'PIN required') {
        const pin = await askText('Enter the admin PIN to control comms');
        if (pin == null) { $('sub').textContent = 'The admin PIN is needed to control comms.'; return; }
        localStorage.setItem('wavs-pin', pin);
        return hello(true);
      }
      toast(msg.error, true);
    }
  };
}
function hello(pinOnly = false) {
  const token = !pinOnly && localStorage.getItem('wavs-comms-token');
  send({ t: 'hello', role: 'control', token: token || undefined, pin: localStorage.getItem('wavs-pin') || undefined });
}
const send = (msg) => ws?.readyState === 1 && ws.send(JSON.stringify(msg));

// ---------------------------------------------------------------- join QR

let info = await (await fetch('/api/comms/info')).json();
let tab = null; // 'anywhere' | 'wifi'
let lanIdx = 0;
async function refreshInfo() {
  try { info = await (await fetch('/api/comms/info')).json(); } catch { return; }
  renderJoin();
}
setInterval(refreshInfo, 3000);

function renderJoin() {
  const rm = info.remote || {};
  const anywhere = rm.status === 'on' && rm.url;
  if (!tab || (tab === 'anywhere' && !anywhere)) tab = anywhere ? 'anywhere' : 'wifi';
  const lan = info.lan || [];
  const here = location.protocol === 'https:' && !/localhost|127\.0\.0\.1/.test(location.hostname) ? `${location.origin}/comms` : null;
  const lanUrl = here || lan[lanIdx]?.url || `https://localhost:${info.httpsPort}/comms`;
  const url = tab === 'anywhere' ? rm.url : lanUrl;
  const open = state && !state.access.rosterOnly && !state.access.hasTeamPassword;
  const statusText = {
    off: 'Off. Phones must be on the same Wi-Fi as this computer.',
    installing: 'Downloading the Cloudflare connector (first time only)…',
    starting: 'Starting…',
    on: 'On. Phones can join from any network: Wi-Fi, hotspot or cellular.',
    error: `Not working: ${esc(rm.error || 'unknown error')}. Retrying…`,
  }[rm.status] || '';
  setHTML($('join'), `
    <div class="cc-tabs" role="tablist">
      <button role="tab" class="${tab === 'anywhere' ? 'on' : ''}" data-tab="anywhere" ${anywhere ? '' : 'disabled'}>Anywhere${anywhere ? '' : ' (off)'}</button>
      <button role="tab" class="${tab === 'wifi' ? 'on' : ''}" data-tab="wifi">Same Wi-Fi</button>
    </div>
    <div class="cc-joinrow">
      <img class="cc-qr" src="/api/comms/qr.svg?url=${encodeURIComponent(url)}" alt="QR code to join comms">
      <div>
        <a class="mono cc-url" href="${esc(url)}" target="_blank">${esc(url)}</a>
        ${tab === 'wifi' && !here && lan.length > 1 ? `<label class="f small"><span>This computer's address</span><select id="lan-pick">${lan.map((l, i) => `<option value="${i}" ${i === lanIdx ? 'selected' : ''}>${esc(l.label)}${l.likely ? ' ✓' : ''}</option>`).join('')}</select></label>` : ''}
        <p class="muted small">${tab === 'anywhere'
          ? 'Works on any network, no warnings. Audio may lag slightly more on cellular.'
          : 'Phone must be on the same Wi-Fi. The first time, it warns the connection isn\'t private: tap <b>Show Details → visit this website</b> (iPhone) or <b>Advanced → Proceed</b> (Android).'}</p>
      </div>
    </div>
    <div class="cc-offsite">
      <div><b>Off-site access</b> <span class="chip ${rm.status === 'on' ? 'good' : rm.status === 'error' ? 'bad' : ''}">${rm.enabled ? (rm.status === 'on' ? 'On' : rm.status === 'error' ? 'Problem' : 'Starting') : 'Off'}</span>
        <button class="btn small ${rm.enabled ? '' : 'primary'}" id="offsite-toggle" type="button">${rm.enabled ? 'Turn off' : 'Turn on'}</button></div>
      <small class="muted">${statusText}</small>
      ${rm.enabled && open ? '<small class="warn-text">⚠ Anyone with the link can join. Set a team password or turn on "Only people on the list" under Sign-in rules.</small>' : ''}
    </div>
    <details class="cc-help"><summary>Phone can't open it?</summary><ol class="small">
      <li>Easiest fix: turn on <b>Off-site access</b> and use the <b>Anywhere</b> code. It works even when the Wi-Fi blocks devices from reaching each other.</li>
      <li>Same Wi-Fi: make sure the phone isn't on a <b>guest</b> network or cellular. Guest Wi-Fi usually blocks devices from reaching each other.</li>
      <li>Try the other addresses in the list above (the one marked ✓ is the most likely).</li>
      <li>On this Mac: System Settings → Network → <b>Firewall</b> → Options → allow <b>node</b> to accept incoming connections.</li>
      <li>Test: on the phone, open <span class="mono">${esc(info.httpUrl || 'http://<this computer>:8080')}</span>. If that doesn't load either, the network or firewall is blocking it.</li>
    </ol></details>`);
}
$('join').addEventListener('click', async (e) => {
  const t = e.target.closest('[data-tab]');
  if (t && !t.disabled) { tab = t.dataset.tab; renderJoin(); }
  if (e.target.id === 'offsite-toggle') {
    const on = !info.remote?.enabled;
    if (on && !await confirmBox('Turn on off-site access?\n\nPhones on any network (mobile data, a hotspot) can then join comms through a secure Cloudflare link. Your team can also open the dashboard through it after signing in with their account.')) return;
    try { await api('POST', '/api/comms/remote', { on }); } catch (err) { return toast(err.message, true); }
    if (on) tab = 'anywhere';
    refreshInfo();
  }
});
$('join').addEventListener('change', (e) => { if (e.target.id === 'lan-pick') { lanIdx = Number(e.target.value); renderJoin(); } });
renderJoin();

// ---------------------------------------------------------------- render

const chName = (id) => state.channels.find((c) => c.id === id)?.name || id;
const posName = (id) => state.positions.find((p) => p.id === id)?.name || '—';

function render() {
  if (!state) return;
  document.body.classList.toggle('as-lead', asLead);
  const online = state.members.filter((m) => m.online);
  $('count').textContent = `${online.length} on comms · ${state.members.length} on the list`;
  setHTML($('engine'), state.engine.online
    ? '<div class="eng-status g-ok"><span class="dev-dot"></span><b>Running</b></div><p class="muted small">Audio is mixing on the dashboard computer. Keep that tab open.</p>'
    : `<div class="eng-status g-bad"><span class="dev-dot"></span><b>Not running</b></div>
       <p class="muted small">Nobody can hear anyone until the engine runs. Open it <b>on the dashboard computer</b> and click Start.</p>
       <a class="btn primary" href="/comms/engine" target="_blank">Open comms engine</a>`);
  renderJoin();
  renderCues();
  renderPeople();
  renderAccess();
  if (!chDraft) renderChannels(); // don't overwrite what's being typed
  renderPositions();
  if (!audioDraft) renderAudio(); // don't overwrite what's being changed
  const sel = $('add-form').elements.position;
  const opts = state.positions.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  if (sel._opts !== opts) { const v = sel.value; sel.innerHTML = opts; sel._opts = opts; if (v) sel.value = v; }
}

function renderCues() {
  const targets = [['all', 'Everyone'], ...state.channels.map((c) => [`ch:${c.id}`, `Channel: ${c.name}`]),
    ...state.members.filter((m) => m.online).map((m) => [`m:${m.id}`, `Person: ${m.name}`])];
  const cur = $('cue-target')?.value || 'all';
  const recent = state.cues.map((c) => {
    const to = c.target.all ? 'Everyone' : c.target.channel ? chName(c.target.channel) : state.members.find((m) => m.id === c.target.member)?.name || '?';
    const acks = c.acks.map((id) => state.members.find((m) => m.id === id)?.name.split(' ')[0]).filter(Boolean);
    return `<div class="cue-row k-${c.kind}"><b>${c.kind.toUpperCase()}</b> ${esc(c.text)} <small class="muted">→ ${esc(to)}</small>
      <small class="${acks.length ? 'ok' : 'muted'}">${acks.length ? `✓ ${esc(acks.join(', '))}` : 'no replies yet'}</small></div>`;
  }).join('');
  const html = `<div class="cue-form">
      <select id="cue-target" aria-label="Send to">${targets.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <input id="cue-text" type="text" maxlength="120" placeholder="Message (optional)">
      <div class="row-btns"><button class="btn cue-sb" data-cue="standby">Standby</button><button class="btn cue-go" data-cue="go">GO</button><button class="btn" data-cue="text">Send</button></div>
    </div><div class="cue-list">${recent}</div>`;
  // Keep what's being typed while state updates arrive.
  const text = $('cue-text')?.value;
  const focused = document.activeElement?.id;
  if (setHTML($('cues'), html)) {
    if (text) $('cue-text').value = text;
    if (focused === 'cue-text' || focused === 'cue-target') $(focused).focus();
  }
}
$('cues').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cue]');
  if (!b) return;
  const tv = $('cue-target').value;
  const target = tv === 'all' ? { all: true } : tv.startsWith('ch:') ? { channel: tv.slice(3) } : { member: tv.slice(2) };
  const text = $('cue-text').value.trim();
  if (b.dataset.cue === 'text' && !text) return toast('Type a message first', true);
  send({ t: 'cue', kind: b.dataset.cue, text, target });
  $('cue-text').value = '';
});

function renderPeople() {
  const chs = state.channels;
  const rows = [...state.members].sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name)).map((m) => {
    const st = m.online ? 'on' : m.signedIn ? 'away' : 'new';
    const stText = { on: 'On comms', away: 'Signed in, not connected', new: 'Not signed in yet' }[st];
    const talkingNow = Object.keys(m.talking || {}).filter((c) => m.talking[c]);
    return `<tr data-id="${esc(m.id)}" class="${talkingNow.length ? 'talking' : ''}">
      <td><span class="cc-dot ${st}" title="${stText}"></span></td>
      <td class="cc-name"><b>${esc(m.name)}</b>${m.lead ? ' <span class="chip on">Lead</span>' : ''}${m.muted ? ' <span class="chip bad">Muted</span>' : ''}
        <small class="muted">${stText}${m.offsite ? ' · off-site' : ''}${m.relay ? ' · audio via internet' : ''}${m.hasCode ? ' · has code' : ''}</small>
        <span class="lvl"><i data-lvl="m:${esc(m.id)}"></i></span></td>
      <td><select data-act="position" aria-label="Position">${state.positions.map((p) => `<option value="${esc(p.id)}" ${p.id === m.position ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></td>
      ${chs.map((c) => {
        const p = m.perms?.[c.id] || {};
        return `<td class="cc-perm"><button class="cperm t ${p.talk ? 'on' : ''} ${m.talking?.[c.id] ? 'live' : ''}" data-perm="talk" data-ch="${esc(c.id)}" title="${esc(c.name)}: talk">T</button><button class="cperm l ${p.listen ? 'on' : ''}" data-perm="listen" data-ch="${esc(c.id)}" title="${esc(c.name)}: listen">L</button></td>`;
      }).join('')}
      <td class="cc-acts">
        <button class="btn small ${m.muted ? 'danger' : ''}" data-act="mute">${m.muted ? 'Unmute' : 'Mute'}</button>
        <details class="cc-more"><summary class="btn small">More</summary><div class="cc-more-menu">
          ${asLead ? '' : `<button data-act="lead">${m.lead ? 'Remove lead' : 'Make lead'}</button>`}
          <button data-act="rename">Rename</button>
          <button data-act="code">${m.hasCode ? 'Change / remove personal code' : 'Set personal code'}</button>
          ${m.signedIn ? '<button data-act="signout">Sign out their phone</button>' : ''}
          <button data-act="remove" class="danger">Remove from list</button>
        </div></details>
      </td></tr>`;
  }).join('');
  const head = `<tr><th></th><th>Person</th><th>Position</th>${chs.map((c) => `<th class="cc-chh" style="--ch:${esc(c.color)}">${esc(c.name)}</th>`).join('')}<th></th></tr>`;
  // Don't rebuild while a "More" menu is open (it would close under the pointer).
  if (document.querySelector('.cc-more[open]')) return;
  setHTML($('people'), `<thead>${head}</thead><tbody>${rows || `<tr><td colspan="${chs.length + 4}" class="muted">Nobody yet. Add people above, or they appear here when they join.</td></tr>`}</tbody>`);
  meters();
}

$('people').addEventListener('click', async (e) => {
  const row = e.target.closest('[data-id]');
  if (!row) return;
  const id = row.dataset.id;
  const m = state.members.find((x) => x.id === id);
  const perm = e.target.closest('[data-perm]');
  if (perm) {
    const cur = m.perms?.[perm.dataset.ch] || {};
    return send({ t: 'perm', memberId: id, channel: perm.dataset.ch, [perm.dataset.perm]: !cur[perm.dataset.perm] });
  }
  const act = e.target.closest('button[data-act]')?.dataset.act;
  if (!act) return;
  e.target.closest('details')?.removeAttribute('open');
  if (act === 'mute') send({ t: 'mute', memberId: id, on: !m.muted });
  if (act === 'lead') send({ t: 'lead', memberId: id, on: !m.lead });
  if (act === 'rename') { const n = await askText('Name', m.name); if (n?.trim()) send({ t: 'edit', memberId: id, name: n }); }
  if (act === 'code') {
    const c = await askText(`Personal code for ${m.name}.\nThey type it when signing in, so nobody else can sign in as them.\nLeave empty to remove it.`, '');
    if (c != null) send({ t: 'edit', memberId: id, code: c });
  }
  if (act === 'signout' && await confirmBox(`Sign ${m.name} out? They can sign in again with their name.`)) send({ t: 'signout', memberId: id });
  if (act === 'remove' && await confirmBox(`Remove ${m.name} from comms?`)) send({ t: 'remove', memberId: id });
});
$('people').addEventListener('change', async (e) => {
  if (e.target.dataset.act !== 'position') return;
  const id = e.target.closest('[data-id]').dataset.id;
  if (await confirmBox('Switch position? Their channels reset to that position\'s defaults.')) send({ t: 'position', memberId: id, position: e.target.value });
  else render();
});

$('add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target.elements;
  send({ t: 'add', name: f.name.value, position: f.position.value, code: f.code.value, lead: f.lead.checked });
  f.name.value = '';
  f.code.value = '';
  f.lead.checked = false;
  f.name.focus();
});

function meters() {
  for (const el of document.querySelectorAll('[data-lvl]')) el.style.width = `${(levels[el.dataset.lvl] || 0) * 100}%`;
}

function renderAccess() {
  if (asLead) return;
  setHTML($('access'), `
    <label class="cb"><input type="checkbox" id="roster-only" ${state.access.rosterOnly ? 'checked' : ''}> Only people on the list can sign in</label>
    <small class="muted">Off: anyone with the link can join and pick a position. On: they must type a name you added.</small>
    <div><b>Team password</b> <span class="chip ${state.access.hasTeamPassword ? 'good' : ''}">${state.access.hasTeamPassword ? 'Set' : 'None'}</span></div>
    <small class="muted">One password everyone types when signing in (e.g. shared in the call sheet).</small>
    <div class="row-btns"><button class="btn small" id="team-set">${state.access.hasTeamPassword ? 'Change' : 'Set'} team password</button>
    ${state.access.hasTeamPassword ? '<button class="btn small danger" id="team-clear">Remove</button>' : ''}</div>`);
}
$('access').addEventListener('change', (e) => { if (e.target.id === 'roster-only') send({ t: 'access', rosterOnly: e.target.checked }); });
$('access').addEventListener('click', async (e) => {
  if (e.target.id === 'team-set') { const p = await askText('Team password'); if (p?.trim()) send({ t: 'access', teamPassword: p.trim() }); }
  if (e.target.id === 'team-clear' && await confirmBox('Remove the team password?')) send({ t: 'access', teamPassword: '' });
});

// Channels editor (local draft until Save)
let chDraft = null;
function renderChannels() {
  const list = chDraft || state.channels;
  setHTML($('channels'), `<div class="cch-list">${list.map((c, i) => `<div class="cch-row" data-i="${i}">
      <input type="color" value="${esc(c.color)}" data-k="color" aria-label="Colour"><input type="text" value="${esc(c.name)}" data-k="name" maxlength="30" aria-label="Channel name">
      <button class="btn small danger" data-del aria-label="Delete channel">✕</button></div>`).join('')}</div>
    <div class="row-btns" id="ch-btns">${chButtons()}</div>`);
}
const chButtons = () => `<button class="btn small" id="ch-add">+ Channel</button>${chDraft ? '<button class="btn small primary" id="ch-save">Save channels</button><button class="btn small" id="ch-cancel">Cancel</button>' : ''}`;
$('channels').addEventListener('input', (e) => {
  const row = e.target.closest('[data-i]');
  if (!row) return;
  chDraft ||= structuredClone(state.channels);
  chDraft[row.dataset.i][e.target.dataset.k] = e.target.value;
  $('ch-btns').innerHTML = chButtons();
});
$('channels').addEventListener('click', async (e) => {
  if (e.target.closest('[data-del]')) {
    chDraft ||= structuredClone(state.channels);
    const i = Number(e.target.closest('[data-i]').dataset.i);
    if (!await confirmBox(`Delete channel "${chDraft[i].name}"? People lose access to it.`)) return;
    chDraft.splice(i, 1);
    renderChannels();
  }
  if (e.target.id === 'ch-add') {
    chDraft ||= structuredClone(state.channels);
    chDraft.push({ name: 'New channel', color: '#64748b' });
    renderChannels();
  }
  if (e.target.id === 'ch-cancel') { chDraft = null; $('channels')._html = null; renderChannels(); }
  if (e.target.id === 'ch-save') { send({ t: 'channels', channels: chDraft }); chDraft = null; $('channels')._html = null; }
});

// ---------------------------------------------------------------- audio in / out
// Sound board <-> comms through an audio interface on the dashboard computer (where the comms
// engine runs). An "in" brings one interface input (e.g. the board's talkback or program feed)
// into comms channels; an "out" sends a mix of comms channels to one interface output
// (e.g. into a board channel for IEMs or recording). The engine lists the interfaces it sees.
let audioDraft = null;
function renderAudio() {
  const list = audioDraft || state.ports || [];
  const devs = state.engine.devices;
  const errs = state.engine.portErrors || {};
  const saved = new Set((state.ports || []).map((p) => p.id));
  const row = (p, i) => {
    const options = devs ? devs[p.kind] : [];
    const known = options.some((d) => d.label === p.device);
    const status = !state.engine.online ? '<small class="muted">Engine not running</small>'
      : !saved.has(p.id) || audioDraft ? '<small class="muted">Not saved yet</small>'
        : errs[p.id] ? `<small class="port-err">⚠ ${esc(errs[p.id])}</small>` : '<small class="g-ok-text">✓ Working</small>';
    return `<div class="aio-row" data-i="${i}">
      <b class="port-kind ${p.kind}">${p.kind === 'in' ? 'IN' : 'OUT'}</b>
      <label>Name <input type="text" data-k="name" value="${esc(p.name)}" maxlength="60" placeholder="${p.kind === 'in' ? 'e.g. Board talkback' : 'e.g. Comms to board'}"></label>
      <label>Audio interface <select data-k="device">
        <option value="">${devs ? (options.length ? 'Choose…' : 'No interfaces found') : 'Start the engine to list interfaces'}</option>
        ${p.device && !known ? `<option selected>${esc(p.device)}</option>` : ''}
        ${options.map((d) => `<option ${d.label === p.device ? 'selected' : ''}>${esc(d.label)}</option>`).join('')}</select></label>
      <label>${p.kind === 'in' ? 'Input' : 'Output'} # <input type="number" data-k="deviceChannel" min="1" max="64" value="${p.deviceChannel || 1}"></label>
      <div class="aio-chans"><span class="muted small">${p.kind === 'in' ? 'Goes into' : 'Sends'}:</span>
        ${state.channels.map((c) => `<label class="chip"><input type="checkbox" data-ch="${esc(c.id)}" ${(p.channels || []).includes(c.id) ? 'checked' : ''}> ${esc(c.name)}</label>`).join('')}</div>
      <div class="aio-end">${status}<button class="btn small danger" data-del aria-label="Remove">✕</button></div>
    </div>`;
  };
  setHTML($('audio'), `<p class="muted small">Plug an audio interface into the <b>dashboard computer</b> (where the comms engine runs) and wire it to your sound board.
      <b>Audio in</b> brings a board output (talkback mic, program mix, a pastor's mic for the camera ops) into comms channels.
      <b>Audio out</b> sends comms channels to a board input (to record comms, or put it in someone's in-ears). Each one uses one channel of the interface.</p>
    ${list.length ? list.map(row).join('') : '<p class="muted">No audio in or out yet.</p>'}
    <div class="row-btns" id="aio-btns">${audioButtons()}</div>`);
}
const audioButtons = () => `<button class="btn small" data-add="in">+ Audio in (from the board)</button>
  <button class="btn small" data-add="out">+ Audio out (to the board)</button>
  ${audioDraft ? '<button class="btn small primary" data-save>Save</button><button class="btn small" data-cancel>Cancel</button>' : ''}`;
$('audio').addEventListener('input', (e) => {
  const r = e.target.closest('[data-i]');
  if (!r) return;
  audioDraft ||= structuredClone(state.ports || []);
  const p = audioDraft[r.dataset.i];
  if (e.target.dataset.k) p[e.target.dataset.k] = e.target.dataset.k === 'deviceChannel' ? Number(e.target.value) : e.target.value;
  if (e.target.dataset.ch) p.channels = [...r.querySelectorAll('[data-ch]:checked')].map((x) => x.dataset.ch);
  if (!$('audio').querySelector('[data-save]')) $('aio-btns').innerHTML = audioButtons(); // keep the cursor where it is
});
$('audio').addEventListener('click', (e) => {
  const add = e.target.closest('[data-add]');
  if (add) {
    audioDraft ||= structuredClone(state.ports || []);
    const kind = add.dataset.add;
    const n = audioDraft.filter((p) => p.kind === kind).length + 1;
    audioDraft.push({ id: `${kind}-${Date.now().toString(36)}`, name: kind === 'in' ? `Board in ${n}` : `Comms out ${n}`, kind, device: '', deviceChannel: n, channels: [] });
    renderAudio();
  }
  if (e.target.closest('[data-del]')) {
    audioDraft ||= structuredClone(state.ports || []);
    audioDraft.splice(Number(e.target.closest('[data-i]').dataset.i), 1);
    renderAudio();
  }
  if (e.target.closest('[data-cancel]')) { audioDraft = null; renderAudio(); }
  if (e.target.closest('[data-save]')) {
    if (audioDraft.some((p) => !p.device)) { toast('Pick an audio interface for each one (start the comms engine to list them)', true); return; }
    send({ t: 'ports', ports: audioDraft });
    audioDraft = null;
    toast('Saved. The comms engine opens them now.');
  }
});

function renderPositions() {
  const chs = state.channels;
  setHTML($('positions'), `<p class="muted small">What a person gets when they join as (or are switched to) each position.</p>
    <div class="cc-table-wrap"><table class="cc-table small"><thead><tr><th>Position</th>${chs.map((c) => `<th class="cc-chh" style="--ch:${esc(c.color)}">${esc(c.name)}</th>`).join('')}</tr></thead>
    <tbody>${state.positions.map((p) => `<tr data-pos="${esc(p.id)}"><td>${esc(p.name)}</td>${chs.map((c) => {
      const v = p.perms?.[c.id] || {};
      const val = v.talk ? 'tl' : v.listen ? 'l' : '';
      return `<td><select data-pch="${esc(c.id)}" aria-label="${esc(p.name)} ${esc(c.name)}"><option value="" ${val === '' ? 'selected' : ''}>—</option><option value="l" ${val === 'l' ? 'selected' : ''}>Listen</option><option value="tl" ${val === 'tl' ? 'selected' : ''}>Talk + listen</option></select></td>`;
    }).join('')}</tr>`).join('')}</tbody></table></div>`);
}
$('positions').addEventListener('change', (e) => {
  const ch = e.target.dataset.pch;
  if (!ch) return;
  send({ t: 'position-perm', position: e.target.closest('[data-pos]').dataset.pos, channel: ch, talk: e.target.value === 'tl', listen: e.target.value !== '' });
});

connect();
