import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { FileDocs } from '../server/docs.js';
import { OrgRegistry } from '../server/orgs.js';
import { Auth } from '../server/auth.js';
import { StationHub, StationDocs, StationAuth } from '../server/station.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wavs-station-'));
const tick = () => new Promise((r) => setTimeout(r, 20));

/** A website (StationHub on files) and a base station joined by an in-memory link. */
function setup() {
  const webDocs = new FileDocs(tmp());
  const orgs = new OrgRegistry({ docs: webDocs }, { local: new FileDocs(tmp()) });
  const auth = new Auth({ docs: webDocs });
  const hub = new StationHub({ docs: webDocs, auth, orgs });
  const jon = auth.create({ name: 'Jon', username: 'jon@wavs.org', password: 'password1' });
  const amy = auth.create({ name: 'Amy', username: 'amy@grace.org', password: 'password2' });
  const wavs = orgs.create('WAVS Events');
  const grace = orgs.create('Grace Church');
  auth.join(jon.id, wavs, 'admin');
  auth.join(amy.id, wavs, 'crew');
  auth.join(amy.id, grace, 'admin'); // Jon isn't on Grace's team

  const link = new EventEmitter();
  link.url = 'https://site.test';
  link.online = false;
  let conn = null;
  link.call = async (t, payload = {}) => {
    if (!link.online) throw new Error('Not connected to the website');
    try { return await hub.handle(conn, { ...payload, t }); } catch (e) { throw Object.assign(new Error(e.message), { remote: true }); }
  };
  const { token, station } = hub.pair({ username: 'jon@wavs.org', password: 'password1', name: 'MacBook' });
  link.connect = () => {
    conn = { station: hub.byToken(token), orgs: new Set(), send: (m) => link.emit('push', m) };
    hub.conns.set({}, conn);
    link.online = true;
    link.emit('online');
  };
  link.disconnect = () => { hub.conns.clear(); link.online = false; link.emit('offline'); };
  link.stop = () => {};
  const dir = tmp();
  const docs = new StationDocs({ dir, link });
  docs.load();
  const sAuth = new StationAuth({ docs: docs.local }, { link, docs });
  return { webDocs, orgs, auth, hub, token, station, link, docs, sAuth, wavs, grace, jon, amy, dir };
}

test('pairing: a website account gets a token; wrong passwords and unknown tokens get nothing', () => {
  const s = setup();
  assert.ok(s.token.length > 30);
  assert.equal(s.hub.byToken(s.token).user.name, 'Jon');
  assert.equal(s.hub.byToken('nope'), null);
  assert.throws(() => s.hub.pair({ username: 'jon@wavs.org', password: 'wrong', name: 'x' }), /not right/);
  assert.ok(!JSON.stringify(s.webDocs.get('stations.json')).includes(s.token), 'only a hash is saved');
  assert.equal(s.hub.list(s.jon.id).length, 1);
  assert.equal(s.hub.list(s.amy.id).length, 0, 'each account sees its own');
  assert.throws(() => s.hub.remove(s.amy.id, s.station.id), /Unknown/);
});

