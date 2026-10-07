import { lanAddresses } from './tunnel.js';

/**
 * A friendly address on the local network: http://wavs.local (Bonjour/mDNS). Macs, iPhones,
 * iPads and Windows 10+ resolve .local names; some Android phones do not (use the IP there).
 * The name can be changed with WAVS_NAME=<name> (e.g. "grace" -> http://grace.local).
 */
export const localName = { active: false, host: null, port80: false, error: null };

export async function startLocalName(name = process.env.WAVS_NAME || 'wavs') {
  const host = `${String(name).toLowerCase().replace(/[^a-z0-9-]/g, '') || 'wavs'}.local`;
  localName.host = host;
  if (process.env.WAVS_MDNS === '0') return localName;
  try {
    const { default: mdns } = await import('multicast-dns');
    const m = mdns();
    m.on('query', (q) => {
      const asks = q.questions.filter((x) => x.name.toLowerCase() === host && (x.type === 'A' || x.type === 'ANY'));
      if (!asks.length) return;
      const answers = lanAddresses().map((i) => ({ name: host, type: 'A', ttl: 120, data: i.address, flush: true }));
      if (answers.length) m.respond({ answers });
    });
    m.on('error', (e) => { localName.error = e.message; });
    localName.active = true;
    localName.stop = () => m.destroy();
  } catch (e) {
    localName.error = e.message;
  }
  return localName;
}

/** Also answer on port 80 (so the address needs no ":8080"). Skipped quietly if the port is taken or not allowed. */
export function listenPort80(server, hostAddr) {
  if (process.env.WAVS_PORT80 === '0') return Promise.resolve(false);
  return new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(80, hostAddr, () => { localName.port80 = true; resolve(true); });
  });
}
