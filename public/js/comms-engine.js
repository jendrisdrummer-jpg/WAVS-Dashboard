// The comms engine: a browser tab on the dashboard computer that mixes comms audio.
//
// Every phone makes one WebRTC connection here. Its microphone becomes a "speaker" and it gets
// back its own personal mix (a "listener"). Between every speaker and listener sits a gain set
// from the routing matrix (comms-routing.js), so each person hears exactly the channels they
// listen to. Audio interface inputs/outputs (e.g. a Behringer WING over USB) are speakers and
// listeners too.
import { matrix } from './comms-routing.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let ws;
let ctx;
let state = null;
let localMic; // kept open: with microphone permission the browser shares real network addresses with phones
const peers = new Map(); // memberId -> { pc, ready, el }  (direct WebRTC)
const relays = new Map(); // memberId -> { player, cap }  (audio through the server)
let sink; // silent output that keeps relay capture worklets running
const ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
const speakers = new Map(); // key -> { node, analyser }
const listeners = new Map(); // key -> { bus }
const gains = new Map(); // "s|l" -> GainNode
const levels = {};

// ---------------------------------------------------------------- start

$('start').onclick = async () => {
  $('err').textContent = '';
  try {
    ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    await ctx.resume();
    await ctx.audioWorklet.addModule('/js/comms-worklet.js');
    sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    localMic = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
    $('startbox').classList.add('hidden');
    $('running').classList.remove('hidden');
    connect();
    setInterval(meter, 200);
    renderPorts();
  } catch (e) { $('err').textContent = e.message; }
};
window.addEventListener('beforeunload', (e) => { if (ctx) { e.preventDefault(); e.returnValue = ''; } });

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/comms-ws`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { send({ t: 'hello', role: 'engine', pin: localStorage.getItem('wavs-pin') || undefined }); setTimeout(reportDevices, 500); };
  ws.onclose = () => {
    for (const id of [...peers.keys(), ...relays.keys()]) dropPeer(id);
    status('Reconnecting to the dashboard…', false);
    if (!connect.stopped) setTimeout(connect, 1500);
  };
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) return onAudio(ev.data);
    onMessage(JSON.parse(ev.data));
  };
}
const send = (msg) => ws?.readyState === 1 && ws.send(JSON.stringify(msg));

function onMessage(msg) {
  switch (msg.t) {
    case 'state':
      state = msg.state;
      for (const id of [...peers.keys(), ...relays.keys()]) if (!state.members.some((m) => m.id === id && m.online)) dropPeer(id);
      syncPorts();
      applyMatrix();
      return render();
    case 'signal': return onSignal(msg.from, msg.data);
    case 'bye': dropPeer(msg.from); return applyMatrix();
    case 'relay': startRelay(msg.from); return render();
    case 'replaced':
      connect.stopped = true;
      status('Another comms engine took over. This tab is no longer mixing.', false);
      ws.close();
      return;
    case 'reload': return location.reload();
    case 'error':
      if (/PIN/.test(msg.error)) {
        const pin = prompt(`${msg.error}\n\nAdmin PIN:`);
        if (pin != null) { localStorage.setItem('wavs-pin', pin); send({ t: 'hello', role: 'engine', pin }); }
      } else console.warn('[comms]', msg.error);
  }
}

// ---------------------------------------------------------------- phones (WebRTC)

function onSignal(id, data) {
  if (data.type === 'offer') return answer(id, data.sdp);
  const peer = peers.get(id);
  if (peer && data.candidate) peer.ready.then(() => peer.pc.addIceCandidate(data.candidate)).catch((e) => console.warn(e));
}

function answer(id, sdp) {
  dropPeer(id);
  const pc = new RTCPeerConnection({ iceServers: ICE });
  const peer = { pc };
  peers.set(id, peer);

  // Their personal mix: everything routed to them is summed into this bus.
  const bus = ctx.createGain();
  const out = ctx.createMediaStreamDestination();
  out.channelCount = 1;
  bus.connect(out);
  listeners.set(`m:${id}`, { bus, out });

  pc.ontrack = (ev) => {
    const stream = ev.streams[0] || new MediaStream([ev.track]);
    // Chrome only feeds a WebRTC stream into Web Audio when it is also attached to a media element.
    peer.el = new Audio();
    peer.el.muted = true;
    peer.el.srcObject = stream;
    peer.el.play().catch(() => {});
    addSpeaker(`m:${id}`, ctx.createMediaStreamSource(stream));
    applyMatrix();
  };
  pc.onicecandidate = (ev) => ev.candidate && send({ t: 'signal', to: id, data: { candidate: ev.candidate.toJSON() } });
  pc.onconnectionstatechange = () => render();
  peer.ready = (async () => {
    await pc.setRemoteDescription({ type: 'offer', sdp });
    pc.addTrack(out.stream.getAudioTracks()[0], out.stream);
    await pc.setLocalDescription(await pc.createAnswer());
    send({ t: 'signal', to: id, data: { type: 'answer', sdp: pc.localDescription.sdp } });
  })();
  peer.ready.catch((e) => console.warn('[comms] answer', e));
  applyMatrix();
}

function dropPeer(id) {
  const peer = peers.get(id);
  const rl = relays.get(id);
  if (!peer && !rl) return;
  peers.delete(id);
  relays.delete(id);
  if (peer) {
    peer.pc.close();
    if (peer.el) peer.el.srcObject = null;
  }
  if (rl) { rl.player.disconnect(); rl.cap.disconnect(); }
  removeEndpoint(`m:${id}`);
}

// ---------------------------------------------------------------- phones through the server (relay)

const idBytes = (id) => new TextEncoder().encode(id.padEnd(8).slice(0, 8));

function startRelay(id) {
  dropPeer(id);
  const player = new AudioWorkletNode(ctx, 'wavs-player'); // their voice
  addSpeaker(`m:${id}`, player);
  const bus = ctx.createGain(); // their mix
  const cap = new AudioWorkletNode(ctx, 'wavs-capture', { processorOptions: { skipSilence: true } });
  bus.connect(cap).connect(sink);
  const head = idBytes(id);
  cap.port.onmessage = (e) => {
    if (ws?.readyState !== 1 || ws.bufferedAmount > 256000) return;
    const out = new Uint8Array(8 + e.data.byteLength);
    out.set(head);
    out.set(new Uint8Array(e.data), 8);
    ws.send(out);
  };
  listeners.set(`m:${id}`, { bus });
  relays.set(id, { player, cap });
  applyMatrix();
}

function onAudio(buf) {
  const id = new TextDecoder().decode(new Uint8Array(buf, 0, 8)).trim();
  const body = buf.slice(8);
  relays.get(id)?.player.port.postMessage(body, [body]);
}

// ---------------------------------------------------------------- mixing

function addSpeaker(key, node) {
  removeSpeaker(key);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  node.connect(analyser);
  speakers.set(key, { node, analyser });
}

function removeSpeaker(key) {
  const s = speakers.get(key);
  if (!s) return;
  s.node.disconnect();
  speakers.delete(key);
  for (const [k, g] of gains) if (k.startsWith(`${key}|`)) { g.disconnect(); gains.delete(k); }
  delete levels[key];
}

function removeEndpoint(key) {
  removeSpeaker(key);
  const l = listeners.get(key);
  if (l) { l.bus.disconnect(); l.cleanup?.(); listeners.delete(key); }
  for (const [k, g] of gains) {
    if (!k.endsWith(`|${key}`)) continue;
    speakers.get(k.split('|')[0])?.node.disconnect(g);
    g.disconnect();
    gains.delete(k);
  }
}

/** Set every speaker -> listener gain from the routing matrix (smoothly, no clicks). */
function applyMatrix() {
  if (!state || !ctx) return;
  const m = matrix(state);
  const now = ctx.currentTime;
  for (const [sk, s] of speakers) {
    for (const [lk, l] of listeners) {
      const target = m[sk]?.[lk] || 0;
      const k = `${sk}|${lk}`;
      let g = gains.get(k);
      if (!g && target > 0) {
        g = ctx.createGain();
        g.gain.value = 0;
        s.node.connect(g).connect(l.bus);
        gains.set(k, g);
      }
      g?.gain.setTargetAtTime(target, now, 0.015);
    }
  }
}

function meter() {
  const buf = new Float32Array(512);
  for (const [key, s] of speakers) {
    s.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const db = 20 * Math.log10(Math.sqrt(sum / buf.length) || 1e-6);
    levels[key] = Math.round(Math.max(0, Math.min(1, (db + 60) / 60)) * 100) / 100;
  }
  send({ t: 'levels', levels });
  for (const el of document.querySelectorAll('[data-lvl]')) el.style.width = `${(levels[el.dataset.lvl] || 0) * 100}%`;
}

// ---------------------------------------------------------------- audio interface ports

let portsKey = '';
const devices = { in: new Map(), out: new Map() }; // device label -> { stream / ctx, ... }

async function deviceList() {
  const all = await navigator.mediaDevices.enumerateDevices();
  return {
    in: all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications'),
    out: all.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications'),
  };
}

function closeDevices() {
  for (const d of devices.in.values()) d.stream.getTracks().forEach((t) => t.stop());
  for (const d of devices.out.values()) d.ctx.close();
  devices.in.clear();
  devices.out.clear();
}

/** (Re)build interface inputs and outputs when their settings change. */
async function syncPorts() {
  const key = JSON.stringify((state.ports || []).map(({ id, kind, device, deviceChannel }) => [id, kind, device, deviceChannel]));
  if (key === portsKey) return;
  portsKey = key;
  for (const k of [...speakers.keys(), ...listeners.keys()]) if (k.startsWith('p:')) removeEndpoint(k);
  closeDevices();
  const list = await deviceList();
  const portErrors = {};
  for (const p of state.ports || []) {
    try {
      if (p.kind === 'in') {
        const dev = list.in.find((d) => d.label === p.device) || list.in.find((d) => d.deviceId === p.device);
        if (!dev) throw new Error('Device not found');
        let d = devices.in.get(dev.deviceId);
        if (!d) {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: {
            deviceId: { exact: dev.deviceId }, channelCount: { ideal: 32 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false,
          } });
          const src = ctx.createMediaStreamSource(stream);
          const n = Math.max(1, stream.getAudioTracks()[0].getSettings().channelCount || 2);
          const split = ctx.createChannelSplitter(n);
          src.connect(split);
          d = { stream, split, n };
          devices.in.set(dev.deviceId, d);
        }
        if (p.deviceChannel > d.n) throw new Error(`The browser only gets ${d.n} channels from this device`);
        const g = ctx.createGain();
        d.split.connect(g, p.deviceChannel - 1);
        addSpeaker(`p:${p.id}`, g);
      } else {
        const dev = list.out.find((d) => d.label === p.device) || list.out.find((d) => d.deviceId === p.device);
        if (!dev) throw new Error('Device not found');
        let d = devices.out.get(dev.deviceId);
        if (!d) {
          // A second audio context plays on the interface; one mono mix per port lands on its channel.
          const octx = new AudioContext({ sinkId: dev.deviceId, latencyHint: 'interactive', sampleRate: 48000 });
          const n = Math.max(2, octx.destination.maxChannelCount);
          octx.destination.channelCount = n;
          octx.destination.channelCountMode = 'explicit';
          octx.destination.channelInterpretation = 'discrete';
          const merge = octx.createChannelMerger(n);
          merge.connect(octx.destination);
          await octx.resume();
          d = { ctx: octx, merge, n };
          devices.out.set(dev.deviceId, d);
        }
        if (p.deviceChannel > d.n) throw new Error(`The browser only sees ${d.n} channels on this device`);
        const bus = ctx.createGain();
        const out = ctx.createMediaStreamDestination();
        out.channelCount = 1;
        bus.connect(out);
        const src = d.ctx.createMediaStreamSource(out.stream);
        src.connect(d.merge, 0, p.deviceChannel - 1);
        listeners.set(`p:${p.id}`, { bus, cleanup: () => src.disconnect() });
      }
    } catch (e) { portErrors[p.id] = e.message; }
  }
  syncPorts.errors = portErrors;
  send({ t: 'port-status', errors: portErrors });
  applyMatrix();
  renderPorts();
}

// Audio in / out are set up on the Comms page (any computer); this tab tells it which audio
// interfaces this computer has, applies the settings and reports problems.
async function reportDevices() {
  if (!ctx) return;
  const list = await deviceList();
  send({ t: 'devices', devices: { in: list.in.map((d) => ({ label: d.label })), out: list.out.map((d) => ({ label: d.label })) } });
}
navigator.mediaDevices?.addEventListener?.('devicechange', () => { portsKey = ''; reportDevices(); if (state) syncPorts(); });

function renderPorts() {
  if (!ctx) { $('ports').innerHTML = '<p class="muted small">Start the engine first.</p>'; return; }
  const chans = state?.channels || [];
  const name = (id) => chans.find((c) => c.id === id)?.name || id;
  const errs = syncPorts.errors || {};
  $('ports').innerHTML = (state?.ports || []).length ? state.ports.map((p) => `<div class="port-row">
    <b class="port-kind ${p.kind}">${p.kind === 'in' ? 'IN' : 'OUT'}</b><span><b>${esc(p.name)}</b> · ${esc(p.device || 'no device')} ch ${p.deviceChannel}</span>
    <span class="muted small">${p.kind === 'in' ? 'into' : 'carries'} ${esc((p.channels || []).map(name).join(', ') || 'no channels')}</span>
    ${errs[p.id] ? `<small class="port-err">${esc(errs[p.id])}</small>` : '<small class="g-ok-text">✓ working</small>'}
  </div>`).join('') : '<p class="muted small">No audio in / out set up.</p>';
}

// ---------------------------------------------------------------- status

function status(text, ok) {
  $('eng-text').textContent = text;
  document.querySelector('.eng-status').classList.toggle('g-ok', ok);
  document.querySelector('.eng-status').classList.toggle('g-bad', !ok);
}

function render() {
  if (!state) return;
  const on = state.members.filter((m) => m.online);
  status('Running: phones can connect', true);
  $('eng-sub').textContent = `${on.length} on comms · ${speakers.size} audio sources · ${gains.size} routes`;
  const html = on.map((m) => {
    const st = relays.has(m.id) ? 'connected (via internet)' : peers.get(m.id)?.pc.connectionState || 'waiting';
    return `<div class="eng-person"><span class="dev-dot ${st.startsWith('connected') ? 'on' : ''}"></span><b>${esc(m.name)}</b>
      <small class="muted">${esc(st)}</small><span class="lvl"><i data-lvl="m:${esc(m.id)}"></i></span></div>`;
  }).join('') || '<p class="muted small">Nobody on comms yet. Phones join at /comms.</p>';
  if ($('people')._html !== html) { $('people')._html = html; $('people').innerHTML = html; }
}
