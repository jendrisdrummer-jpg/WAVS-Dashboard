import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Accounts for the dashboard. They belong to this computer and each account has a role per
 * organization (the church and the company can have different teams):
 *
 *   admin     everything: gear, settings, organizations, accounts, updates
 *   producer  runs the event: service plan, people & mics, dashboards, comms control
 *   crew      green room hand-offs, notes and checklists
 *
 * The first account is the owner: admin in every organization, and can't be removed.
 * New people join through invite links an admin creates (role and organization preset).
 * Until the first account exists the dashboard works as before (open, or the admin PIN).
 */
export const ROLES = ['crew', 'producer', 'admin'];
export const RANK = { crew: 1, producer: 2, admin: 3 };
const SESSION_DAYS = 30;

const str = (v, max = 80) => String(v ?? '').trim().slice(0, max);
const key = (username) => str(username).toLowerCase();
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function checkPassword(stored, password) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt') return false;
  const want = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(String(password ?? ''), Buffer.from(salt, 'base64'), want.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(want, got);
}

function validPassword(pw) {
  if (String(pw ?? '').length < 8) throw new Error('Use at least 8 characters for the password');
  return String(pw);
}

export class Auth {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'users.json');
    this.sessionsFile = path.join(dataDir, 'sessions.json');
    this.data = { users: [], invites: [], requireLogin: false };
    this.sessions = {};
    try { this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch { /* no accounts yet */ }
    try { this.sessions = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8')); } catch { /* none */ }
    this.failures = new Map();
  }

  save() {
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }

  saveSessions() {
    clearTimeout(this.sessTimer);
    this.sessTimer = setTimeout(() => {
      fs.writeFileSync(`${this.sessionsFile}.tmp`, JSON.stringify(this.sessions), { mode: 0o600 });
      fs.renameSync(`${this.sessionsFile}.tmp`, this.sessionsFile);
    }, 500);
  }

  get enabled() { return this.data.users.length > 0; }

  user(id) { return this.data.users.find((u) => u.id === id); }

  byName(username) { return this.data.users.find((u) => u.key === key(username)); }

  /** The role this user has in an organization (null = no access). */
  roleIn(user, orgId) {
    if (!user) return null;
    if (user.owner) return 'admin';
    return user.roles?.[orgId] || null;
  }

  rank(user, orgId) { return RANK[this.roleIn(user, orgId)] || 0; }

  /** What the browser may know about an account. */
  view(u, orgId) {
    return { id: u.id, name: u.name, username: u.username, owner: Boolean(u.owner), role: this.roleIn(u, orgId), roles: u.roles, createdAt: u.createdAt, lastSeen: u.lastSeen || null };
  }

  // ---------------------------------------------------------------- accounts

  create({ name, username, password, owner = false, roles = {} }) {
    if (!str(name)) throw new Error('Enter your name');
    if (!str(username)) throw new Error('Enter an email or username');
    if (this.byName(username)) throw new Error('That email or username already has an account. Sign in instead.');
    const u = {
      id: crypto.randomUUID(), name: str(name, 60), username: str(username), key: key(username),
      pass: hashPassword(validPassword(password)), owner, roles, createdAt: new Date().toISOString(),
    };
    this.data.users.push(u);
    this.save();
    return u;
  }

  /** The very first account: the owner (admin everywhere). */
  createOwner(info) {
    if (this.enabled) throw new Error('The owner account already exists');
    return this.create({ ...info, owner: true });
  }

  setRole(userId, orgId, role) {
    const u = this.user(userId);
    if (!u) throw new Error('Unknown account');
    if (u.owner) throw new Error('The owner is an admin everywhere');
    if (role && !ROLES.includes(role)) throw new Error('Unknown role');
    u.roles = { ...u.roles };
    if (role) u.roles[orgId] = role; else delete u.roles[orgId];
    this.save();
  }

  remove(userId) {
    const u = this.user(userId);
    if (!u) throw new Error('Unknown account');
    if (u.owner) throw new Error("The owner account can't be removed");
    this.data.users = this.data.users.filter((x) => x.id !== userId);
    for (const [t, s] of Object.entries(this.sessions)) if (s.userId === userId) delete this.sessions[t];
    this.save();
    this.saveSessions();
  }

  /** Admin resets someone's password: returns a temporary one to pass on. */
  resetPassword(userId) {
    const u = this.user(userId);
    if (!u) throw new Error('Unknown account');
    const temp = crypto.randomBytes(6).toString('base64url');
    u.pass = hashPassword(temp);
    for (const [t, s] of Object.entries(this.sessions)) if (s.userId === userId) delete this.sessions[t];
    this.save();
    this.saveSessions();
    return temp;
  }

  changePassword(userId, current, next) {
    const u = this.user(userId);
    if (!u || !checkPassword(u.pass, current)) throw new Error('Your current password is not right');
    u.pass = hashPassword(validPassword(next));
    this.save();
  }

  setRequireLogin(on) {
    this.data.requireLogin = Boolean(on);
    this.save();
  }

  // ---------------------------------------------------------------- sign in

  tooMany(ip) {
    const f = this.failures.get(ip);
    return f && Date.now() - f.at < 10 * 60000 && f.n >= 10;
  }

  failed(ip) {
    const f = this.failures.get(ip);
    const now = Date.now();
    this.failures.set(ip, f && now - f.at < 10 * 60000 ? { n: f.n + 1, at: f.at } : { n: 1, at: now });
  }

  /** Returns a session token for a correct username + password. */
  login(username, password, ip = '') {
    if (this.tooMany(ip)) throw new Error('Too many wrong tries. Wait 10 minutes and try again.');
    const u = this.byName(username);
    if (!u || !checkPassword(u.pass, password)) {
      this.failed(ip);
      throw new Error('That email/username or password is not right');
    }
    return this.startSession(u);
  }

  startSession(u) {
    const token = crypto.randomBytes(24).toString('base64url');
    this.sessions[sha(token)] = { userId: u.id, expires: Date.now() + SESSION_DAYS * 86400000 };
    u.lastSeen = new Date().toISOString();
    this.save();
    this.saveSessions();
    return token;
  }

  logout(token) {
    if (token) { delete this.sessions[sha(token)]; this.saveSessions(); }
  }

  /** The signed-in account for a session token, or null. Sessions slide forward while used. */
  session(token) {
    if (!token) return null;
    const s = this.sessions[sha(token)];
    if (!s) return null;
    if (s.expires < Date.now()) { delete this.sessions[sha(token)]; this.saveSessions(); return null; }
    const u = this.user(s.userId);
    if (!u) return null;
    if (s.expires - Date.now() < (SESSION_DAYS - 1) * 86400000) {
      s.expires = Date.now() + SESSION_DAYS * 86400000;
      this.saveSessions();
    }
    return u;
  }

  // ---------------------------------------------------------------- invites

  invite({ orgId, role, by, days = 7, label = '' }) {
    if (!ROLES.includes(role)) throw new Error('Unknown role');
    const inv = {
      code: crypto.randomBytes(12).toString('base64url'), orgId, role, by, label: str(label, 60),
      createdAt: new Date().toISOString(), expires: Date.now() + Math.min(Math.max(Number(days) || 7, 1), 90) * 86400000, used: 0,
    };
    this.data.invites = [...this.data.invites.filter((i) => i.expires > Date.now()), inv];
    this.save();
    return inv;
  }

  findInvite(code) {
    const inv = this.data.invites.find((i) => i.code === code);
    return inv && inv.expires > Date.now() ? inv : null;
  }

  revokeInvite(code) {
    this.data.invites = this.data.invites.filter((i) => i.code !== code);
    this.save();
  }

  /** Accept an invite: a new account, or an existing one (with its password) gets the role. */
  acceptInvite(code, { name, username, password }, ip = '') {
    const inv = this.findInvite(code);
    if (!inv) throw new Error('This invite link has expired or was cancelled. Ask for a new one.');
    let u = this.byName(username);
    if (u) {
      if (this.tooMany(ip)) throw new Error('Too many wrong tries. Wait 10 minutes and try again.');
      if (!checkPassword(u.pass, password)) { this.failed(ip); throw new Error('That account exists. Enter its password to add this access to it.'); }
    } else {
      u = this.create({ name, username, password });
    }
    // Never lower someone's existing role through an invite.
    if (!u.owner && (RANK[u.roles?.[inv.orgId]] || 0) < RANK[inv.role]) {
      u.roles = { ...u.roles, [inv.orgId]: inv.role };
    }
    inv.used++;
    this.save();
    return { user: u, token: this.startSession(u) };
  }
}

/** Read the session cookie from a request (no cookie library needed). */
export function sessionToken(req) {
  const m = /(?:^|;\s*)wavs_session=([^;]+)/.exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : null;
}

export function sessionCookie(token, { secure = false } = {}) {
  return `wavs_session=${token ? encodeURIComponent(token) : ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? SESSION_DAYS * 86400 : 0}${secure ? '; Secure' : ''}`;
}
