// Comms on a phone: sign in, then talk and listen on the channels the producer allows.
// Audio goes phone <-> comms engine (a browser tab on the dashboard computer) over WebRTC;
// the server only passes setup messages and keeps track of who is talking.
import { talkingOn } from './comms-routing.js';

const TOKEN = 'wavs-comms-token';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const screens = ['join', 'start', 'main', 'gone'];
const show = (id) => screens.forEach((s) => $(s).classList.toggle('hidden', s !== id));

let ws;
let me = null; // my member record
let state = null;
let engineOnline = false;
let mic = null; // MediaStream
let pc = null;
let started = false;
const talking = new Set(); // channel ids I'm talking on
let latchMode = localStorage.getItem('wavs-comms-latch') || 'auto'; // auto: tap = latch, hold = momentary

// ---------------------------------------------------------------- socket

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/comms-ws`);
  ws.onopen = () => send({ t: 'hello', role: 'member', token: localStorage.getItem(TOKEN) });
  ws.onclose = () => {
    setStatus();
    closePeer();
    setTimeout(connect, 1500);
  };
  ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
}
const send = (msg) => ws?.readyState === 1 && ws.send(JSON.stringify(msg));

function onMessage(msg) {
  switch (msg.t) {
    case 'need-join': return showJoin(msg);
    case 'joined': localStorage.setItem(TOKEN, msg.token); return;
    case 'welcome':
      me = msg.member;
      state = msg.state;
      engineOnline = state.engine.online;
      if (!started) { $('start-name').textContent = me.name; $('start-pos').textContent = positionName(me.position); show('start'); }
      else { resendTalk(); startPeer(); }
      return render();
    case 'state':
      state = msg.state;
      me = state.members.find((m) => m.id === me?.id) || me;
      // Drop talk on channels I'm no longer allowed to talk on.
      for (const c of [...talking]) if (!me.perms?.[c]?.talk || me.muted) talking.delete(c);
      updateMicGate();
      return render();
    case 'engine':
      engineOnline = msg.online;
      if (msg.online && started) startPeer();
      if (!msg.online) closePeer();
      return render();
    case 'signal': return onSignal(msg.data);
    case 'cue': return showCue(msg.cue, msg.channel);
    case 'removed':
      localStorage.removeItem(TOKEN);
      stopAll();
      $('gone-why').textContent = msg.reason || '';
      return show('gone');
    case 'reload': return location.reload();
    case 'error':
      if (!$('join').classList.contains('hidden')) $('join-err').textContent = msg.error;
      else flash(msg.error);
      return;
  }
}

// ---------------------------------------------------------------- sign in

function showJoin(msg) {
  localStorage.removeItem(TOKEN);
  $('join-org').textContent = msg.org ? `${msg.org} comms` : 'Comms';
  document.title = $('join-org').textContent;
  $('f-team').classList.toggle('hidden', !msg.teamPassword);
  $('f-team').querySelector('input').required = msg.teamPassword;
  $('f-pos').classList.toggle('hidden', msg.rosterOnly);
  const sel = $('f-pos').querySelector('select');
  sel.innerHTML = msg.positions.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  sel.value = localStorage.getItem('wavs-comms-pos') || msg.positions[msg.positions.length - 1]?.id;
  const nameInput = $('join-form').elements.name;
  if (!nameInput.value) nameInput.value = localStorage.getItem('wavs-comms-name') || '';
  show('join');
}

$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target.elements;
  $('join-err').textContent = '';
  localStorage.setItem('wavs-comms-name', f.name.value.trim());
  localStorage.setItem('wavs-comms-pos', f.position.value);
  send({ t: 'join', name: f.name.value, teamPassword: f.teamPassword.value, code: f.code.value, position: f.position.value });
});

$('gone-btn').onclick = () => { started = false; ws.close(); };

// ---------------------------------------------------------------- audio

$('start-btn').onclick = async () => {
  $('start-err').textContent = '';
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This page must be opened with https:// to use the microphone.');
    mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    started = true;
    $('out').play().catch(() => {});
    updateMicGate();
    keepAwake();
    show('main');
    startPeer();
    render();
  } catch (e) {
    $('start-err').textContent = e.name === 'NotAllowedError'
      ? 'Microphone blocked. Allow the microphone for this site in your browser settings, then try again.'
      : e.message;
  }
};

function closePeer() {
  if (pc) { pc.onconnectionstatechange = null; pc.close(); pc = null; }
  setStatus();
}

async function startPeer() {
  closePeer();
  if (!started || !engineOnline || !mic) return setStatus();
  pc = new RTCPeerConnection({ iceServers: [] }); // same network: no STUN/TURN needed
  for (const track of mic.getAudioTracks()) pc.addTrack(track, mic);
  pc.ontrack = (ev) => { $('out').srcObject = ev.streams[0] || new MediaStream([ev.track]); $('out').play().catch(() => {}); };
  pc.onicecandidate = (ev) => ev.candidate && send({ t: 'signal', data: { candidate: ev.candidate.toJSON() } });
  pc.onconnectionstatechange = () => {
    setStatus();
    if (pc?.connectionState === 'failed') setTimeout(startPeer, 1000);
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({ t: 'signal', data: { type: 'offer', sdp: pc.localDescription.sdp } });
  setStatus();
}

async function onSignal(data) {
  if (!pc) return;
  try {
    if (data.type === 'answer') await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
    else if (data.candidate) await pc.addIceCandidate(data.candidate);
  } catch (e) { console.warn('[comms] signal', e); }
}

/** The mic only sends while I'm talking on something. */
function updateMicGate() {
  if (mic) for (const t of mic.getAudioTracks()) t.enabled = talking.size > 0 && !me?.muted;
}

function stopAll() {
  started = false;
  closePeer();
  mic?.getTracks().forEach((t) => t.stop());
  mic = null;
  talking.clear();
}

let wakeLock;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && started) keepAwake(); });

// ---------------------------------------------------------------- talk / listen

function setTalk(ch, on) {
  if (on && (!me.perms?.[ch]?.talk || me.muted)) return;
  if (on) talking.add(ch); else talking.delete(ch);
  updateMicGate();
  send({ t: 'talk', channel: ch, on });
  if (on) navigator.vibrate?.(15);
  renderTalk();
}
function resendTalk() { for (const ch of talking) send({ t: 'talk', channel: ch, on: true }); }

// Press and hold = talk while held. Quick tap = latch on / off (unless latching is turned off).
function bindTalk(btn, ch) {
  let downAt = 0;
  let wasOn = false;
  const down = (e) => {
    e.preventDefault();
    btn.setPointerCapture?.(e.pointerId);
    downAt = Date.now();
    wasOn = talking.has(ch);
    if (!wasOn) setTalk(ch, true);
  };
  const up = (e) => {
    e.preventDefault();
    if (!downAt) return;
    const quick = Date.now() - downAt < 300;
    downAt = 0;
    if (wasOn) setTalk(ch, false); // tap again to unlatch
    else if (!(quick && latchMode === 'auto')) setTalk(ch, false); // held = momentary
  };
  btn.addEventListener('pointerdown', down);
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

$('channels').addEventListener('click', (e) => {
  const lb = e.target.closest('[data-listen]');
  if (lb) send({ t: 'listen', channel: lb.dataset.listen, on: !(me.listen?.[lb.dataset.listen] !== false) });
});
$('channels').addEventListener('input', (e) => {
  if (e.target.dataset.vol) send({ t: 'listen', channel: e.target.dataset.vol, volume: Number(e.target.value) / 100 });
});

$('menu-btn').onclick = () => $('menu').classList.toggle('hidden');
$('latch-mode').onclick = () => {
  latchMode = latchMode === 'auto' ? 'hold' : 'auto';
  localStorage.setItem('wavs-comms-latch', latchMode);
  $('menu').classList.add('hidden');
  render();
};
$('sign-out').onclick = () => {
  if (!confirm('Sign out of comms on this phone?')) return;
  localStorage.removeItem(TOKEN);
  location.reload();
};

// ---------------------------------------------------------------- cues

let cueId = null;
function showCue(cue, channel) {
  cueId = cue.id;
  $('cue').className = `cx-cue k-${cue.kind}`;
  $('cue-kind').textContent = { standby: 'STANDBY', go: 'GO', text: channel ? `To ${channel}` : 'Message' }[cue.kind];
  $('cue-text').textContent = cue.text || (channel ? channel : '');
  navigator.vibrate?.(cue.kind === 'go' ? [300, 100, 300] : [150, 80, 150]);
  clearTimeout(showCue.timer);
  if (cue.kind === 'go') showCue.timer = setTimeout(() => $('cue').classList.add('hidden'), 6000);
}
$('cue-ack').onclick = () => { send({ t: 'ack', cueId }); $('cue').classList.add('hidden'); };

// ---------------------------------------------------------------- render

const positionName = (id) => state?.positions.find((p) => p.id === id)?.name || '';

function setStatus() {
  const el = $('status');
  let text = 'Connecting…';
  let cls = '';
  if (ws?.readyState !== 1) text = 'Reconnecting…';
  else if (!engineOnline) { text = 'Comms engine offline'; cls = 'bad'; }
  else if (me?.muted) { text = 'Muted by producer'; cls = 'bad'; }
  else if (pc?.connectionState === 'connected') { text = 'Connected'; cls = 'ok'; }
  else if (pc?.connectionState === 'failed') { text = 'Audio failed, retrying'; cls = 'bad'; }
  el.textContent = text;
  el.className = `cx-status ${cls}`;
}

function render() {
  if (!state || !me) return;
  setStatus();
  $('me-name').textContent = me.name;
  $('me-pos').textContent = ` · ${positionName(me.position)}${me.lead ? ' · Lead' : ''}`;
  $('control-link').classList.toggle('hidden', !me.lead);
  $('latch-mode').textContent = latchMode === 'auto' ? 'Talk: hold, or tap to latch ✓' : 'Talk: hold only ✓';
  $('hint').textContent = latchMode === 'auto' ? 'Hold TALK to talk. Tap it once to stay on; tap again to stop.' : 'Hold TALK to talk.';

  const mine = state.channels.filter((c) => me.perms?.[c.id]?.talk || me.perms?.[c.id]?.listen);
  const key = JSON.stringify([mine, me.perms, me.listen, me.volume, me.muted]);
  if ($('channels')._key !== key) {
    $('channels')._key = key;
    $('channels').innerHTML = mine.length ? mine.map((c) => {
      const p = me.perms[c.id];
      const on = p.listen && me.listen?.[c.id] !== false;
      const vol = Math.round((me.volume?.[c.id] ?? 1) * 100);
      return `<div class="cx-ch" style="--ch:${esc(c.color)}" data-ch="${esc(c.id)}">
        <div class="cx-ch-head"><b>${esc(c.name)}</b><span class="cx-ch-who" data-who="${esc(c.id)}"></span></div>
        <div class="cx-ch-ctl">
          ${p.listen ? `<button class="cx-listen ${on ? 'on' : ''}" data-listen="${esc(c.id)}" aria-pressed="${on}">${on ? '🔊 Listening' : '🔇 Off'}</button>
          <input type="range" min="0" max="100" value="${vol}" data-vol="${esc(c.id)}" aria-label="${esc(c.name)} volume" ${on ? '' : 'disabled'}>` : '<span class="muted small">Talk only</span>'}
        </div>
        ${p.talk ? `<button class="cx-talk" data-talk="${esc(c.id)}" ${me.muted ? 'disabled' : ''}>TALK</button>` : '<div class="cx-talk-none muted small">Listen only</div>'}
      </div>`;
    }).join('') : '<p class="muted cx-none">The producer hasn\'t given you any channels yet.</p>';
    for (const b of $('channels').querySelectorAll('[data-talk]')) bindTalk(b, b.dataset.talk);
  }
  renderTalk();
}

function renderTalk() {
  if (!state) return;
  for (const b of $('channels').querySelectorAll('[data-talk]')) {
    const on = talking.has(b.dataset.talk);
    b.classList.toggle('on', on);
    b.textContent = on ? 'TALKING' : 'TALK';
  }
  const others = state.members.filter((m) => m.id !== me.id && m.online);
  for (const el of $('channels').querySelectorAll('[data-who]')) {
    const who = others.filter((m) => m.talking?.[el.dataset.who]).map((m) => m.name.split(' ')[0]);
    el.textContent = who.length ? `🗣 ${who.join(', ')}` : '';
  }
  const live = others.map((m) => ({ m, chs: talkingOn(m, state.channels) })).filter((x) => x.chs.length);
  $('talkers').innerHTML = live.map(({ m, chs }) => `<span class="cx-talker">${esc(m.name)} <small>${chs.map((c) => esc(c.name)).join(', ')}</small></span>`).join('');
}

function flash(text) {
  const t = document.createElement('div');
  t.className = 'toast err';
  t.textContent = text;
  document.body.append(t);
  setTimeout(() => t.remove(), 3000);
}

connect();
