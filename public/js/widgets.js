// Widget library for the dashboard builder.
//
// Each widget: { title, icon, category, size: {w, h}, chrome?, options: [...], mount(body, opts, ctx) }
// mount() returns { update(), meters?(), destroy?() }. update() runs on every state change and
// once a second (for clocks / countdowns), so it must be cheap: build HTML and hand it to setHTML(),
// which only touches the DOM when something changed.
//
// Option field types: text | textarea | number | checkbox | select (choices: () => [[value, label]])
//                     multi (several of choices) | mics. An option's `group` puts it under a heading.
// `presets` (optional) adds ready-made variants of a widget to the Add widget panel.
import {
  store, esc, setHTML, api, toast, fmtDuration, micView, applyMeters,
} from './common.js';
import { buildTile } from './video.js';
import { spacingConflicts, drawSpectrum, rfRows } from './views.js';
import { planTiming, currentInfo, serviceClock, planSource, noServiceText } from './plan.js';
import { mountMicView, MIC_OPTIONS } from './micviews.js';

const switcherChoices = () => [['', '— none —'], ...store.config.switchers.map((s) => [s.id, s.name])];
const ppChoices = () => store.config.propresenter.map((p) => [p.id, p.name]);
const sourceChoices = () => store.config.video.sources.map((s) => [s.id, s.label || s.id]);
const meChoices = (all = false) => () => [...(all ? [['all', 'All M/Es']] : [['', 'Default']]), ...[1, 2, 3, 4].map((n) => [String(n), `M/E ${n}`])];

const meOf = (sw, me) => (me && me !== 'all' ? sw.mes?.[Number(me) - 1] : null) || sw.mes?.[0] || sw;
const empty = (text) => `<div class="w-empty">${text}</div>`;
const PLATFORM = { youtube: ['YT', 'YouTube'], facebook: ['f', 'Facebook'] };
const platformBadge = (p) => `<span class="pf pf-${esc(p || 'other')}" title="${esc(PLATFORM[p]?.[1] || p || '')}">${esc(PLATFORM[p]?.[0] || '•')}</span>`;

