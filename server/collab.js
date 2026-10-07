import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

class JsonFile extends EventEmitter {
  constructor(file, initial) {
    super();
    this.file = file;
    this.data = initial;
    if (fs.existsSync(file)) {
      try { this.data = { ...initial, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) {
        console.error(`[store] could not read ${file}: ${e.message}`);
      }
    }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    this.emit('change', this.data);
  }
}

const key = (k) => {
  const clean = String(k || '').toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(0, 40);
  if (!clean) throw new Error('Invalid name');
  return clean;
};

/**
 * Shared notes and checklists. Several widgets on different dashboards can show the same
 * note or checklist by using the same name (e.g. "producer", "stage-setup").
 */
export class Board extends JsonFile {
  constructor(dataDir) {
    super(path.join(dataDir, 'board.json'), { notes: {}, checklists: {} });
  }

  setNote(name, text) {
    this.data.notes[key(name)] = { text: String(text ?? '').slice(0, 20000), updatedAt: new Date().toISOString() };
    this.save();
  }

  setChecklist(name, { title, text }) {
    // Text form: "# Section" lines start a section, every other line is an item.
    const k = key(name);
    const old = this.data.checklists[k]?.items || [];
    let section = '';
    const items = [];
    for (const raw of String(text ?? '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#')) { section = line.replace(/^#+\s*/, ''); continue; }
      const kept = old.find((o) => o.text === line && o.section === section);
      items.push({ id: kept?.id || crypto.randomUUID(), text: line.slice(0, 200), section, done: kept?.done || false });
    }
    this.data.checklists[k] = { title: String(title || this.data.checklists[k]?.title || 'Checklist').slice(0, 80), items };
    this.save();
  }

  toggle(name, itemId, done) {
    const item = this.data.checklists[key(name)]?.items.find((i) => i.id === itemId);
    if (!item) throw new Error('Checklist item not found');
    item.done = typeof done === 'boolean' ? done : !item.done;
    item.doneAt = item.done ? new Date().toISOString() : null;
    this.save();
  }

  resetChecklist(name) {
    for (const i of this.data.checklists[key(name)]?.items || []) { i.done = false; i.doneAt = null; }
    this.save();
  }
}

/** Saved dashboard layouts (one per role / screen). */
export class Dashboards extends JsonFile {
  constructor(dataDir, defaults) {
    super(path.join(dataDir, 'dashboards.json'), { dashboards: [] });
    if (!this.data.dashboards.length) {
      this.data.dashboards = defaults;
      this.save();
    }
  }

  list() { return this.data.dashboards; }

  create({ name, copyFrom }) {
    const src = copyFrom && this.data.dashboards.find((d) => d.id === copyFrom);
    const d = {
      id: crypto.randomUUID(),
      name: String(name || 'New dashboard').slice(0, 60),
      rows: src?.rows || 12,
      scale: src?.scale || 100,
      widgets: src ? structuredClone(src.widgets).map((w) => ({ ...w, id: crypto.randomUUID() })) : [],
    };
    d.slug = this.uniqueSlug(d.name);
    this.data.dashboards.push(d);
    this.save();
    return d;
  }

  update(id, { name, rows, scale, widgets }) {
    const d = this.data.dashboards.find((x) => x.id === id);
    if (!d) throw new Error('Dashboard not found');
    if (typeof name === 'string' && name.trim() && name !== d.name) { d.name = name.trim().slice(0, 60); d.slug = this.uniqueSlug(d.name, id); }
    if (Number.isFinite(rows)) d.rows = Math.min(40, Math.max(4, Math.round(rows)));
    if (Number.isFinite(scale)) d.scale = Math.min(200, Math.max(40, Math.round(scale)));
    if (Array.isArray(widgets)) {
      d.widgets = widgets.slice(0, 80).map((w) => ({
        id: String(w.id || crypto.randomUUID()),
        type: String(w.type),
        x: int(w.x), y: int(w.y), w: Math.max(1, int(w.w)), h: Math.max(1, int(w.h)),
        options: w.options && typeof w.options === 'object' ? w.options : {},
      }));
    }
    this.save();
    return d;
  }

  remove(id) {
    if (this.data.dashboards.length <= 1) throw new Error('Keep at least one dashboard');
    this.data.dashboards = this.data.dashboards.filter((d) => d.id !== id);
    this.save();
  }

  uniqueSlug(name, selfId) {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'dashboard';
    let slug = base;
    for (let i = 2; this.data.dashboards.some((d) => d.slug === slug && d.id !== selfId); i++) slug = `${base}-${i}`;
    return slug;
  }
}

const int = (v) => Math.max(0, Math.min(200, Math.round(Number(v) || 0)));
