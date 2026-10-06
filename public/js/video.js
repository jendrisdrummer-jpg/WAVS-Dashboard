// Video / feed tiles. Each tile is built once (so streams aren't interrupted)
// and only its overlays (tally, labels) are refreshed on state changes.
import { store, esc } from './common.js';

export function buildTile(cfg) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.tabIndex = 0;
  el.innerHTML = `
    <div class="label"><span>${esc(cfg.label || cfg.id)}</span></div>
    <div class="tally"></div>
    <div class="status">Connecting…</div>
    <div class="tools"><button data-fs title="Fullscreen">⛶</button></div>`;
  el.querySelector('[data-fs]').onclick = () => toggleFullscreen(el);
  el.ondblclick = () => toggleFullscreen(el);

  const handler = TYPES[cfg.type];
  const tile = { el, cfg, update: () => {} };
  if (!handler) setStatus(el, `Unknown tile type "${esc(cfg.type)}"`);
  else Object.assign(tile, handler(el, cfg) || {});

  const baseUpdate = tile.update;
  tile.update = () => {
    baseUpdate();
    const sw = cfg.switcher && store.state.switchers[cfg.switcher];
    const tally = el.querySelector('.tally');
    if (sw) {
      // Overlay the program/preview of the chosen M/E (Constellation etc.), or the switcher default.
      const me = (cfg.me && sw.mes?.[cfg.me - 1]) || sw;
      const html = sw.online
        ? `${me.ftb ? '<span class="chip bad">FTB</span>' : ''}
           ${me.program ? `<span class="chip live">PGM · ${esc(me.program.name)}</span>` : ''}
           ${me.preview ? `<span class="chip good">PVW · ${esc(me.preview.name)}</span>` : ''}`
        : '<span class="chip bad">Switcher offline</span>';
      if (tally._html !== html) { tally._html = html; tally.innerHTML = html; }
      el.classList.toggle('on-air', sw.online && !me.ftb);
    }
  };
  return tile;
}

function setStatus(el, html) {
  const s = el.querySelector('.status');
  s.classList.toggle('hidden', !html);
  if (html) s.innerHTML = html;
}

function toggleFullscreen(el) {
  if (document.fullscreenElement) document.exitFullscreen();
  else el.requestFullscreen?.();
}

function addVideo(el, { muted = true } = {}) {
  const v = document.createElement('video');
  v.autoplay = true;
  v.playsInline = true;
  v.muted = muted;
  el.prepend(v);
  const btn = document.createElement('button');
  btn.textContent = '🔇';
  btn.title = 'Listen (unmute)';
  btn.onclick = () => { v.muted = !v.muted; btn.textContent = v.muted ? '🔇' : '🔊'; };
  el.querySelector('.tools').prepend(btn);
  v.addEventListener('playing', () => setStatus(el, null));
  return v;
}

