#!/usr/bin/env node
// Run the dashboard in the background: it starts when you log in and restarts if it stops.
//
//   node scripts/service.mjs install     set up and start
//   node scripts/service.mjs uninstall   stop and remove
//   node scripts/service.mjs stop|start  stop until next login / start again
//   node scripts/service.mjs status
//
// macOS: a launchd agent (~/Library/LaunchAgents/com.wavs.dashboard.plist)
// Linux: a systemd user service; Windows: a hidden script in the Startup folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dataDirFor, oldDataCandidates, adoptOldData } from '../server/datadir.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const HOME = os.homedir();
const DATA = dataDirFor({ root: ROOT });
const LOG = path.join(DATA, 'logs', 'dashboard.log');
const PORT = Number(process.env.PORT) || 8080;
const cmd = process.argv[2] || 'status';

const LABEL = 'com.wavs.dashboard';
const PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const UNIT = path.join(HOME, '.config', 'systemd', 'user', 'wavs-dashboard.service');
const STARTUP = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'WAVS Dashboard.vbs');
const WINLOOP = path.join(DATA, 'run-dashboard.cmd');

const run = (file, args, quiet = false) => {
  try { return execFileSync(file, args, { stdio: quiet ? 'ignore' : 'inherit' }); } catch (e) { if (!quiet) throw e; return null; }
};
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const uid = () => (process.getuid ? process.getuid() : 0);

async function alreadyRunning() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/auth/status`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

function warnProtectedFolder() {
  const rel = path.relative(HOME, ROOT).split(path.sep)[0];
  if (process.platform === 'darwin' && ['Desktop', 'Documents', 'Downloads'].includes(rel)) {
    console.log(`\n⚠  The dashboard folder is in your ${rel} folder. macOS may block background apps from`);
    console.log(`   reading it. If it doesn't start, move the folder to your home folder (${HOME}/WAVS-Dashboard)`);
    console.log('   and run the installer again.\n');
  }
}

async function install() {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  // Bring over an older setup now (from Terminal, where macOS lets us look in Downloads etc.).
  const from = adoptOldData(DATA, oldDataCandidates({ root: ROOT }));
  if (from) console.log(`Copied your existing setup from ${from}`);
  if (await alreadyRunning() && !isInstalled()) {
    console.log(`\nThe dashboard is already running in a Terminal window. Stop it there first (Control + C), then run this again.\n`);
    process.exit(1);
  }
  warnProtectedFolder();
  const pathEnv = [path.dirname(NODE), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':');

  if (process.platform === 'darwin') {
    fs.mkdirSync(path.dirname(PLIST), { recursive: true });
    fs.writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(NODE)}</string><string>${xml(path.join(ROOT, 'server', 'index.js'))}</string></array>
  <key>WorkingDirectory</key><string>${xml(ROOT)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>WAVS_SERVICE</key><string>1</string>
    <key>PATH</key><string>${xml(pathEnv)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xml(LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG)}</string>
</dict>
</plist>
`);
    run('launchctl', ['bootout', `gui/${uid()}/${LABEL}`], true);
    run('launchctl', ['bootstrap', `gui/${uid()}`, PLIST]);
  } else if (process.platform === 'linux') {
    fs.mkdirSync(path.dirname(UNIT), { recursive: true });
    fs.writeFileSync(UNIT, `[Unit]
Description=WAVS Dashboard
After=network-online.target

[Service]
WorkingDirectory=${ROOT}
ExecStart=${NODE} ${path.join(ROOT, 'server', 'index.js')}
Environment=WAVS_SERVICE=1
Environment=PATH=${pathEnv}
Restart=always
RestartSec=5
StandardOutput=append:${LOG}
StandardError=append:${LOG}

[Install]
WantedBy=default.target
`);
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', 'wavs-dashboard']);
    run('loginctl', ['enable-linger', os.userInfo().username], true);
  } else if (process.platform === 'win32') {
    fs.writeFileSync(WINLOOP, `@echo off\r\nset WAVS_SERVICE=1\r\ncd /d "${ROOT}"\r\n:loop\r\n"${NODE}" server\\index.js >> "${LOG}" 2>&1\r\ntimeout /t 5 /nobreak >nul\r\ngoto loop\r\n`);
    fs.mkdirSync(path.dirname(STARTUP), { recursive: true });
    fs.writeFileSync(STARTUP, `CreateObject("WScript.Shell").Run """${WINLOOP}""", 0, False\r\n`);
    run('wscript', [STARTUP]);
  } else {
    console.log(`Starting by itself isn't supported on ${process.platform}. Run "npm start" instead.`);
    process.exit(1);
  }

  for (let i = 0; i < 20 && !(await alreadyRunning()); i++) await new Promise((r) => setTimeout(r, 500));
  if (await alreadyRunning()) {
    console.log('\n✅ The dashboard is running in the background and will start by itself when you log in.');
    console.log(`   Open http://localhost:${PORT} (or http://wavs.local from other devices on your network).`);
    console.log('   You can close this window.\n');
  } else {
    console.log(`\nIt's set up, but didn't answer yet. Check the log: ${LOG}\n`);
  }
}

function isInstalled() {
  return fs.existsSync(process.platform === 'darwin' ? PLIST : process.platform === 'linux' ? UNIT : STARTUP);
}

function stop() {
  if (process.platform === 'darwin') run('launchctl', ['bootout', `gui/${uid()}/${LABEL}`], true);
  else if (process.platform === 'linux') run('systemctl', ['--user', 'stop', 'wavs-dashboard'], true);
  else if (process.platform === 'win32') {
    // Stop the restart loop first, then the dashboard itself.
    run('wmic', ['process', 'where', `CommandLine like '%run-dashboard.cmd%'`, 'call', 'terminate'], true);
    run('wmic', ['process', 'where', `CommandLine like '%${ROOT.replace(/\\/g, '\\\\')}%server%index.js%'`, 'call', 'terminate'], true);
  }
}

async function start() {
  if (process.platform === 'darwin') run('launchctl', ['bootstrap', `gui/${uid()}`, PLIST], true);
  else if (process.platform === 'linux') run('systemctl', ['--user', 'start', 'wavs-dashboard']);
  else if (process.platform === 'win32') run('wscript', [STARTUP]);
}

switch (cmd) {
  case 'install': await install(); break;
  case 'uninstall':
    stop();
    for (const f of [PLIST, UNIT, STARTUP, WINLOOP]) fs.rmSync(f, { force: true });
    if (process.platform === 'linux') run('systemctl', ['--user', 'daemon-reload'], true);
    console.log('The dashboard no longer starts by itself. Run "npm start" to use it from Terminal.');
    break;
  case 'stop': stop(); console.log('Stopped. It starts again at your next login (or run: npm run service:start).'); break;
  case 'start': await start(); console.log(`Started. Open http://localhost:${PORT}`); break;
  default:
    console.log(isInstalled() ? 'Installed: starts by itself when you log in.' : 'Not installed (runs only from Terminal).');
    console.log(await alreadyRunning() ? `Running: http://localhost:${PORT}` : 'Not running right now.');
    console.log(`Log: ${LOG}`);
}
