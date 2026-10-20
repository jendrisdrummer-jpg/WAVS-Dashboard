import crypto from 'node:crypto';
import { place } from './docs.js';

/**
 * The website's own settings (WAVS_HOSTED=1), changed by the site owner in Settings:
 *
 *   signups   'open'   anyone can create an account and an organization
 *             'code'   only with the beta code (the default)
 *             'closed' no new accounts (invites to an organization still work)
 *
 * Saved as site.json next to the accounts.
 */
export const SIGNUPS = ['open', 'code', 'closed'];
const newCode = () => crypto.randomBytes(4).toString('hex').toUpperCase();

export class Site {
  constructor(target) {
    ({ docs: this.docs, key: this.key } = place(target, 'site.json'));
    this.data = { name: 'WAVS Dashboard', signups: 'code', code: null, ...(this.docs.get(this.key) || {}) };
    if (!this.data.code) { this.data.code = newCode(); this.save(); }
    this.unwatch = this.docs.watch(this.key, (d) => { if (d) this.data = { ...this.data, ...d }; });
  }

  save() { this.docs.put(this.key, this.data); }

  get name() { return this.data.name; }
  get signups() { return this.data.signups; }

  /** Is a sign-up allowed? The owner's email (WAVS_OWNER_EMAIL) always is, until the owner exists. */
  check(code, { ownerSignup = false } = {}) {
    if (ownerSignup) return;
    if (this.data.signups === 'closed') throw new Error('Sign-ups are closed for now. Ask for an invite link.');
    if (this.data.signups === 'code') {
      const a = Buffer.from(String(code || '').trim().toUpperCase());
      const b = Buffer.from(this.data.code);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('That beta code isn\'t right');
    }
  }

  update({ signups, newCode: renew, name } = {}) {
    if (signups !== undefined) {
      if (!SIGNUPS.includes(signups)) throw new Error('Unknown sign-up setting');
      this.data.signups = signups;
    }
    if (renew) this.data.code = newCode();
    if (name !== undefined) this.data.name = String(name).trim().slice(0, 60) || 'WAVS Dashboard';
    this.save();
    return this.view();
  }

  view() { return { name: this.data.name, signups: this.data.signups, code: this.data.code }; }
}