export const WIDGETS = {
  // ------------------------------------------------------------------ video
  video: {
    title: 'Video feed', icon: '🎥', category: 'Video', size: { w: 6, h: 5 }, chrome: false,
    options: [
      { key: 'source', label: 'Source', type: 'select', choices: sourceChoices },
      { key: 'switcher', label: 'Show tally from', type: 'select', choices: switcherChoices },
      { key: 'me', label: 'M/E', type: 'select', choices: meChoices() },
    ],
    mount(body, opts) {
      const src = store.config.video.sources.find((s) => s.id === opts.source);
      if (!src) { body.innerHTML = empty('Choose a video source in this widget’s settings.<br><small>Sources are defined under <code>video.sources</code> in the config.</small>'); return { update() {} }; }
      const tile = buildTile({ ...src, label: opts.title || src.label, switcher: opts.switcher ?? src.switcher, me: Number(opts.me) || null });
      body.append(tile.el);
      return { update: () => tile.update(), destroy: () => tile.el.querySelectorAll('video').forEach((v) => v.srcObject?.getTracks?.().forEach((t) => t.stop())) };
    },
  },

  // ------------------------------------------------------------------ slides
  propresenter: {
    title: 'ProPresenter', icon: '🖥️', category: 'Slides', size: { w: 4, h: 5 }, chrome: false,
    options: [
      { key: 'pp', label: 'ProPresenter', type: 'select', choices: ppChoices },
      { key: 'showStatus', label: 'Show layers, screens & timers', type: 'checkbox', default: true },
    ],
    mount(body, opts) {
      const tile = buildTile({ id: `pp-${opts.pp}`, type: 'propresenter', propresenter: opts.pp || ppChoices()[0]?.[0], label: opts.title || 'ProPresenter' });
      if (opts.showStatus === false) tile.el.classList.add('pp-nostatus');
      body.append(tile.el);
      return { update: () => tile.update() };
    },
  },

  'pp-timers': {
    title: 'ProPresenter timers', icon: '⏱️', category: 'Slides', size: { w: 3, h: 3 },
    fit: true, // contents grow and shrink with the widget's box
    options: [
      { key: 'pp', label: 'ProPresenter', type: 'select', choices: ppChoices },
      { key: 'only', label: 'Only these timers (names, comma-separated; empty = all)', type: 'text', placeholder: 'e.g. Service, Sermon' },
      { key: 'style', label: 'Look', type: 'select', choices: () => [['list', 'List'], ['big', 'Big (first timer fills the widget)']] },
      { key: 'running', label: 'Only timers that are running', type: 'checkbox' },
    ],
    presets: [
      { name: 'ProPresenter timers', icon: '⏱️', size: { w: 3, h: 3 }, options: {} },
      { name: 'Big timer (one)', icon: '⏲️', size: { w: 3, h: 2 }, options: { style: 'big', running: true, title: 'Timer' } },
    ],
    mount(body, opts) {
      return {
        update() {
          const pp = store.state.propresenter[opts.pp || ppChoices()[0]?.[0]];
          const want = String(opts.only || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
          let timers = (pp?.timers || []).filter((t) => !want.length || want.includes(String(t.name).toLowerCase()));
          if (opts.running) timers = timers.filter((t) => t.state === 'running');
          if (!timers.length) return setHTML(body, empty(pp?.online ? (opts.running ? 'No timer running' : 'No timers') : 'ProPresenter offline'));
          const tone = (t) => (String(t.time).trim().startsWith('-') ? 'over' : /^0?0:00:[0-2]\d$|^00:[0-2]\d$/.test(String(t.time).trim()) ? 'soon' : '');
          if (opts.style === 'big') {
            const t = timers[0];
            return setHTML(body, `<div class="big-timer ${tone(t)} ${t.state === 'running' ? 'running' : ''}"><small>${esc(t.name)}</small><b class="mono">${esc(String(t.time).replace(/^00:/, ''))}</b><span class="muted small">${esc(t.state || '')}</span></div>`);
          }
          setHTML(body, `<div class="timers" style="--n:${timers.length}">${timers.map((t) => `
            <div class="timer ${t.state === 'running' ? 'running' : ''} ${tone(t)}"><span>${esc(t.name)}</span><b class="mono">${esc(String(t.time).replace(/^00:/, ''))}</b></div>`).join('')}</div>`);
        },
      };
    },
  },

  'pp-media': {
    title: 'Video countdown', icon: '🎬', category: 'Slides', size: { w: 3, h: 2 },
    fit: true, // contents grow and shrink with the widget's box
    options: [
      { key: 'pp', label: 'ProPresenter', type: 'select', choices: ppChoices },
      { key: 'layer', label: 'Layer', type: 'select', choices: () => [['any', 'Whatever is playing'], ['presentation', 'Presentation (videos on slides)'], ['announcement', 'Announcements'], ['audio', 'Audio']] },
      { key: 'show', label: 'Show', type: 'select', choices: () => [['remaining', 'Time remaining'], ['elapsed', 'Time elapsed']] },
      { key: 'warn', label: 'Turn amber in the last … seconds', type: 'number', default: 10 },
    ],
    mount(body, opts) {
      return {
        update() {
          const pp = store.state.propresenter[opts.pp || ppChoices()[0]?.[0]];
          const media = pp?.media || {};
          const order = opts.layer && opts.layer !== 'any' ? [opts.layer] : ['presentation', 'announcement', 'audio'];
          const m = order.map((l) => media[l]).find((x) => x && x.duration);
          if (!m) return setHTML(body, empty(pp?.online ? 'No video playing' : 'ProPresenter offline'));
          // Keep counting smoothly between updates while it plays.
          const pos = Math.min(m.duration, m.time + (m.playing ? (Date.now() - m.at) / 1000 : 0));
          const left = Math.max(0, m.duration - pos);
          const warn = Number(opts.warn ?? 10);
          setHTML(body, `<div class="pp-media ${left <= warn ? 'soon' : ''} ${m.playing ? '' : 'paused'}">
            <div class="pm-name">${m.playing ? '▶' : '⏸'} ${esc(m.name)}</div>
            <b class="mono pm-time">${opts.show === 'elapsed' ? fmtDuration(pos) : `-${fmtDuration(left)}`}</b>
            <div class="bar pm-bar"><i style="width:${Math.min(100, (pos / m.duration) * 100)}%"></i></div>
            <small class="muted">${fmtDuration(pos)} / ${fmtDuration(m.duration)}</small></div>`);
        },
      };
    },
  },

  'pp-slide': {
    title: 'Current slide', icon: '🔤', category: 'Slides', size: { w: 4, h: 3 },
    fit: true, // contents grow and shrink with the widget's box
    options: [
      { key: 'pp', label: 'ProPresenter', type: 'select', choices: ppChoices },
      { key: 'which', label: 'Show', type: 'select', choices: () => [['current', 'Current slide'], ['next', 'Next slide'], ['both', 'Current and next']] },
      { key: 'notes', label: 'Show slide notes', type: 'checkbox' },
      { key: 'size', label: 'Text size in px (empty = fit the widget)', type: 'number', default: '' },
    ],
    presets: [
      { name: 'Current slide (text)', icon: '🔤', size: { w: 4, h: 3 }, options: {} },
      { name: 'Next slide (text)', icon: '⏭️', size: { w: 3, h: 2 }, options: { which: 'next', title: 'Next slide' } },
    ],
    mount(body, opts) {
      return {
        update() {
          const pp = store.state.propresenter[opts.pp || ppChoices()[0]?.[0]];
          if (!pp?.online) return setHTML(body, empty('ProPresenter offline'));
          const part = (s, label, cls) => `<div class="ps ${cls}">${label ? `<small class="muted">${label}</small>` : ''}<div class="ps-text" style="${Number(opts.size) ? `font-size:${cls === 'next' && opts.which === 'both' ? opts.size * 0.6 : opts.size}px` : ''}">${esc(s?.text || '') || '<span class="muted">(blank)</span>'}</div>
            ${opts.notes && s?.notes ? `<div class="ps-notes">${esc(s.notes)}</div>` : ''}</div>`;
          body.querySelector('.pp-slide-w')?.classList.toggle('both', opts.which === 'both');
          const html = opts.which === 'next' ? part(pp.next, '', 'next')
            : opts.which === 'both' ? part(pp.current, 'Now', 'cur') + part(pp.next, 'Next', 'next')
            : part(pp.current, '', 'cur');
          setHTML(body, `<div class="pp-slide-w ${opts.which === 'both' ? 'both' : ''}"><div class="muted small">${esc(pp.presentation?.name || '')}</div>${html}</div>`);
        },
      };
    },
  },

  'pp-playlist': {
    title: 'ProPresenter playlist', icon: '🗂️', category: 'Slides', size: { w: 3, h: 5 },
    options: [{ key: 'pp', label: 'ProPresenter', type: 'select', choices: ppChoices }],
    mount(body, opts) {
      let last = -2;
      return {
        update() {
          const pp = store.state.propresenter[opts.pp || ppChoices()[0]?.[0]];
          const pl = pp?.playlist;
          if (!pl) return setHTML(body, empty(pp?.online ? 'No playlist active' : 'ProPresenter offline'));
          setHTML(body, `<div class="ppl"><b>${esc(pl.name)}</b>${pl.items.map((it, i) => it.type === 'header'
            ? `<div class="pl-h">${esc(it.name)}</div>`
            : `<div class="ppl-i ${i === pl.index ? 'cur' : ''} ${pl.index > -1 && i < pl.index ? 'done' : ''}">${esc(it.name)}</div>`).join('')}</div>`);
          if (pl.index !== last) { last = pl.index; body.querySelector('.ppl-i.cur')?.scrollIntoView({ block: 'nearest' }); }
        },
      };
    },
  },

  'pp-status': {
    title: 'ProPresenter status', icon: '🟢', category: 'Slides', size: { w: 3, h: 2 },
    options: [{ key: 'pp', label: 'ProPresenter', type: 'select', choices: ppChoices }],
    mount(body, opts) {
      const LAYERS = [['slide', 'Slide'], ['media', 'Media'], ['video_input', 'Video in'], ['announcements', 'Announce'], ['props', 'Props'], ['messages', 'Messages'], ['audio', 'Audio']];
      return {
        update() {
          const pp = store.state.propresenter[opts.pp || ppChoices()[0]?.[0]];
          if (!pp?.online) return setHTML(body, empty(pp?.error ? `ProPresenter offline<br><small>${esc(pp.error)}</small>` : 'ProPresenter offline'));
          const chip = (on, label) => `<span class="chip ${on ? 'on' : ''}">${label}</span>`;
          setHTML(body, `<div class="pps">
            <div class="chips">${chip(pp.screens?.audience, 'Audience screen')}${chip(pp.screens?.stage, 'Stage screen')}${pp.capture ? chip(pp.capture.status === 'active', `Recording${pp.capture.destination ? ` · ${esc(pp.capture.destination)}` : ''}`) : ''}</div>
            <div class="chips">${LAYERS.filter(([k]) => pp.layers && k in pp.layers).map(([k, l]) => chip(pp.layers[k], l)).join('')}</div>
            ${pp.look ? `<small class="muted">Look: ${esc(pp.look)}</small>` : ''}</div>`);
        },
      };
    },
  },

  'stage-message': {
    title: 'Stage message', icon: '💬', category: 'Slides', size: { w: 3, h: 2 },
    options: [{ key: 'pp', label: 'ProPresenter', type: 'select', choices: ppChoices }],
    mount(body, opts) {
      if (!store.config.control.propresenterStageMessage) {
        body.innerHTML = empty('Stage messages are turned off.<br><small>Set <code>control.propresenterStageMessage: true</code> in the config.</small>');
        return { update() {} };
      }
      body.innerHTML = `<form class="stage-form"><input type="text" maxlength="300" placeholder="e.g. 5 minutes – wrap up" aria-label="Message">
        <div class="row-btns"><button class="btn primary">Send</button><button class="btn" data-clear type="submit">Clear</button></div>
        <div class="muted small" data-cur></div></form>`;
      const form = body.querySelector('form');
      const ppId = () => opts.pp || ppChoices()[0]?.[0];
      form.onsubmit = async (e) => {
        e.preventDefault();
        const text = e.submitter?.hasAttribute('data-clear') ? '' : form.querySelector('input').value.trim();
        try {
          await api('POST', `/api/propresenter/${encodeURIComponent(ppId())}/stage-message`, { text });
          if (!text) form.querySelector('input').value = '';
          toast(text ? 'Stage message sent' : 'Stage message cleared');
        } catch (err) { toast(err.message, true); }
      };
      return {
        update() {
          const msg = store.state.propresenter[ppId()]?.stageMessage;
          setHTML(body.querySelector('[data-cur]'), msg ? `On stage display: <b>${esc(msg)}</b>` : 'No stage message showing');
        },
      };
    },
  },

  // ------------------------------------------------------------------ switcher
  switcher: {
    title: 'Program / Preview', icon: '🔴', category: 'Switcher', size: { w: 3, h: 2 },
    options: [
      { key: 'switcher', label: 'Switcher', type: 'select', choices: switcherChoices },
      { key: 'me', label: 'M/E', type: 'select', choices: meChoices() },
    ],
    mount(body, opts) {
      return {
        update() {
          const sw = store.state.switchers[opts.switcher || store.config.switchers[0]?.id];
          if (!sw) return setHTML(body, empty('Choose a switcher in settings'));
          if (!sw.online) return setHTML(body, empty(`${esc(sw.name)} offline${sw.error ? `<br><small>${esc(sw.error)}</small>` : ''}`));
          const me = meOf(sw, opts.me);
          setHTML(body, `<div class="pp-tally">
            <div class="tb pgm"><small>PROGRAM${me.name ? ` · ${esc(me.name)}` : ''}</small><b>${esc(me.program?.name || '—')}</b></div>
            <div class="tb pvw"><small>PREVIEW</small><b>${esc(me.preview?.name || '—')}</b></div>
            <div class="chips">
              ${sw.streaming != null ? `<span class="chip ${sw.streaming ? 'live' : ''}">${sw.streaming ? '● STREAMING' : 'Not streaming'}</span>` : ''}
              ${sw.recording != null ? `<span class="chip ${sw.recording ? 'live' : ''}">${sw.recording ? '● RECORDING' : 'Not recording'}</span>` : ''}
              ${me.ftb ? '<span class="chip bad">FADE TO BLACK</span>' : ''}
            </div></div>`);
        },
      };
    },
  },

  'switcher-overview': {
    title: 'Switcher overview', icon: '🎛️', category: 'Switcher', size: { w: 5, h: 6 },
    options: [{ key: 'switcher', label: 'Switcher', type: 'select', choices: switcherChoices }],
    mount(body, opts) {
      return {
        update() {
          const sw = store.state.switchers[opts.switcher || store.config.switchers[0]?.id];
          if (!sw) return setHTML(body, empty('Choose a switcher in settings'));
          if (!sw.online) return setHTML(body, empty(`${esc(sw.name)} offline`));
          setHTML(body, `<div class="swo">
            <div class="swo-head"><b>${esc(sw.model || sw.name)}</b>
              ${sw.streaming ? '<span class="chip live">● STREAM</span>' : ''}${sw.recording ? '<span class="chip live">● REC</span>' : ''}
              ${(sw.dsks || []).map((d) => `<span class="chip ${d.onAir ? 'live' : ''}">DSK${d.index}${d.onAir ? ' ON' : ''}</span>`).join('')}
            </div>
            <div class="swo-mes">${(sw.mes || []).map((m) => `
              <div class="swo-me ${m.ftb ? 'ftb' : ''}">
                <div class="swo-name">${esc(m.name)}${m.inTransition ? ' <span class="chip">TRANS</span>' : ''}${m.ftb ? ' <span class="chip bad">FTB</span>' : ''}</div>
                <div class="swo-pgm">${esc(m.program?.name || '—')}</div>
                <div class="swo-pvw">${esc(m.preview?.name || '—')}</div>
                <div class="swo-keys">${(m.keyers || []).map((on, i) => `<span class="${on ? 'on' : ''}">K${i + 1}</span>`).join('')}</div>
              </div>`).join('')}</div>
            ${(sw.auxes || []).length ? `<div class="swo-aux">${sw.auxes.map((a) => `<div><small>${esc(a.name)}</small><b>${esc(a.source?.name || '—')}</b></div>`).join('')}</div>` : ''}
          </div>`);
        },
      };
    },
  },

  tally: {
    title: 'Camera tally', icon: '🚦', category: 'Switcher', size: { w: 4, h: 3 },
    options: [
      { key: 'switcher', label: 'Switcher', type: 'select', choices: switcherChoices },
      { key: 'me', label: 'Tally from', type: 'select', choices: meChoices(true) },
      { key: 'inputs', label: 'Only these inputs (e.g. 1-8, 12)', type: 'text' },
    ],
    mount(body, opts) {
      const wanted = parseRange(opts.inputs);
      return {
        update() {
          const sw = store.state.switchers[opts.switcher || store.config.switchers[0]?.id];
          if (!sw?.online) return setHTML(body, empty('Switcher offline'));
          const mes = opts.me === 'all' ? sw.mes || [] : [meOf(sw, opts.me)];
          const live = new Set(mes.flatMap((m) => m.onAir || (m.program ? [m.program.input] : [])));
          const next = new Set(mes.flatMap((m) => m.next || (m.preview ? [m.preview.input] : [])));
          const inputs = (sw.inputs || []).filter((i) => !wanted || wanted.has(i.input));
          setHTML(body, inputs.length ? `<div class="tally-grid">${inputs.map((i) => {
            const st = live.has(i.input) ? 'live' : next.has(i.input) ? 'next' : '';
            return `<div class="tl ${st}" title="${esc(i.name)}"><small>${i.input}</small><b>${esc(i.name)}</b>${st ? `<em>${st === 'live' ? 'ON AIR' : 'PREVIEW'}</em>` : ''}</div>`;
          }).join('')}</div>` : empty('No inputs reported'));
        },
      };
    },
  },

  // ------------------------------------------------------------------ service plan
  plan: {
    title: 'Service plan', icon: '📋', category: 'Service', size: { w: 3, h: 7 },
    options: [
      { key: 'compact', label: 'Compact (hide times)', type: 'checkbox' },
      { key: 'controls', label: 'Show Previous / Next buttons', type: 'checkbox', default: true },
    ],
    mount(body, opts, ctx) {
      body.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-item],[data-step]');
        if (!b || ctx.editing()) return;
        try {
          if (b.dataset.step) await api('POST', `/api/service/${b.dataset.step}`);
          else await api('POST', '/api/service/current', { itemId: b.dataset.item });
        } catch (err) { toast(err.message, true); }
      });
      let lastCur = null;
      return {
        update() {
          const svc = store.service;
          if (!svc.plan) return setHTML(body, empty(noServiceText(store.config.planningCenter && !svc.idle ? 'Loading Planning Center…' : 'No service plan yet.<br><small>Add one on the <a href="/admin#plan">Setup</a> page (Planning Center or typed in).</small>')));
          const timing = planTiming(svc);
          const cur = svc.current?.itemId;
          const rows = svc.plan.items.map((it) => {
            if (it.type === 'header') return `<div class="pl-h">${esc(it.title)}</div>`;
            const t = timing.items[it.id] || {};
            const isCur = it.id === cur;
            const actual = svc.actuals?.[it.id];
            const over = actual != null && it.length && actual > it.length + 15;
            return `<button class="pl-i ${isCur ? 'cur' : ''} ${t.done ? 'done' : ''}" data-item="${esc(it.id)}">
              ${opts.compact ? '' : `<span class="pl-t mono">${t.start ? t.start : ''}</span>`}
              <span class="pl-n">${esc(it.title)}${it.key ? ` <span class="chip">${esc(it.key)}</span>` : ''}</span>
              <span class="pl-l mono">${isCur ? `<b class="${it.length && t.remaining < 0 ? 'over' : ''}">${fmtDuration(it.length ? t.remaining : -t.remaining)}</b>` : actual != null ? `<span class="${over ? 'over' : 'ok'}" title="Actual (planned ${fmtDuration(it.length)})">${fmtDuration(actual)}</span>` : it.length ? fmtDuration(it.length) : ''}</span>
            </button>`;
          }).join('');
          setHTML(body, `<div class="plan ${opts.compact ? 'compact' : ''}">
            <div class="pl-top">
              <div><b>${esc(svc.plan.title || 'Service')}</b>${svc.plan.seriesTitle ? ` <span class="muted">· ${esc(svc.plan.seriesTitle)}</span>` : ''}
                <div class="muted small">${svc.plan.dates ? `${esc(svc.plan.dates)} · ` : ''}${planSource(svc)}${svc.current?.by ? ` · following ${esc({ 'pco-live': 'Services LIVE', propresenter: 'ProPresenter', manual: 'operator' }[svc.current.by] || svc.current.by)}` : ''}</div></div>
              ${opts.controls === false ? '' : '<div class="row-btns"><button class="btn small" data-step="previous" title="Previous item">◀</button><button class="btn small" data-step="next" title="Next item">▶</button></div>'}
            </div>
            <div class="pl-list">${rows}</div></div>`);
          if (cur !== lastCur) { lastCur = cur; body.querySelector('.pl-i.cur')?.scrollIntoView({ block: 'nearest' }); }
        },
      };
    },
  },

  timeline: {
    title: 'Service timeline', icon: '🎞️', category: 'Service', size: { w: 12, h: 2 },
    fit: true, // contents grow and shrink with the widget's box
    presets: [
      { name: 'Service timeline (strip)', icon: '🎞️', size: { w: 12, h: 2 }, options: {} },
      { name: 'Service timeline (by length)', icon: '📏', size: { w: 12, h: 2 }, options: { sizing: 'length' } },
    ],
    options: [
      { key: 'sizing', label: 'Block width', type: 'select', choices: () => [['equal', 'Equal squares'], ['length', 'By planned length']] },
      { key: 'past', label: 'Finished items', type: 'select', choices: () => [['2', 'Show the last 2'], ['all', 'Show all'], ['0', 'Hide']] },
      { key: 'times', label: 'Show planned start times', type: 'checkbox', default: true },
      { key: 'headers', label: 'Show section headers (e.g. Worship, Message)', type: 'checkbox', default: true },
      { key: 'click', label: 'Click an item to make it current', type: 'checkbox', default: true },
    ],
    mount(body, opts, ctx) {
      body.classList.add('flush');
      body.addEventListener('click', (e) => {
        const b = e.target.closest('[data-item]');
        if (!b || ctx.editing() || !opts.click) return;
        api('POST', '/api/service/current', { itemId: b.dataset.item }).catch((err) => toast(err.message, true));
      });
      let lastCur = null;
      return {
        update() {
          const svc = store.service;
          if (!svc.plan) return setHTML(body, empty(noServiceText('No service plan yet')));
          const timing = planTiming(svc);
          const all = svc.plan.items;
          const playable = all.filter((i) => i.type !== 'header');
          const curIdx = playable.findIndex((i) => i.id === svc.current?.itemId);
          const keepPast = opts.past === 'all' ? Infinity : Number(opts.past || 0);
          const firstShown = curIdx < 0 ? 0 : Math.max(0, curIdx - keepPast);
          const shownIds = new Set(playable.slice(firstShown).map((i) => i.id));
          const longest = Math.max(60, ...playable.map((i) => i.length || 0));
          let header = null;
          const blocks = [];
          for (const it of all) {
            if (it.type === 'header') { header = it.title; continue; }
            if (!shownIds.has(it.id)) { header = null; continue; }
            if (header && opts.headers !== false) blocks.push(`<div class="tl-h"><span>${esc(header)}</span></div>`);
            header = null;
            const t = timing.items[it.id] || {};
            const isCur = it.id === svc.current?.itemId;
            const actual = svc.actuals?.[it.id];
            const over = isCur ? it.length && t.remaining < 0 : actual != null && it.length && actual > it.length + 15;
            const pct = isCur && it.length ? Math.min(100, Math.max(0, 100 - (t.remaining / it.length) * 100)) : 0;
            const grow = opts.sizing === 'length' ? `flex-grow:${Math.max(0.6, (it.length || 60) / longest * 3).toFixed(2)};` : '';
            blocks.push(`<button class="tl-i ${isCur ? 'cur' : ''} ${t.done ? 'done' : ''} ${over ? 'over' : ''}" style="${grow}" data-item="${esc(it.id)}">
              <span class="tl-top">${opts.times !== false && t.start ? `<span class="mono">${t.start}</span>` : ''}${it.key ? `<span class="chip">${esc(it.key)}</span>` : ''}</span>
              <span class="tl-n">${esc(it.title)}</span>
              <span class="tl-l mono">${isCur ? (it.length ? fmtDuration(t.remaining) : fmtDuration(-t.remaining || 0)) : t.done && actual != null ? fmtDuration(actual) : it.length ? fmtDuration(it.length) : '—'}</span>
              ${isCur ? `<span class="tl-bar"><i style="width:${pct}%"></i></span>` : ''}
            </button>`);
          }
          setHTML(body, `<div class="tl ${opts.sizing === 'length' ? 'by-length' : ''}">${blocks.join('') || empty('The service is finished')}</div>`);
          const cur = svc.current?.itemId;
          if (cur !== lastCur) {
            lastCur = cur;
            const el = body.querySelector('.tl-i.cur');
            const strip = body.querySelector('.tl');
            if (el && strip) strip.scrollTo({ left: Math.max(0, el.offsetLeft - strip.clientWidth * 0.15), behavior: 'smooth' });
          }
        },
      };
    },
  },

  'current-item': {
    title: 'Current item', icon: '⏳', category: 'Service', size: { w: 3, h: 3 },
    fit: true, // contents grow and shrink with the widget's box
    options: [{ key: 'controls', label: 'Show Previous / Next buttons', type: 'checkbox' }],
    mount(body, opts, ctx) {
      body.addEventListener('click', (e) => {
        const b = e.target.closest('[data-step]');
        if (b && !ctx.editing()) api('POST', `/api/service/${b.dataset.step}`).catch((err) => toast(err.message, true));
      });
      return {
        update() {
          const info = currentInfo(store.service);
          if (!info) return setHTML(body, empty(store.service.plan ? 'Service not started.<br><small>Pick an item in the plan, advance ProPresenter, or start Services LIVE.</small>' : noServiceText('No service plan')));
          const pct = info.item.length ? Math.min(100, (info.elapsed / info.item.length) * 100) : 0;
          setHTML(body, `<div class="ci ${info.item.length && info.remaining < 0 ? 'overrun' : info.remaining < 30 && info.item.length ? 'soon' : ''}">
            <div class="ci-title">${esc(info.item.title)}${info.item.key ? ` <span class="chip">${esc(info.item.key)}</span>` : ''}</div>
            <div class="ci-time mono">${info.item.length ? fmtDuration(info.remaining) : fmtDuration(info.elapsed)}</div>
            <div class="ci-sub muted">${info.item.length ? (info.remaining < 0 ? 'over time' : 'remaining') : 'elapsed'}</div>
            ${info.item.length ? `<div class="bar ci-bar"><i style="width:${pct}%"></i></div>` : ''}
            <div class="ci-next">${info.next ? `Up next: <b>${esc(info.next.title)}</b>${info.next.length ? ` <span class="muted mono">${fmtDuration(info.next.length)}</span>` : ''}` : '<span class="muted">Last item</span>'}</div>
            ${opts.controls ? '<div class="row-btns"><button class="btn small" data-step="previous">◀ Previous</button><button class="btn small" data-step="next">Next ▶</button></div>' : ''}
          </div>`);
        },
      };
    },
  },

  'service-clock': {
    title: 'Service clock', icon: '🕘', category: 'Service', size: { w: 3, h: 2 },
    fit: true, // contents grow and shrink with the widget's box
    options: [],
    mount(body) {
      return {
        update() {
          const c = serviceClock(store.service);
          setHTML(body, c ? `<div class="big-stat ${c.tone}"><small>${esc(c.label)}</small><b class="mono">${fmtDuration(c.seconds)}</b>${c.sub ? `<span class="muted small">${esc(c.sub)}</span>` : ''}</div>` : empty(store.service.plan ? 'No service times' : noServiceText('No service times')));
        },
      };
    },
  },

  clock: {
    title: 'Clock', icon: '🕑', category: 'Service', size: { w: 3, h: 2 },
    fit: true, // contents grow and shrink with the widget's box
    options: [{ key: 'seconds', label: 'Show seconds', type: 'checkbox', default: true }],
    mount(body, opts) {
      return {
        update() {
          const now = new Date();
          const t = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', ...(opts.seconds === false ? {} : { second: '2-digit' }) });
          setHTML(body, `<div class="big-stat"><b class="mono">${t}</b><span class="muted small">${now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</span></div>`);
        },
      };
    },
  },

  // ------------------------------------------------------------------ audio / rf
  mics: {
    title: 'Mics & gear', icon: '🎤', category: 'Audio & RF', size: { w: 8, h: 6 },
    options: MIC_OPTIONS,
    // Ready-made versions listed separately in the Add widget panel; all are fully adjustable after.
    presets: [
      { name: 'Mic board (full screen)', icon: '🎤', size: { w: 9, h: 10 }, options: { layout: 'board', title: 'Who has which mic' } },
      { name: 'Mic board (compact)', icon: '🎙️', size: { w: 6, h: 5 }, options: { layout: 'board', role: false, details: false, graph: 'rf', seconds: '20' } },
      { name: 'Mic rows (side panel)', icon: '📶', size: { w: 3, h: 6 }, options: { layout: 'rows', details: false } },
      { name: 'Mic cards', icon: '🪪', size: { w: 8, h: 5 }, options: { layout: 'cards', levels: 'meters' } },
      { name: 'Photo tiles', icon: '🖼️', size: { w: 6, h: 5 }, options: { layout: 'tiles', levels: 'none', details: false } },
      { name: 'Mic strip (bottom bar)', icon: '➖', size: { w: 12, h: 3 }, options: { layout: 'strip', levels: 'meters' } },
      { name: 'Mics in use', icon: '🔴', size: { w: 6, h: 5 }, options: { layout: 'tiles', show: 'in-use', sort: 'status', levels: 'graph', graph: 'rf' } },
    ],
    mount(body, opts) {
      body.classList.add('flush');
      return mountMicView(body, opts);
    },
  },

  'rf-table': {
    title: 'RF & batteries', icon: '📶', category: 'Audio & RF', size: { w: 8, h: 5 },
    options: [],
    mount(body) {
      body.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Receiver</th><th>Mic</th><th>RX name</th><th>Person</th><th>TX</th><th>MHz</th><th>G,Ch</th><th>RF / Audio</th><th>Battery</th><th>Flags</th></tr></thead><tbody></tbody></table></div>`;
      const tb = body.querySelector('tbody');
      return {
        update() {
          const list = store.slots.map(micView);
          if (setHTML(tb, rfRows(list, spacingConflicts(list)))) applyMeters(tb);
        },
        meters: () => applyMeters(tb),
      };
    },
  },

  'rf-plot': {
    title: 'Frequency plot', icon: '📡', category: 'Audio & RF', size: { w: 4, h: 4 },
    options: [],
    mount(body) {
      body.innerHTML = '<svg class="spectrum fill" role="img" aria-label="Carrier frequencies"></svg>';
      const svg = body.firstElementChild;
      let lastDraw = 0;
      return {
        update() {
          if (Date.now() - lastDraw < 900) return; // RF bars: once a second is plenty
          lastDraw = Date.now();
          const list = store.slots.map(micView);
          drawSpectrum(svg, list, spacingConflicts(list));
        },
      };
    },
  },

  // ------------------------------------------------------------------ live stream
  viewers: {
    title: 'Live viewers', icon: '📈', category: 'Stream', size: { w: 3, h: 3 },
    fit: true, // contents grow and shrink with the widget's box
    options: [
      { key: 'perPlatform', label: 'Show each platform', type: 'checkbox', default: true },
      { key: 'graph', label: 'Show the last hour as a graph', type: 'checkbox', default: true },
    ],
    mount(body, opts) {
      return {
        update() {
          const list = Object.entries(store.state.streams || {}).map(([id, s]) => ({ id, ...s }));
          if (!list.length) return setHTML(body, empty('No streams set up.<br><small>Add YouTube or Facebook on the <a href="/gear">Gear</a> page.</small>'));
          const live = list.filter((s) => s.live);
          const total = live.reduce((n, s) => n + (s.viewers || 0), 0);
          const hist = (store.streams.history || []).filter((p) => p.t > Date.now() - 3600000);
          let graph = '';
          if (opts.graph !== false && hist.length > 1) {
            const max = Math.max(1, ...hist.map((p) => p.v));
            const pts = hist.map((p, i) => `${((i / (hist.length - 1)) * 100).toFixed(1)},${(30 - (p.v / max) * 28).toFixed(1)}`).join(' ');
            graph = `<svg class="vw-graph" viewBox="0 0 100 30" preserveAspectRatio="none" aria-label="Viewers over the last hour"><polyline points="${pts}" /></svg>`;
          }
          setHTML(body, `<div class="vw">
            <div class="vw-total"><b class="mono">${live.length ? total.toLocaleString() : '—'}</b><small>${live.length ? 'watching now' : 'not live'}${store.streams.peak ? ` · peak ${store.streams.peak.toLocaleString()}` : ''}</small></div>
            ${graph}
            ${opts.perPlatform !== false ? `<div class="vw-list">${list.map((s) => `<div class="vw-row ${s.live ? 'on' : ''}" title="${esc(s.error || s.title || '')}">
              ${platformBadge(s.platform)}<span class="vw-name">${esc(s.name)}</span>
              <span class="vw-state">${s.error && !s.live ? '<span class="over">⚠</span>' : s.live ? '<span class="live-dot"></span>' : '<small class="muted">offline</small>'}</span>
              <b class="mono">${s.live ? (s.viewers ?? 0).toLocaleString() : ''}</b></div>`).join('')}</div>` : ''}
          </div>`);
        },
      };
    },
  },

  comments: {
    title: 'Stream comments', icon: '💬', category: 'Stream', size: { w: 4, h: 6 },
    fit: (o) => o.filter === 'pinned', // the big pinned comment fills its box; the feed shows more comments instead
    options: [
      { key: 'filter', label: 'Show', type: 'select', choices: () => [['all', 'All comments'], ['flagged', 'Questions and prayer requests'], ['question', 'Questions only'], ['prayer', 'Prayer requests only'], ['pinned', 'Only the pinned comment (big, for a host or confidence screen)']] },
      { key: 'platforms', label: 'Platforms', type: 'select', choices: () => [['all', 'All'], ['youtube', 'YouTube'], ['facebook', 'Facebook']] },
      { key: 'highlight', label: 'Highlight questions and prayer requests', type: 'checkbox', default: true },
      { key: 'newestTop', label: 'Newest at the top', type: 'checkbox' },
    ],
    presets: [
      { name: 'Stream comments', icon: '💬', size: { w: 4, h: 6 }, options: {} },
      { name: 'Questions & prayer requests', icon: '🙏', size: { w: 4, h: 5 }, options: { title: 'Questions & prayer', filter: 'flagged' } },
      { name: 'Pinned comment (big)', icon: '📌', size: { w: 6, h: 3 }, options: { filter: 'pinned', title: 'Pinned comment' } },
    ],
    mount(body, opts, ctx) {
      body.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-pin],[data-hide],[data-unpin]');
        if (!b || ctx.editing()) return;
        try {
          if (b.dataset.pin) await api('POST', '/api/streams/pin', { id: b.dataset.pin });
          if (b.dataset.unpin != null) await api('POST', '/api/streams/pin', { id: null });
          if (b.dataset.hide && confirm('Hide this comment from the dashboards? (It stays on YouTube/Facebook.)')) await api('POST', '/api/streams/hide', { id: b.dataset.hide });
        } catch (err) { toast(err.message, true); }
      });
      let stick = true;
      body.addEventListener('scroll', () => {
        const atEdge = opts.newestTop ? body.scrollTop < 20 : body.scrollHeight - body.scrollTop - body.clientHeight < 30;
        stick = atEdge;
      });
      return {
        update() {
          const p = store.streams.pinned;
          if (opts.filter === 'pinned') {
            return setHTML(body, p ? `<div class="cm-pinned-big">${platformBadge(p.platform)}<div class="cm-pb-text">${esc(p.text)}</div><div class="cm-pb-author">— ${esc(p.author)}</div></div>`
              : empty('No comment pinned.<br><small>Pin one from a comments widget.</small>'));
          }
          let list = store.streams.comments;
          if (opts.platforms && opts.platforms !== 'all') list = list.filter((c) => c.platform === opts.platforms);
          if (opts.filter === 'question' || opts.filter === 'prayer') list = list.filter((c) => c.kind === opts.filter);
          if (opts.filter === 'flagged') list = list.filter((c) => c.kind);
          list = list.slice(-120);
          if (opts.newestTop) list = [...list].reverse();
          const anySource = Object.keys(store.state.streams || {}).length;
          const html = `${p ? `<div class="cm-pin">${platformBadge(p.platform)}<b>${esc(p.author)}</b> ${esc(p.text)}<button class="btn small" data-unpin title="Unpin">✕</button></div>` : ''}
            <div class="cm-list">${list.map((c) => `<div class="cm ${opts.highlight !== false && c.kind ? `k-${c.kind}` : ''} ${p?.id === c.id ? 'pinned' : ''}">
              ${platformBadge(c.platform)}
              <div class="cm-body"><div class="cm-head"><b>${esc(c.author)}</b><small class="muted">${new Date(c.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</small>
                ${opts.highlight !== false && c.kind ? `<span class="chip">${c.kind === 'question' ? 'Question' : 'Prayer'}</span>` : ''}</div>
                <div class="cm-text">${esc(c.text)}</div></div>
              <span class="cm-acts"><button class="btn small" data-pin="${esc(c.id)}" title="Pin (shows on 'pinned' widgets)">📌</button><button class="btn small" data-hide="${esc(c.id)}" title="Hide">✕</button></span>
            </div>`).join('') || empty(anySource ? 'No comments yet' : 'No streams set up.<br><small>Add YouTube or Facebook on the <a href="/gear">Gear</a> page.</small>')}</div>`;
          if (setHTML(body, html) && stick) body.scrollTop = opts.newestTop ? 0 : body.scrollHeight;
        },
      };
    },
  },

  // ------------------------------------------------------------------ team
  alerts: {
    title: 'Alerts', icon: '⚠️', category: 'Team', size: { w: 3, h: 3 },
    options: [],
    mount(body) {
      return {
        update() {
          setHTML(body, store.alerts.length
            ? `<div class="list">${store.alerts.map((a) => `<span class="alert ${a.level}">${esc(a.text)}</span>`).join('')}</div>`
            : '<div class="w-empty ok">✓ All clear</div>');
        },
      };
    },
  },

  comms: {
    title: 'Comms', icon: '🎧', category: 'Team', size: { w: 4, h: 3 },
    options: [{ key: 'offline', label: 'Also show people who are not connected', type: 'checkbox' }],
    mount(body, opts) {
      return {
        update() {
          const c = store.comms;
          const people = c.members.filter((m) => m.online || opts.offline);
          if (!c.members.length) return setHTML(body, '<div class="w-empty">Nobody on comms yet. <a href="/comms/control">Set up comms</a></div>');
          const rows = c.channels.map((ch) => {
            const on = people.filter((m) => m.talking.includes(ch.id));
            return `<div class="cw-ch" style="--ch:${esc(ch.color)}"><b>${esc(ch.name)}</b>${on.map((m) => `<span class="cw-p live">🗣 ${esc(m.name)}</span>`).join('') || '<small class="muted">quiet</small>'}</div>`;
          }).join('');
          setHTML(body, `<div class="cw">${c.engine ? '' : '<span class="alert critical">Comms engine is not running</span>'}${rows}
            <div class="chips">${people.map((m) => `<span class="cw-p ${m.online ? '' : 'muted'}" title="${esc(m.position)}">${m.online ? '●' : '○'} ${esc(m.name)}${m.muted ? ' (muted)' : ''}</span>`).join('')}</div></div>`);
        },
      };
    },
  },

  notes: {
    title: 'Notes', icon: '📝', category: 'Team', size: { w: 4, h: 3 },
    options: [{ key: 'name', label: 'Shared note name (same name = same note everywhere)', type: 'text', default: 'main' }],
    mount(body, opts, ctx) {
      const name = opts.name || 'main';
      let editing = false;
      body.innerHTML = '<div class="note-view"></div><textarea class="note-edit hidden" aria-label="Note"></textarea>';
      const view = body.querySelector('.note-view');
      const ta = body.querySelector('textarea');
      ctx.addAction('✎', 'Edit note', async () => {
        if (!editing) {
          editing = true;
          ta.value = store.board.notes[name]?.text || '';
          view.classList.add('hidden'); ta.classList.remove('hidden'); ta.focus();
        } else {
          editing = false;
          try { await api('PUT', `/api/notes/${encodeURIComponent(name)}`, { text: ta.value }); } catch (err) { toast(err.message, true); }
          ta.classList.add('hidden'); view.classList.remove('hidden');
        }
      });
      return {
        update() {
          if (editing) return;
          const text = store.board.notes[name]?.text;
          setHTML(view, text ? formatNote(text) : '<span class="muted">Empty note. Click ✎ to write. Everyone sees changes live.</span>');
        },
      };
    },
  },

  checklist: {
    title: 'Checklist', icon: '✅', category: 'Team', size: { w: 3, h: 5 },
    options: [{ key: 'name', label: 'Shared checklist name', type: 'text', default: 'main' }],
    mount(body, opts, ctx) {
      const name = opts.name || 'main';
      let editing = false;
      body.innerHTML = '<div class="ck-view"></div><div class="ck-edit hidden"><textarea aria-label="Checklist items"></textarea><small class="muted">One item per line. Start a line with # for a section, e.g. “# Audio”.</small></div>';
      const view = body.querySelector('.ck-view');
      const editBox = body.querySelector('.ck-edit');
      const ta = editBox.querySelector('textarea');
      view.addEventListener('change', (e) => {
        const cb = e.target.closest('input[data-id]');
        if (cb) api('POST', `/api/checklists/${encodeURIComponent(name)}/toggle`, { itemId: cb.dataset.id, done: cb.checked }).catch((err) => toast(err.message, true));
      });
      ctx.addAction('↺', 'Untick everything', () => {
        if (confirm('Untick every item on this checklist?')) api('POST', `/api/checklists/${encodeURIComponent(name)}/reset`).catch((err) => toast(err.message, true));
      });
      ctx.addAction('✎', 'Edit items', async () => {
        if (!editing) {
          editing = true;
          const items = store.board.checklists[name]?.items || [];
          let sec = '';
          ta.value = items.map((i) => { const pre = i.section !== sec ? `${i.section ? `# ${i.section}\n` : ''}` : ''; sec = i.section; return pre + i.text; }).join('\n');
          view.classList.add('hidden'); editBox.classList.remove('hidden'); ta.focus();
        } else {
          editing = false;
          try { await api('PUT', `/api/checklists/${encodeURIComponent(name)}`, { title: opts.title, text: ta.value }); } catch (err) { toast(err.message, true); }
          editBox.classList.add('hidden'); view.classList.remove('hidden');
        }
      });
      return {
        update() {
          if (editing) return;
          const items = store.board.checklists[name]?.items || [];
          if (!items.length) return setHTML(view, '<span class="muted">No items. Click ✎ to add some.</span>');
          const done = items.filter((i) => i.done).length;
          let sec = null;
          setHTML(view, `<div class="ck-prog"><span>${done} / ${items.length} completed</span><div class="bar"><i style="width:${(done / items.length) * 100}%"></i></div></div>
            ${items.map((i) => {
              const head = i.section !== sec ? `<div class="ck-sec">${esc(i.section || '')}</div>` : '';
              sec = i.section;
              return `${head}<label class="ck-i ${i.done ? 'done' : ''}"><input type="checkbox" data-id="${esc(i.id)}" ${i.done ? 'checked' : ''}><span>${esc(i.text)}</span></label>`;
            }).join('')}`);
        },
      };
    },
  },

  text: {
    title: 'Text', icon: '🔤', category: 'Team', size: { w: 3, h: 2 },
    fit: true, // contents grow and shrink with the widget's box
    options: [
      { key: 'text', label: 'Text', type: 'textarea' },
      { key: 'size', label: 'Text size in px (empty = fit the widget)', type: 'number', default: '' },
      { key: 'align', label: 'Align', type: 'select', choices: () => [['center', 'Center'], ['left', 'Left']] },
    ],
    mount(body, opts) {
      body.innerHTML = `<div class="w-text" style="${Number(opts.size) ? `font-size:${Number(opts.size)}px;` : ''}text-align:${opts.align === 'left' ? 'left' : 'center'}">${esc(opts.text || '')}</div>`;
      return { update() {} };
    },
  },

  web: {
    title: 'Web page', icon: '🌐', category: 'Team', size: { w: 4, h: 4 },
    options: [{ key: 'url', label: 'URL (encoder status, stream analytics, Resi, etc.)', type: 'text' }],
    mount(body, opts) {
      body.innerHTML = /^https?:\/\//.test(opts.url || '') ? `<iframe class="w-frame" src="${esc(opts.url)}" referrerpolicy="no-referrer"></iframe>` : empty('Set a URL in settings');
      return { update() {} };
    },
  },
};

export const CATEGORIES = ['Service', 'Video', 'Switcher', 'Slides', 'Audio & RF', 'Stream', 'Team'];

/** Very small, safe formatter for notes: # heading, - bullets, ! highlight, links. */
function formatNote(text) {
  const lines = esc(text).split('\n');
  let out = '';
  let inList = false;
  for (const l of lines) {
    const bullet = l.match(/^\s*[-*•]\s+(.*)/);
    if (bullet && !inList) { out += '<ul>'; inList = true; }
    if (!bullet && inList) { out += '</ul>'; inList = false; }
    const linked = (s) => s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    if (bullet) out += `<li>${linked(bullet[1])}</li>`;
    else if (/^#{1,3}\s/.test(l)) out += `<h4>${linked(l.replace(/^#+\s*/, ''))}</h4>`;
    else if (/^!\s?/.test(l)) out += `<div class="note-hl">★ ${linked(l.replace(/^!\s?/, ''))}</div>`;
    else out += l.trim() ? `<p>${linked(l)}</p>` : '';
  }
  return out + (inList ? '</ul>' : '');
}

/** "1-4, 9" -> Set{1,2,3,4,9}; empty -> null */
function parseRange(s) {
  if (!s || !String(s).trim()) return null;
  const out = new Set();
  for (const part of String(s).split(',')) {
    const [a, b] = part.split('-').map((x) => parseInt(x, 10));
    if (Number.isFinite(a)) for (let i = a; i <= (Number.isFinite(b) ? b : a); i++) out.add(i);
  }
  return out;
}
