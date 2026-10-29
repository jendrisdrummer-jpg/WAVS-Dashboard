import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Auth } from '../server/auth.js';
import { mailConfig, resetEmail, Mailer } from '../server/mail.js';

const fresh = () => new Auth(fs.mkdtempSync(path.join(os.tmpdir(), 'wavs-reset-')));

test('forgot password: one link, for an hour, once', () => {
  const a = fresh();
  const amy = a.create({ name: 'Amy', username: 'Amy@Grace.org', password: 'password1' });
  const session = a.login('amy@grace.org', 'password1');
  assert.equal(a.startReset('nobody@grace.org'), null, 'no account: nothing to send');
  const r = a.startReset('AMY@grace.org');
  assert.equal(r.user.id, amy.id);
  assert.equal(a.resetFor(r.token).id, amy.id);
  assert.ok(!JSON.stringify(a.data).includes(r.token), 'only a hash is saved');
  assert.throws(() => a.finishReset(r.token, 'short'), /8 characters/);
  assert.equal(a.resetFor(r.token).id, amy.id, 'a too-short password does not use up the link');
  const t = a.finishReset(r.token, 'newpassword9');
  assert.ok(a.session(t), 'signed in');
  assert.equal(a.session(session), null, 'other sessions are signed out');
  assert.throws(() => a.login('amy@grace.org', 'password1'));
  assert.ok(a.login('amy@grace.org', 'newpassword9'));
  assert.throws(() => a.finishReset(r.token, 'another123'), /expired or was already used/);
  assert.equal(a.resetFor('made-up'), null);
});

test('forgot password: asking again replaces the old link; old links expire', () => {
  const a = fresh();
  a.create({ name: 'Amy', username: 'amy@grace.org', password: 'password1' });
  const first = a.startReset('amy@grace.org');
  const second = a.startReset('amy@grace.org');
  assert.equal(a.resetFor(first.token), null);
  assert.ok(a.resetFor(second.token));
  const short = a.startReset('amy@grace.org', { minutes: -1 });
  assert.equal(a.resetFor(short.token), null, 'expired');
});

test('accounts with a plain username (not an email) get no email', () => {
  const a = fresh();
  a.create({ name: 'Sound', username: 'soundbooth', password: 'password1' });
  assert.equal(a.startReset('soundbooth'), null);
});

test('email settings: Gmail, any SMTP, the test log, or off', async () => {
  assert.equal(mailConfig({}), null);
  const g = mailConfig({ GMAIL_USER: 'wavs@gmail.com', GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop' });
  assert.equal(g.kind, 'gmail');
  assert.equal(g.transport.auth.pass, 'abcdefghijklmnop', 'spaces Google shows are removed');
  assert.match(g.from, /wavs@gmail\.com/);
  assert.equal(mailConfig({ SMTP_URL: 'smtps://u:p@smtp.x.org:465' }).kind, 'smtp');
  const m = new Mailer(mailConfig({ MAIL_TRANSPORT: 'log' }));
  const e = resetEmail({ name: 'Amy <b>', link: 'https://x.onrender.com/reset/abc' });
  await m.send({ to: 'amy@grace.org', ...e });
  assert.equal(m.sent[0].to, 'amy@grace.org');
  assert.match(m.sent[0].text, /https:\/\/x\.onrender\.com\/reset\/abc/);
  assert.ok(m.sent[0].html.includes('Amy &lt;b&gt;'), 'names are escaped in the HTML');
  await assert.rejects(new Mailer(null).send({ to: 'x' }), /isn't set up/);
});
