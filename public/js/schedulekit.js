// Bits shared by the Schedule page and Home: dates, and what changes from one service to the next.
import { store, esc, api, toast, confirmBox } from './common.js';

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "2026-05-02T09:00" → Date (the dashboard computer's local time). */
export const when = (start) => new Date(start);

export function fmtDay(start) {
  return when(start).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export function fmtTime(start) {
  return when(start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** "Today 9:00 AM", "Tomorrow 7:00 PM", "Sat, May 2 9:00 AM". */
export function fmtWhen(start) {
  const d = when(start);
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(new Date().toDateString())) / 86400000);
  const day = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days === -1 ? 'Yesterday' : fmtDay(start);
  return `${day} ${fmtTime(start)}`;
}

/** "in 2 h 10 min", "in 5 days". */
export function fmtIn(iso) {
  const min = Math.round((new Date(iso) - Date.now()) / 60000);
  if (min <= 0) return 'now';
  if (min < 60) return `in ${min} min`;
  if (min < 48 * 60) return `in ${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`;
  return `in ${Math.round(min / 1440)} days`;
}

const personName = (id) => store.greenroom.people.find((p) => p.id === id)?.name || null;

/** Mic by mic, who changes between two services: [{ label, from, to }]. */
export function micChanges(fromMics = {}, toMics = {}) {
  const out = [];
  for (const slot of store.slots) {
    const a = fromMics[slot.id]?.personId || null;
    const b = toMics[slot.id]?.personId || null;
    if (a === b) continue;
    out.push({ label: slot.label, from: a && personName(a), to: b && personName(b) });
  }
  return out;
}

export function changesHtml(changes, { max = 12 } = {}) {
  if (!changes.length) return '<span class="muted">No mic changes</span>';
  const rows = changes.slice(0, max).map((c) => `<div class="chg"><b>${esc(c.label)}</b><span>${c.from ? esc(c.from) : '<i class="muted">nobody</i>'}</span><span class="arrow">→</span><span>${c.to ? esc(c.to) : '<i class="muted">nobody</i>'}</span></div>`).join('');
  return `<div class="chgs">${rows}${changes.length > max ? `<div class="muted small">+${changes.length - max} more</div>` : ''}</div>`;
}

export function planLabel(plan = {}) {
  const pl = plan.playlist ? ` · ProPresenter playlist “${esc(plan.playlist)}”` : '';
  if (plan.source === 'manual') return `Typed order of service (${(plan.text || '').split('\n').filter((l) => l.trim()).length} lines)${pl}`;
  if (plan.source === 'propresenter') return `Follows the ProPresenter playlist${plan.playlist ? ` “${esc(plan.playlist)}”` : ''}`;
  if (plan.source === 'pco') return `Planning Center: ${esc(plan.pcoTitle || 'plan')}${pl}`;
  return `Keeps the order of service that's loaded${pl}`;
}

/** "↶ Undo" and "End service" buttons (Home and the Schedule page). Returns true if it handled the click. */
export async function scheduleAction(e) {
  const sc = store.schedule;
  const live = sc.services.find(async (s) => s.id === sc.liveId);
  const run = async (url, ok) => api('POST', url).then(async () => toast(ok)).catch(async (err) => toast(err.message, true));
  if (e.target.closest('[data-undo]')) {
    const msg = live
      ? `Undo “${live.name}” going live? Everything goes back to how it was just before: the service that was live, everyone's mics and the order of service. ${live.name} goes back to planned and won't go live by itself again (use Go live or Next service when you're ready).`
      : 'Undo? The service you ended (or the order of service you cleared) comes back, with everyone\'s mics.';
    if (await confirmBox(msg)) run('/api/schedule/undo', 'Back to how it was');
    return true;
  }
  if (e.target.closest('[data-clear]')) {
    if (await confirmBox('Clear the order of service that\'s still loaded? Dashboards then show “No service live” and what\'s next. (Undo puts it back.)')) run('/api/schedule/clear', 'Cleared');
    return true;
  }
  if (!live) return false;
  if (e.target.closest('[data-end]')) {
    if (await confirmBox(`End “${live.name}”? It's marked done, and its order of service, countdowns and mic assignments are cleared from the dashboards until the next service goes live (by itself at its usual time, if that's on). Undo brings it back.`)) run('/api/schedule/end', `${live.name} ended`);
    return true;
  }
  return false;
}
