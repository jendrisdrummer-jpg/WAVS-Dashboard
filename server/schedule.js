import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

/**
 * Services planned ahead: a conference's sessions (grouped as an "event"), next month's Sundays,
 * weekly ones from a recurring template. Each service has its own name and start, order of
 * service, who has which mic, notes and (optionally) the ProPresenter playlist it uses.
 * Dashboards and the comms roster are the same for every service.
 *
 * One service is live at a time. Going live loads it into the green room and the service plan
 * (Runtime.goLive); changes made while it's live are saved back to it. The next service goes live
 * by itself shortly before it starts (see due()), or with "Next service" on the Home page.
 *
 * Times are the dashboard computer's local time, "2026-05-03T19:00".
 */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const SOURCES = ['', 'manual', 'propresenter', 'pco'];
const DAY = 24 * 3600 * 1000;
const str = (v, max) => String(v ?? '').trim().slice(0, max);

/** "2026-05-03" for a Date, in local time. */
export const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function cleanPlan(p = {}) {
  const source = SOURCES.includes(p.source) ? p.source : '';
  return {
    source,
    text: source === 'manual' ? str(p.text, 20000) : '',
    playlist: str(p.playlist, 120), // ProPresenter playlist this service uses ('' = whatever is active)
    serviceTypeId: source === 'pco' ? str(p.serviceTypeId, 40) : '',
    planId: source === 'pco' ? str(p.planId, 40) : '',
    pcoTitle: source === 'pco' ? str(p.pcoTitle, 200) : '',
  };
}

function cleanMics(m = {}) {
  const out = {};
  for (const [mic, a] of Object.entries(m || {}).slice(0, 200)) {
    const personId = str(a?.personId, 64);
    if (personId) out[str(mic, 80)] = { personId, ...(a.note ? { note: str(a.note, 200) } : {}) };
  }
  return out;
}

