import { EventEmitter } from 'node:events';

/**
 * Live stream viewer counts and comments.
 *
 *  YouTube   API key (free, Google Cloud). The live video is found from the channel's /live page
 *            (no API quota), then videos.list gives concurrent viewers and the live chat id, and
 *            liveChatMessages.list the chat. A pasted video link works too.
 *  Facebook  Page ID + Page access token. /{page}/live_videos gives the live video and live_views;
 *            /{video}/comments the comments.
 *  simulator For demos and testing.
 *
 * State per stream goes into the hub ("streams"); comments are kept here (latest 300) with a
 * kind (question / prayer) so the widget can filter and highlight them.
 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const MAX_COMMENTS = 300;

export function commentKind(text) {
  const t = String(text || '').toLowerCase();
  if (/\bpray(er|ers|ing)?\b|\bplease pray\b/.test(t)) return 'prayer';
  if (/\?\s*$|\?\s|^(who|what|when|where|why|how|can|could|is|are|do|does|will|would|should)\b/.test(t)) return 'question';
  return null;
}

async function getJson(url, opts = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(12000), ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = data.error;
    throw new Error(e?.message || e?.errors?.[0]?.message || `HTTP ${res.status}`);
  }
  return data;
}

/** "https://youtu.be/ID", "…watch?v=ID", "…/live/ID" -> ID; channel forms -> { channelPath } */
export function parseYouTube(input) {
  const s = String(input || '').trim();
  const vid = s.match(/(?:youtu\.be\/|[?&]v=|\/live\/|\/shorts\/)([\w-]{11})/);
  if (vid) return { videoId: vid[1] };

  const ch = s.match(/(UC[\w-]{22})/);
  if (ch) return { channelPath: `channel/${ch[1]}` };
  const handle = s.match(/@([\w.-]+)/);
  if (handle) return { channelPath: `@${handle[1]}` };
  const named = s.match(/youtube\.com\/(c|user)\/([\w.-]+)/);
  if (named) return { channelPath: `${named[1]}/${named[2]}` };
  return { channelPath: `@${s.replace(/^@/, '')}` };
}

class Source {
  constructor(cfg, mgr) {
    this.cfg = cfg;
    this.mgr = mgr;
    this.timers = [];
    this.stopped = false;
  }

  set(data) { this.mgr.update(this.cfg, data); }

  every(ms, fn) {
    const run = async () => {
      if (this.stopped) return;
      let next = ms;
      try { next = (await fn()) || ms; } catch (e) { this.set({ error: e.message }); }
      if (!this.stopped) this.timers.push(setTimeout(run, typeof next === 'number' ? next : ms));
    };
    run();
  }

  stop() { this.stopped = true; this.timers.forEach(clearTimeout); }
}

class YouTube extends Source {
  start() {
    this.target = parseYouTube(this.cfg.channel);
    this.set({ platform: 'youtube', live: false, viewers: null, error: null });
    this.every(20000, () => this.poll());
  }

  /** Which video is live right now (from the channel's /live page; no API quota used). */
  async findLive() {
    if (this.target.videoId) return this.target.videoId;
    const res = await fetch(`https://www.youtube.com/${this.target.channelPath}/live`, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en' }, signal: AbortSignal.timeout(12000) });
    const html = await res.text();
    const canon = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/);
    if (canon && /"isLive(Now|Content)":true/.test(html)) return canon[1];
    return null;
  }

