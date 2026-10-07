import net from 'node:net';
import { PlanningCenter } from './drivers/planningcenter.js';

/**
 * "Test" buttons on the Gear page: try to reach one device with the settings typed in,
 * without saving them. Each returns { ok, detail } within a few seconds.
 */
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

async function getJson(url, ms = 3000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text();
    return { status: res.status, text };
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'No answer (timed out). Check the IP address and that it is on the same network.' : friendly(e));
  } finally { clearTimeout(t); }
}

function friendly(e) {
  const code = e.cause?.code || e.code;
  if (code === 'ECONNREFUSED') return 'Connection refused: the device is there but not accepting connections on that port.';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'Not reachable from this computer. Is it on the same network?';
  if (code === 'ENOTFOUND') return 'That host name could not be found.';
  return e.message;
}

function testShure({ host, port = 2202 }) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    let buf = '';
    const done = (r) => { clearTimeout(t); sock.destroy(); resolve(r); };
    const t = setTimeout(() => done(buf
      ? { ok: true, detail: 'Connected' }
      : { ok: false, detail: 'No answer (timed out). Check the IP address, and that the receiver is on the same network.' }), 4000);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write('< GET MODEL >< GET FW_VER >'));
    sock.on('data', (d) => {
      buf += d;
      const model = buf.match(/REP MODEL \{?([^}>]+)/)?.[1]?.trim();
      if (model) done({ ok: true, detail: `Connected to ${model}${buf.match(/REP FW_VER \{?([^}>]+)/) ? ` (firmware ${buf.match(/REP FW_VER \{?([^}>]+)/)[1].trim()})` : ''}` });
    });
    sock.on('error', (e) => done({ ok: false, detail: friendly(e) }));
  });
}

async function testAtem({ host }) {
  let Atem;
  try { ({ Atem } = await import('atem-connection')); } catch { return { ok: false, detail: 'atem-connection is not installed (run npm install)' }; }
  const atem = new Atem();
  try {
    await withTimeout(new Promise((resolve, reject) => {
      atem.once('connected', resolve);
      atem.once('error', (e) => reject(new Error(String(e))));
      atem.connect(host);
    }), 6000, 'No answer (timed out). Check the IP address in ATEM Setup → Network.');
    const s = atem.state;
    return { ok: true, detail: `Connected to ${s?.info?.productIdentifier || 'ATEM'}${s?.video?.mixEffects ? ` · ${s.video.mixEffects.length} M/E` : ''}` };
  } catch (e) {
    return { ok: false, detail: e.message };
  } finally {
    atem.disconnect().catch(() => {});
  }
}

async function testVmix({ host, port = 8088 }) {
  const r = await getJson(`http://${host}:${port}/api`);
  const version = r.text.match(/<version>([^<]+)/)?.[1];
  return version ? { ok: true, detail: `Connected to vMix ${version}` } : { ok: false, detail: `Answered with HTTP ${r.status}, but it doesn't look like vMix` };
}

async function testProPresenter({ host, port = 1025 }) {
  const r = await getJson(`http://${host}:${port}/version`);
  try {
    const v = JSON.parse(r.text);
    return { ok: true, detail: `Connected to ${v.host_description || 'ProPresenter'}${v.name ? ` on ${v.name}` : ''}` };
  } catch {
    return { ok: false, detail: `Answered with HTTP ${r.status}. Is network enabled in ProPresenter → Settings → Network, and is the port right?` };
  }
}

async function testVideo({ type, url }) {
  if (type === 'capture') return { ok: true, detail: 'Capture cards are checked by the browser on the computer showing the dashboard.' };
  const r = await getJson(url, 4000);
  // WHEP endpoints answer GET with 4xx (they expect POST); any answer means the server is reachable.
  return r.status < 500 ? { ok: true, detail: `Server reachable (HTTP ${r.status})` } : { ok: false, detail: `Server error (HTTP ${r.status})` };
}

async function testPco(cfg) {
  const types = await new PlanningCenter(cfg).serviceTypes();
  return { ok: true, detail: `Connected. Service types: ${types.map((t) => t.name).join(', ') || 'none'}`, serviceTypes: types };
}

export async function testDevice(kind, cfg) {
  if (cfg?.type === 'simulator') return { ok: true, detail: 'Simulated device (no hardware needed)' };
  try {
    switch (kind) {
      case 'receiver': return await testShure(cfg);
      case 'switcher': return await (cfg.type === 'vmix' ? testVmix(cfg) : testAtem(cfg));
      case 'propresenter': return await testProPresenter(cfg);
      case 'video': return await testVideo(cfg);
      case 'planningCenter': return await testPco(cfg);
      default: return { ok: false, detail: `Unknown device kind "${kind}"` };
    }
  } catch (e) {
    return { ok: false, detail: friendly(e) };
  }
}
