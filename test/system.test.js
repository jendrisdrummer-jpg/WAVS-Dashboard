import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { System } from '../server/system.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

test('update: checks GitHub-style origin, fast-forwards main, ignores a rewritten lockfile', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));
  const origin = path.join(base, 'origin.git');
  const work = path.join(base, 'work');
  const install = path.join(base, 'install');
  git(base, 'init', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, work);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't']]) git(work, 'config', k, v);
  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
  fs.writeFileSync(path.join(work, 'package-lock.json'), '{}');
  git(work, 'add', '-A'); git(work, 'commit', '-qm', 'first'); git(work, 'push', '-q', 'origin', 'main');
  git(base, 'clone', '-q', origin, install);

  const sys = new System(install);
  assert.equal((await sys.check()).behind, 0);
  fs.writeFileSync(path.join(work, 'feature.txt'), 'new');
  git(work, 'add', '-A'); git(work, 'commit', '-qm', 'Add a new feature'); git(work, 'push', '-q', 'origin', 'main');
  fs.writeFileSync(path.join(install, 'package-lock.json'), '{"rewritten":true}'); // what npm install can do
  const st = await sys.check();
  assert.equal(st.behind, 1);
  assert.deepEqual(st.changes, ['Add a new feature']);
  assert.equal(st.dirty, false);
  const r = await sys.update();
  assert.equal(r.updated, 1);
  assert.equal(r.restart, false, 'not a background service here, so the person restarts it');
  assert.ok(fs.existsSync(path.join(install, 'feature.txt')));

  fs.writeFileSync(path.join(install, 'package.json'), '{"edited":"by hand"}');
  assert.equal((await sys.check()).dirty, true);
  await assert.rejects(sys.update(), /edited by hand/);
});
