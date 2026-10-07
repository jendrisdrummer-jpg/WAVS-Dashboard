// Schedule: services planned ahead (events with several sessions, repeating Sundays), which one
// is live, and when the next one goes live by itself.
import { start, store, onRender, esc, setHTML, api, toast } from './common.js';
import { WEEKDAYS, fmtDay, fmtTime, fmtWhen, fmtIn, micChanges, changesHtml, planLabel } from './schedulekit.js';

await start({ page: 'schedule' });

const sched = () => store.schedule || { services: [], events: [], templates: [] };
const eventName = (id) => sched().events.find((e) => e.id === id)?.name || '';
const micCount = (m) => Object.keys(m || {}).length;
let showEarlier = false;

// ---------------------------------------------------------------- render

function render() {
  const sc = sched();
  const live = sc.services.find((s) => s.id === sc.liveId);
  const next = sc.services.find((s) => s.id === sc.nextId);

  setHTML(document.getElementById('top'), `
    <div class="sch-now">
      <div><small class="muted">Live now</small><b>${live ? esc(live.name) : '—'}</b>${live ? `<span class="muted">${fmtWhen(live.start)}</span>` : '<span class="muted">No scheduled service is live</span>'}</div>
      <div><small class="muted">Up next</small><b>${next ? esc(next.name) : '—'}</b>${next ? `<span class="muted">${fmtWhen(next.start)}${sc.auto && sc.switchAt ? ` · goes live by itself ${fmtIn(sc.switchAt)}` : ''}</span>` : '<span class="muted">Nothing else scheduled</span>'}</div>
      ${next ? '<button class="btn primary" data-next>Next service ▶</button>' : ''}
    </div>
    <label class="cb sch-auto"><input type="checkbox" data-auto ${sc.auto ? 'checked' : ''}> Go to the next service by itself
      <input type="number" min="5" max="600" step="5" value="${sc.leadMinutes || 90}" data-lead style="width:70px"> minutes before it starts
      <small class="muted">(waits for the live service to finish, but no later than 15 minutes before the next one)</small></label>`);

  document.getElementById('repeat-panel').classList.toggle('hidden', !sc.templates.length);
  setHTML(document.getElementById('repeats'), sc.templates.map((t) => `
    <div class="sch-row">
      <div class="sch-when"><b>${WEEKDAYS[t.weekday]}s</b><span>${fmtTime(`2000-01-01T${t.time}`)}</span></div>
      <div class="sch-what"><b>${esc(t.name)}</b><small class="muted">${t.every === 2 ? 'Every other week' : 'Every week'} · ${micCount(t.mics)} mics planned · scheduled ${t.weeksAhead} weeks ahead</small></div>
      <div class="sch-btns"><button class="btn small" data-edit-t="${t.id}">Edit</button><button class="btn small danger" data-del-t="${t.id}">Stop repeating</button></div>
    </div>`).join(''));

  const today = new Date().toDateString();
  const upcoming = sc.services.filter((s) => s.state !== 'done');
  const earlier = sc.services.filter((s) => s.state === 'done').reverse();
  const row = (s, prev) => {
    const changes = prev ? micChanges(prev.mics, s.mics) : [];
    return `<div class="sch-row ${s.state}">
      <div class="sch-when"><b>${fmtTime(s.start)}</b>${s.state === 'live' ? '<span class="chip live">LIVE</span>' : s.state === 'done' ? '<span class="chip">Done</span>' : ''}</div>
      <div class="sch-what">
        <b>${esc(s.name)}</b>
        <small class="muted">${s.eventId ? `<span class="chip on">${esc(eventName(s.eventId))}</span> ` : ''}${s.templateId ? '<span class="chip" title="From a repeating service">↻</span> ' : ''}${micCount(s.mics)} mics · ${planLabel(s.plan)}</small>
        ${prev && s.state === 'planned' && changes.length ? `<details class="sch-chg"><summary>${changes.length} mic change${changes.length === 1 ? '' : 's'} from ${esc(prev.name)}</summary>${changesHtml(changes)}</details>` : ''}
      </div>
      <div class="sch-btns">
        ${s.state !== 'live' ? `<button class="btn small" data-live="${s.id}">Go live</button>` : ''}
        <button class="btn small" data-edit="${s.id}">Edit</button>
        <button class="btn small" data-dup="${s.id}">Duplicate</button>
        ${s.state !== 'live' ? `<button class="btn small danger" data-del="${s.id}">Delete</button>` : ''}
      </div>
    </div>`;
  };
  let lastDay = '';
  let prev = null;
  const body = upcoming.map((s) => {
    const d = new Date(s.start).toDateString();
    const head = d !== lastDay ? `<div class="sch-day">${d === today ? 'Today · ' : ''}${fmtDay(s.start)}</div>` : '';
    lastDay = d;
    const html = head + row(s, prev);
    prev = s;
    return html;
  }).join('');
  const events = sc.events.length ? `<div class="sch-events">${sc.events.map((e) => `<span class="sch-event"><b>${esc(e.name)}</b>
      <small class="muted">${sc.services.filter((s) => s.eventId === e.id).length} services</small>
      <button class="btn small" data-add-to="${e.id}">+ Service</button><button class="btn small" data-ren-e="${e.id}">Rename</button><button class="btn small danger" data-del-e="${e.id}">Delete</button></span>`).join('')}</div>` : '';
  setHTML(document.getElementById('list'), `${events}${body || '<p class="muted">Nothing scheduled yet. Add a service, an event with several services, or a repeating service like “Sunday 9:00”.</p>'}
    ${earlier.length ? `<button class="btn small" data-earlier>${showEarlier ? 'Hide' : 'Show'} earlier services (${earlier.length})</button>
      ${showEarlier ? earlier.map((s) => `<div class="sch-day">${fmtDay(s.start)}</div>${row(s, null)}`).join('') : ''}` : ''}`);
}

