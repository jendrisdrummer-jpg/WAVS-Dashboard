import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Auth, sessionToken } from '../server/auth.js';

const fresh = () => new Auth(fs.mkdtempSync(path.join(os.tmpdir(), 'auth-')));

test('owner account, sign in, sessions survive a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-'));
  const a = new Auth(dir);
  assert.equal(a.enabled, false);
  a.createOwner({ name: 'Jon Endris', username: 'Jon@Example.com', password: 'long enough' });
  assert.throws(() => a.createOwner({ name: 'X', username: 'x', password: 'long enough' }), /already exists/);
  assert.throws(() => a.login('jon@example.com', 'wrong'), /not right/);
  const token = a.login('JON@example.com', 'long enough');
  assert.equal(a.session(token).name, 'Jon Endris');
  assert.equal(a.roleIn(a.session(token), 'any-org'), 'admin', 'owner is admin everywhere');
  const raw = fs.readFileSync(path.join(dir, 'users.json'), 'utf8');
  assert.ok(!raw.includes('long enough'), 'passwords are never stored');
  // sessions are written shortly after; force it and reload
  clearTimeout(a.sessTimer);
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify(a.sessions));
  const again = new Auth(dir);
  assert.equal(again.session(token)?.name, 'Jon Endris');
  a.logout(token);
  assert.equal(a.session(token), null);
});

test('invites: role per organization, never lowers an existing role', () => {
  const a = fresh();
  const owner = a.createOwner({ name: 'Owner', username: 'owner', password: 'password1' });
  const inv = a.invite({ orgId: 'church', role: 'crew', by: owner.id });
  const { user, token } = a.acceptInvite(inv.code, { name: 'Sam', username: 'sam', password: 'password2' });
  assert.equal(a.roleIn(user, 'church'), 'crew');
  assert.equal(a.roleIn(user, 'company'), null, 'no access to the other organization');
  assert.ok(a.session(token));
  const prod = a.invite({ orgId: 'company', role: 'producer', by: owner.id });
  assert.throws(() => a.acceptInvite(prod.code, { username: 'sam', password: 'nope' }), /Enter its password/);
  a.acceptInvite(prod.code, { username: 'SAM', password: 'password2' });
  assert.equal(a.roleIn(a.byName('sam'), 'company'), 'producer');
  a.setRole(user.id, 'church', 'admin');
  const crewAgain = a.invite({ orgId: 'church', role: 'crew', by: owner.id });
  a.acceptInvite(crewAgain.code, { username: 'sam', password: 'password2' });
  assert.equal(a.roleIn(a.byName('sam'), 'church'), 'admin');
  a.revokeInvite(inv.code);
  assert.throws(() => a.acceptInvite(inv.code, { name: 'Late', username: 'late', password: 'password3' }), /expired or was cancelled/);
});

test('admin tools: reset password signs them out, owner cannot be removed', () => {
  const a = fresh();
  const owner = a.createOwner({ name: 'Owner', username: 'owner', password: 'password1' });
  const inv = a.invite({ orgId: 'o', role: 'producer', by: owner.id });
  const { user, token } = a.acceptInvite(inv.code, { name: 'P', username: 'p', password: 'password2' });
  const temp = a.resetPassword(user.id);
  assert.equal(a.session(token), null);
  assert.ok(a.login('p', temp));
  assert.throws(() => a.remove(owner.id), /can't be removed/);
  assert.throws(() => a.setRole(owner.id, 'o', 'crew'), /admin everywhere/);
  assert.throws(() => a.create({ name: 'Short', username: 's', password: '123' }), /at least 8/);
  a.remove(user.id);
  assert.equal(a.byName('p'), undefined);
});

test('too many wrong passwords from one address are refused for a while', () => {
  const a = fresh();
  a.createOwner({ name: 'Owner', username: 'owner', password: 'password1' });
  for (let i = 0; i < 10; i++) assert.throws(() => a.login('owner', `x${i}`, '1.2.3.4'));
  assert.throws(() => a.login('owner', 'password1', '1.2.3.4'), /Too many/);
  assert.ok(a.login('owner', 'password1', '5.6.7.8'));
});

test('session cookie parsing', () => {
  assert.equal(sessionToken({ headers: { cookie: 'a=1; wavs_session=abc%2D1; b=2' } }), 'abc-1');
  assert.equal(sessionToken({ headers: {} }), null);
});
