import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

/**
 * The order of service and where we are in it.
 *
 * Plans come from Planning Center (`source: "pco"`) or are typed / pasted in
 * on the admin page (`source: "manual"`). That covers Faith Teams, a PDF run sheet,
 * or a one-off event.
 *
 * The current item is set by whichever happens last:
 *   - Planning Center Services LIVE moves to a new item (pco-live)
 *   - ProPresenter shows a presentation whose name matches an item (propresenter)
 *   - someone taps an item, or Next / Previous, on a dashboard (manual)
 * When the current item changes, the time spent on the previous one is recorded,
 * so the plan widget can show planned vs actual ("how did Sunday go").
 */
export class ServiceManager extends EventEmitter {
  constructor({ dataDir, pco, cfg }) {
    super();
    this.file = path.join(dataDir, 'service.json');
    this.pco = pco;
    this.cfg = { followProPresenter: true, livePollMs: 3000, planRefreshMs: 60000, ...cfg };
    // links: per plan, which plan item each ProPresenter playlist item is ({ ppKey: itemId | 'ignore' }).
    // aliases: remembered by name for future plans ({ "pp name": "plan item title" | 'ignore' }).
    // expectPlaylist: the ProPresenter playlist this service uses (from the schedule); others are ignored.
    this.saved = { source: null, serviceTypeId: null, planId: null, manual: null, current: null, actuals: {}, links: {}, aliases: {}, expectPlaylist: '' };
    if (fs.existsSync(this.file)) {
      try { this.saved = { ...this.saved, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch { /* start fresh */ }
    }
    this.plan = null;
    this.upcoming = [];
    this.pcoStatus = { configured: Boolean(pco), ok: null, error: null, lastSync: null };
  }

  async start() {
    if (this.saved.source === 'manual' && this.saved.manual) this.plan = this.saved.manual;
    if (this.pco) {
      await this.refreshUpcoming();
      if (this.stopped) return; // organization switched while Planning Center was loading
      // Nothing chosen yet: follow the next Planning Center plan automatically.
      if (!this.saved.source && !this.saved.idle && this.upcoming[0]) await this.selectPco(this.upcoming[0].serviceTypeId, this.upcoming[0].id, { keepProgress: true });
      else if (this.saved.source === 'pco') await this.reloadPco();
      if (this.stopped) return;
      this.liveTimer = setInterval(() => this.pollLive(), this.cfg.livePollMs);
      this.planTimer = setInterval(() => { this.reloadPco(); this.refreshUpcoming(); }, this.cfg.planRefreshMs);
    }
    this.emitState();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.liveTimer);
    clearInterval(this.planTimer);
    this.removeAllListeners();
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.saved, null, 2));
    fs.renameSync(tmp, this.file);
  }

  state() {
    return {
      source: this.saved.source,
      planId: this.saved.planId,
      serviceTypeId: this.saved.serviceTypeId,
      plan: this.planForToday(),
      current: this.saved.current,
      actuals: this.saved.actuals,
      upcoming: this.upcoming,
      pco: this.pcoStatus,
      followProPresenter: this.cfg.followProPresenter,
      links: this.saved.links?.[this.planKey()] || {},
      remembered: Object.keys(this.saved.aliases || {}).length,
      playlist: { expected: this.saved.expectPlaylist || '', active: this.activePlaylist || null },
      idle: Boolean(this.saved.idle),
    };
  }

  /**
   * No order of service: nothing is live (the schedule ended it). Stays empty after a restart too,
   * rather than picking the next Planning Center plan by itself.
   */
  clear() {
    this.saved = { ...this.saved, source: null, serviceTypeId: null, planId: null, manual: null, current: null, actuals: {}, expectPlaylist: '', idle: true };
    this.plan = null;
    this.save();
    this.emitState();
  }

  /** Put the plan back exactly as it was (Undo on the schedule): source, items, progress. */
  restore(saved) {
    if (!saved) return;
    this.saved = { ...this.saved, ...structuredClone(saved) };
    this.plan = this.saved.source === 'manual' ? this.saved.manual : this.saved.source === 'pco' ? this.plan : null;
    this.save();
    if (this.saved.source === 'pco') this.reloadPco();
    this.emitState();
    this.emit('planLoaded');
  }

  /** Only follow this ProPresenter playlist ('' = whichever is active). */
  expectPlaylist(name) {
    const v = String(name || '').trim();
    if (v === (this.saved.expectPlaylist || '')) return;
    this.saved = { ...this.saved, expectPlaylist: v };
    this.save();
    this.emitState();
  }

  /** Is this the playlist the service expects? (Remembers the active one for the warning.) */
  playlistOk(pl) {
    if (this.activePlaylist !== pl.name) { this.activePlaylist = pl.name; this.emitState(); }
    const want = normalize(this.saved.expectPlaylist);
    return !want || normalize(pl.name) === want;
  }

  /** Links belong to one plan (Planning Center plans are new every week). */
  planKey() { return `${this.saved.source}:${this.saved.planId || 'manual'}`; }

  /**
   * Which plan item a ProPresenter playlist item is, and how we know:
   *   link        set on the Service page for this plan
   *   remembered  linked by name in an earlier plan ("Countdown Loop" is always "Pre-Service")
   *   name        same (or contained) name
   *   position    nth item of the playlist = nth item of the plan (same number of items)
   *   ignore      set to "don't move the plan"
   */
  resolve(cued, pl) {
    if (!this.plan || !cued || cued.type === 'header') return { itemId: null, how: null };
    const items = this.plan.items.filter((i) => i.type !== 'header');
    const link = (this.saved.links?.[this.planKey()] || {})[ppKey(cued)];
    if (link === 'ignore') return { itemId: null, how: 'ignore' };
    if (link && items.some((i) => i.id === link)) return { itemId: link, how: 'link' };
    const alias = (this.saved.aliases || {})[normalize(cued.name)];
    if (alias === 'ignore') return { itemId: null, how: 'ignore' };
    if (alias) {
      const hit = this.byTitle(alias, (t) => t === alias);
      if (hit) return { itemId: hit.id, how: 'remembered' };
    }
    const want = normalize(cued.name);
    const named = want && this.byTitle(want, (t) => t === want || (t.length > 3 && want.includes(t)) || (want.length > 3 && t.includes(want)));
    if (named) return { itemId: named.id, how: 'name' };
    const plItems = (pl?.items || []).filter((i) => i.type !== 'header');
    const k = plItems.indexOf(cued);
    if (k >= 0 && plItems.length === items.length) return { itemId: items[k].id, how: 'position' };
    return { itemId: null, how: null };
  }

  /** First plan item whose title passes `test`, preferring ones at or after the current item (songs repeat). */
  byTitle(_want, test) {
    const idx = this.plan.items.findIndex((i) => i.id === this.saved.current?.itemId);
    const matches = this.plan.items.filter((i) => i.type !== 'header' && normalize(i.title) && test(normalize(i.title)));
    return matches.find((m) => this.plan.items.indexOf(m) >= idx) || matches[0] || null;
  }

  /** How every item of a ProPresenter playlist matches the plan (for the Service page). */
  preview(pl) {
    return (pl?.items || []).map((it, i) => ({
      key: ppKey(it), name: it.name, type: it.type, cued: i === pl.index,
      link: (this.saved.links?.[this.planKey()] || {})[ppKey(it)] || null,
      ...this.resolve(it, pl),
    }));
  }

  /** Link a ProPresenter item to a plan item (or 'ignore', or null for automatic). Also remembered by name. */
  setLink({ key, name, itemId }) {
    if (!this.plan) throw new Error('Load a service plan first');
    if (itemId && itemId !== 'ignore' && !this.plan.items.some((i) => i.id === itemId)) throw new Error('Unknown plan item');
    const pk = this.planKey();
    const links = { ...(this.saved.links?.[pk] || {}) };
    const aliases = { ...(this.saved.aliases || {}) };
    const n = normalize(name);
    if (!itemId) { delete links[key]; if (n) delete aliases[n]; } else {
      links[key] = itemId;
      if (n) aliases[n] = itemId === 'ignore' ? 'ignore' : normalize(this.plan.items.find((i) => i.id === itemId).title);
    }
    // Keep links for the last few plans only.
    const all = { ...(this.saved.links || {}), [pk]: links };
    this.saved = { ...this.saved, links: Object.fromEntries(Object.entries(all).slice(-12)), aliases };
    this.save();
    this.emitState();
  }

  /** A manual plan is "today's" plan: its start time is applied to the current date. */
  planForToday() {
    if (this.saved.source !== 'manual' || !this.plan) return this.plan;
    const m = String(this.plan.start || '').match(/^(\d{1,2}):(\d{2})$/);
    const d = this.plan.date ? new Date(`${this.plan.date}T00:00`) : new Date();
    const dates = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    if (!m) return { ...this.plan, dates };
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    return { ...this.plan, dates, times: [{ id: 'manual', name: 'Service', type: 'service', startsAt: d.toISOString(), endsAt: null }] };
  }

  emitState() { this.emit('change', this.state()); }

  pcoError(err) {
    this.pcoStatus = { ...this.pcoStatus, ok: false, error: err.message };
    console.error(`[planning center] ${err.message}`);
    this.emitState();
  }

  async refreshUpcoming() {
    try {
      this.upcoming = await this.pco.upcomingPlans();
      this.pcoStatus = { ...this.pcoStatus, ok: true, error: null, lastSync: new Date().toISOString() };
      this.emitState();
    } catch (e) { this.pcoError(e); }
  }

  async reloadPco() {
    if (this.saved.source !== 'pco' || !this.pco) return;
    try {
      this.plan = await this.pco.loadPlan(this.saved.serviceTypeId, this.saved.planId);
      this.pcoStatus = { ...this.pcoStatus, ok: true, error: null, lastSync: new Date().toISOString() };
      this.emitState();
    } catch (e) { this.pcoError(e); }
  }

  async selectPco(serviceTypeId, planId, { keepProgress = false } = {}) {
    if (!this.pco) throw new Error('Planning Center is not configured');
    const same = this.saved.source === 'pco' && this.saved.planId === planId;
    this.saved = { ...this.saved, source: 'pco', serviceTypeId, planId, idle: false };
    if (!same && !keepProgress) this.saved = { ...this.saved, current: null, actuals: {} };
    this.save();
    await this.reloadPco();
    if (!same) this.emit('planLoaded');
  }

  /** Manual plan from lines like "5:00 Welcome", "# Worship" (header), "Song: 4:30 Holy Forever". */
  setManual({ title, text, start, date = '' }) {
    const items = parsePlanText(text);
    // Optional service start time ("09:30"); applied to today's date in state(), or to date
    // ("2026-05-02") for a scheduled service.
    const m = String(start || '').match(/^(\d{1,2}):(\d{2})$/);
    this.saved = {
      ...this.saved,
      idle: false,
      source: 'manual',
      serviceTypeId: null,
      planId: null,
      manual: { title: title || 'Service', seriesTitle: null, dates: null, times: [], items, text, start: m ? start : '', date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '' },
      current: null,
      actuals: {},
    };
    this.plan = this.saved.manual;
    this.save();
    this.emitState();
    this.emit('planLoaded');
  }

  async pollLive() {
    if (this.saved.source !== 'pco' || !this.saved.planId) return;
    try {
      const live = await this.pco.live(this.saved.serviceTypeId, this.saved.planId);
      if (!live) return;
      const cur = this.saved.current;
      const newer = !cur || !live.startedAt || new Date(live.startedAt) > new Date(cur.startedAt);
      if (cur?.itemId !== live.itemId && newer) this.setCurrent(live.itemId, 'pco-live', live.startedAt);
    } catch { /* LIVE isn't always available; plan reloads surface real errors */ }
  }

  /** Called when ProPresenter's active presentation changes. */
  onPresentation(name) {
    if (!this.cfg.followProPresenter || !this.plan || !name) return false;
    const alias = (this.saved.aliases || {})[normalize(name)];
    if (alias === 'ignore') return true;
    if (alias) {
      const hit = this.byTitle(alias, (t) => t === alias);
      if (hit) { if (hit.id !== this.saved.current?.itemId) this.setCurrent(hit.id, 'propresenter'); return true; }
    }
    const items = this.plan.items.filter((i) => i.type !== 'header');
    const want = normalize(name);
    if (!want) return false;
    const idx = this.plan.items.findIndex((i) => i.id === this.saved.current?.itemId);
    const matches = items.filter((i) => {
      const t = normalize(i.title);
      return t && (t === want || (t.length > 3 && want.includes(t)) || (want.length > 3 && t.includes(want)));
    });
    if (!matches.length) return false;
    // Prefer the first match at or after the current position (songs can repeat).
    const pick = matches.find((m) => this.plan.items.indexOf(m) >= idx) || matches[0];
    if (pick.id !== this.saved.current?.itemId) this.setCurrent(pick.id, 'propresenter');
    return true;
  }

  /**
   * Called when ProPresenter's active playlist or cued item changes.
   * - Source "propresenter": the playlist *is* the order of service.
   * - Planning Center / manual plan: match the cued item by name; if names differ but the
   *   playlist and plan have the same number of items, follow by position instead.
   */
  onPlaylist(pl) {
    if (!this.cfg.followProPresenter || !pl?.items?.length) return;
    if (!this.playlistOk(pl)) return; // another service's playlist is open in ProPresenter
    if (this.saved.source === 'propresenter') {
      const items = pl.items.map((it, i) => ({
        id: `${pl.uuid}:${i}`,
        title: it.name || `Item ${i + 1}`,
        type: it.type === 'header' ? 'header' : it.type === 'presentation' ? 'item' : 'media',
        position: 'during',
        length: 0,
      }));
      if (this.saved.planId !== pl.uuid) this.saved = { ...this.saved, planId: pl.uuid, current: null, actuals: {} };
      const changed = JSON.stringify(items) !== JSON.stringify(this.plan?.items);
      this.plan = { title: pl.name, seriesTitle: null, dates: null, times: [], items };
      if (changed) { this.save(); this.emitState(); }
      const cur = items[pl.index];
      if (cur && cur.type !== 'header' && cur.id !== this.saved.current?.itemId) this.setCurrent(cur.id, 'propresenter');
      return;
    }
    const cued = pl.items[pl.index];
    if (!this.plan || !cued) return;
    const { itemId } = this.resolve(cued, pl);
    if (itemId && itemId !== this.saved.current?.itemId) this.setCurrent(itemId, 'propresenter');
  }

  /** Use ProPresenter's active playlist as the order of service. */
  useProPresenter() {
    this.saved = { ...this.saved, source: 'propresenter', serviceTypeId: null, planId: null, current: null, actuals: {}, idle: false };
    this.plan = null;
    this.save();
    this.emitState();
    this.emit('planLoaded');
  }

  setCurrent(itemId, by = 'manual', startedAt = null) {
    if (itemId && !this.plan?.items.some((i) => i.id === itemId)) throw new Error('Unknown item');
    const prev = this.saved.current;
    if (prev?.itemId && prev.startedAt) {
      const spent = Math.max(0, Math.round((Date.now() - new Date(prev.startedAt)) / 1000));
      this.saved.actuals = { ...this.saved.actuals, [prev.itemId]: (this.saved.actuals[prev.itemId] || 0) + spent };
    }
    this.saved.current = itemId ? { itemId, startedAt: startedAt || new Date().toISOString(), by } : null;
    this.save();
    this.emitState();
  }

  step(dir) {
    const items = (this.plan?.items || []).filter((i) => i.type !== 'header');
    if (!items.length) return;
    const idx = items.findIndex((i) => i.id === this.saved.current?.itemId);
    const next = items[Math.min(items.length - 1, Math.max(0, idx + dir))];
    if (idx === -1) this.setCurrent(items[0].id);
    else if (next.id !== this.saved.current?.itemId) this.setCurrent(next.id);
  }

  resetProgress() {
    this.saved = { ...this.saved, current: null, actuals: {} };
    this.save();
    this.emitState();
  }
}

