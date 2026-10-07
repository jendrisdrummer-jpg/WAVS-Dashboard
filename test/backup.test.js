import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { OrgRegistry } from '../server/orgs.js';
import { Auth } from '../server/auth.js';
import { createBackup, readBackup, importBackup, isEncrypted } from '../server/backup.js';

function computer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-'));
  return { dir, orgs: new OrgRegistry(dir), auth: new Auth(dir) };
}

test('move an organization (with photos and accounts) to another computer', () => {
  const mac = computer();
  const church = mac.orgs.create('Grace Church', { mics: { receivers: [{ name: 'Rack A', host: '10.0.0.5', channels: [{ label: 'Pastor' }] }] } });
  const company = mac.orgs.create('WAVS Events');
  fs.mkdirSync(path.join(mac.orgs.dir(church), 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(mac.orgs.dir(church), 'uploads', 'pastor.jpg'), Buffer.from([0xff, 0xd8, 1, 2, 3]));
  fs.writeFileSync(path.join(mac.orgs.dir(church), 'comms.json'), '{"members":[{"name":"Sam"}]}');
  const owner = mac.auth.createOwner({ name: 'Jon', username: 'jon', password: 'password1' });
  const inv = mac.auth.invite({ orgId: church, role: 'crew', by: owner.id });
  mac.auth.acceptInvite(inv.code, { name: 'Casey', username: 'casey', password: 'password2' });
  const inv2 = mac.auth.invite({ orgId: company, role: 'producer', by: owner.id });
  mac.auth.acceptInvite(inv2.code, { name: 'Pat', username: 'pat', password: 'password3' });

  const file = createBackup({ orgs: mac.orgs, auth: mac.auth, orgIds: [church], password: 'secret pw' });
  assert.ok(isEncrypted(file));
  assert.throws(() => readBackup(file), /protected with a password/);
  assert.throws(() => readBackup(file, 'nope'), /doesn't open/);
  const data = readBackup(file, 'secret pw');
  assert.deepEqual(data.users.map((u) => u.username).sort(), ['casey', 'jon'], 'only people with access to that org (and the owner)');

  const pc = computer(); // a fresh computer at church
  const r = importBackup({ data, orgs: pc.orgs, auth: pc.auth });
  assert.equal(r.imported[0].name, 'Grace Church');
  assert.equal(pc.orgs.read(church).mics.receivers[0].host, '10.0.0.5');
  assert.deepEqual([...fs.readFileSync(path.join(pc.orgs.dir(church), 'uploads', 'pastor.jpg'))], [0xff, 0xd8, 1, 2, 3]);
  assert.ok(fs.existsSync(path.join(pc.orgs.dir(church), 'comms.json')));
  // people sign in with the same passwords; the old owner becomes owner on a computer without one
  assert.ok(pc.auth.login('casey', 'password2'));
  assert.equal(pc.auth.roleIn(pc.auth.byName('casey'), church), 'crew');
  assert.equal(pc.auth.byName('jon').owner, true);
  assert.equal(pc.auth.byName('pat'), undefined);
});

test('importing again: replace or keep both; existing accounts keep their password', () => {
  const a = computer();
  const id = a.orgs.create('Grace Church', { org: { serviceName: 'Sunday 9' } });
  const data = readBackup(createBackup({ orgs: a.orgs, auth: a.auth, orgIds: [id] }));
  const b = computer();
  b.auth.createOwner({ name: 'Other', username: 'other', password: 'password9' });
  importBackup({ data, orgs: b.orgs, auth: b.auth, choices: { [id]: 'new' } });
  const r = importBackup({ data, orgs: b.orgs, auth: b.auth, choices: { [id]: 'new' } });
  assert.equal(r.imported[0].id, `${id}-2`, 'a second copy gets its own id');
  b.orgs.write(id, { ...b.orgs.read(id), org: { ...b.orgs.read(id).org, serviceName: 'changed here' } });
  importBackup({ data, orgs: b.orgs, auth: b.auth, choices: { [id]: 'replace' } });
  assert.equal(b.orgs.read(id).org.serviceName, 'Sunday 9');
  assert.equal(b.auth.byName('other').owner, true, 'existing owner stays');
  // the default when the org already exists is to skip, never overwrite silently
  assert.equal(importBackup({ data, orgs: b.orgs, auth: b.auth }).imported.length, 0);
});

test('a crafted backup cannot write outside the organization folder', () => {
  const a = computer();
  const evil = { format: 'wavs-backup', version: 1, orgs: [{ id: 'x', name: 'X', files: { '../../evil.txt': Buffer.from('hi').toString('base64'), 'settings.json': Buffer.from('{}').toString('base64') } }], users: [] };
  const data = readBackup(zlib.gzipSync(Buffer.from(JSON.stringify(evil))));
  importBackup({ data, orgs: a.orgs, auth: a.auth });
  assert.equal(fs.existsSync(path.join(a.dir, 'evil.txt')), false);
  assert.equal(fs.existsSync(path.join(a.dir, '..', 'evil.txt')), false);
  assert.throws(() => readBackup(Buffer.from('not a backup')), /isn't a WAVS Dashboard backup/);
});
