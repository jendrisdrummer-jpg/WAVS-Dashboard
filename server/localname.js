import fs from 'node:fs';
import path from 'node:path';
import { lanAddresses } from './tunnel.js';

/**
 * A friendly address on the local network: http://<name>.local (Bonjour/mDNS). Macs, iPhones,
 * iPads and Windows 10+ resolve .local names; some Android phones do not (use the IP there).
 *
 * Each computer that can host has its own name (Settings → This computer), e.g. "wavs" on the
 * Mac for WAVS events and "grace" on the church computer, so two hosts on one network don't
 * clash. WAVS_NAME=<name> overrides it. If another device already answers for the name, that's
 * reported (localName.conflict) so the person can pick another.
 */
export const localName = { active: false, host: null, name: null, port80: false, error: null, conflict: null };

let mdns = null;
let file = null;

export const cleanName = (n) => String(n || '').toLowerCase().replace(/\.local$/, '').replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, 40);

export async function startLocalName(dataDir) {
  file = path.join(dataDir, 'computer.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* default */ }
  const name = cleanName(process.env.WAVS_NAME || saved.name) || 'wavs';
  return announce(name);
}

/** Change this computer's name (saved), and start answering for it. */
export async function setLocalName(name) {
  const n = cleanName(name);
  if (!n) throw new Error('Use letters, numbers and dashes, e.g. "grace" or "wavs-booth"');
  if (process.env.WAVS_NAME) throw new Error('The name is set with WAVS_NAME on this computer');
  fs.writeFileSync(file, JSON.stringify({ name: n }));
  return announce(n);
}

async function announce(name) {
  localName.name = name;
  localName.host = `${name}.local`;
  localName.conflict = null;
  if (mdns) { mdns.destroy(); mdns = null; localName.active = false; }
  if (process.env.WAVS_MDNS === '0') return localName;
  try {
    const { default: create } = await import('multicast-dns');
    const m = create();
    mdns = m;
    const host = localName.host;
    const mine = () => new Set(lanAddresses().map((i) => i.address));
    let probing = true;
    m.on('query', (q) => {
      const asks = q.questions.some((x) => x.name.toLowerCase() === host && (x.type === 'A' || x.type === 'ANY'));
      if (!asks || probing) return;
      const answers = lanAddresses().map((i) => ({ name: host, type: 'A', ttl: 120, data: i.address, flush: true }));
      if (answers.length) m.respond({ answers });
    });
    // Before answering, ask whether another device already uses this name.
    m.on('response', (r) => {
      const other = [...(r.answers || []), ...(r.additionals || [])]
        .find((a) => a.type === 'A' && a.name?.toLowerCase() === host && !mine().has(a.data));
      if (other) localName.conflict = other.data;
    });
    m.on('error', (e) => { localName.error = e.message; });
    m.query({ questions: [{ name: host, type: 'A' }] });
    await new Promise((r) => setTimeout(r, 1200));
    probing = false;
    localName.active = true;
    if (localName.conflict) console.log(`  ⚠ Another device (${localName.conflict}) already uses ${host}. Pick another name in Settings → This computer.`);
  } catch (e) {
    localName.error = e.message;
  }
  return localName;
}

export function stopLocalName() { mdns?.destroy(); mdns = null; }

/** Also answer on port 80 (so the address needs no ":8080"). Skipped quietly if the port is taken or not allowed. */
export function listenPort80(server, hostAddr) {
  if (process.env.WAVS_PORT80 === '0') return Promise.resolve(false);
  return new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(80, hostAddr, () => { localName.port80 = true; resolve(true); });
  });
}