export class Schedule extends EventEmitter {
  constructor(dataDir) {
    super();
    this.file = path.join(dataDir, 'schedule.json');
    this.data = { services: [], events: [], templates: [], liveId: null, auto: true, leadMinutes: 90 };
    if (fs.existsSync(this.file)) {
      try { this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch (e) {
        console.error(`[schedule] could not read ${this.file}: ${e.message}`);
      }
    }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    this.emit('change', this.view());
  }

  view() {
    const services = [...this.data.services].sort((a, b) => a.start.localeCompare(b.start));
    const live = this.live();
    return { ...this.data, services, nextId: this.next()?.id || null, switchAt: live || services.length ? this.switchAt : null };
  }

  get(id) { return this.data.services.find((s) => s.id === id); }
  live() { return this.get(this.data.liveId) || null; }

  /** The service after the live one (or the next upcoming one): what "Next service" goes to. */
  next(now = Date.now()) {
    const live = this.live();
    const planned = this.data.services.filter((s) => s.state === 'planned').sort((a, b) => a.start.localeCompare(b.start));
    if (live) return planned.find((s) => s.start > live.start) || null;
    return planned.find((s) => new Date(s.start).getTime() + 4 * 3600 * 1000 > now) || null;
  }

  /**
   * Is it time for the next service to go live by itself? Usually leadMinutes before it starts;
   * if the live one is still running then, wait until it's expected to end (liveEnd), but no later
   * than 15 minutes before the next one starts.
   */
  due(now = Date.now(), liveEnd = null) {
    this.switchAt = null;
    if (!this.data.auto) return null;
    const next = this.next(now);
    if (!next) return null;
    const start = new Date(next.start).getTime();
    if (start + 4 * 3600 * 1000 < now) return null; // long gone: don't jump to it
    const lead = (this.data.leadMinutes || 90) * 60000;
    let at = start - lead;
    if (this.live() && liveEnd) at = Math.min(start - 15 * 60000, Math.max(at, liveEnd + 10 * 60000));
    this.switchAt = new Date(at).toISOString();
    return now >= at ? next : null;
  }

  // ---------------------------------------------------------------- services

  clean(fields, base = {}) {
    const s = { ...base };
    if (fields.name !== undefined) s.name = str(fields.name, 120) || 'Service';
    if (fields.start !== undefined) {
      if (!TIME.test(String(fields.start))) throw new Error('Pick a date and start time');
      s.start = String(fields.start);
    }
    if (fields.eventId !== undefined) {
      const ev = fields.eventId ? str(fields.eventId, 64) : null;
      if (ev && !this.data.events.some((e) => e.id === ev)) throw new Error('Unknown event');
      s.eventId = ev;
    }
    if (fields.plan !== undefined) s.plan = cleanPlan(fields.plan);
    if (fields.mics !== undefined) s.mics = cleanMics(fields.mics);
    if (fields.notes !== undefined) s.notes = str(fields.notes, 4000);
    return s;
  }

  addService(fields) {
    const s = this.clean({ name: 'Service', plan: {}, mics: {}, notes: '', eventId: null, ...fields },
      { id: crypto.randomUUID(), state: 'planned', templateId: null, edited: true });
    if (!s.start) throw new Error('Pick a date and start time');
    this.data.services.push(s);
    this.save();
    return s;
  }

  updateService(id, fields) {
    const s = this.get(id);
    if (!s) throw new Error('Service not found');
    Object.assign(s, this.clean(fields), { edited: true });
    this.save();
    return s;
  }

  removeService(id) {
    const s = this.get(id);
    if (!s) return;
    const t = s.templateId && this.data.templates.find((x) => x.id === s.templateId);
    if (t) t.skip = [...new Set([...(t.skip || []), s.start.slice(0, 10)])].slice(-100); // don't bring it back
    this.data.services = this.data.services.filter((x) => x.id !== id);
    if (this.data.liveId === id) this.data.liveId = null;
    this.save();
  }

  duplicate(id, { start, name } = {}) {
    const s = this.get(id);
    if (!s) throw new Error('Service not found');
    return this.addService({ name: name || `${s.name} (copy)`, start: start || s.start, eventId: s.eventId, plan: s.plan, mics: s.mics, notes: s.notes });
  }

  /** Mark a service live (the previous one is done). Runtime.goLive loads it. */
  setLive(id) {
    const s = this.get(id);
    if (!s) throw new Error('Service not found');
    const prev = this.live();
    if (prev && prev.id !== id) Object.assign(prev, { state: 'done', endedAt: new Date().toISOString() });
    Object.assign(s, { state: 'live', liveAt: new Date().toISOString() });
    this.data.liveId = id;
    // Keep finished services for two months before this one (a record of what happened).
    const cutoff = ymd(new Date(new Date(s.start).getTime() - 60 * DAY));
    this.data.services = this.data.services.filter((x) => x.state !== 'done' || x.start.slice(0, 10) >= cutoff);
    this.save();
    return s;
  }

  /** Changes made while live (mics on Service & People, the typed plan) are kept with the service. */
  syncLive(fields) {
    const s = this.live();
    if (!s) return;
    const next = this.clean(fields);
    const changed = Object.entries(next).some(([k, v]) => JSON.stringify(v) !== JSON.stringify(s[k]));
    if (!changed) return;
    Object.assign(s, next, { edited: true });
    this.save();
  }

  // ---------------------------------------------------------------- events (a conference, a weekend)

  addEvent({ name }) {
    const e = { id: crypto.randomUUID(), name: str(name, 120) || 'Event' };
    this.data.events.push(e);
    this.save();
    return e;
  }

  updateEvent(id, { name }) {
    const e = this.data.events.find((x) => x.id === id);
    if (!e) throw new Error('Event not found');
    e.name = str(name, 120) || e.name;
    this.save();
    return e;
  }

  /** Remove an event; with services too, or keep them as plain services. */
  removeEvent(id, { withServices = false } = {}) {
    this.data.events = this.data.events.filter((e) => e.id !== id);
    if (withServices) this.data.services = this.data.services.filter((s) => s.eventId !== id || s.state === 'live');
    for (const s of this.data.services) if (s.eventId === id) s.eventId = null;
    this.save();
  }

  // ---------------------------------------------------------------- recurring

  /** A weekly (or every-other-week) service, e.g. "Sunday 9:00". */
  saveTemplate(fields) {
    let t = fields.id && this.data.templates.find((x) => x.id === fields.id);
    const weekday = Number(fields.weekday);
    if (!(weekday >= 0 && weekday <= 6)) throw new Error('Pick a day of the week');
    if (!/^\d{2}:\d{2}$/.test(String(fields.time))) throw new Error('Pick a start time');
    const next = {
      name: str(fields.name, 120) || 'Service',
      weekday,
      time: String(fields.time),
      every: Number(fields.every) === 2 ? 2 : 1,
      from: /^\d{4}-\d{2}-\d{2}$/.test(String(fields.from)) ? String(fields.from) : ymd(new Date()),
      weeksAhead: Math.min(26, Math.max(1, Number(fields.weeksAhead) || 8)),
      plan: cleanPlan(fields.plan),
      mics: cleanMics(fields.mics),
      notes: str(fields.notes, 4000),
    };
    if (t) Object.assign(t, next);
    else { t = { id: crypto.randomUUID(), skip: [], ...next }; this.data.templates.push(t); }
    this.materialize({ save: false });
    this.save();
    return t;
  }

  removeTemplate(id, { now = new Date() } = {}) {
    const today = ymd(now);
    // Upcoming copies nobody changed go; changed or past ones stay as normal services.
    this.data.services = this.data.services.filter((s) => s.templateId !== id || s.edited || s.state !== 'planned' || s.start.slice(0, 10) < today);
    for (const s of this.data.services) if (s.templateId === id) s.templateId = null;
    this.data.templates = this.data.templates.filter((t) => t.id !== id);
    this.save();
  }

  /** Dates a template falls on from today to weeksAhead. */
  static dates(t, today = new Date()) {
    const out = [];
    const anchor = new Date(`${t.from}T00:00`);
    while (anchor.getDay() !== t.weekday) anchor.setDate(anchor.getDate() + 1); // first one on/after "from"
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (d < anchor) d.setTime(anchor.getTime());
    const end = new Date(today.getTime() + t.weeksAhead * 7 * DAY);
    for (; d <= end; d.setDate(d.getDate() + 1)) {
      if (d.getDay() !== t.weekday) continue;
      const weeks = Math.round((d - anchor) / (7 * DAY));
      if (t.every === 2 && weeks % 2) continue;
      out.push(ymd(d));
    }
    return out;
  }

  /**
   * Put each template's upcoming services on the schedule (the next weeksAhead weeks). Copies
   * nobody has changed follow the template; changed ones are left alone.
   */
  materialize({ save = true, now = new Date() } = {}) {
    const today = ymd(now);
    let changed = false;
    for (const t of this.data.templates) {
      const want = new Set(Schedule.dates(t, now).filter((d) => !(t.skip || []).includes(d)));
      // Untouched upcoming copies that the template no longer has (e.g. its day changed).
      const before = this.data.services.length;
      this.data.services = this.data.services.filter((s) => s.templateId !== t.id || s.edited || s.state !== 'planned'
        || s.start.slice(0, 10) < today || want.has(s.start.slice(0, 10)));
      changed ||= before !== this.data.services.length;
      for (const date of want) {
        const fields = { name: t.name, start: `${date}T${t.time}`, plan: t.plan, mics: t.mics, notes: t.notes };
        const s = this.data.services.find((x) => x.templateId === t.id && x.start.slice(0, 10) === date);
        if (!s) {
          this.data.services.push({ id: crypto.randomUUID(), state: 'planned', templateId: t.id, edited: false, eventId: null, ...structuredClone(fields) });
          changed = true;
        } else if (!s.edited && s.state === 'planned' && JSON.stringify({ name: s.name, start: s.start, plan: s.plan, mics: s.mics, notes: s.notes }) !== JSON.stringify(fields)) {
          Object.assign(s, structuredClone(fields));
          changed = true;
        }
      }
    }
    if (changed && save) this.save();
    return changed;
  }

  setOptions({ auto, leadMinutes }) {
    if (auto !== undefined) this.data.auto = Boolean(auto);
    if (leadMinutes !== undefined) this.data.leadMinutes = Math.min(600, Math.max(5, Number(leadMinutes) || 90));
    this.save();
  }
}
