import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Where everything you set up is stored (organizations, gear, people and photos, dashboards,
 * comms). It lives in one fixed place per computer, outside the code folder, so updating,
 * re-downloading or re-cloning the dashboard never loses it:
 *   macOS    ~/Library/Application Support/WAVS Dashboard
 *   Windows  %APPDATA%\WAVS Dashboard
 *   Linux    ~/.wavs-dashboard
 * WAVS_DATA=<folder> overrides it (e.g. for testing, or to keep data on another drive).
 */
export function dataDirFor({ env = process.env, root, home = os.homedir(), platform = process.platform } = {}) {
  if (env.WAVS_DATA) return path.resolve(root, env.WAVS_DATA);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'WAVS Dashboard');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'WAVS Dashboard');
  return path.join(home, '.wavs-dashboard');
}

/** Older versions kept data inside the code folder. These are the places a copy usually ends up. */
export function oldDataCandidates({ root, home = os.homedir() }) {
  const out = [path.join(root, 'data')];
  for (const parent of [home, 'Downloads', 'Desktop', 'Documents'].map((d) => path.resolve(home, d))) {
    let names = [];
    try { names = fs.readdirSync(parent); } catch { continue; }
    for (const n of names) if (/^wavs[-_ ]?dashboard/i.test(n)) out.push(path.join(parent, n, 'data'));
  }
  return [...new Set(out)];
}

function lastChange(dir) {
  // The newest file anywhere in the org folders says which copy was used most recently.
  let newest = 0;
  const walk = (d, depth) => {
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) { if (depth < 3 && it.name !== 'bin') walk(p, depth + 1); } else {
        try { newest = Math.max(newest, fs.statSync(p).mtimeMs); } catch { /* ignore */ }
      }
    }
  };
  walk(dir, 0);
  return newest;
}

/**
 * First start with the fixed data folder: copy in the most recently used setup from an older
 * copy of the dashboard (organizations, or pre-organization people/dashboards). The old folder is
 * left as it was. Returns the folder that was copied, or null.
 */
export function adoptOldData(dataDir, candidates) {
  if (fs.existsSync(path.join(dataDir, 'orgs.json'))) return null;
  const has = (d) => ['orgs.json', 'greenroom.json', 'dashboards.json'].some((f) => fs.existsSync(path.join(d, f)));
  const found = candidates
    .filter((d) => path.resolve(d) !== path.resolve(dataDir) && has(d))
    .map((d) => ({ d, at: lastChange(d) }))
    .sort((a, b) => b.at - a.at)[0];
  if (!found) return null;
  fs.mkdirSync(dataDir, { recursive: true });
  for (const name of fs.readdirSync(found.d)) {
    if (name === '.gitkeep' || name === 'bin') continue; // cloudflared re-downloads if needed
    fs.cpSync(path.join(found.d, name), path.join(dataDir, name), { recursive: true });
  }
  return found.d;
}
