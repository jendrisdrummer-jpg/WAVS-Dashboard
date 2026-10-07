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

test('ProPresenter links: a link beats names, "don\'t move" holds the plan, and links carry to next week', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavs-'));
  const svc = new ServiceManager({ dataDir: dir, pco: null, cfg: {} });
  svc.setManual({ title: 'Sunday', text: '10:00 Pre-Service\n# Worship\nsong 4:30 Worship Set\n35m Message\n3:00 Closing' });
  const [pre, , worship, message] = svc.plan.items;
  const pl = {
    uuid: 'pl1', name: 'Sunday', index: 0,
    items: [
      { name: 'Countdown Loop', type: 'media', uuid: 'a' },
      { name: 'Announcements Loop', type: 'media', uuid: 'b' },
      { name: 'Great Is Thy Faithfulness', type: 'presentation', uuid: 'c' },
      { name: 'Sermon Slides', type: 'presentation', uuid: 'd' },
      { name: 'Closing', type: 'presentation', uuid: 'e' },
    ],
  };
  // Nothing linked: "Closing" matches by name; the others don't match (5 vs 4 items, so no position fallback).
  assert.equal(svc.resolve(pl.items[4], pl).how, 'name');
  assert.equal(svc.resolve(pl.items[0], pl).how, null);

  svc.setLink({ key: 'u:a', name: 'Countdown Loop', itemId: pre.id });
  svc.setLink({ key: 'u:b', name: 'Announcements Loop', itemId: 'ignore' });
  svc.setLink({ key: 'u:c', name: 'Great Is Thy Faithfulness', itemId: worship.id });
  svc.setLink({ key: 'u:d', name: 'Sermon Slides', itemId: message.id });

  svc.onPlaylist({ ...pl, index: 0 });
  assert.equal(svc.saved.current.itemId, pre.id);
  svc.onPlaylist({ ...pl, index: 1 }); // announcement loop: plan stays on Pre-Service
  assert.equal(svc.saved.current.itemId, pre.id);
  svc.onPlaylist({ ...pl, index: 2 });
  assert.equal(svc.saved.current.itemId, worship.id);
  svc.onPlaylist({ ...pl, index: 3 });
  assert.equal(svc.saved.current.itemId, message.id);
  assert.deepEqual(svc.preview({ ...pl, index: 3 }).map((p) => p.how), ['link', 'ignore', 'link', 'link', 'name']);

  // Next week: a brand-new plan (new item ids) with the same titles, and a new playlist (new uuids).
  svc.setManual({ title: 'Next Sunday', text: '10:00 Pre-Service\nsong 4:30 Worship Set\n35m Message' });
  const [pre2, worship2, message2] = svc.plan.items;
  const pl2 = { uuid: 'pl2', name: 'Next', index: 0, items: [{ name: 'Countdown Loop', uuid: 'x' }, { name: 'Announcements Loop', uuid: 'y' }, { name: 'Sermon Slides', uuid: 'z' }, { name: 'Great Is Thy Faithfulness', uuid: 'w' }] };
  assert.deepEqual(svc.preview(pl2).map((p) => [p.how, p.itemId]), [
    ['remembered', pre2.id], ['ignore', null], ['remembered', message2.id], ['remembered', worship2.id],
  ]);
  // Back to automatic
  svc.setLink({ key: 'u:z', name: 'Sermon Slides', itemId: null });
  assert.equal(svc.resolve(pl2.items[2], pl2).how, null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'service.json'), 'utf8')).aliases['countdown loop'], 'pre service');
});
