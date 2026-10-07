// Home: what's happening now, where to go, and whether the gear is healthy.
import { start, store, onRender, esc, setHTML, icon, fmtDuration, can, api, toast } from './common.js';
import { currentInfo, serviceClock, planSource } from './plan.js';
import { fmtWhen, fmtIn, micChanges, changesHtml, scheduleAction } from './schedulekit.js';

await start({ page: 'home' });

const cfg = store.config;

setHTML(document.getElementById('links'), [
  ['/greenroom', 'mic', 'Green Room', 'Who has which mic'],
  ['/rf', 'rf', 'RF & batteries', 'Every channel and frequency'],
  ['/schedule', 'calendar', 'Schedule', 'Services planned ahead', 'producer'],
  ['/admin', 'list', 'Service & people', 'Plan, people, mic assignments', 'producer'],
  ['/comms/control', 'headset', 'Comms', 'Channels, people, cues', 'producer'],
  ['/gear', 'plug', 'Gear', 'Connections and setup', 'admin'],
  ['/settings', 'settings', 'Settings', 'Accounts, branding, updates', 'admin'],
].filter((l) => !l[4] || can(l[4])).map(([href, ic, title, sub]) => `<a class="htile" href="${href}">${icon(ic, 'ic htile-ic')}<b>${title}</b><small>${sub}</small></a>`).join(''));

function gearSummary() {
  const rows = [
    ...Object.values(store.state.receivers).map((r) => ['Wireless', r.name, r.online, r.error, r.placeholder]),
    ...Object.values(store.state.switchers).map((r) => ['Switcher', r.name, r.online, r.error, r.placeholder]),
    ...Object.values(store.state.propresenter).map((r) => ['ProPresenter', r.name, r.online, r.error, r.placeholder]),
  ];
  if (cfg.planningCenter) rows.push(['Plans', 'Planning Center', store.service.pco?.ok !== false, store.service.pco?.error]);
  if (!rows.length) return `<p class="muted">No gear added yet.</p><a class="btn primary" href="/gear">${icon('plus')} Add gear</a>`;
  const live = rows.filter((r) => !r[4]); // placeholders (no IP address yet) don't count
  const ok = live.filter((r) => r[2]).length;
  return `<div class="gear-sum ${ok === live.length ? 'all-ok' : 'some-bad'}"><b>${ok} of ${live.length}</b> connected</div>
    <div class="gear-rows">${rows.map(([kind, name, on, err, ph]) => `<div class="gear-row ${on ? 'g-ok' : ph ? '' : 'g-bad'}" title="${esc(err || '')}">
      <span class="dev-dot"></span><span>${esc(name)}</span><small class="muted">${kind}</small><b>${on ? 'Connected' : ph ? 'No IP yet' : 'Offline'}</b></div>`).join('')}</div>
    <a class="btn small" href="/gear">Open Gear</a>`;
}

/** Live and next scheduled service, with "Next service" and what changes on the mics. */
function scheduleCard() {
  const sc = store.schedule;
  const el = document.getElementById('sched');
  const live = sc.services.find((s) => s.id === sc.liveId);
  const next = sc.services.find((s) => s.id === sc.nextId);
  const pl = store.service.playlist || {};
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const wrongPlaylist = pl.expected && pl.active && norm(pl.expected) !== norm(pl.active);
  el.classList.toggle('hidden', !live && !next && !(can('producer') && store.config.setupComplete));
  const stale = !live && store.service.plan && can('producer'); // a plan is still loaded with nothing live
  const undoBtn = sc.canUndo && can('producer') ? '<button class="btn small" data-undo>↶ Undo</button>' : '';
  if (!live && !next) {
    setHTML(el, `<div class="panel-body sched-empty">${icon('calendar')} <span>${sc.services.length ? 'No service is live and nothing else is scheduled.' : 'Plan services ahead: a conference\'s sessions or next month\'s Sundays.'}</span>
      ${stale ? '<button class="btn small" data-clear>Clear the loaded plan</button>' : ''}${undoBtn} <a class="btn small" href="/schedule">Open Schedule</a></div>`);
    return;
  }
  const changes = live && next ? micChanges(live.mics, next.mics) : [];
  setHTML(el, `<div class="panel-body sched-card">
    <div class="sched-col"><small class="muted">Live now</small><b>${live ? esc(live.name) : 'Nothing'}</b><span class="muted">${live ? fmtWhen(live.start) : 'No scheduled service is live'}</span>
      ${stale ? `<span class="sched-warn">An order of service is still loaded (${esc(store.service.plan.title || 'plan')}), so dashboards still show it. <button class="btn small" data-clear>Clear it</button></span>` : ''}
      ${wrongPlaylist ? `<span class="sched-warn">⚠ ProPresenter has “${esc(pl.active)}” open; this service uses “${esc(pl.expected)}”.</span>` : ''}</div>
    <div class="sched-col"><small class="muted">Up next</small><b>${next ? esc(next.name) : '—'}</b>
      <span class="muted">${next ? `${fmtWhen(next.start)}${sc.auto && sc.switchAt ? ` · goes live by itself ${fmtIn(sc.switchAt)}` : ''}` : 'Nothing else scheduled'}</span></div>
    ${live && next ? `<div class="sched-col sched-chg"><small class="muted">Mic changes for ${esc(next.name)}</small>${changesHtml(changes, { max: 6 })}</div>` : ''}
    <div class="sched-btns">${next && can('producer') ? '<button class="btn primary" data-next>Next service ▶</button>' : ''}
      ${can('producer') && (live || undoBtn) ? `<span class="sched-row">${undoBtn}${live ? '<button class="btn small" data-end>End service</button>' : ''}</span>` : ''}
      <a class="btn small" href="/schedule">Schedule</a></div>
  </div>`);
}