test('a base station gets the organizations its account is an admin of, and changes go both ways', async () => {
  const s = setup();
  s.webDocs.put(`orgs/${s.wavs}/greenroom.json`, { people: [{ id: 'p1', name: 'On the website' }] });
  s.webDocs.put(`orgs/${s.grace}/greenroom.json`, { people: [{ id: 'g1', name: 'Grace only' }] });
  s.link.connect();
  await tick();
  assert.deepEqual(s.docs.get('orgs.json').orgs.map((o) => o.name), ['WAVS Events'], "not Grace: Jon isn't its admin");
  assert.equal(s.docs.get(`orgs/${s.wavs}/greenroom.json`).people[0].name, 'On the website');
  assert.equal(s.docs.get(`orgs/${s.grace}/greenroom.json`), undefined);
  // team: names and roles only, no passwords
  assert.deepEqual(s.sAuth.data.users.map((u) => [u.name, u.roles[s.wavs]]).sort(), [['Amy', 'crew'], ['Jon', 'admin']]);
  assert.ok(s.sAuth.data.users.every((u) => !u.pass));

  // station → website (and the website's open pages reload)
  let reloaded = 0;
  s.webDocs.watch(`orgs/${s.wavs}/greenroom.json`, () => reloaded++);
  s.docs.put(`orgs/${s.wavs}/greenroom.json`, { people: [{ id: 'p1', name: 'Changed at the event' }] });
  await tick();
  assert.equal(s.webDocs.get(`orgs/${s.wavs}/greenroom.json`).people[0].name, 'Changed at the event');
  assert.equal(reloaded, 1);
  assert.equal(s.docs.status().pending, 0);

  // website → station
  let told = 0;
  s.docs.watch(`orgs/${s.wavs}/schedule.json`, () => told++);
  s.webDocs.put(`orgs/${s.wavs}/schedule.json`, { services: [{ id: 's1' }] });
  await tick();
  assert.deepEqual(s.docs.get(`orgs/${s.wavs}/schedule.json`).services, [{ id: 's1' }]);
  assert.equal(told, 1);

  // the station can't reach other organizations or the website's own records
  await assert.rejects(s.link.call('put', { key: `orgs/${s.grace}/greenroom.json`, json: '{}' }), /Not part of/);
  await assert.rejects(s.link.call('put', { key: 'users.json', json: '{}' }), /Not part of/);
  await assert.rejects(s.link.call('remove', { prefix: `orgs/${s.wavs}` }), /on the website/);
  // renaming the organization on the station renames it on the website
  s.docs.put(`orgs/${s.wavs}/settings.json`, { ...s.webDocs.get(`orgs/${s.wavs}/settings.json`), org: { ...s.webDocs.get(`orgs/${s.wavs}/settings.json`).org, name: 'WAVS Live' } });
  await tick();
  assert.equal(s.orgs.data.orgs.find((o) => o.id === s.wavs).name, 'WAVS Live');
});

test('offline: changes wait in the copy, in order, and go out when the internet is back', async () => {
  const s = setup();
  s.link.connect();
  await tick();
  s.link.disconnect();
  for (let i = 1; i <= 3; i++) s.docs.put(`orgs/${s.wavs}/board.json`, { notes: { n: String(i) } });
  s.docs.put(`orgs/${s.wavs}/comms.json`, { channels: [] });
  await s.docs.putFile(`orgs/${s.wavs}/uploads/a.jpg`, Buffer.from([1, 2, 3]), 'image/jpeg');
  assert.equal(s.docs.status().pending, 3, 'repeated saves of one document become one');
  // meanwhile on the website
  s.webDocs.put(`orgs/${s.wavs}/schedule.json`, { services: [{ id: 'web' }] });
  s.webDocs.put(`orgs/${s.wavs}/board.json`, { notes: { n: 'website' } });
  // the copy survives a restart of the base station
  s.docs.writeCopy();
  const again = new StationDocs({ dir: s.dir, link: s.link });
  again.load();
  assert.equal(again.status().pending, 3);
  assert.equal(again.get(`orgs/${s.wavs}/board.json`).notes.n, '3');
  // back online
  s.link.connect();
  await tick(); await tick();
  assert.equal(again.status().pending, 0);
  assert.equal(s.webDocs.get(`orgs/${s.wavs}/board.json`).notes.n, '3', "the event's change wins");
  assert.deepEqual(s.webDocs.get(`orgs/${s.wavs}/comms.json`), { channels: [] });
  assert.deepEqual([...(await s.webDocs.getFile(`orgs/${s.wavs}/uploads/a.jpg`)).data], [1, 2, 3]);
  assert.deepEqual(again.get(`orgs/${s.wavs}/schedule.json`).services, [{ id: 'web' }], "and the website's other changes arrive");
});

test('sign-in on a base station: website accounts, and offline only those who signed in there before', async () => {
  const s = setup();
  s.link.connect();
  await tick();
  await assert.rejects(s.sAuth.login('jon@wavs.org', 'wrong'), /not right/);
  const t = await s.sAuth.login('jon@wavs.org', 'password1');
  assert.equal(s.sAuth.session(t).name, 'Jon');
  assert.equal(s.sAuth.roleIn(s.sAuth.session(t), s.wavs), 'admin');
  s.link.disconnect();
  assert.ok(await s.sAuth.login('jon@wavs.org', 'password1'), 'offline: Jon signed in here before');
  await assert.rejects(s.sAuth.login('jon@wavs.org', 'wrong'), /not right/);
  await assert.rejects(s.sAuth.login('amy@grace.org', 'password2'), /Sign in once while online/);
  assert.throws(() => s.sAuth.createOwner({}), /on the website/);
});
