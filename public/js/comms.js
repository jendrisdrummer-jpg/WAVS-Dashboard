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
let actx = null; // AudioContext for the relay
let relay = null; // { cap, player } when audio goes through the dashboard instead of directly
let mode = new URLSearchParams(location.search).has('relay') ? 'relay' : 'direct';
let fallbackTimer;
// Public STUN lets a phone on another network find a direct path; if none works we use the relay.
const ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
let started = false;
const talking = new Set(); // channel ids I'm talking on
let latchMode = localStorage.getItem('wavs-comms-latch') || 'auto'; // auto: tap = latch, hold = momentary
// Channels picked to talk on (like Unity's talk keys): the one big TALK button talks to all of them.
const ARMED = 'wavs-comms-armed';
let armed = null; // Set, loaded once we know my channels
const ptting = () => talking.size > 0;

// ---------------------------------------------------------------- socket

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/comms-ws`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => send({ t: 'hello', role: 'member', token: localStorage.getItem(TOKEN) });
  ws.onclose = () => {
    setStatus();
    closePeer();
    setTimeout(connect, 1500);
  };
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) { relay?.player.port.postMessage(ev.data, [ev.data]); return; }
    onMessage(JSON.parse(ev.data));
  };
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
      else { resendTalk(); startAudio(); }
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
      if (msg.online && started) startAudio();
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
    // Created on the tap so the browser allows sound; used if audio has to go through the dashboard.
    actx = new AudioContext();
    await actx.resume();
    await actx.audioWorklet.addModule('/js/comms-worklet.js');
    started = true;
    $('out').play().catch(() => {});
    updateMicGate();
    keepAwake();
    show('main');
    startAudio();
    render();
  } catch (e) {
    $('start-err').textContent = e.name === 'NotAllowedError'
      ? 'Microphone blocked. Allow the microphone for this site in your browser settings, then try again.'
      : e.message;
  }
};

function closePeer() {
  clearTimeout(fallbackTimer);
  if (pc) { pc.onconnectionstatechange = null; pc.close(); pc = null; }
  if (relay) { relay.cap.disconnect(); relay.player.disconnect(); relay.src.disconnect(); relay = null; }
  setStatus();
}

function startAudio() { return mode === 'relay' ? startRelay() : startPeer(); }

/** Audio through the dashboard over the comms connection: works on any network, a little more delay. */
function startRelay() {
  closePeer();
  mode = 'relay';
  if (!started || !engineOnline || !mic) return setStatus();
  const src = actx.createMediaStreamSource(mic);
  const cap = new AudioWorkletNode(actx, 'wavs-capture', { processorOptions: { gated: true } });
  cap.port.onmessage = (e) => { if (ws?.readyState === 1 && ws.bufferedAmount < 64000) ws.send(e.data); };
  const mute = actx.createGain();
  mute.gain.value = 0;
  src.connect(cap).connect(mute).connect(actx.destination); // keeps the capture running
  const player = new AudioWorkletNode(actx, 'wavs-player');
  player.connect(actx.destination);
  relay = { src, cap, player };
  updateMicGate();
  send({ t: 'relay' });
  setStatus();
}

async function startPeer() {
  closePeer();
  if (!started || !engineOnline || !mic) return setStatus();
  pc = new RTCPeerConnection({ iceServers: ICE });
  // No direct audio path within a few seconds (hotspot, cellular, isolated guest Wi-Fi)? Use the relay.
  fallbackTimer = setTimeout(() => { if (pc && pc.connectionState !== 'connected') startRelay(); }, 7000);
  for (const track of mic.getAudioTracks()) pc.addTrack(track, mic);
  pc.ontrack = (ev) => { $('out').srcObject = ev.streams[0] || new MediaStream([ev.track]); $('out').play().catch(() => {}); };
  pc.onicecandidate = (ev) => ev.candidate && send({ t: 'signal', data: { candidate: ev.candidate.toJSON() } });
  pc.onconnectionstatechange = () => {
    setStatus();
    if (pc?.connectionState === 'failed') startRelay();
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
  const on = talking.size > 0 && !me?.muted;
  if (mic) for (const t of mic.getAudioTracks()) t.enabled = on;
  relay?.cap.port.postMessage({ on });
}

function stopAll() {
  started = false;
  closePeer();
  mic?.getTracks().forEach((t) => t.stop());
  actx?.close();
  actx = null;
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

// The channels I may talk on, and which of them are picked.
const talkable = () => (state?.channels || []).filter((c) => me?.perms?.[c.id]?.talk).map((c) => c.id);
function loadArmed() {
  const can = talkable();
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(ARMED) || 'null'); } catch { /* ignore */ }
  armed = new Set((Array.isArray(saved) ? saved : can.slice(0, 1)).filter((id) => can.includes(id)));
}
function saveArmed() { try { localStorage.setItem(ARMED, JSON.stringify([...armed])); } catch { /* ignore */ } }

/** Talk (or stop) on every picked channel. */
function setPtt(on) {
  if (on) for (const ch of armed) setTalk(ch, true);
  else for (const ch of [...talking]) setTalk(ch, false);
  renderTalk();
}

// The big TALK button: press and hold = talk while held; a quick tap latches on / off
// (unless latching is turned off in ⋯).
(function bindPtt() {
  const btn = $('ptt');
  let downAt = 0;
  let wasOn = false;
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    btn.setPointerCapture?.(e.pointerId);
    downAt = Date.now();
    wasOn = ptting();
    if (!wasOn) setPtt(true);
  });
  const up = (e) => {
    e.preventDefault();
    if (!downAt) return;
    const quick = Date.now() - downAt < 300;
    downAt = 0;
    if (wasOn) setPtt(false); // tap again to unlatch
    else if (!(quick && latchMode === 'auto')) setPtt(false); // held = momentary
  };
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
})();

// Keys: tap a key to pick / unpick it for talking; the 🔊 corner turns listening on / off.
$('channels').addEventListener('click', (e) => {
  const lb = e.target.closest('[data-listen]');
  if (lb) { send({ t: 'listen', channel: lb.dataset.listen, on: !(me.listen?.[lb.dataset.listen] !== false) }); return; }
  const key = e.target.closest('[data-key]');
  if (!key || !me.perms?.[key.dataset.key]?.talk) return;
  const ch = key.dataset.key;
  if (armed.has(ch)) { armed.delete(ch); if (talking.has(ch)) setTalk(ch, false); } else { armed.add(ch); if (ptting()) setTalk(ch, true); }
  saveArmed();
  navigator.vibrate?.(8);
  render(true);
});

// Mix: volume per channel I listen to.
$('mix-btn').onclick = () => {
  const open = $('mix').classList.toggle('hidden') === false;
  $('mix-btn').setAttribute('aria-expanded', String(open));
  if (open) render(true);
};
$('mix').addEventListener('input', (e) => {
  if (e.target.dataset.vol) send({ t: 'listen', channel: e.target.dataset.vol, volume: Number(e.target.value) / 100 });
});
$('mix').addEventListener('click', (e) => {
  if (e.target.closest('[data-mix-close]')) { $('mix').classList.add('hidden'); $('mix-btn').setAttribute('aria-expanded', 'false'); }
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
  else if (relay) { text = 'Connected · via internet'; cls = 'ok'; }
  else if (pc?.connectionState === 'connected') { text = 'Connected'; cls = 'ok'; }
  else if (pc) { text = 'Connecting audio…'; }
  el.textContent = text;
  el.className = `cx-status ${cls}`;
}

function render(force = false) {
  if (!state || !me) return;
  setStatus();
  $('me-name').textContent = me.name;
  $('me-pos').textContent = ` · ${positionName(me.position)}${me.lead ? ' · Lead' : ''}`;
  $('control-link').classList.toggle('hidden', !me.lead);
  $('latch-mode').textContent = latchMode === 'auto' ? 'Talk: hold, or tap to latch ✓' : 'Talk: hold only ✓';
  if (!armed) loadArmed();
  for (const ch of [...armed]) if (!me.perms?.[ch]?.talk) armed.delete(ch); // the producer took it away

  const mine = state.channels.filter((c) => me.perms?.[c.id]?.talk || me.perms?.[c.id]?.listen);
  const key = JSON.stringify([mine, me.perms, me.listen, me.muted, [...armed]]);
  if ($('channels')._key !== key || force) {
    $('channels')._key = key;
    $('channels').innerHTML = mine.length ? mine.map((c) => {
      const p = me.perms[c.id];
      const on = p.listen && me.listen?.[c.id] !== false;
      const picked = armed.has(c.id);
      return `<div class="cx-key ${picked ? 'armed' : ''} ${p.talk ? '' : 'listen-only'}" style="--ch:${esc(c.color)}" data-key="${esc(c.id)}"
          role="button" tabindex="0" aria-pressed="${picked}" aria-label="${esc(c.name)}${p.talk ? (picked ? ', picked for talk' : ', tap to talk on it') : ', listen only'}">
        ${p.listen ? `<button class="cx-key-listen ${on ? 'on' : ''}" data-listen="${esc(c.id)}" aria-pressed="${on}" aria-label="${on ? 'Listening' : 'Not listening'}: ${esc(c.name)}">${on ? '🔊' : '🔇'}</button>` : '<span class="cx-key-listen none" title="Talk only">🔇</span>'}
        <b class="cx-key-name">${esc(c.name)}</b>
        <span class="cx-key-who" data-who="${esc(c.id)}"></span>
        <span class="cx-key-state">${!p.talk ? 'Listen only' : picked ? 'TALK ✓' : 'Tap to talk'}</span>
      </div>`;
    }).join('') : '<p class="muted cx-none">The producer hasn\'t given you any channels yet.</p>';
  }
  const listening = mine.filter((c) => me.perms[c.id].listen);
  const mixKey = JSON.stringify([listening.map((c) => c.id), me.listen, me.volume]);
  if (!$('mix').classList.contains('hidden') && ($('mix')._key !== mixKey || force)) {
    $('mix')._key = mixKey;
    $('mix').innerHTML = `<div class="cx-mix-head"><b>Volumes</b><button class="btn small" data-mix-close>Done</button></div>
      ${listening.map((c) => {
        const on = me.listen?.[c.id] !== false;
        return `<label class="cx-mix-row" style="--ch:${esc(c.color)}"><span>${esc(c.name)}${on ? '' : ' <small class="muted">(off)</small>'}</span>
          <input type="range" min="0" max="100" value="${Math.round((me.volume?.[c.id] ?? 1) * 100)}" data-vol="${esc(c.id)}" aria-label="${esc(c.name)} volume" ${on ? '' : 'disabled'}></label>`;
      }).join('') || '<p class="muted">You don\'t listen to any channels.</p>'}`;
  }
  const canTalk = talkable().length > 0;
  $('ptt').disabled = me.muted || !armed.size;
  $('ptt').classList.toggle('hidden', !canTalk);
  $('hint').textContent = !canTalk ? 'Listen only: the producer hasn\'t given you a channel to talk on.'
    : !armed.size ? 'Tap a channel to pick it, then hold TALK.'
      : latchMode === 'auto' ? 'Hold TALK to talk on the picked channels. Tap it to stay on; tap again to stop.' : 'Hold TALK to talk on the picked channels.';
  renderTalk();
}

function renderTalk() {
  if (!state) return;
  const ptt = $('ptt');
  ptt.classList.toggle('on', ptting());
  const names = state.channels.filter((c) => talking.has(c.id) || (!ptting() && armed?.has(c.id))).map((c) => c.name);
  ptt.innerHTML = ptting() ? `TALKING<small>${esc(names.join(' · '))}</small>` : `TALK${names.length ? `<small>${esc(names.join(' · '))}</small>` : ''}`;
  ptt.style.setProperty('--ch', state.channels.find((c) => armed?.has(c.id))?.color || 'var(--accent)');
  for (const k of $('channels').querySelectorAll('[data-key]')) k.classList.toggle('talking', talking.has(k.dataset.key));
  const others = state.members.filter((m) => m.id !== me.id && m.online);
  for (const el of $('channels').querySelectorAll('[data-who]')) {
    const who = others.filter((m) => m.talking?.[el.dataset.who]).map((m) => m.name.split(' ')[0]);
    el.textContent = who.length ? `🗣 ${who.join(', ')}` : '';
    el.closest('[data-key]')?.classList.toggle('busy', who.length > 0);
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
