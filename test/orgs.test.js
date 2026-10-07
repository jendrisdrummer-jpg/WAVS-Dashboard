import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OrgRegistry, normalizeSettings, mergeIncoming, maskSettings } from '../server/orgs.js';

test('settings: tidies gear and gives every device an id', () => {
  const s = normalizeSettings({
    mics: { receivers: [{ name: 'SLX-D Rack A', host: '192.168.1.101', channels: [{ label: 'HH 1' }, { label: 'Pastor', kind: 'headset' }] }] },
    switchers: [{ name: 'ATEM', type: 'atem', host: '10.0.0.5', meNames: 'Program, Stream' }],
  });
  assert.equal(s.mics.receivers[0].id, 'slx-d-rack-a');
  assert.equal(s.mics.receivers[0].port, 2202);
  assert.deepEqual(s.mics.receivers[0].channels.map((c) => c.kind), ['handheld', 'headset']);
  assert.deepEqual(s.switchers[0].meNames, ['Program', 'Stream']);
});

test('settings: explains what is wrong with bad gear', () => {
  assert.throws(() => normalizeSettings({ mics: { receivers: [{ name: 'Rack A', host: '192.168.1.300!' }] } }), /Rack A: .* doesn't look like an IP/);
  assert.throws(() => normalizeSettings({ propresenter: [{ name: 'PP', host: 'not a host!' }] }), /doesn't look like an IP/);
  assert.throws(() => normalizeSettings({ video: { sources: [{ label: 'Program', type: 'webrtc', url: 'ftp://x' }] } }), /must start with http/);
});

test('settings: gear can be saved before its IP address is known', () => {
  const s = normalizeSettings({
    mics: { receivers: [{ name: 'Rack B', host: '', model: 'SLXD4D', channels: [{ label: 'HH 1' }, { label: 'HH 2' }] }] },
    switchers: [{ name: 'ATEM', type: 'atem' }],
    propresenter: [{ name: 'PP' }],
  });
  assert.equal(s.mics.receivers[0].host, '');
  assert.equal(s.mics.receivers[0].channels.length, 2);
  assert.equal(s.switchers[0].host, '');
  assert.equal(s.propresenter[0].host, '');
});

test('settings: secrets never go to the browser and survive a round trip', () => {
  const saved = normalizeSettings({ security: { adminPin: '4321' }, planningCenter: { appId: 'abc', secret: 'shh' } });
  const masked = maskSettings(saved);
  assert.equal(masked.planningCenter.secret, '••••••••');
  assert.equal(masked.security.adminPin, null);
  const back = mergeIncoming(saved, { ...masked, org: { ...masked.org, name: 'Renamed' } });
  assert.equal(back.planningCenter.secret, 'shh');
  assert.equal(back.security.adminPin, '4321');
  assert.equal(back.org.name, 'Renamed');
  assert.equal(mergeIncoming(saved, { security: { adminPin: '' } }).security.adminPin, null);
});

test('organizations: first run moves existing data into the first organization', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavs-orgs-'));
  fs.writeFileSync(path.join(dir, 'greenroom.json'), '{"people":[{"id":"p1","name":"Sam"}]}');
  const reg = new OrgRegistry(dir);
  reg.migrate({ org: { name: 'Grace Church', theme: {} }, mics: { receivers: [] }, switchers: [], propresenter: [], video: { sources: [] }, _file: 'config/config.yaml' });
  assert.equal(reg.data.active, 'grace-church');
  assert.ok(fs.existsSync(path.join(dir, 'orgs', 'grace-church', 'greenroom.json')));
  assert.equal(reg.read('grace-church').setupComplete, false);

  const id = reg.create('Acme Productions');
  assert.deepEqual(reg.list().map((o) => o.name), ['Grace Church', 'Acme Productions']);
  assert.throws(() => reg.remove('grace-church'), /Switch to another/);
  reg.setActive(id);
  reg.remove('grace-church');
  assert.deepEqual(reg.list().map((o) => o.id), ['acme-productions']);
});
