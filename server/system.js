import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * "This computer": version, updates and the background service.
 *
 * Updates come from the GitHub repository the dashboard was cloned from (git). "Update now"
 * fast-forwards to the latest main branch, installs packages, and restarts. When running as the
 * background service the restart is automatic (the service starts it again); otherwise the
 * person restarts it.
 */
export class System {
  constructor(root) {
    this.root = root;
    this.updating = false;
  }

  git(args, timeout = 30000) {
    return exec('git', args, { cwd: this.root, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).then((r) => r.stdout.trim());
  }

  get isGit() { return fs.existsSync(path.join(this.root, '.git')); }

  /** Running as the background service (started by launchd / systemd / Windows startup)? */
  get asService() { return process.env.WAVS_SERVICE === '1'; }

  serviceInstalled() {
    const home = os.homedir();
    if (process.platform === 'darwin') return fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'com.wavs.dashboard.plist'));
    if (process.platform === 'linux') return fs.existsSync(path.join(home, '.config', 'systemd', 'user', 'wavs-dashboard.service'));
    if (process.platform === 'win32') return fs.existsSync(path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'WAVS Dashboard.vbs'));
    return false;
  }

  async version() {
    const pkg = JSON.parse(fs.readFileSync(path.join(this.root, 'package.json'), 'utf8'));
    if (!this.isGit) return { version: pkg.version, commit: null, date: null };
    try {
      const [commit, date] = (await this.git(['log', '-1', '--format=%h|%cs'])).split('|');
      return { version: pkg.version, commit, date };
    } catch { return { version: pkg.version, commit: null, date: null }; }
  }

  async check() {
    if (!this.isGit) return { git: false };
    try {
      await this.git(['fetch', '--quiet', 'origin', 'main'], 60000);
    } catch (e) {
      throw new Error(`Couldn't reach GitHub to check for updates (${(e.stderr || e.message).split('\n')[0]}). Is this computer online?`);
    }
    const branch = await this.git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const behind = Number(await this.git(['rev-list', '--count', 'HEAD..origin/main'])) || 0;
    const changes = behind ? (await this.git(['log', '--pretty=%s', '-n', '15', 'HEAD..origin/main'])).split('\n').filter(Boolean) : [];
    // npm sometimes rewrites package-lock.json on install; that alone isn't a hand edit.
    const dirty = (await this.git(['status', '--porcelain', '--untracked-files=no'])).split('\n').filter((l) => l.trim() && !/package-lock\.json$/.test(l)).length > 0;
    return { git: true, branch, behind, changes, dirty };
  }

  async update() {
    if (this.updating) throw new Error('An update is already running');
    this.updating = true;
    try {
      const st = await this.check();
      if (!st.git) throw new Error("This copy wasn't installed with git, so it can't update itself. See the README (Updating).");
      if (st.dirty) throw new Error("Some of the dashboard's files were edited by hand, so it won't overwrite them. Ask for help, or re-install.");
      await this.git(['checkout', '--quiet', '--', 'package-lock.json']).catch(() => {});
      if (st.branch !== 'main') await this.git(['checkout', '--quiet', 'main']);
      await this.git(['merge', '--ff-only', '--quiet', 'origin/main']);
      const npm = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
      await exec(fs.existsSync(npm) ? npm : 'npm', ['install', '--no-audit', '--no-fund', '--omit=dev'], {
        cwd: this.root, timeout: 300000, shell: process.platform === 'win32',
        env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}` },
      });
      return { updated: st.behind, restart: this.asService };
    } finally {
      this.updating = false;
    }
  }

  /** Restart (only as the background service, which starts it again). */
  restartSoon() {
    if (!this.asService) return false;
    setTimeout(() => process.exit(0), 800);
    return true;
  }
}
