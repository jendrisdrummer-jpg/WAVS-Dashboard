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
      if (p.photo && p.photo !== fields.photo) this.deletePhoto(p.photo);
      p.photo = fields.photo;
    }
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
