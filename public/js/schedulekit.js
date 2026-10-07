// Bits shared by the Schedule page and Home: dates, and what changes from one service to the next.
import { store, esc } from './common.js';

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
