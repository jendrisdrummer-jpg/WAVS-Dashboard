/**
 * ProPresenter 7 (7.9+) via its built-in REST API.
 * Enable in ProPresenter: Settings > Network > Enable Network, note the port.
 *
 * Every endpoint is optional: if one isn't supported by your version, that
 * part of the panel simply stays empty. Only /version decides online/offline.
 */
export class ProPresenter {
  constructor(cfg, hub) {
    this.cfg = { port: 1025, pollMs: 1000, timeoutMs: 2500, ...cfg };
    this.hub = hub;
    this.base = `http://${this.cfg.host}:${this.cfg.port}`;
    this.slow = 0;
  }

  start() {
    this.hub.update('propresenter', this.cfg.id, { name: this.cfg.name || this.cfg.id, host: this.cfg.host, online: false });
    this.tick();
  }

  async get(path) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
    try {
      const res = await fetch(this.base + path, { signal: ctrl.signal });
      if (!res.ok) return undefined;
      const text = await res.text();
      try { return JSON.parse(text); } catch { return text; }
    } finally {
      clearTimeout(t);
    }
  }

  async opt(path) {
    try { return await this.get(path); } catch { return undefined; }
  }

  async tick() {
    if (this.stopped) return;
    try {
      // Light, every tick: what's on screen right now.
      const version = this.slow === 0 || !this.version ? await this.get('/version') : this.version;
      if (!version) throw new Error('No response from /version');
      this.version = version;

      const [slide, slideIndex, layers, audience, stage, timers, capture, activePl] = await Promise.all([
        this.opt('/v1/status/slide'),
        this.opt('/v1/presentation/slide_index'),
        this.opt('/v1/status/layers'),
        this.opt('/v1/status/audience_screens'),
        this.opt('/v1/status/stage_screens'),
        this.opt('/v1/timers/current'),
        this.opt('/v1/capture/status'),
        this.opt('/v1/playlist/active'),
      ]);

      // Active playlist and the item that's cued in it (drives the service plan).
      const plId = activePl?.presentation?.playlist;
      const plItem = activePl?.presentation?.item;
      if (plId?.uuid && (plId.uuid !== this.playlistUuid || this.slow === 0)) {
        const pl = await this.opt(`/v1/playlist/${encodeURIComponent(plId.uuid)}`);
        this.playlistUuid = plId.uuid;
        this.playlistItems = Array.isArray(pl?.items)
          ? pl.items.filter((it) => !it.is_hidden).map((it) => ({ name: it.id?.name || '', type: it.type || 'presentation', uuid: it.id?.uuid || null }))
          : [];
      }
      const playlist = plId?.uuid ? {
        uuid: plId.uuid,
        name: plId.name || 'Playlist',
        items: this.playlistItems || [],
        // Match by uuid first (hidden items shift indexes), then fall back to the reported index.
        index: plItem ? Math.max(-1, (this.playlistItems || []).findIndex((it) => it.uuid && it.uuid === plItem.uuid)) : -1,
        itemName: plItem?.name || null,
      } : null;
      if (playlist && playlist.index === -1 && Number.isInteger(plItem?.index)) playlist.index = plItem.index;

      const idx = slideIndex?.presentation_index;
      const presId = idx?.presentation_id;
      // Heavier, every ~5 ticks or when the presentation changes.
      if (this.slow === 0 || (presId?.uuid && presId.uuid !== this.presUuid)) {
        const [active, look, videoInputs, stageMsg] = await Promise.all([
          this.opt('/v1/presentation/active'),
          this.opt('/v1/look/current'),
          this.opt('/v1/video_inputs'),
          this.opt('/v1/stage/message'),
        ]);
        this.presUuid = presId?.uuid;
        const groups = active?.presentation?.groups || [];
        this.slowData = {
          slideCount: groups.reduce((n, g) => n + (g.slides?.length || 0), 0) || null,
          groups: flattenGroups(groups),
          look: look?.id?.name || null,
          videoInputs: Array.isArray(videoInputs) ? videoInputs.map((v) => v?.id?.name || v?.name).filter(Boolean) : [],
          stageMessage: typeof stageMsg === 'string' ? stageMsg : null,
        };
      }
      this.slow = (this.slow + 1) % 5;

      this.hub.update('propresenter', this.cfg.id, {
        online: true,
        error: null,
        version: typeof version === 'object' ? `${version.host_description || 'ProPresenter'} ${version.api_version || ''}`.trim() : String(version),
        presentation: presId ? { uuid: presId.uuid, name: presId.name, index: idx.index } : null,
        current: slide?.current ? { text: slide.current.text || '', notes: slide.current.notes || '' } : null,
        next: slide?.next ? { text: slide.next.text || '', notes: slide.next.notes || '' } : null,
        layers: layers && typeof layers === 'object' ? layers : null,
        screens: { audience: typeof audience === 'boolean' ? audience : null, stage: typeof stage === 'boolean' ? stage : null },
        timers: Array.isArray(timers) ? timers.map((t) => ({ name: t?.id?.name, time: t?.time, state: t?.state })) : [],
        capture: capture && typeof capture === 'object' ? { status: capture.status, destination: capture.capture_destination || null } : null,
        playlist,
        ...this.slowData,
      });
    } catch (err) {
      this.slow = 0;
      this.hub.update('propresenter', this.cfg.id, { online: false, error: err.name === 'AbortError' ? 'Timed out' : err.message });
    }
    this.timer = setTimeout(() => this.tick(), this.cfg.pollMs);
  }

  /** Proxy a slide thumbnail (avoids CORS / exposing ProPresenter to every browser). */
  async thumbnail(uuid, index, quality = 480) {
    const res = await fetch(`${this.base}/v1/presentation/${encodeURIComponent(uuid)}/thumbnail/${Number(index)}?quality=${quality}`);
    if (!res.ok) throw new Error(`thumbnail ${res.status}`);
    return { type: res.headers.get('content-type') || 'image/jpeg', body: Buffer.from(await res.arrayBuffer()) };
  }

  async setStageMessage(text) {
    const method = text ? 'PUT' : 'DELETE';
    const res = await fetch(`${this.base}/v1/stage/message`, {
      method, headers: { 'content-type': 'application/json' }, body: text ? JSON.stringify(text) : undefined,
    });
    if (!res.ok) throw new Error(`ProPresenter responded ${res.status}`);
  }

  stop() { this.stopped = true; clearTimeout(this.timer); }
}

function flattenGroups(groups) {
  let i = 0;
  return groups.map((g) => {
    const start = i;
    i += g.slides?.length || 0;
    return { name: g.name, color: rgba(g.color), start, count: g.slides?.length || 0 };
  });
}

function rgba(c) {
  if (!c || typeof c.red !== 'number') return null;
  const to = (v) => Math.round(v * 255);
  return `rgb(${to(c.red)},${to(c.green)},${to(c.blue)})`;
}
