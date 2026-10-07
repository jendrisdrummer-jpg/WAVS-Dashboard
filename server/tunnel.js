import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';

const run = promisify(execFile);

/**
 * Off-site access for comms: a Cloudflare "quick tunnel" gives phones a public https:// address
 * (https://<random>.trycloudflare.com) that reaches this computer from any network, with a real
 * certificate. No Cloudflare account is needed. The address changes each time the tunnel starts.
 *
 * Only the comms phone page is reachable through it (see the separate server in index.js),
 * never the dashboard or its settings.
 *
 * cloudflared is used from the PATH (e.g. Homebrew) or downloaded once into data/bin/ from
 * Cloudflare's official GitHub releases.
 */
const RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download';

function releaseFile() {
  const arch = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' }[process.arch];
  if (!arch) return null;
  if (process.platform === 'darwin') return `cloudflared-darwin-${arch === 'arm64' ? 'arm64' : 'amd64'}.tgz`;
  if (process.platform === 'linux') return `cloudflared-linux-${arch}`;
  if (process.platform === 'win32') return `cloudflared-windows-${arch === '386' ? '386' : 'amd64'}.exe`;
  return null;
}

export class Tunnel extends EventEmitter {
  constructor(dataDir, port) {
    super();
    this.dir = path.join(dataDir, 'bin');
    this.file = path.join(dataDir, 'tunnel.json');
    this.port = port;
    this.state = { status: 'off', url: null, error: null };
    this.enabled = false;
    // mode "quick": a free random https://….trycloudflare.com address that changes on each start.
    // mode "named": your own address (e.g. dashboard.yourchurch.org) from a Cloudflare tunnel token.
    this.conf = { mode: 'quick', token: '', hostname: '' };
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.enabled = saved.enabled === true;
      this.conf = { mode: saved.mode || 'quick', token: saved.token || '', hostname: saved.hostname || '' };
    } catch { /* first run */ }
  }

  persist() {
    fs.writeFileSync(this.file, JSON.stringify({ ...this.conf, enabled: this.enabled }, null, 2), { mode: 0o600 });
  }

  /** What the browser may see (never the token). */
  publicState() {
    return { ...this.state, enabled: this.enabled, mode: this.conf.mode, hostname: this.conf.hostname || null, hasToken: Boolean(this.conf.token), port: this.port };
  }

  configure({ mode, token, hostname }) {
    if (mode) this.conf.mode = mode === 'named' ? 'named' : 'quick';
    if (typeof token === 'string' && token.trim() && !/^•+$/.test(token)) this.conf.token = token.trim();
    if (typeof hostname === 'string') this.conf.hostname = hostname.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
    if (this.conf.mode === 'named' && (!this.conf.token || !this.conf.hostname)) throw new Error('Enter the tunnel token and the address (e.g. dashboard.yourchurch.org)');
    this.persist();
  }

  restart() { this.stop(); this.start(); }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('change', this.state);
  }

  /** Turn off-site access on or off (remembered across restarts). */
  async enable(on) {
    this.enabled = Boolean(on);
    this.persist();
    if (this.enabled) return this.start();
    this.stop();
    this.set({ status: 'off', url: null, error: null });
  }

  async findBinary() {
    const local = path.join(this.dir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
    const candidates = [local, '/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared'];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    try {
      const { stdout } = await run(process.platform === 'win32' ? 'where' : 'which', ['cloudflared']);
      if (stdout.trim()) return stdout.trim().split(/\r?\n/)[0];
    } catch { /* not on PATH */ }
    return null;
  }

  /** Download cloudflared from Cloudflare's GitHub releases into data/bin/. */
  async install() {
    const name = releaseFile();
    if (!name) throw new Error(`Off-site access isn't available on this computer (${process.platform} ${process.arch})`);
    this.set({ status: 'installing', error: null });
    fs.mkdirSync(this.dir, { recursive: true });
    const res = await fetch(`${RELEASES}/${name}`);
    if (!res.ok) throw new Error(`Could not download cloudflared (HTTP ${res.status}). Is this computer online?`);
    const tmp = path.join(this.dir, name);
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    const bin = path.join(this.dir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
    if (name.endsWith('.tgz')) {
      await run('tar', ['-xzf', tmp, '-C', this.dir]);
      fs.rmSync(tmp);
    } else {
      fs.renameSync(tmp, bin);
    }
    fs.chmodSync(bin, 0o755);
    return bin;
  }

  async start() {
    if (this.proc) return;
    clearTimeout(this.retry);
    try {
      const bin = (await this.findBinary()) || (await this.install());
      if (!this.enabled) return;
      this.set({ status: 'starting', url: null, error: null });
      const named = this.conf.mode === 'named' && this.conf.token;
      const args = named
        ? ['tunnel', '--no-autoupdate', 'run', '--token', this.conf.token]
        : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.port}`];
      const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.proc = proc;
      let log = '';
      const onData = (chunk) => {
        const text = chunk.toString();
        log = (log + text).slice(-2000);
        if (named && /Registered tunnel connection/i.test(text) && this.state.status !== 'on') {
          this.set({ status: 'on', url: `https://${this.conf.hostname}`, error: null });
          console.log(`  Off-site: https://${this.conf.hostname}`);
        }
        const m = !named && text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m && this.state.url !== m[0]) {
          this.set({ status: 'on', url: m[0], error: null });
          console.log(`  Comms off-site: ${m[0]}/comms`);
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('error', (e) => this.set({ status: 'error', error: e.message }));
      proc.on('exit', (code) => {
        this.proc = null;
        if (!this.enabled) return;
        const why = log.split('\n').reverse().find((l) => /ERR|error|failed/i.test(l)) || `cloudflared stopped (code ${code})`;
        this.set({ status: 'error', url: null, error: why.replace(/^\S+\s+(ERR|INF|WRN)\s+/, '').slice(0, 200) });
        this.retry = setTimeout(() => this.start(), 15000); // keep trying (e.g. internet was down)
      });
    } catch (e) {
      this.set({ status: 'error', error: e.message });
      if (this.enabled) this.retry = setTimeout(() => this.start(), 60000);
    }
  }

  stop() {
    clearTimeout(this.retry);
    if (this.proc) { const p = this.proc; this.proc = null; p.removeAllListeners('exit'); p.kill(); }
    this.set({ url: null, status: this.enabled ? 'starting' : 'off' });
  }
}

/** This computer's network addresses, best first (Wi-Fi/Ethernet before VPNs and virtual adapters). */
export function lanAddresses() {
  const rank = (name) => (/^(en|eth|wlan|wl)/i.test(name) ? 0 : /^(wi-?fi|ethernet)/i.test(name) ? 0 : /^(utun|tun|tap|tailscale|zt|docker|br-|bridge|vbox|vmnet|veth|awdl|llw)/i.test(name) ? 2 : 1);
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, list]) => (list || []).map((i) => ({ ...i, name })))
    .filter((i) => i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
    .map((i) => ({ address: i.address, iface: i.name, likely: rank(i.name) === 0 }));
}