  async poll() {
    const key = encodeURIComponent(this.cfg.apiKey);
    if (!this.videoId) {
      this.videoId = await this.findLive();
      if (!this.videoId) { this.set({ live: false, viewers: null, error: null, title: null }); return 60000; }
    }
    const d = await getJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${this.videoId}&key=${key}`);
    const v = d.items?.[0];
    const ls = v?.liveStreamingDetails;
    const live = Boolean(ls && ls.actualStartTime && !ls.actualEndTime);
    this.set({
      live, title: v?.snippet?.title || null, url: `https://www.youtube.com/watch?v=${this.videoId}`,
      viewers: live && ls.concurrentViewers != null ? Number(ls.concurrentViewers) : live ? 0 : null, error: null,
    });
    if (!live) {
      if (!this.target.videoId) this.videoId = null; // look for the next live video
      this.chatId = null;
      return 60000;
    }
    if (ls.activeLiveChatId && ls.activeLiveChatId !== this.chatId) {
      this.chatId = ls.activeLiveChatId;
      this.pageToken = null;
      this.pollChat();
    }
    return 20000;
  }

  async pollChat() {
    const chatId = this.chatId;
    if (this.stopped || !chatId || this.chatRunning) return;
    this.chatRunning = true;
    let wait = 8000;
    try {
      const d = await getJson(`https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=${encodeURIComponent(chatId)}&part=snippet,authorDetails&maxResults=200${this.pageToken ? `&pageToken=${this.pageToken}` : ''}&key=${encodeURIComponent(this.cfg.apiKey)}`);
      const first = !this.pageToken;
      this.pageToken = d.nextPageToken;
      const items = (d.items || []).filter((m) => m.snippet?.type === 'textMessageEvent' || m.snippet?.type === 'superChatEvent');
      this.mgr.addComments(this.cfg, (first ? items.slice(-15) : items).map((m) => ({
        pid: m.id, author: m.authorDetails?.displayName || 'YouTube viewer', text: m.snippet.displayMessage || m.snippet.textMessageDetails?.messageText || '', at: m.snippet.publishedAt,
      })));
      wait = Math.max(6000, Number(d.pollingIntervalMillis) || 8000);
    } catch (e) {
      this.set({ error: `Chat: ${e.message}` });
      wait = 30000;
    } finally {
      this.chatRunning = false;
    }
    if (!this.stopped && this.chatId === chatId) this.timers.push(setTimeout(() => this.pollChat(), wait));
  }
}

const FB = 'https://graph.facebook.com/v21.0';
class Facebook extends Source {
  start() {
    this.set({ platform: 'facebook', live: false, viewers: null, error: null });
    this.seen = new Set();
    this.every(20000, () => this.poll());
  }

  async poll() {
    const t = encodeURIComponent(this.cfg.token);
    const d = await getJson(`${FB}/${encodeURIComponent(this.cfg.pageId)}/live_videos?broadcast_status=${encodeURIComponent('["LIVE"]')}&fields=id,title,live_views,permalink_url&limit=1&access_token=${t}`);
    const v = d.data?.[0];
    this.set({
      live: Boolean(v), viewers: v ? Number(v.live_views) || 0 : null, title: v?.title || null,
      url: v?.permalink_url ? `https://www.facebook.com${v.permalink_url}` : null, error: null,
    });
    if (v && v.id !== this.videoId) {
      this.videoId = v.id;
      this.firstComments = true;
      this.pollComments();
    }
    if (!v) this.videoId = null;
    return v ? 20000 : 60000;
  }

  async pollComments() {
    const id = this.videoId;
    if (this.stopped || !id) return;
    try {
      const d = await getJson(`${FB}/${id}/comments?fields=id,message,created_time,from{name}&order=reverse_chronological&limit=50&access_token=${encodeURIComponent(this.cfg.token)}`);
      const fresh = (d.data || []).filter((c) => !this.seen.has(c.id)).reverse();
      fresh.forEach((c) => this.seen.add(c.id));
      this.mgr.addComments(this.cfg, (this.firstComments ? fresh.slice(-15) : fresh).map((c) => ({
        pid: c.id, author: c.from?.name || 'Facebook viewer', text: c.message || '', at: c.created_time,
      })));
      this.firstComments = false;
    } catch (e) {
      this.set({ error: `Comments: ${e.message}` });
    }
    if (!this.stopped && this.videoId === id) this.timers.push(setTimeout(() => this.pollComments(), 6000));
  }
}

