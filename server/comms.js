import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

/**
 * Comms (intercom) coordination for one organization.
 *
 * Audio never passes through this server: every phone makes a WebRTC connection to the
 * comms engine (a browser page on the dashboard computer) which mixes it. This class keeps
 * the channels, positions and people, the live talk state, and relays WebRTC setup messages
 * between phones and the engine over the /comms-ws WebSocket.
 *
 * Roles on the socket: "member" (a phone), "engine" (the mixer page), "control" (producer / lead).
 */

const DEFAULT_CHANNELS = [
  ['directors', 'Directors', '#ef4444'], ['cams', 'Cam Ops', '#3b82f6'], ['lighting', 'Lighting', '#f59e0b'],
  ['gfx', 'GFX', '#a855f7'], ['audio', 'Audio', '#22c55e'], ['stage', 'Stage', '#06b6d4'],
].map(([id, name, color]) => ({ id, name, color }));

const p = (talkListen, listenOnly = []) => {
  const perms = {};
  for (const c of talkListen) perms[c] = { talk: true, listen: true };
  for (const c of listenOnly) perms[c] = { talk: false, listen: true };
  return perms;
};
const ALL = DEFAULT_CHANNELS.map((c) => c.id);
const DEFAULT_POSITIONS = [
  { id: 'director', name: 'Director', perms: p(ALL) },
  { id: 'producer', name: 'Producer', perms: p(ALL) },
  { id: 'camera', name: 'Camera op', perms: p(['cams'], ['directors']) },
  { id: 'lighting', name: 'Lighting', perms: p(['lighting'], ['directors']) },
  { id: 'gfx', name: 'GFX / ProPresenter', perms: p(['gfx'], ['directors']) },
  { id: 'audio', name: 'Audio', perms: p(['audio'], ['directors']) },
  { id: 'stage', name: 'Stage manager', perms: p(['stage', 'directors']) },
  { id: 'listen', name: 'Listen only', perms: p([], ['directors']) },
];