/** A stable key for a ProPresenter playlist item (its presentation id, or its name). */
export const ppKey = (it) => (it?.uuid ? `u:${it.uuid}` : `n:${normalize(it?.name)}`);

export function normalize(s) {
  return String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Plain-text order of service, one item per line:
 *   # Worship              -> header
 *   5:00 Welcome           -> 5 minute item
 *   Song 4:30 Holy Forever -> song (also "song:", "media", "video")
 *   Message 35m            -> minutes with "m"
 * Lines without a length get 0.
 */
export function parsePlanText(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
    if (line.startsWith('#')) return { id: crypto.randomUUID(), title: line.replace(/^#+\s*/, ''), type: 'header', position: 'during', length: 0 };
    let type = 'item';
    let rest = line;
    const t = rest.match(/^(song|media|video)\b:?\s*/i);
    if (t) { type = t[1].toLowerCase() === 'song' ? 'song' : 'media'; rest = rest.slice(t[0].length); }
    let length = 0;
    const clock = rest.match(/(^|\s)(\d{1,2}):(\d{2})(?=\s|$)/);
    const mins = rest.match(/(^|\s)(\d{1,3})\s?m(in)?(?=\s|$)/i);
    if (clock) { length = Number(clock[2]) * 60 + Number(clock[3]); rest = rest.replace(clock[0], ' '); }
    else if (mins) { length = Number(mins[2]) * 60; rest = rest.replace(mins[0], ' '); }
    return { id: crypto.randomUUID(), title: rest.replace(/\s+/g, ' ').replace(/^[-–—:\s]+|[-–—:\s]+$/g, '') || 'Item', type, position: 'during', length };
  });
}