const SIM_NAMES = ['Grace Miller', 'David Chen', 'Maria Lopez', 'James Carter', 'Aisha Johnson', 'Tom Becker', 'Hannah Kim', 'Luis Ortega', 'Sarah Nguyen', 'Ben Walker'];
const SIM_TEXT = [
  'Good morning from Ohio! 👋', 'Watching from the hospital today', 'Amen 🙌', 'So good to be with you all', 'Love this song',
  'Can you share the verse reference again?', 'Where can I find the notes from today?', 'Please pray for my mom, she has surgery tomorrow',
  'Praying for everyone watching', 'Audio is great today', 'Hello from Texas!', 'What time is the evening service?', 'This message is exactly what I needed',
];
class Simulator extends Source {
  start() {
    let viewers = 40 + Math.round(Math.random() * 30);
    const platform = this.cfg.simPlatform || 'youtube';
    this.set({ platform, live: true, viewers, title: 'Sunday Service (simulated)', url: null, error: null, simulated: true });
    this.every(5000, () => {
      viewers = Math.max(5, Math.round(viewers + (Math.random() - 0.4) * 6));
      this.set({ viewers });
    });
    this.every(6000, () => {
      if (Math.random() < 0.6) {
        this.mgr.addComments(this.cfg, [{
          pid: Math.random().toString(36).slice(2), author: SIM_NAMES[Math.floor(Math.random() * SIM_NAMES.length)],
          text: SIM_TEXT[Math.floor(Math.random() * SIM_TEXT.length)], at: new Date().toISOString(),
        }]);
      }
      return 3000 + Math.random() * 7000;
    });
  }
}

const SOURCES = { youtube: YouTube, facebook: Facebook, simulator: Simulator };

export class Streams extends EventEmitter {
  constructor(list, hub) {
    super();
    this.hub = hub;
    this.list = list;
    this.sources = list.map((cfg) => new SOURCES[cfg.platform](cfg, this));
    this.comments = [];
    this.pinned = null;
    this.hidden = new Set();
    this.history = []; // [{ t, v }] total viewers every 30 s, last 3 hours
    this.peak = 0;
  }

  start() {
    for (const s of this.sources) s.start();
    this.histTimer = setInterval(() => this.sample(), 30000);
    this.histTimer.unref?.();
  }

  stop() {
    for (const s of this.sources) s.stop();
    clearInterval(this.histTimer);
    this.removeAllListeners();
  }

  update(cfg, data) {
    const prev = this.hub.state.streams?.[cfg.id] || {};
    const next = { name: cfg.name, platform: cfg.platform === 'simulator' ? prev.platform || 'youtube' : cfg.platform, ...data };
    if (next.viewers != null) next.peak = Math.max(prev.peak || 0, next.viewers);
    this.hub.update('streams', cfg.id, next);
    this.emitTotals();
  }

  total() {
    return Object.values(this.hub.state.streams || {}).reduce((n, s) => n + (s.live && s.viewers ? s.viewers : 0), 0);
  }

  emitTotals() {
    const total = this.total();
    if (total > this.peak) this.peak = total;
  }

  sample() {
    const anyLive = Object.values(this.hub.state.streams || {}).some((s) => s.live);
    if (!anyLive && !this.history.length) return;
    this.history = [...this.history, { t: Date.now(), v: this.total() }].slice(-360);
    this.emit('change', { type: 'history', history: this.history, peak: this.peak });
  }

  addComments(cfg, items) {
    if (!items.length) return;
    const platform = this.hub.state.streams?.[cfg.id]?.platform || cfg.platform;
    const add = items.filter((c) => c.text).map((c) => ({
      id: `${cfg.id}:${c.pid}`, source: cfg.id, sourceName: cfg.name, platform,
      author: String(c.author).slice(0, 80), text: String(c.text).slice(0, 600), at: c.at || new Date().toISOString(), kind: commentKind(c.text),
    })).filter((c, i, arr) => !this.comments.some((x) => x.id === c.id) && arr.findIndex((x) => x.id === c.id) === i);
    if (!add.length) return;
    this.comments = [...this.comments, ...add].slice(-MAX_COMMENTS);
    this.emit('change', { type: 'comments', add });
  }

  pin(id) {
    this.pinned = id ? this.comments.find((c) => c.id === id) || null : null;
    this.emit('change', { type: 'pin', pinned: this.pinned });
  }

  hide(id) {
    this.hidden.add(id);
    this.comments = this.comments.filter((c) => c.id !== id);
    if (this.pinned?.id === id) this.pin(null);
    this.emit('change', { type: 'hide', id });
  }

  snapshot() {
    return { comments: this.comments, pinned: this.pinned, history: this.history, peak: this.peak };
  }
}