const str = (v, max = 60) => String(v ?? '').trim().slice(0, max);
const hash = (v) => crypto.createHash('sha256').update(`wavs-comms:${v}`).digest('hex');
const sameName = (a, b) => str(a).toLowerCase().replace(/\s+/g, ' ') === str(b).toLowerCase().replace(/\s+/g, ' ');
const matches = (stored, given) => {
  const a = Buffer.from(stored || '');
  const b = Buffer.from(hash(str(given, 40)));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const slug = (s) => str(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || crypto.randomUUID().slice(0, 8);

export class Comms extends EventEmitter {
  /** checkPin(pin) -> boolean: the organization's admin PIN (true when none is set). */
  constructor(dir, { checkPin, orgName }) {
    super();
    this.file = path.join(dir, 'comms.json');
    this.checkPin = checkPin;
    this.orgName = orgName;
    // access.rosterOnly: only people added in advance can sign in.
    // access.teamPassword: one password for the whole team (hashed).
    this.data = { channels: DEFAULT_CHANNELS, positions: DEFAULT_POSITIONS, members: [], ports: [], access: { rosterOnly: false, teamPassword: null } };
    if (fs.existsSync(this.file)) {
      try { this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch (e) { console.error(`[comms] ${e.message}`); }
    }
    this.sockets = new Set();
    this.engine = null;
    this.talking = {}; // memberId -> { channelId: true }
    this.levels = {}; // endpoint key -> 0..1 (from the engine)
    this.cues = []; // recent cues with acknowledgements
  }

  // ---------------------------------------------------------------- persistence & state

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 2));
      fs.renameSync(`${this.file}.tmp`, this.file);
    }, 200);
  }

  online(id) { return [...this.sockets].some((ws) => ws.role === 'member' && ws.memberId === id); }

  /** What every client sees (tokens are never included). */
  state() {
    return {
      channels: this.data.channels,
      positions: this.data.positions,
      members: this.data.members.map(({ token, passcode, ...m }) => ({ ...m, hasCode: Boolean(passcode), signedIn: Boolean(token), online: this.online(m.id), talking: this.talking[m.id] || {} })),
      ports: this.data.ports,
      access: { rosterOnly: this.data.access.rosterOnly, hasTeamPassword: Boolean(this.data.access.teamPassword) },
      engine: { online: Boolean(this.engine) },
      cues: this.cues,
    };
  }

  /** Small public view for dashboards: who is on comms and who is talking (no settings). */
  summary() {
    return {
      engine: Boolean(this.engine),
      channels: this.data.channels,
      members: this.data.members.map((m) => ({
        id: m.id, name: m.name, position: this.data.positions.find((x) => x.id === m.position)?.name || '', online: this.online(m.id),
        muted: m.muted, lead: m.lead, talking: Object.keys(this.talking[m.id] || {}),
      })),
    };
  }

  /** Send state to everyone, at most 10x/sec. */
  changed() {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      const msg = JSON.stringify({ t: 'state', state: this.state() });
      for (const ws of this.sockets) if (ws.readyState === 1 && ws.role) ws.send(msg);
      this.emit('change', this.state());
    }, 100);
  }

  send(ws, msg) { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); }

  member(id) { return this.data.members.find((m) => m.id === id); }

  // ---------------------------------------------------------------- sockets

  attach(ws, req) {
    this.sockets.add(ws);
    ws.isLocal = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      try { this.handle(ws, msg); } catch (e) { this.send(ws, { t: 'error', error: e.message }); }
    });
    ws.on('close', () => this.detach(ws));
  }

  detach(ws) {
    this.sockets.delete(ws);
    if (ws === this.engine) {
      this.engine = null;
      for (const s of this.sockets) if (s.role === 'member') this.send(s, { t: 'engine', online: false });
    }
    if (ws.role === 'member' && !this.online(ws.memberId)) {
      delete this.talking[ws.memberId];
      this.send(this.engine, { t: 'bye', from: ws.memberId });
    }
    this.changed();
  }

  /** Producer (admin PIN) or a person marked as lead (their phone token). */
  canControl(ws) {
    if (ws.leadId) return Boolean(this.member(ws.leadId)?.lead); // a lead who was demoted loses control at once
    return ws.role === 'control' || (ws.role === 'member' && Boolean(this.member(ws.memberId)?.lead));
  }

  /** The producer (admin PIN), as opposed to a lead. */
  isProducer(ws) { return ws.role === 'control' && !ws.leadId; }

  handle(ws, msg) {
    switch (msg.t) {
      case 'hello': return this.hello(ws, msg);
      case 'join': return this.join(ws, msg);
      case 'signal': return this.signal(ws, msg);
      case 'talk': return this.talk(ws, msg);
      case 'listen': return this.listen(ws, msg);
      case 'ack': return this.ack(ws, msg);
      case 'levels':
        if (ws === this.engine) {
          this.levels = msg.levels || {};
          const out = JSON.stringify({ t: 'levels', levels: this.levels });
          for (const s of this.sockets) if (this.canControl(s) && s.readyState === 1) s.send(out);
        }
        return;
      case 'ports':
        if (ws !== this.engine && !this.canControl(ws)) throw new Error('Not allowed');
        this.data.ports = (msg.ports || []).slice(0, 16).map((pt) => ({
          id: slug(pt.id || pt.name), name: str(pt.name) || 'Port', kind: pt.kind === 'out' ? 'out' : 'in',
          device: str(pt.device, 120), deviceChannel: Math.max(1, Math.min(64, Number(pt.deviceChannel) || 1)),
          channels: (pt.channels || []).filter((c) => this.data.channels.some((x) => x.id === c)), muted: Boolean(pt.muted),
        }));
        this.save();
        return this.changed();
      default:
        if (!this.canControl(ws)) throw new Error('Only the producer or a lead can do that');
        return this.control(ws, msg);
    }
  }

  hello(ws, { role, token, pin }) {
    if (role === 'engine') {
      // The mixer must run on the dashboard computer itself (or know the admin PIN).
      if (!ws.isLocal && !this.checkPin(pin)) throw new Error('The comms engine must run on the dashboard computer (or enter the admin PIN)');
      if (this.engine && this.engine !== ws) this.send(this.engine, { t: 'replaced' });
      this.engine = ws;
      ws.role = 'engine';
      this.send(ws, { t: 'state', state: this.state() });
      for (const s of this.sockets) if (s.role === 'member') this.send(s, { t: 'engine', online: true });
      return this.changed();
    }
    if (role === 'control') {
      const lead = token && this.data.members.find((m) => m.token === token && m.lead);
      if (lead) {
        ws.role = 'control';
        ws.leadId = lead.id; // a lead: can run comms, but not change sign-in rules or choose leads
      } else if (this.checkPin(pin)) {
        ws.role = 'control';
      } else throw new Error('PIN required');
      return this.send(ws, { t: 'state', state: this.state(), levels: this.levels, asLead: Boolean(ws.leadId) });
    }
    // phone
    const m = token && this.data.members.find((x) => x.token === token);
    if (!m) {
      return this.send(ws, {
        t: 'need-join', org: this.orgName, rosterOnly: this.data.access.rosterOnly, teamPassword: Boolean(this.data.access.teamPassword),
        positions: this.data.positions.map(({ id, name }) => ({ id, name })),
      });
    }
    ws.role = 'member';
    ws.memberId = m.id;
    this.send(ws, { t: 'welcome', member: { ...m, token: undefined }, state: this.state() });
    this.changed();
  }

  /**
   * Signing in from a phone. People added in advance sign in with their name (and their personal
   * code if they have one) and get the position the producer set up. Others are added as new
   * people, unless the list is "roster only".
   */
  join(ws, { name, position, teamPassword, code }) {
    if (!str(name)) throw new Error('Enter your name');
    const { access } = this.data;
    if (access.teamPassword && !matches(access.teamPassword, teamPassword)) throw new Error("That team password isn't right");
    let m = this.data.members.find((x) => sameName(x.name, name));
    if (m) {
      if (m.passcode && !matches(m.passcode, code)) throw new Error("Enter your personal code (ask the producer if you don't have it)");
      if (!m.passcode && m.token && this.online(m.id)) throw new Error(`${m.name} is already signed in on another phone. Ask the producer to sign them out first.`);
      // A new sign-in replaces the old phone.
      for (const s of this.sockets) if (s.memberId === m.id) { this.send(s, { t: 'removed', reason: 'Signed in on another phone' }); s.close(); }
      m.token = crypto.randomBytes(18).toString('base64url');
    } else {
      if (access.rosterOnly) throw new Error(`${str(name)} isn't on the comms list for ${this.orgName}. Check the spelling, or ask the producer to add you.`);
      const pos = this.data.positions.find((x) => x.id === position) || this.data.positions[this.data.positions.length - 1];
      m = {
        id: crypto.randomUUID().slice(0, 8), token: crypto.randomBytes(18).toString('base64url'), name: str(name, 40), passcode: null,
        position: pos.id, perms: structuredClone(pos.perms), listen: {}, volume: {}, muted: false, lead: false, createdAt: new Date().toISOString(),
      };
      this.data.members.push(m);
    }
    this.save();
    this.send(ws, { t: 'joined', token: m.token });
    this.hello(ws, { token: m.token });
  }

  signal(ws, { to, data }) {
    if (ws.role === 'member') return this.send(this.engine, { t: 'signal', from: ws.memberId, data });
    if (ws === this.engine) {
      for (const s of this.sockets) if (s.role === 'member' && s.memberId === to) this.send(s, { t: 'signal', data });
    }
  }

  talk(ws, { channel, on }) {
    if (ws.role !== 'member') return;
    const m = this.member(ws.memberId);
    const t = (this.talking[m.id] ||= {});
    if (on && m.perms?.[channel]?.talk && !m.muted) t[channel] = true;
    else delete t[channel];
    this.changed();
  }

  listen(ws, { channel, on, volume }) {
    if (ws.role !== 'member') return;
    const m = this.member(ws.memberId);
    if (!m.perms?.[channel]?.listen) return;
    if (typeof on === 'boolean') m.listen[channel] = on;
    if (typeof volume === 'number') m.volume[channel] = Math.max(0, Math.min(1, volume));
    this.save();
    this.changed();
  }

  ack(ws, { cueId }) {
    const cue = this.cues.find((c) => c.id === cueId);
    if (cue && ws.memberId && !cue.acks.includes(ws.memberId)) { cue.acks.push(ws.memberId); this.changed(); }
  }

  /** Producer / lead actions. */
  control(ws, msg) {
    const m = msg.memberId && this.member(msg.memberId);
    switch (msg.t) {
      case 'add': {
        // Add someone in advance with their position (and optional personal code).
        if (!str(msg.name)) throw new Error('Enter a name');
        if (this.data.members.some((x) => sameName(x.name, msg.name))) throw new Error(`${str(msg.name)} is already on the list`);
        const pos = this.data.positions.find((x) => x.id === msg.position) || this.data.positions[0];
        this.data.members.push({
          id: crypto.randomUUID().slice(0, 8), token: null, name: str(msg.name, 40), passcode: str(msg.code, 40) ? hash(str(msg.code, 40)) : null,
          position: pos.id, perms: structuredClone(pos.perms), listen: {}, volume: {}, muted: false, lead: Boolean(msg.lead), createdAt: new Date().toISOString(),
        });
        break;
      }
      case 'edit':
        if (!m) throw new Error('Unknown person');
        if (str(msg.name)) {
          if (this.data.members.some((x) => x !== m && sameName(x.name, msg.name))) throw new Error(`${str(msg.name)} is already on the list`);
          m.name = str(msg.name, 40);
        }
        if (typeof msg.code === 'string') m.passcode = str(msg.code, 40) ? hash(str(msg.code, 40)) : null;
        break;
      case 'signout':
        if (!m) throw new Error('Unknown person');
        m.token = null;
        delete this.talking[m.id];
        for (const s of this.sockets) if (s.memberId === m.id) { this.send(s, { t: 'removed', reason: 'Signed out by the producer' }); s.close(); }
        break;
      case 'access':
        if (!this.isProducer(ws)) throw new Error('Only the producer can change sign-in rules');
        if (typeof msg.rosterOnly === 'boolean') this.data.access.rosterOnly = msg.rosterOnly;
        if (typeof msg.teamPassword === 'string') this.data.access.teamPassword = str(msg.teamPassword, 40) ? hash(str(msg.teamPassword, 40)) : null;
        break;
      case 'perm': {
        if (!m || !this.data.channels.some((c) => c.id === msg.channel)) throw new Error('Unknown person or channel');
        const cur = m.perms[msg.channel] || { talk: false, listen: false };
        m.perms[msg.channel] = { talk: msg.talk ?? cur.talk, listen: msg.listen ?? cur.listen };
        if (!m.perms[msg.channel].talk) delete this.talking[m.id]?.[msg.channel];
        break;
      }
      case 'position': {
        const pos = this.data.positions.find((x) => x.id === msg.position);
        if (!m || !pos) throw new Error('Unknown person or position');
        m.position = pos.id;
        m.perms = structuredClone(pos.perms);
        delete this.talking[m.id];
        break;
      }
      case 'mute':
        if (!m) throw new Error('Unknown person');
        m.muted = Boolean(msg.on);
        if (m.muted) delete this.talking[m.id];
        break;
      case 'lead':
        if (!m) throw new Error('Unknown person');
        if (!this.isProducer(ws)) throw new Error('Only the producer can choose leads');
        m.lead = Boolean(msg.on);
        break;
      case 'remove':
        if (!m) throw new Error('Unknown person');
        this.data.members = this.data.members.filter((x) => x.id !== m.id);
        delete this.talking[m.id];
        for (const s of this.sockets) if (s.memberId === m.id) { this.send(s, { t: 'removed', reason: 'Removed from comms by the producer' }); s.close(); }
        break;
      case 'channels': {
        const ids = new Set();
        const list = (msg.channels || []).slice(0, 16).map((c) => {
          let id = slug(c.id || c.name);
          for (let n = 2; ids.has(id); n++) id = `${slug(c.id || c.name)}-${n}`;
          ids.add(id);
          return { id, name: str(c.name, 30) || 'Channel', color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : '#64748b' };
        });
        for (const x of [...this.data.members, ...this.data.positions]) for (const k of Object.keys(x.perms)) if (!ids.has(k)) delete x.perms[k];
        this.data.channels = list;
        break;
      }
      case 'position-perm': {
        const pos = this.data.positions.find((x) => x.id === msg.position);
        if (!pos) throw new Error('Unknown position');
        pos.perms[msg.channel] = { talk: Boolean(msg.talk), listen: Boolean(msg.listen) || Boolean(msg.talk) };
        break;
      }
      case 'cue': {
        const cue = { id: crypto.randomUUID().slice(0, 8), kind: ['standby', 'go', 'text'].includes(msg.kind) ? msg.kind : 'text', text: str(msg.text, 120), target: msg.target || { all: true }, at: new Date().toISOString(), acks: [] };
        this.cues = [cue, ...this.cues].slice(0, 6);
        for (const s of this.sockets) {
          if (s.role !== 'member') continue;
          const who = this.member(s.memberId);
          const hit = cue.target.all || cue.target.member === who.id || (cue.target.channel && who.perms[cue.target.channel]?.listen);
          if (hit) this.send(s, { t: 'cue', cue, channel: this.data.channels.find((c) => c.id === cue.target.channel)?.name || null });
        }
        break;
      }
      default:
        throw new Error(`Unknown action "${msg.t}"`);
    }
    this.save();
    this.changed();
  }

  stop() {
    clearTimeout(this.pending);
    if (this.saveTimer) { clearTimeout(this.saveTimer); fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); }
    for (const ws of this.sockets) { this.send(ws, { t: 'reload' }); ws.close(); }
    this.sockets.clear();
    this.removeAllListeners();
  }
}
