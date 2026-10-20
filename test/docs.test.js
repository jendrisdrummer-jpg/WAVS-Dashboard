import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { FileDocs, MongoDocs, copyAll, mongoHost, LOCAL_ONLY } from '../server/docs.js';
import { OrgRegistry } from '../server/orgs.js';
import { Auth } from '../server/auth.js';
import { GreenroomStore } from '../server/store.js';
import { Schedule } from '../server/schedule.js';
import { createBackup, readBackup, importBackup } from '../server/backup.js';

// MongoDB tests run when WAVS_TEST_MONGODB is set (a replica set, e.g. a local test server:
// docker run -p 27017:27017 mongo:7 --replSet rs0, then rs.initiate()).
const MONGO = process.env.WAVS_TEST_MONGODB;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wavs-docs-'));
const mongo = (opts = {}) => MongoDocs.connect(MONGO, { dbName: opts.dbName || `wavs_test_${crypto.randomBytes(4).toString('hex')}`, timeoutMs: 3000, ...opts });
const until = async (fn, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (fn()) return true;
  return false;
};

async function basics(docs) {
  assert.equal(docs.get('orgs/a/greenroom.json'), undefined);
  docs.put('orgs/a/greenroom.json', { people: [{ id: 'p1', name: 'Sam' }], assignments: { 'rx1.1': { personId: 'p1' } } });
  docs.put('orgs/b/settings.json', { org: { name: 'B' } });
  assert.deepEqual(docs.get('orgs/a/greenroom.json').assignments, { 'rx1.1': { personId: 'p1' } }, 'mic ids with dots survive');
  const got = docs.get('orgs/a/greenroom.json');
  got.people.push({ id: 'p2' });
  assert.equal(docs.get('orgs/a/greenroom.json').people.length, 1, 'callers get their own copy');
  await docs.putFile('orgs/a/uploads/x.jpg', Buffer.from([0xff, 0xd8, 9]), 'image/jpeg');
  assert.deepEqual([...(await docs.getFile('orgs/a/uploads/x.jpg')).data], [0xff, 0xd8, 9]);
  assert.equal((await docs.getFile('orgs/a/uploads/x.jpg')).type, 'image/jpeg');
  assert.equal(await docs.getFile('orgs/a/uploads/missing.jpg'), null);
  assert.deepEqual(docs.list('orgs/a/'), ['orgs/a/greenroom.json', 'orgs/a/uploads/x.jpg']);
  assert.deepEqual(docs.list('orgs/b/set'), ['orgs/b/settings.json']);
  await docs.removeFile('orgs/a/uploads/x.jpg');
  assert.equal(await docs.getFile('orgs/a/uploads/x.jpg'), null);
  await docs.remove('orgs/a');
  assert.deepEqual(docs.list('orgs/'), ['orgs/b/settings.json']);
  assert.throws(() => docs.put('../evil.json', {}), /Bad storage key/);
  await docs.flush();
}

test('files: save, read, list and remove', async () => {
  const dir = tmp();
  const docs = new FileDocs(dir);
  await basics(docs);
  assert.ok(fs.existsSync(path.join(dir, 'orgs', 'b', 'settings.json')), 'same layout as before');
  assert.ok(LOCAL_ONLY.test('tls/key.pem') && LOCAL_ONLY.test('database.json') && LOCAL_ONLY.test('host.json') && !LOCAL_ONLY.test('orgs.json'));
});

test('connection strings: host without the password', () => {
  assert.equal(mongoHost('mongodb+srv://jon:secret@cluster0.ab1cd.mongodb.net/?retryWrites=true'), 'cluster0.ab1cd.mongodb.net');
  assert.equal(mongoHost('mongodb://localhost:27017/wavs'), 'localhost:27017');
  assert.equal(mongoHost('https://example.com'), null);
});

test('mongodb: save, read, list and remove', { skip: !MONGO && 'set WAVS_TEST_MONGODB' }, async () => {
  const docs = await mongo();
  try {
    await basics(docs);
    // Everything was saved: a second connection sees the same.
    const again = await mongo({ dbName: docs.db.databaseName });
    assert.deepEqual(again.get('orgs/b/settings.json'), { org: { name: 'B' } });
    assert.deepEqual(again.list(''), ['orgs/b/settings.json']);
    await again.close();
  } finally { await docs.db.dropDatabase(); await docs.close(); }
});

