import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDirFor, oldDataCandidates, adoptOldData } from '../server/datadir.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wavs-'));

test('data lives outside the code folder, in one place per computer', () => {
  assert.equal(dataDirFor({ env: {}, root: '/code', home: '/Users/sam', platform: 'darwin' }), '/Users/sam/Library/Application Support/WAVS Dashboard');
  assert.equal(dataDirFor({ env: {}, root: '/code', home: '/home/sam', platform: 'linux' }), '/home/sam/.wavs-dashboard');
  assert.equal(dataDirFor({ env: { WAVS_DATA: 'x' }, root: '/code', home: '/home/sam', platform: 'linux' }), '/code/x');
});

test('the most recently used old copy is brought over once, and the old folder is left alone', () => {
  const home = tmp();
  const older = path.join(home, 'Downloads', 'WAVS-Dashboard-main', 'data');
  const newer = path.join(home, 'WAVS-Dashboard', 'data');
  for (const [d, name] of [[older, 'Old Org'], [newer, 'Grace Church']]) {
    fs.mkdirSync(path.join(d, 'orgs', 'x'), { recursive: true });
    fs.writeFileSync(path.join(d, 'orgs.json'), JSON.stringify({ active: 'x', orgs: [{ id: 'x', name }] }));
    fs.writeFileSync(path.join(d, 'orgs', 'x', 'settings.json'), '{}');
  }
  const past = new Date(Date.now() - 86400000);
  for (const f of ['orgs.json', 'orgs/x/settings.json']) fs.utimesSync(path.join(older, f), past, past);
  const fresh = path.join(home, 'Desktop', 'wavs-dashboard-new'); // the copy being started now: empty data
  fs.mkdirSync(path.join(fresh, 'data'), { recursive: true });

  const target = path.join(home, 'Library', 'WAVS Dashboard');
  const from = adoptOldData(target, oldDataCandidates({ root: fresh, home }));
  assert.equal(from, newer);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'orgs.json'))).orgs[0].name, 'Grace Church');
  assert.ok(fs.existsSync(path.join(newer, 'orgs.json')), 'old copy untouched');
  assert.equal(adoptOldData(target, oldDataCandidates({ root: fresh, home })), null, 'only once');
});

test('nothing to bring over on a brand new computer', () => {
  const home = tmp();
  assert.equal(adoptOldData(path.join(home, 'target'), oldDataCandidates({ root: path.join(home, 'code'), home })), null);
});
