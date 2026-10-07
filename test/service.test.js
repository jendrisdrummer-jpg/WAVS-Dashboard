import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePlanText, ServiceManager, normalize } from '../server/service.js';

test('parses a typed order of service', () => {
  const items = parsePlanText('# Worship\nsong 4:30 Holy Forever\n35m Message\nWelcome - 2:00\nAnnouncements');
  assert.deepEqual(items.map(({ id, ...rest }) => rest), [
    { title: 'Worship', type: 'header', position: 'during', length: 0 },
    { title: 'Holy Forever', type: 'song', position: 'during', length: 270 },
    { title: 'Message', type: 'item', position: 'during', length: 2100 },
    { title: 'Welcome', type: 'item', position: 'during', length: 120 },
    { title: 'Announcements', type: 'item', position: 'during', length: 0 },
  ]);
});

test('follows ProPresenter by presentation name and records actual item times', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavs-'));
  const svc = new ServiceManager({ dataDir: dir, pco: null, cfg: {} });
  svc.setManual({ title: 'Sunday', text: '5:00 Welcome\nsong 4:30 Holy Forever (Live)\n35m Message' });
  const [welcome, song] = svc.plan.items;

  svc.onPresentation('Holy Forever');
  assert.equal(svc.saved.current.itemId, song.id);
  assert.equal(svc.saved.current.by, 'propresenter');

  svc.onPresentation('Totally unrelated deck');
  assert.equal(svc.saved.current.itemId, song.id);

  svc.step(-1);
  assert.equal(svc.saved.current.itemId, welcome.id);
  assert.ok(song.id in svc.saved.actuals, 'time on the song is recorded when moving on');
  assert.equal(normalize('Holy Forever (Live)'), 'holy forever');
});

test('follows the cued ProPresenter playlist item, by name or by position', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavs-'));
  const svc = new ServiceManager({ dataDir: dir, pco: null, cfg: {} });
  svc.setManual({ title: 'Sunday', text: '5:00 Welcome\nsong 4:30 Holy Forever\n35m Message' });
  const pl = (index, names) => ({ uuid: 'p1', name: 'Sunday', index, items: names.map((n) => ({ name: n, type: n.startsWith('#') ? 'header' : 'presentation' })) });

  // Same names: match by name.
  svc.onPlaylist(pl(2, ['Welcome', '# Worship', 'Holy Forever (Live)', 'Message']));
  assert.equal(svc.plan.items.find((i) => i.id === svc.saved.current.itemId).title, 'Holy Forever');

  // Different names but same number of items: follow by position.
  svc.onPlaylist(pl(3, ['Walk in', '# Worship', 'Song A', 'Sermon']));
  assert.equal(svc.plan.items.find((i) => i.id === svc.saved.current.itemId).title, 'Message');
});

test('uses the ProPresenter playlist as the order of service', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavs-'));
  const svc = new ServiceManager({ dataDir: dir, pco: null, cfg: {} });
  svc.useProPresenter();
  svc.onPlaylist({ uuid: 'p1', name: 'Sunday Service', index: 2, items: [{ name: 'Walk-in', type: 'media' }, { name: 'Worship', type: 'header' }, { name: 'Holy Forever', type: 'presentation' }] });
  assert.equal(svc.plan.title, 'Sunday Service');
  assert.equal(svc.plan.items.length, 3);
  assert.equal(svc.plan.items[1].type, 'header');
  assert.equal(svc.saved.current.itemId, 'p1:2');
});
