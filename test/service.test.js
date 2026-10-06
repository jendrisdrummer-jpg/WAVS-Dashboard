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
