// Comms control: for the producer (admin PIN) or a lead (signed in on comms as a lead).
import { start, esc, setHTML, toast } from './common.js';

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
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.t === 'state') { state = msg.state; if (msg.levels) levels = msg.levels; if ('asLead' in msg) asLead = msg.asLead; render(); }
    else if (msg.t === 'levels') { levels = msg.levels; meters(); }
    else if (msg.t === 'reload') location.reload();
    else if (msg.t === 'error') {
      if (msg.error === 'PIN required') {
        const pin = prompt('Enter the admin PIN to control comms');
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

const info = await (await fetch('/api/comms/info')).json();
const urls = location.protocol === 'https:' ? [`${location.origin}/comms`, ...info.joinUrls.filter((u) => !u.startsWith(location.origin))] : info.joinUrls;
let urlIdx = 0;
function renderJoin() {
  const url = urls[urlIdx] || `https://localhost:${info.httpsPort}/comms`;
  setHTML($('join'), `<img class="cc-qr" src="/api/comms/qr.svg?url=${encodeURIComponent(url)}" alt="QR code to join comms">
    <div><a class="mono cc-url" href="${esc(url)}" target="_blank">${esc(url)}</a>
    ${urls.length > 1 ? `<button class="btn small" id="next-url" type="button">Other network (${urlIdx + 1}/${urls.length})</button>` : ''}
    <p class="muted small">Phones must be on the same Wi-Fi. The first time, the phone warns the connection isn't private: tap <b>Show details → visit this website</b> (iPhone) or <b>Advanced → Proceed</b> (Android).</p></div>`);
  const nb = $('next-url');
  if (nb) nb.onclick = () => { urlIdx = (urlIdx + 1) % urls.length; renderJoin(); };
}
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
  renderCues();
  renderPeople();
  renderAccess();
  if (!chDraft) renderChannels(); // don't overwrite what's being typed
  renderPositions();
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
        <small class="muted">${stText}${m.hasCode ? ' · has code' : ''}</small>
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

$('people').addEventListener('click', (e) => {
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
  if (act === 'rename') { const n = prompt('Name', m.name); if (n?.trim()) send({ t: 'edit', memberId: id, name: n }); }
  if (act === 'code') {
    const c = prompt(`Personal code for ${m.name}.\nThey type it when signing in, so nobody else can sign in as them.\nLeave empty to remove it.`, '');
    if (c != null) send({ t: 'edit', memberId: id, code: c });
  }
  if (act === 'signout' && confirm(`Sign ${m.name} out? They can sign in again with their name.`)) send({ t: 'signout', memberId: id });
  if (act === 'remove' && confirm(`Remove ${m.name} from comms?`)) send({ t: 'remove', memberId: id });
});
$('people').addEventListener('change', (e) => {
  if (e.target.dataset.act !== 'position') return;
  const id = e.target.closest('[data-id]').dataset.id;
  if (confirm('Switch position? Their channels reset to that position\'s defaults.')) send({ t: 'position', memberId: id, position: e.target.value });
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
$('access').addEventListener('click', (e) => {
  if (e.target.id === 'team-set') { const p = prompt('Team password'); if (p?.trim()) send({ t: 'access', teamPassword: p.trim() }); }
  if (e.target.id === 'team-clear' && confirm('Remove the team password?')) send({ t: 'access', teamPassword: '' });
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
$('channels').addEventListener('click', (e) => {
  if (e.target.closest('[data-del]')) {
    chDraft ||= structuredClone(state.channels);
    const i = Number(e.target.closest('[data-i]').dataset.i);
    if (!confirm(`Delete channel "${chDraft[i].name}"? People lose access to it.`)) return;
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
