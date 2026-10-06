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
    this.saved = { source: null, serviceTypeId: null, planId: null, manual: null, current: null, actuals: {} };
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
      // Nothing chosen yet: follow the next Planning Center plan automatically.
      if (!this.saved.source && this.upcoming[0]) await this.selectPco(this.upcoming[0].serviceTypeId, this.upcoming[0].id, { keepProgress: true });
      else if (this.saved.source === 'pco') await this.reloadPco();
      this.liveTimer = setInterval(() => this.pollLive(), this.cfg.livePollMs);
      this.planTimer = setInterval(() => { this.reloadPco(); this.refreshUpcoming(); }, this.cfg.planRefreshMs);
    }
    this.emitState();
  }

  stop() { clearInterval(this.liveTimer); clearInterval(this.planTimer); }

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
    };
  }

  /** A manual plan is "today's" plan: its start time is applied to the current date. */
  planForToday() {
    if (this.saved.source !== 'manual' || !this.plan) return this.plan;
    const m = String(this.plan.start || '').match(/^(\d{1,2}):(\d{2})$/);
    const d = new Date();
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
    this.saved = { ...this.saved, source: 'pco', serviceTypeId, planId };
    if (!same && !keepProgress) this.saved = { ...this.saved, current: null, actuals: {} };
    this.save();
    await this.reloadPco();
    if (!same) this.emit('planLoaded');
  }

  /** Manual plan from lines like "5:00 Welcome", "# Worship" (header), "Song: 4:30 Holy Forever". */
  setManual({ title, text, start }) {
    const items = parsePlanText(text);
    // Optional service start time ("09:30"); applied to today's date in state().
    const m = String(start || '').match(/^(\d{1,2}):(\d{2})$/);
    this.saved = {
      ...this.saved,
      source: 'manual',
      serviceTypeId: null,
      planId: null,
      manual: { title: title || 'Service', seriesTitle: null, dates: null, times: [], items, text, start: m ? start : '' },
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
    if (!this.cfg.followProPresenter || !this.plan || !name) return;
    const items = this.plan.items.filter((i) => i.type !== 'header');
    const want = normalize(name);
    if (!want) return;
    const idx = this.plan.items.findIndex((i) => i.id === this.saved.current?.itemId);
    const matches = items.filter((i) => {
      const t = normalize(i.title);
      return t && (t === want || (t.length > 3 && want.includes(t)) || (want.length > 3 && t.includes(want)));
    });
    if (!matches.length) return;
    // Prefer the first match at or after the current position (songs can repeat).
    const pick = matches.find((m) => this.plan.items.indexOf(m) >= idx) || matches[0];
    if (pick.id !== this.saved.current?.itemId) this.setCurrent(pick.id, 'propresenter');
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
