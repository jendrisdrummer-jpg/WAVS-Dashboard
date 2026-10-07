// Home: what's happening now, where to go, and whether the gear is healthy.
import { start, store, onRender, esc, setHTML, icon, fmtDuration } from './common.js';
import { currentInfo, serviceClock, planSource } from './plan.js';

await start({ page: 'home' });

const cfg = store.config;

setHTML(document.getElementById('links'), [
  ['/greenroom', 'mic', 'Green Room', 'Who has which mic'],
  ['/rf', 'rf', 'RF & batteries', 'Every channel and frequency'],
  ['/admin', 'list', 'Service & people', 'Plan, people, mic assignments'],
  ['/comms/control', 'headset', 'Comms', 'Channels, people, cues'],
  ['/gear', 'plug', 'Gear', 'Connections and setup'],
  ['/settings', 'settings', 'Settings', 'Branding, PIN, Planning Center'],
].map(([href, ic, title, sub]) => `<a class="htile" href="${href}">${icon(ic, 'ic htile-ic')}<b>${title}</b><small>${sub}</small></a>`).join(''));

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

function render() {
  const svc = store.service;
  const info = currentInfo(svc);
  const clock = serviceClock(svc);
  const now = new Date();
  setHTML(document.getElementById('hero'), `
    <div class="hero-main">
      <small class="muted">${now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</small>
      <h1>${esc(store.greenroom.service?.name || svc.plan?.title || cfg.org.serviceName || cfg.org.name)}</h1>
      <p class="muted">${svc.plan ? `${esc(svc.plan.title || '')}${svc.plan.seriesTitle ? ` · ${esc(svc.plan.seriesTitle)}` : ''} · ${planSource(svc)}` : 'No service plan loaded. <a href="/admin#plan">Add one</a>'}</p>
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
