import { EventEmitter } from 'node:events';

/**
 * Central live state. Drivers write into it, the WebSocket layer broadcasts changes.
 *
 * sections: receivers, mics, propresenter, switchers  (keyed by id)
 * Fast-changing meter values (RF / audio) go through `meter()` and are batched,
 * so they don't flood clients with full-object updates.
 */
export class Hub extends EventEmitter {
  constructor() {
    super();
    this.state = { receivers: {}, mics: {}, propresenter: {}, switchers: {} };
    this.pendingMeters = {};
    this.timer = setInterval(() => this.flushMeters(), 100);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.removeAllListeners();
  }

  /** Shallow-merge `data` into state[section][id]; emits only when something changed. */
  update(section, id, data) {
    const prev = this.state[section][id] || {};
    let changed = !this.state[section][id];
    for (const [k, v] of Object.entries(data)) {
      if (JSON.stringify(prev[k]) !== JSON.stringify(v)) { changed = true; break; }
    }
    if (!changed) return;
    const next = { ...prev, ...data, id };
    this.state[section][id] = next;
    this.emit('update', { section, id, data: next });
  }

  remove(section, id) {
    if (!this.state[section][id]) return;
    delete this.state[section][id];
    this.emit('update', { section, id, data: null });
  }

  /** High-rate values: { rfDbm, audioDbfs, antenna }. Stored and sent at most 10x/sec. */
  meter(micId, values) {
    const mic = this.state.mics[micId];
    if (mic) Object.assign(mic, values);
    this.pendingMeters[micId] = { ...(this.pendingMeters[micId] || {}), ...values };
  }

  flushMeters() {
    if (!Object.keys(this.pendingMeters).length) return;
    const meters = this.pendingMeters;
    this.pendingMeters = {};
    this.emit('meters', meters);
  }
}
