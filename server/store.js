import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

/** The colour behind a person's photo on the mic board ("#7c3aed"), or null for automatic. */
const cleanColor = (c) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : null);

export const STATUSES = ['assigned', 'picked-up', 'on-stage', 'returned'];

/**
 * Green room data: people (with photos), which mic each person has, and
 * where they are in the hand-off flow. Persisted to data/greenroom.json so it
 * survives restarts; deliberately a plain JSON file so it's easy to back up or edit.
 */
export class GreenroomStore extends EventEmitter {
  constructor(dataDir) {
    super();
    this.file = path.join(dataDir, 'greenroom.json');
    this.uploads = path.join(dataDir, 'uploads');
    fs.mkdirSync(this.uploads, { recursive: true });
    this.data = { service: { name: null, notes: '' }, people: [], assignments: {} };
    if (fs.existsSync(this.file)) {
      try { this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch (e) {
        console.error(`[store] could not read ${this.file}: ${e.message}`);
      }
    }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    this.emit('change', this.data);
  }

  person(id) { return this.data.people.find((p) => p.id === id); }

  addPerson({ name, role = '', notes = '', photo = null, color = null }) {
    if (!name?.trim()) throw new Error('Name is required');
    const p = { id: crypto.randomUUID(), name: name.trim(), role: role.trim(), notes: notes.trim(), photo, color: cleanColor(color) };
    this.data.people.push(p);
    this.save();
    return p;
  }

  updatePerson(id, fields) {
    const p = this.person(id);
    if (!p) throw new Error('Person not found');
    for (const k of ['name', 'role', 'notes']) if (typeof fields[k] === 'string') p[k] = fields[k].trim();
    if (typeof fields.color === 'string') p.color = cleanColor(fields.color);
    if (fields.photo !== undefined) {
      if (p.photo && p.photo !== fields.photo) { this.deletePhoto(p.photo); delete p.face; }
      p.photo = fields.photo;
    }
    this.save();
    return p;
  }

  /**
   * Where the face is in a person's photo, so every card shape (tall strips, squares, small
   * circles) can keep it in frame. Found in the browser when a photo is added, or set by hand.
   * { x, y } face centre and s face height, as fractions of the photo; ar = photo width / height.
   * { none: true } = no face found (crop as before). by: 'auto' | 'manual' (manual is never
   * replaced by an automatic pass). Ignored if the photo changed since it was measured.
   */
  setFace(id, { photo, face, manual = false } = {}) {
    const p = this.person(id);
    if (!p) throw new Error('Person not found');
    if (!p.photo || photo !== p.photo) return p; // measured an old photo
    if (face === null) { delete p.face; this.save(); return p; }
    if (!manual && p.face?.by === 'manual') return p;
    const num = (v, lo, hi) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < lo || n > hi) throw new Error('Face position is out of range');
      return Math.round(n * 10000) / 10000;
    };
    const ar = num(face?.ar, 0.05, 20);
    p.face = face?.none
      ? { photo, none: true, ar, by: manual ? 'manual' : 'auto' }
      : { photo, x: num(face?.x, 0, 1), y: num(face?.y, 0, 1), s: num(face?.s, 0.01, 1), ar, by: manual ? 'manual' : 'auto' };
    if (Number.isInteger(face?.v) && face.v > 0 && face.v < 100) p.face.v = face.v; // which face finder measured it
    this.save();
    return p;
  }

  removePerson(id) {
    const p = this.person(id);
    if (!p) return;
    if (p.photo) this.deletePhoto(p.photo);
    this.data.people = this.data.people.filter((x) => x.id !== id);
    for (const [mic, a] of Object.entries(this.data.assignments)) if (a.personId === id) delete this.data.assignments[mic];
    this.save();
  }

  deletePhoto(file) {
    const full = path.join(this.uploads, path.basename(file));
    fs.rm(full, { force: true }, () => {});
  }

  assign(micId, { personId, status, note }) {
    const prev = this.data.assignments[micId] || {};
    const next = { ...prev, updatedAt: new Date().toISOString() };
    if (personId !== undefined) {
      if (personId && !this.person(personId)) throw new Error('Person not found');
      next.personId = personId;
      if (!prev.personId || prev.personId !== personId) next.status = 'assigned';
    }
    if (status !== undefined) {
      if (!STATUSES.includes(status)) throw new Error(`Status must be one of ${STATUSES.join(', ')}`);
      next.status = status;
    }
    if (note !== undefined) next.note = String(note).slice(0, 200);
    if (!next.personId) delete this.data.assignments[micId];
    else this.data.assignments[micId] = next;
    this.save();
    return this.data.assignments[micId] || null;
  }

  clearAssignments() {
    this.data.assignments = {};
    this.save();
  }

  setService(fields) {
    this.data.service = { ...this.data.service, ...fields };
    this.save();
  }
}
