import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Tunnel } from '../server/tunnel.js';

// A stand-in for cloudflared: prints the address first, and only later that it's connected.
function fakeCloudflared(dir, { registerAfterMs }) {
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  const bin = path.join(dir, 'bin', 'cloudflared');
  fs.writeFileSync(bin, `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'args.json'))}, JSON.stringify(process.argv.slice(2)));
console.error('INF |  https://partnership-throws-tuner-broker.trycloudflare.com  |');
${registerAfterMs === null ? '' : `setTimeout(() => console.error('INF Registered tunnel connection connIndex=0 protocol=http2'), ${registerAfterMs});`}
setInterval(() => {}, 1000);
`, { mode: 0o755 });
}

const until = async (fn, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (fn()) return true;
  return false;
};

test('the free link only shows once Cloudflare has connected it, over https (http2)', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavs-tun-'));
  fakeCloudflared(dir, { registerAfterMs: 400 });
  const t = new Tunnel(dir, 8090);
  try {
    await t.enable(true);
    assert.ok(await until(() => fs.existsSync(path.join(dir, 'args.json'))));
    await new Promise((r) => setTimeout(r, 150)); // address printed, not connected yet
    assert.equal(t.state.status, 'starting');
    assert.equal(t.state.url, null, 'no link to hand out yet');
    assert.ok(await until(() => t.state.status === 'on'));
    assert.equal(t.state.url, 'https://partnership-throws-tuner-broker.trycloudflare.com');
    const args = JSON.parse(fs.readFileSync(path.join(dir, 'args.json'), 'utf8'));
    assert.deepEqual(args.slice(args.indexOf('--protocol'), args.indexOf('--protocol') + 2), ['--protocol', 'http2']);
    assert.ok(args.includes('--url') && args.includes('http://127.0.0.1:8090'));
  } finally { await t.enable(false); }
});

test('your own address: on once connected, with the token, over http2', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavs-tun-'));
  fakeCloudflared(dir, { registerAfterMs: 100 });
  const t = new Tunnel(dir, 8090);
  try {
    t.configure({ mode: 'named', token: 'tok123', hostname: 'https://Dashboard.Example.org/' });
    await t.enable(true);
    assert.ok(await until(() => t.state.status === 'on'));
    assert.equal(t.state.url, 'https://dashboard.example.org');
    const args = JSON.parse(fs.readFileSync(path.join(dir, 'args.json'), 'utf8'));
    assert.deepEqual(args, ['tunnel', '--no-autoupdate', '--protocol', 'http2', 'run', '--token', 'tok123']);
  } finally { await t.enable(false); }
});