onRender(render);
setInterval(render, 30000);

// ---------------------------------------------------------------- actions

const call = async (fn, ok) => { try { await fn(); if (ok) toast(ok); } catch (err) { toast(err.message, true); } };

document.getElementById('top').addEventListener('click', (e) => {
  if (e.target.closest('[data-next]')) call(() => api('POST', '/api/schedule/next'), 'Next service is live');
});
document.getElementById('top').addEventListener('change', (e) => {
  if (e.target.matches('[data-auto]')) call(() => api('PUT', '/api/schedule/options', { auto: e.target.checked }));
  if (e.target.matches('[data-lead]')) call(() => api('PUT', '/api/schedule/options', { leadMinutes: Number(e.target.value) }));
});

document.getElementById('add-service').onclick = () => editService(null);
document.getElementById('add-repeat').onclick = () => editService(null, { template: true });
document.getElementById('add-event').onclick = async () => {
  const name = prompt('Event name (e.g. "Spring Conference 2026")');
  if (!name?.trim()) return;
  let ev;
  await call(async () => { ev = await api('POST', '/api/schedule/events', { name }); });
  if (ev) editService(null, { eventId: ev.id });
};

for (const id of ['list', 'repeats']) {
  document.getElementById(id).addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    const sc = sched();
    if (d.live) {
      const s = sc.services.find((x) => x.id === d.live);
      if (confirm(`Make “${s.name}” the live service now? Its mic plan and order of service are loaded, and everyone's mic goes back to “Assigned”.`)) call(() => api('POST', `/api/schedule/services/${d.live}/live`), `${s.name} is live`);
    } else if (d.edit) editService(sc.services.find((x) => x.id === d.edit));
    else if (d.dup) {
      const s = sc.services.find((x) => x.id === d.dup);
      call(async () => { const copy = await api('POST', `/api/schedule/services/${d.dup}/duplicate`, { name: s.name }); editService(copy); });
    } else if (d.del) {
      const s = sc.services.find((x) => x.id === d.del);
      if (confirm(`Delete “${s.name}” (${fmtWhen(s.start)})?`)) call(() => api('DELETE', `/api/schedule/services/${d.del}`), 'Deleted');
    } else if (d.editT) editService(sc.templates.find((t) => t.id === d.editT), { template: true });
    else if (d.delT) {
      const t = sc.templates.find((x) => x.id === d.delT);
      if (confirm(`Stop repeating “${t.name}”? Upcoming ones you haven't changed are removed; ones you changed stay.`)) call(() => api('DELETE', `/api/schedule/templates/${d.delT}`), 'Stopped');
    } else if (d.addTo) editService(null, { eventId: d.addTo });
    else if (d.renE) {
      const ev = sc.events.find((x) => x.id === d.renE);
      const name = prompt('Event name', ev.name);
      if (name?.trim()) call(() => api('PUT', `/api/schedule/events/${ev.id}`, { name }));
    } else if (d.delE) {
      const ev = sc.events.find((x) => x.id === d.delE);
      const n = sc.services.filter((s) => s.eventId === ev.id).length;
      if (!confirm(`Delete the event “${ev.name}”?`)) return;
      const withServices = n > 0 && confirm(`Also delete its ${n} service${n === 1 ? '' : 's'}? (Cancel keeps them as separate services.)`);
      call(() => api('DELETE', `/api/schedule/events/${ev.id}${withServices ? '?services=1' : ''}`), 'Deleted');
    } else if ('earlier' in d) { showEarlier = !showEarlier; render(); }
  });
}

