import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Comms } from '../server/comms.js';
import { matrix } from '../public/js/comms-routing.js';

// A fake WebSocket that records what the server sends it.
function socket(local = false) {
  const ws = { readyState: 1, sent: [], binary: [], handlers: {}, closed: false, isLocal: local };
  ws.send = (raw, opts) => (opts?.binary ? ws.binary.push(Buffer.from(raw)) : ws.sent.push(JSON.parse(raw)));
  ws.on = (ev, fn) => { ws.handlers[ev] = fn; };
  ws.close = () => { ws.closed = true; ws.handlers.close?.(); };
  ws.last = (t) => [...ws.sent].reverse().find((m) => m.t === t);
  return ws;
}

function setup({ pin = '1234' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-'));
  const comms = new Comms(dir, { checkPin: (p) => p === pin, orgName: 'Grace Church' });
  const connect = (local = false, { offsite = false, ip = '203.0.113.9', authRank = 0 } = {}) => {
    const ws = socket(local);
    comms.attach(ws, { socket: { remoteAddress: local || offsite ? '127.0.0.1' : '192.168.1.50' }, viaTunnel: offsite, authRank, headers: { 'cf-connecting-ip': ip } });
    ws.msg = (m) => ws.handlers.message(JSON.stringify(m), false);
    ws.bin = (buf) => ws.handlers.message(buf, true);
    return ws;
  };
  const producer = connect();
  producer.msg({ t: 'hello', role: 'control', pin });
  return { comms, connect, producer };
}

const phone = (env, name, extra = {}) => {
  const ws = env.connect();
  ws.msg({ t: 'hello', role: 'member' });
  ws.msg({ t: 'join', name, ...extra });
  return ws;
};

test('routing: people hear the channels they listen to, never themselves', () => {
  const channels = [{ id: 'gfx' }, { id: 'directors' }];
  const state = {
    channels,
    members: [
      { id: 'd', online: true, perms: { gfx: { talk: true, listen: true }, directors: { talk: true, listen: true } }, talking: { gfx: true } },
      { id: 'g', online: true, perms: { gfx: { talk: true, listen: true } }, volume: { gfx: 0.5 } },
      { id: 'c', online: true, perms: { directors: { talk: false, listen: true } } },
      { id: 'x', online: false, perms: { gfx: { talk: true, listen: true } } },
    ],
    ports: [
      { id: 'tb', kind: 'in', channels: ['gfx'] },
      { id: 'bus', kind: 'out', channels: ['directors'] },
    ],
  };
  const m = matrix(state);
  assert.equal(m['m:d']['m:g'], 0.5, 'GFX op hears the director on GFX at their own volume');
  assert.equal(m['m:d']['m:c'], 0, 'camera op is not on GFX');
  assert.equal(m['m:d']['m:d'], 0, 'nobody hears themself');
  assert.equal(m['p:tb']['m:g'], 0.5, 'console talkback lands in GFX');
  assert.equal(m['m:d']['p:bus'], 0, 'director talking on GFX does not reach the directors bus');
  assert.ok(!('m:x' in m), 'offline people are not mixed');
  state.members[0].talking = { directors: true };
  assert.equal(matrix(state)['m:d']['p:bus'], 1, 'directors channel goes to the console bus');
  assert.equal(matrix(state)['m:d']['m:c'], 1);
  state.members[0].muted = true;
  assert.equal(matrix(state)['m:d']['m:c'], 0, 'a muted person is not heard');
});

test('roster: people added in advance sign in by name and get their position', () => {
  const env = setup();
  env.producer.msg({ t: 'add', name: 'Sam Rivera', position: 'gfx' });
  const ws = phone(env, '  sam   RIVERA ');
  assert.ok(ws.last('joined').token);
  const me = ws.last('welcome').member;
  assert.equal(me.name, 'Sam Rivera');
  assert.equal(me.position, 'gfx');
  assert.equal(me.perms.gfx.talk, true);
  assert.equal(me.token, undefined, 'token is not echoed in the member record');
  assert.equal(env.comms.data.members.length, 1, 'no duplicate person');
});

test('roster: a personal code protects a name', () => {
  const env = setup();
  env.producer.msg({ t: 'add', name: 'Pat', position: 'director', code: 'blue7', lead: true });
  const wrong = phone(env, 'Pat', { code: 'nope' });
  assert.match(wrong.last('error').error, /personal code/);
  assert.equal(wrong.last('joined'), undefined);
  const right = phone(env, 'pat', { code: 'blue7' });
  assert.ok(right.last('joined'));
  // signing in again elsewhere with the code replaces the first phone
  const again = phone(env, 'Pat', { code: 'blue7' });
  assert.ok(again.last('joined'));
  assert.equal(right.last('removed').reason, 'Signed in on another phone');
  assert.equal(JSON.stringify(env.comms.state()).includes('blue7'), false, 'code never leaves the server');
});

test('roster: without a code, a name already online cannot be taken over', () => {
  const env = setup();
  env.producer.msg({ t: 'add', name: 'Alex', position: 'camera' });
  phone(env, 'Alex');
  const thief = phone(env, 'Alex');
  assert.match(thief.last('error').error, /already signed in/);
});

test('roster only + team password', () => {
  const env = setup();
  env.producer.msg({ t: 'access', rosterOnly: true, teamPassword: 'sunday' });
  env.producer.msg({ t: 'add', name: 'Jo', position: 'audio' });
  const hello = env.connect();
  hello.msg({ t: 'hello', role: 'member' });
  assert.deepEqual([hello.last('need-join').org, hello.last('need-join').rosterOnly, hello.last('need-join').teamPassword], ['Grace Church', true, true]);
  assert.match(phone(env, 'Jo').last('error').error, /team password/);
  assert.match(phone(env, 'Stranger', { teamPassword: 'sunday' }).last('error').error, /isn't on the comms list/);
  assert.ok(phone(env, 'Jo', { teamPassword: 'sunday' }).last('joined'));
});

test('open sign-in adds new people with the position they pick', () => {
  const env = setup();
  const ws = phone(env, 'Walk In', { position: 'lighting' });
  assert.equal(ws.last('welcome').member.position, 'lighting');
});

test('leads can run comms but not change sign-in rules or choose leads', () => {
  const env = setup();
  env.producer.msg({ t: 'add', name: 'Lead Person', position: 'director', lead: true });
  env.producer.msg({ t: 'add', name: 'Cam One', position: 'camera' });
  const token = phone(env, 'Lead Person').last('joined').token;
  const ctl = env.connect();
  ctl.msg({ t: 'hello', role: 'control', token });
  assert.equal(ctl.last('state').asLead, true);
  const cam = env.comms.data.members.find((m) => m.name === 'Cam One');
  ctl.msg({ t: 'perm', memberId: cam.id, channel: 'gfx', listen: true });
  assert.equal(cam.perms.gfx.listen, true);
  ctl.msg({ t: 'access', rosterOnly: true });
  assert.match(ctl.last('error').error, /Only the producer/);
  ctl.msg({ t: 'lead', memberId: cam.id, on: true });
  assert.match(ctl.last('error').error, /Only the producer/);
  // A stranger with no PIN gets nothing.
  const nobody = env.connect();
  nobody.msg({ t: 'hello', role: 'control', pin: 'wrong' });
  assert.match(nobody.last('error').error, /PIN/);
  nobody.msg({ t: 'remove', memberId: cam.id });
  assert.ok(env.comms.data.members.includes(cam));
});

test('talk is only allowed on channels with talk permission', () => {
  const env = setup();
  env.producer.msg({ t: 'add', name: 'Cam', position: 'camera' });
  const ws = phone(env, 'Cam');
  const id = ws.last('welcome').member.id;
  ws.msg({ t: 'talk', channel: 'directors', on: true });
  ws.msg({ t: 'talk', channel: 'cams', on: true });
  assert.deepEqual(env.comms.talking[id], { cams: true });
  env.producer.msg({ t: 'mute', memberId: id, on: true });
  assert.deepEqual(env.comms.talking[id], undefined);
});

test('off-site: phones can join; control needs a signed-in producer; the engine never runs through the tunnel', () => {
  const env = setup({ pin: '' });
  const eng = env.connect(false, { offsite: true, authRank: 3 });
  eng.msg({ t: 'hello', role: 'engine' });
  assert.match(eng.last('error').error, /dashboard computer/);
  assert.equal(env.comms.engine, null);
  const ctl = env.connect(false, { offsite: true });
  ctl.msg({ t: 'hello', role: 'control', pin: '' });
  assert.match(ctl.last('error').error, /producer/);
  const prod = env.connect(false, { offsite: true, authRank: 2 });
  prod.msg({ t: 'hello', role: 'control' });
  assert.ok(prod.last('state'), 'a signed-in producer can run comms from anywhere');
  const ws = env.connect(false, { offsite: true });
  ws.msg({ t: 'hello', role: 'member' });
  ws.msg({ t: 'join', name: 'Remote Rita' });
  assert.ok(ws.last('welcome'));
  assert.equal(env.comms.state().members[0].offsite, true);
});

test('relay: audio frames go phone -> engine (tagged with who) and engine -> that phone only', () => {
  const env = setup();
  const eng = env.connect(true);
  eng.msg({ t: 'hello', role: 'engine' });
  const a = phone(env, 'Ann');
  const b = phone(env, 'Bob');
  const annId = a.last('welcome').member.id;
  a.msg({ t: 'relay' });
  assert.equal(eng.last('relay').from, annId);
  a.bin(Buffer.alloc(320, 7));
  assert.equal(eng.binary.length, 1);
  assert.equal(eng.binary[0].subarray(0, 8).toString(), annId);
  assert.equal(eng.binary[0].length, 328);
  eng.bin(Buffer.concat([Buffer.from(annId), Buffer.alloc(320, 9)]));
  assert.equal(a.binary.length, 1);
  assert.equal(a.binary[0][0], 9);
  assert.equal(b.binary.length, 0, 'other phones get nothing');
  b.bin(Buffer.alloc(9000)); // oversized frames are dropped
  assert.equal(eng.binary.length, 1);
});

test('sign-in: too many wrong codes from one address are refused for a while', () => {
  const env = setup();
  env.producer.msg({ t: 'add', name: 'Pat', position: 'director', code: 'right' });
  for (let i = 0; i < 8; i++) phone(env, 'Pat', { code: `wrong${i}` });
  const ws = phone(env, 'Pat', { code: 'right' });
  assert.match(ws.last('error').error, /Too many wrong tries/);
});
