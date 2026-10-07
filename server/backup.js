import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

/**
 * Moving organizations between computers (e.g. the Mac that hosts WAVS events and the church's
 * computer). A backup file holds one or more organizations — settings and gear, people and
 * photos, dashboards, notes, plans, comms and logo — plus the accounts that have a role in them
 * (with their scrambled passwords, so people keep signing in the same way).
 *
 * File: gzip(JSON). With a password: "WAVSENC1" + salt + iv + tag + AES-256-GCM(gzip(JSON)).
 * The computer-specific bits (certificate, Cloudflare connector, sessions) are not included.
 */
const MAGIC = Buffer.from('WAVSENC1');
const FORMAT = 'wavs-backup';

function listFiles(dir, base = dir) {
  const out = [];
  for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) out.push(...listFiles(p, base));
    else if (!it.name.endsWith('.tmp')) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

const keyFrom = (password, salt) => crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 });

/** Build a backup file for the given organizations. */
export function createBackup({ orgs, auth, orgIds, password = '' }) {
  const list = orgIds.map((id) => {
    const entry = orgs.data.orgs.find((o) => o.id === id);
    if (!entry) throw new Error(`Unknown organization ${id}`);
    const dir = orgs.dir(id);
    const files = {};
    if (fs.existsSync(dir)) for (const rel of listFiles(dir)) files[rel] = fs.readFileSync(path.join(dir, rel)).toString('base64');
    return { id, name: entry.name, files };
  });
  const users = auth.data.users
    .filter((u) => u.owner || orgIds.some((id) => u.roles?.[id]))
    .map(({ id, name, username, pass, owner, roles, createdAt }) => ({
      id, name, username, pass, owner: Boolean(owner),
      roles: Object.fromEntries(Object.entries(roles || {}).filter(([k]) => orgIds.includes(k))),
      createdAt,
    }));
  const json = Buffer.from(JSON.stringify({ format: FORMAT, version: 1, createdAt: new Date().toISOString(), orgs: list, users }));
  const gz = zlib.gzipSync(json);
  if (!password) return gz;
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFrom(password, salt), iv);
  const body = Buffer.concat([c.update(gz), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), body]);
}

export const isEncrypted = (buf) => buf.subarray(0, MAGIC.length).equals(MAGIC);

/** Open a backup file (asks for the password if it has one). */
export function readBackup(buf, password = '') {
  let gz = buf;
  if (isEncrypted(buf)) {
    if (!password) throw Object.assign(new Error('This backup is protected with a password'), { needsPassword: true });
    const salt = buf.subarray(8, 24);
    const iv = buf.subarray(24, 36);
    const tag = buf.subarray(36, 52);
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(password, salt), iv);
      d.setAuthTag(tag);
      gz = Buffer.concat([d.update(buf.subarray(52)), d.final()]);
    } catch {
      throw Object.assign(new Error("That password doesn't open this backup"), { needsPassword: true });
    }
  }
  let data;
  try { data = JSON.parse(zlib.gunzipSync(gz).toString('utf8')); } catch { throw new Error("This isn't a WAVS Dashboard backup file"); }
  if (data.format !== FORMAT || !Array.isArray(data.orgs)) throw new Error("This isn't a WAVS Dashboard backup file");
  return data;
}

/**
 * Bring organizations from a backup into this computer.
 * choices: { [orgIdInBackup]: 'new' | 'replace' | 'skip' }   ('replace' only if it exists here)
 * Returns { imported: [{ from, id, name, mode }], users: { added, updated } }
 */
export function importBackup({ data, orgs, auth, choices = {} }) {
  const imported = [];
  const idMap = {};
  for (const o of data.orgs) {
    const mode = choices[o.id] || (orgs.data.orgs.some((x) => x.id === o.id) ? 'skip' : 'new');
    if (mode === 'skip') continue;
    let id = o.id;
    if (mode === 'new') {
      for (let i = 2; orgs.data.orgs.some((x) => x.id === id); i++) id = `${o.id}-${i}`;
      orgs.data.orgs.push({ id, name: o.name });
      orgs.save();
    } else if (!orgs.data.orgs.some((x) => x.id === id)) {
      throw new Error(`${o.name} doesn't exist on this computer, so it can't be replaced`);
    }
    const dir = orgs.dir(id);
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [rel, b64] of Object.entries(o.files)) {
      const target = path.resolve(dir, rel);
      if (!target.startsWith(path.resolve(dir) + path.sep)) continue; // never write outside the org folder
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(b64, 'base64'));
    }
    const entry = orgs.data.orgs.find((x) => x.id === id);
    try { entry.name = orgs.read(id).org.name || o.name; } catch { entry.name = o.name; }
    orgs.save();
    idMap[o.id] = id;
    imported.push({ from: o.id, id, name: entry.name, mode });
  }

  // Accounts: people keep their sign-in. Existing accounts (same email/username) keep their
  // password here and just gain the roles; new ones are added with the password they had.
  let added = 0;
  let updated = 0;
  const hadOwner = auth.data.users.some((u) => u.owner);
  for (const u of data.users || []) {
    const roles = {};
    for (const [from, role] of Object.entries(u.roles || {})) if (idMap[from]) roles[idMap[from]] = role;
    // The old owner was admin everywhere; keep them admin of what was brought over.
    if (u.owner) for (const id of Object.values(idMap)) roles[id] = 'admin';
    const existing = auth.byName(u.username);
    if (existing) {
      if (!existing.owner) existing.roles = { ...existing.roles, ...roles };
      updated++;
    } else {
      if (!Object.keys(roles).length && !(u.owner && !hadOwner)) continue;
      auth.data.users.push({
        id: crypto.randomUUID(), name: u.name, username: u.username, key: String(u.username).trim().toLowerCase(),
        pass: u.pass, owner: Boolean(u.owner && !hadOwner), roles, createdAt: u.createdAt || new Date().toISOString(),
      });
      added++;
    }
  }
  if (added || updated) auth.save();
  return { imported, users: { added, updated } };
}