// ---------------------------------------------------------------- the editor

/** Default start for a new service: the next hour, or the day after an event's last service. */
function defaultStart(eventId) {
  const last = sched().services.filter((s) => s.eventId === eventId).map((s) => s.start).sort().pop();
  if (eventId && last) return last;
  const d = new Date(Date.now() + 3600000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:00`;
}

/**
 * Add or change a service (or a repeating service: template). Name, when, event, order of
 * service, ProPresenter playlist, who has which mic, notes.
 */
function editService(item, { template = false, eventId = null } = {}) {
  const sc = sched();
  const s = item || { name: '', start: defaultStart(eventId), eventId, plan: { source: '' }, mics: {}, notes: '', weekday: 0, time: '09:00', every: 1, weeksAhead: 8 };
  const plan = s.plan || {};
  const people = [...store.greenroom.people].sort((a, b) => a.name.localeCompare(b.name));
  const slots = store.slots.filter((x) => !x.hidden);
  const others = sc.services.filter((x) => x.id !== s.id).slice(-30);
  const upcomingPco = store.service.upcoming || [];
  const dlg = document.createElement('dialog');
  dlg.className = 'dlg sch-dlg';
  dlg.innerHTML = `<form method="dialog">
    <h3>${template ? (item ? 'Repeating service' : 'New repeating service') : item ? 'Edit service' : 'New service'}</h3>
    <div class="dlg-fields">
      <label>Name <input type="text" name="name" required maxlength="120" value="${esc(s.name)}" placeholder="${template ? 'Sunday 9:00' : 'Sat 9am Session 2'}"></label>
      ${template ? `<div class="sch-2">
          <label>Every <select name="weekday">${WEEKDAYS.map((w, i) => `<option value="${i}" ${i === Number(s.weekday) ? 'selected' : ''}>${w}</option>`).join('')}</select></label>
          <label>Starts at <input type="time" name="time" required value="${esc(s.time)}"></label>
          <label>How often <select name="every"><option value="1">Every week</option><option value="2" ${s.every === 2 ? 'selected' : ''}>Every other week</option></select></label>
          <label>Schedule ahead <select name="weeksAhead">${[4, 8, 12, 26].map((w) => `<option value="${w}" ${w === Number(s.weeksAhead) ? 'selected' : ''}>${w} weeks</option>`).join('')}</select></label>
        </div>
        <small class="muted">Each week appears on the schedule; you can change any single week without changing the others.</small>`
    : `<div class="sch-2">
          <label>Date <input type="date" name="date" required value="${esc(s.start.slice(0, 10))}"></label>
          <label>Starts at <input type="time" name="time" required value="${esc(s.start.slice(11, 16))}"></label>
          <label>Event <select name="eventId"><option value="">— None —</option>${sc.events.map((e) => `<option value="${e.id}" ${e.id === s.eventId ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></label>
        </div>`}
      <fieldset><legend>Order of service</legend>
        <select name="source">
          <option value="">Keep whatever is loaded</option>
          <option value="manual" ${plan.source === 'manual' ? 'selected' : ''}>Type or paste it (Faith Teams, a run sheet)</option>
          <option value="propresenter" ${plan.source === 'propresenter' ? 'selected' : ''}>Use the ProPresenter playlist</option>
          <option value="pco" ${plan.source === 'pco' ? 'selected' : ''} ${upcomingPco.length || plan.source === 'pco' ? '' : 'disabled'}>Planning Center plan${upcomingPco.length ? '' : ' (connect it in Settings)'}</option>
        </select>
        <textarea name="text" rows="7" placeholder="# Pre-service&#10;10:00 Walk-in loop&#10;# Worship&#10;song 4:30 Goodness Of God&#10;35m Message" data-for="manual">${esc(plan.text || '')}</textarea>
        <select name="pco" data-for="pco">${plan.source === 'pco' && !upcomingPco.some((u) => u.id === plan.planId) ? `<option value="${esc(plan.serviceTypeId)}|${esc(plan.planId)}" selected>${esc(plan.pcoTitle || 'Chosen plan')}</option>` : ''}
          ${upcomingPco.map((u) => `<option value="${esc(u.serviceTypeId)}|${esc(u.id)}" data-title="${esc(u.title)}" ${u.id === plan.planId ? 'selected' : ''}>${esc(u.serviceTypeName)}: ${esc(u.title)} (${esc(u.dates || '')})</option>`).join('')}</select>
        <label>ProPresenter playlist for this service <small class="muted">(optional)</small>
          <input type="text" name="playlist" maxlength="120" value="${esc(plan.playlist || '')}" placeholder="Leave empty to follow whichever playlist is open">
        </label>
        <small class="muted">For a conference with a playlist per session, type its name exactly as in ProPresenter. Other playlists are then ignored while this service is live.</small>
      </fieldset>
      <fieldset><legend>Who has which mic</legend>
        ${others.length ? `<label class="small">Copy from <select data-copy><option value="">— pick a service —</option>${others.map((o) => `<option value="${o.id}">${esc(o.name)} · ${fmtWhen(o.start)}</option>`).join('')}</select></label>` : ''}
        <div class="sch-mics">${slots.map((slot) => {
          const a = s.mics?.[slot.id] || {};
          return `<label class="sch-mic"><span>${esc(slot.label)}</span>
            <select data-mic="${esc(slot.id)}"><option value="">— Nobody —</option>${people.map((p) => `<option value="${p.id}" ${p.id === a.personId ? 'selected' : ''}>${esc(p.name)}${p.role ? ` (${esc(p.role)})` : ''}</option>`).join('')}</select>
            <input type="text" data-note="${esc(slot.id)}" maxlength="200" value="${esc(a.note || '')}" placeholder="Note"></label>`;
        }).join('') || '<p class="muted">No mics yet. Add receivers on the Gear page.</p>'}</div>
        ${people.length ? '' : '<p class="muted">No people yet. Add your team on Service &amp; People.</p>'}
      </fieldset>
      <label>Notes <textarea name="notes" rows="2" maxlength="4000">${esc(s.notes || '')}</textarea></label>
    </div>
    <div class="sch-dlg-btns">
      ${!template && item ? '<button type="button" class="btn small" data-repeat>↻ Repeat weekly</button>' : '<span></span>'}
      <span><button value="cancel" class="btn" formnovalidate>Cancel</button> <button value="save" class="btn primary">Save</button></span>
    </div>
  </form>`;
  document.body.append(dlg);
  const f = dlg.querySelector('form');
  const syncSource = () => { for (const el of f.querySelectorAll('[data-for]')) el.classList.toggle('hidden', el.dataset.for !== f.source.value); };
  f.source.onchange = syncSource;
  syncSource();
  dlg.querySelector('[data-copy]')?.addEventListener('change', (e) => {
    const from = sched().services.find((x) => x.id === e.target.value);
    if (!from) return;
    for (const sel of f.querySelectorAll('[data-mic]')) sel.value = from.mics?.[sel.dataset.mic]?.personId || '';
    for (const inp of f.querySelectorAll('[data-note]')) inp.value = from.mics?.[inp.dataset.note]?.note || '';
    toast(`Mics copied from ${from.name}`);
  });

  const collect = () => {
    const mics = {};
    for (const sel of f.querySelectorAll('[data-mic]')) {
      if (!sel.value) continue;
      const note = f.querySelector(`[data-note="${CSS.escape(sel.dataset.mic)}"]`)?.value.trim();
      mics[sel.dataset.mic] = { personId: sel.value, ...(note ? { note } : {}) };
    }
    const [serviceTypeId, planId] = (f.pco.value || '|').split('|');
    const body = {
      name: f.name.value.trim(),
      plan: { source: f.source.value, text: f.text.value, playlist: f.playlist.value.trim(), serviceTypeId, planId, pcoTitle: f.pco.selectedOptions[0]?.dataset.title || f.pco.selectedOptions[0]?.textContent || '' },
      mics,
      notes: f.notes.value,
    };
    if (template) Object.assign(body, { weekday: Number(f.weekday.value), time: f.time.value, every: Number(f.every.value), weeksAhead: Number(f.weeksAhead.value), from: s.from });
    else Object.assign(body, { start: `${f.date.value}T${f.time.value}`, eventId: f.eventId.value || null });
    return body;
  };

  dlg.querySelector('[data-repeat]')?.addEventListener('click', () => {
    const body = collect();
    const day = new Date(body.start).getDay();
    dlg.close('cancel');
    editService({ ...body, weekday: day, time: body.start.slice(11, 16), every: 1, weeksAhead: 8, from: body.start.slice(0, 10), name: body.name }, { template: true, fromService: true });
  });

  f.addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'save') return;
    e.preventDefault();
    const body = collect();
    try {
      if (template) await api('POST', '/api/schedule/templates', item?.id ? { ...body, id: item.id } : body);
      else if (item?.id) await api('PUT', `/api/schedule/services/${item.id}`, body);
      else await api('POST', '/api/schedule/services', body);
      toast('Saved');
      dlg.close('save');
    } catch (err) { toast(err.message, true); }
  });
  dlg.onclose = () => dlg.remove();
  dlg.showModal();
}