const TYPES = {
  /** Local capture card / webcam-class device on the machine running the browser. */
  capture(el, cfg) {
    const v = addVideo(el);
    const key = `wavs-tile-device:${cfg.id}`;
    const picker = document.createElement('select');
    picker.title = 'Choose capture device';
    el.querySelector('.tools').prepend(picker);
    let stream;

    async function open() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus(el, 'Capture needs http://localhost or https<small>Open the dashboard on the computer with the capture card, or serve over HTTPS.</small>');
        return;
      }
      try {
        // Ask once so device labels become visible, then pick the configured device.
        if (!stream) stream = await navigator.mediaDevices.getUserMedia({ video: true });
        const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
        const saved = localStorage.getItem(key);
        const want = devices.find((d) => d.deviceId === saved)
          || devices.find((d) => cfg.device && d.label.toLowerCase().includes(cfg.device.toLowerCase()))
          || null;
        picker.innerHTML = `<option value="">Select device…</option>${devices.map((d) => `<option value="${esc(d.deviceId)}" ${want?.deviceId === d.deviceId ? 'selected' : ''}>${esc(d.label || 'Camera')}</option>`).join('')}`;
        stream.getTracks().forEach((t) => t.stop());
        if (!want) { setStatus(el, `No device matching “${esc(cfg.device || '')}”<small>Hover and pick one from the list.</small>`); stream = null; return; }
        stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: want.deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
          // `audio: true` in config also opens the default audio input, e.g. the capture card's embedded audio.
          audio: cfg.audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
        });
        v.srcObject = stream;
        stream.getVideoTracks()[0].onended = () => { setStatus(el, 'Device disconnected'); setTimeout(open, 3000); };
      } catch (e) {
        setStatus(el, `Can't open capture device<small>${esc(e.message)}</small>`);
        setTimeout(open, 5000);
      }
    }
    picker.onchange = () => {
      localStorage.setItem(key, picker.value);
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      open();
    };
    open();
  },

  /** WebRTC WHEP playback (MediaMTX, OvenMediaEngine, Cloudflare, etc.). */
  webrtc(el, cfg) {
    const v = addVideo(el);
    let pc;
    async function connect() {
      pc?.close();
      pc = new RTCPeerConnection({ iceServers: cfg.iceServers || [] });
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.ontrack = (e) => { if (v.srcObject !== e.streams[0]) v.srcObject = e.streams[0]; };
      pc.onconnectionstatechange = () => {
        if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
          setStatus(el, 'Stream lost – retrying…');
          setTimeout(connect, 3000);
        }
      };
      try {
        await pc.setLocalDescription(await pc.createOffer());
        await new Promise((r) => {
          if (pc.iceGatheringState === 'complete') return r();
          pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && r());
          setTimeout(r, 1500);
        });
        const res = await fetch(cfg.url, { method: 'POST', headers: { 'content-type': 'application/sdp' }, body: pc.localDescription.sdp });
        if (!res.ok) throw new Error(`WHEP server answered ${res.status}`);
        await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
      } catch (e) {
        setStatus(el, `No stream<small>${esc(cfg.url)}<br>${esc(e.message)}</small>`);
        setTimeout(connect, 5000);
      }
    }
    connect();
  },

  hls(el, cfg) {
    const v = addVideo(el);
    if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src = cfg.url; return; }
    const s = document.createElement('script');
    s.src = '/vendor/hls.min.js';
    s.onload = () => {
      const hls = new window.Hls({ liveSyncDurationCount: 2, lowLatencyMode: true });
      hls.loadSource(cfg.url);
      hls.attachMedia(v);
      hls.on(window.Hls.Events.ERROR, (_e, d) => {
        if (d.fatal) { setStatus(el, `HLS error<small>${esc(d.details)}</small>`); setTimeout(() => hls.loadSource(cfg.url), 5000); }
      });
    };
    document.head.append(s);
  },

  mjpeg(el, cfg) {
    const img = document.createElement('img');
    img.className = 'feed';
    img.alt = cfg.label || '';
    img.onload = () => setStatus(el, null);
    img.onerror = () => { setStatus(el, `No image<small>${esc(cfg.url)}</small>`); setTimeout(load, 3000); };
    const load = () => { img.src = cfg.refreshMs ? `${cfg.url}${cfg.url.includes('?') ? '&' : '?'}t=${Date.now()}` : cfg.url; };
    el.prepend(img);
    load();
    if (cfg.refreshMs) setInterval(load, cfg.refreshMs);
  },

  iframe(el, cfg) {
    const f = document.createElement('iframe');
    f.src = cfg.url;
    f.onload = () => setStatus(el, null);
    el.prepend(f);
  },

  /** Live ProPresenter status: current / next slide, groups, layers, timers. */
  propresenter(el, cfg) {
    const box = document.createElement('div');
    box.className = 'pp';
    el.prepend(box);
    el.style.background = 'var(--panel)';
    let last = {}; // sentinel so the first update always renders
    return {
      update() {
        const pp = store.state.propresenter[cfg.propresenter];
        if (pp === last) return; // unchanged; avoid re-fetching the thumbnail
        last = pp;
        if (!pp) { setStatus(el, `ProPresenter "${esc(cfg.propresenter)}" not configured`); return; }
        if (!pp.online) {
          setStatus(el, `ProPresenter not responding<small>${esc(pp.host || '')} ${esc(pp.error || '')}</small>`);
          box.classList.add('hidden');
          return;
        }
        setStatus(el, null);
        box.classList.remove('hidden');
        const idx = pp.presentation?.index;
        const group = pp.groups?.find((g) => idx >= g.start && idx < g.start + g.count);
        const layers = pp.layers || {};
        const timers = pp.timers || [];
        box.innerHTML = `
          <div class="pp-head">
            <div class="pp-title" title="${esc(pp.presentation?.name || '')}">${esc(pp.presentation?.name || 'No presentation')}</div>
            ${group ? `<span class="chip" style="border-color:${esc(group.color || '')}">${esc(group.name)}</span>` : ''}
            ${idx != null ? `<span class="chip mono">${idx + 1}${pp.slideCount ? ` / ${pp.slideCount}` : ''}</span>` : ''}
          </div>
          <div>
            ${pp.groups?.length ? `<div class="pp-groups">${pp.groups.map((g) => `<div class="${g === group ? 'cur' : ''}" style="flex:${g.count};background:${esc(g.color || '')}" title="${esc(g.name)}"></div>`).join('')}</div>` : ''}
            <div class="pp-body" style="height:calc(100% - 14px);padding-top:8px">
              <div class="pp-slide"><span class="cap">LIVE</span>
                ${pp.presentation?.uuid && idx != null ? `<img alt="" src="/api/propresenter/${encodeURIComponent(cfg.propresenter)}/thumbnail/${encodeURIComponent(pp.presentation.uuid)}/${idx}" onerror="this.remove()">` : ''}
                <div class="txt">${esc(pp.current?.text || '')}</div></div>
              <div class="pp-slide next"><span class="cap">NEXT</span><div class="txt">${esc(pp.next?.text || '')}</div></div>
            </div>
          </div>
          <div class="pp-foot">
            ${Object.entries(layers).map(([k, on]) => `<span class="chip ${on ? 'on' : ''}">${esc(k.replace(/_/g, ' '))}</span>`).join('')}
            ${pp.screens ? `<span class="chip ${pp.screens.audience ? 'good' : 'bad'}">Audience ${pp.screens.audience ? 'on' : 'off'}</span><span class="chip ${pp.screens.stage ? 'good' : 'bad'}">Stage ${pp.screens.stage ? 'on' : 'off'}</span>` : ''}
            ${pp.capture?.status === 'active' ? '<span class="chip live">● REC</span>' : ''}
            ${pp.look ? `<span class="chip">Look: ${esc(pp.look)}</span>` : ''}
            ${timers.map((t) => `<span class="chip mono ${t.state === 'running' ? 'on' : ''}">${esc(t.name)} ${esc(t.time)}</span>`).join('')}
            ${pp.stageMessage ? `<span class="chip live">Stage msg: ${esc(pp.stageMessage)}</span>` : ''}
          </div>`;
      },
    };
  },
};
