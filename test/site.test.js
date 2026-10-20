import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Site } from '../server/site.js';
import { OrgRegistry } from '../server/orgs.js';
import { Auth } from '../server/auth.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wavs-site-'));

test('website sign-ups: beta code by default, open, closed; the owner always gets in first', () => {
  const dir = tmp();
  const site = new Site(dir);
  assert.equal(site.signups, 'code');
  assert.match(site.view().code, /^[0-9A-F]{8}$/);
  assert.throws(() => site.check('nope'), /beta code/);
  site.check(site.view().code.toLowerCase()); // not case sensitive
  site.check('', { ownerSignup: true });
  const old = site.view().code;
  assert.notEqual(site.update({ newCode: true }).code, old);
  site.update({ signups: 'open' });
  site.check('');
  site.update({ signups: 'closed' });
  assert.throws(() => site.check(site.view().code), /closed/);
  assert.throws(() => site.update({ signups: 'whatever' }), /Unknown/);
  assert.equal(new Site(dir).signups, 'closed', 'saved');
});

test('TV link keys: one per organization, checked exactly', () => {
  const dir = tmp();
  const orgs = new OrgRegistry(dir);
  const a = orgs.create('Grace Church');
  const b = orgs.create('Hope Church');
  const ka = orgs.tvKey(a);
  assert.equal(orgs.tvKey(a), ka, 'stays the same');
  assert.ok(orgs.tvKeyOk(a, ka));
  assert.ok(!orgs.tvKeyOk(b, ka), "another organization's key doesn't work");
  assert.ok(!orgs.tvKeyOk(a, `${ka}x`) && !orgs.tvKeyOk(a, '') && !orgs.tvKeyOk('nope', ka));
});

test('teams: the owner is admin everywhere but only a member where they joined', () => {
  const dir = tmp();
  const auth = new Auth(dir);
  const owner = auth.create({ name: 'Jon', username: 'jon@x.org', password: 'password1', owner: true });
  const amy = auth.create({ name: 'Amy', username: 'amy@x.org', password: 'password1' });
  auth.join(amy.id, 'grace', 'admin');
  auth.join(owner.id, 'wavs', 'admin');
  assert.equal(auth.roleIn(owner, 'grace'), 'admin');
  assert.ok(!auth.memberOf(owner, 'grace') && auth.memberOf(owner, 'wavs'));
  assert.ok(auth.memberOf(amy, 'grace') && !auth.memberOf(amy, 'wavs'));
  assert.equal(auth.rank(amy, 'wavs'), 0);
});