document.getElementById('sched').addEventListener('click', async (e) => {
  if (scheduleAction(e)) return;
  if (!e.target.closest('[data-next]')) return;
  const next = store.schedule.services.find((s) => s.id === store.schedule.nextId);
  if (!next || !confirm(`Go to “${next.name}” now? Its mic plan and order of service are loaded, and everyone's mic goes back to “Assigned”.`)) return;
  try { await api('POST', '/api/schedule/next'); toast(`${next.name} is live`); } catch (err) { toast(err.message, true); }
});

function render() {
  scheduleCard();
  const svc = store.service;
  const info = currentInfo(svc);
  const clock = serviceClock(svc);
  const now = new Date();
  // Using the schedule and nothing is live (and no plan loaded): say so, and what's next.
  const sc = store.schedule;
  const idle = sc.services.length && !sc.liveId && !svc.plan;
  const nextUp = sc.services.find((s) => s.id === sc.nextId);
  setHTML(document.getElementById('hero'), `
    <div class="hero-main">
      <small class="muted">${now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</small>
      <h1>${idle ? 'No service live' : esc(store.greenroom.service?.name || svc.plan?.title || cfg.org.serviceName || cfg.org.name)}</h1>
      <p class="muted">${idle ? (nextUp ? `Next: ${esc(nextUp.name)} · ${fmtWhen(nextUp.start)}` : 'Nothing else is scheduled. <a href="/schedule">Open Schedule</a>')
    : svc.plan ? `${esc(svc.plan.title || '')}${svc.plan.seriesTitle ? ` · ${esc(svc.plan.seriesTitle)}` : ''} · ${planSource(svc)}` : 'No service plan loaded. <a href="/admin#plan">Add one</a>'}</p>
    </div>
    <div class="hero-stats">
      <div class="hero-stat"><small>Now</small><b>${info ? esc(info.item.title) : '—'}</b>${info ? `<span class="mono ${info.item.length && info.remaining < 0 ? 'over' : 'ok'}">${info.item.length ? fmtDuration(info.remaining) : fmtDuration(info.elapsed)}</span>` : ''}</div>
      <div class="hero-stat"><small>Up next</small><b>${info?.next ? esc(info.next.title) : '—'}</b></div>
      <div class="hero-stat"><small>${clock ? esc(clock.label) : 'Service clock'}</small><b class="mono ${clock?.tone || ''}">${clock ? fmtDuration(clock.seconds) : '—'}</b></div>
    </div>`);

  setHTML(document.getElementById('dashes'), store.dashboards.map((d) => `<a class="htile" href="/d/${encodeURIComponent(d.slug)}">${icon('grid', 'ic htile-ic')}<b>${esc(d.name)}</b><small>${d.widgets.length} widgets</small></a>`).join('')
    + `<a class="htile add" href="/dashboards?new=1">${icon('plus', 'ic htile-ic')}<b>New dashboard</b><small>Build one for a role or screen</small></a>`);

  setHTML(document.getElementById('gear'), gearSummary());
  setHTML(document.getElementById('alerts'), store.alerts.length
    ? store.alerts.map((a) => `<span class="alert ${a.level}">${esc(a.text)}</span>`).join('')
    : '<div class="w-empty ok">✓ All clear</div>');
}

onRender(render);
setInterval(render, 1000);