test('mongodb: a change on one computer reaches the other', { skip: !MONGO && 'set WAVS_TEST_MONGODB' }, async () => {
  const a = await mongo();
  const b = await mongo({ dbName: a.db.databaseName });
  try {
    const storeB = new Schedule({ docs: b, prefix: 'orgs/grace/' });
    let changes = 0;
    storeB.on('change', () => changes++);
    const storeA = new Schedule({ docs: a, prefix: 'orgs/grace/' });
    storeA.data.leadMinutes = 45;
    storeA.save();
    await a.flush();
    assert.ok(await until(() => storeB.data.leadMinutes === 45), 'B reloads');
    assert.ok(changes >= 1, 'and tells the screens');
    // Our own writes don't come back as changes from elsewhere.
    let echoes = 0;
    storeA.on('change', () => echoes++);
    storeA.data.auto = false;
    storeA.save();
    await a.flush();
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(echoes, 1);
    storeA.close(); storeB.close();
  } finally { await a.db.dropDatabase(); await a.close(); await b.close(); }
});

test('mongodb: copy this computer\'s setup up, then back up and restore from it', { skip: !MONGO && 'set WAVS_TEST_MONGODB' }, async () => {
  const dir = tmp();
  const orgs = new OrgRegistry(dir);
  const id = orgs.create('Grace Church');
  orgs.setActive(id);
  const store = new GreenroomStore(orgs.place(id));
  await store.savePhoto('pastor.jpg', Buffer.from([1, 2, 3]), 'image/jpeg');
  store.addPerson({ name: 'Pastor Mike', photo: 'pastor.jpg' });
  new Auth(dir).createOwner({ name: 'Jon', username: 'jon', password: 'password1' });
  fs.mkdirSync(path.join(dir, 'tls'));
  fs.writeFileSync(path.join(dir, 'tls', 'key.pem'), 'secret');

  const cloud = await mongo({ mirrorDir: path.join(dir, 'cloud-copy') });
  try {
    const n = await copyAll(FileDocs.at(dir), cloud);
    assert.equal(n.files, 1);
    assert.ok(!cloud.list('').some((k) => k.startsWith('tls/') || k === 'host.json'), 'computer-specific files stay here');
    const there = new OrgRegistry({ docs: cloud }, { local: new FileDocs(tmp()) });
    assert.deepEqual(there.data.orgs.map((o) => o.name), ['Grace Church']);
    assert.equal(there.data.active, null, 'each computer picks its own active organization');
    const st = new GreenroomStore(there.place(id));
    assert.equal(st.data.people[0].name, 'Pastor Mike');
    assert.deepEqual([...(await st.getPhoto('pastor.jpg')).data], [1, 2, 3]);
    assert.ok(new Auth({ docs: cloud }).login('jon', 'password1'), 'accounts came along');

    // Backups work the same from the cloud.
    const data = readBackup(await createBackup({ orgs: there, auth: new Auth({ docs: cloud }), orgIds: [id] }));
    const pc = tmp();
    const pcOrgs = new OrgRegistry(pc);
    await importBackup({ data, orgs: pcOrgs, auth: new Auth(pc) });
    assert.ok(fs.existsSync(path.join(pc, 'orgs', id, 'uploads', 'pastor.jpg')));
  } finally { await cloud.db.dropDatabase(); await cloud.close(); }
});

test('mongodb: starts from this computer\'s copy when the internet is down', { skip: !MONGO && 'set WAVS_TEST_MONGODB' }, async () => {
  const mirrorDir = tmp();
  const dbName = `wavs_test_${crypto.randomBytes(4).toString('hex')}`;
  const up = await mongo({ dbName, mirrorDir });
  up.put('orgs.json', { orgs: [{ id: 'grace', name: 'Grace' }] });
  await up.putFile('orgs/grace/logo.png', Buffer.from([7, 7]), 'image/png');
  await up.close(); // writes the copy
  try {
    // Same database, but unreachable: point the copy at a server that isn't there.
    const copy = JSON.parse(fs.readFileSync(path.join(mirrorDir, 'docs.json'), 'utf8'));
    fs.writeFileSync(path.join(mirrorDir, 'docs.json'), JSON.stringify({ ...copy, host: '127.0.0.1:9' }));
    await assert.rejects(MongoDocs.connect('mongodb://127.0.0.1:9/', { dbName, timeoutMs: 500 }), /Couldn't reach/);
    const down = await MongoDocs.connect('mongodb://127.0.0.1:9/', { dbName, timeoutMs: 500, mirrorDir, offlineOk: true });
    assert.equal(down.status().offline, true);
    assert.deepEqual(down.get('orgs.json').orgs[0].name, 'Grace');
    assert.deepEqual([...(await down.getFile('orgs/grace/logo.png')).data], [7, 7], 'photos and logos too');
    down.put('orgs.json', { orgs: [] }); // saved here, sent later
    await down.flush();
    assert.equal(down.status().pending, 1);
    await down.close();
  } finally {
    const c = await mongo({ dbName });
    await c.db.dropDatabase();
    await c.close();
  }
});
