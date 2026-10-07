// Service plan timing maths, shared by the plan / current item / service clock widgets.

const playable = (svc) => (svc.plan?.items || []).filter((i) => i.type !== 'header');
const hhmm = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** The service time (Planning Center "service" type) that is running now, or the next / last one. */
export function activeServiceTime(svc, now = Date.now()) {
  const times = (svc.plan?.times || []).filter((t) => t.type === 'service' && t.startsAt);
  if (!times.length) return null;
  const total = playable(svc).filter((i) => i.position !== 'pre' && i.position !== 'post').reduce((n, i) => n + (i.length || 0), 0);
  const withEnd = times.map((t) => ({ ...t, start: new Date(t.startsAt).getTime(), end: t.endsAt ? new Date(t.endsAt).getTime() : new Date(t.startsAt).getTime() + total * 1000 }));
  return withEnd.find((t) => now < t.end + 15 * 60000) || withEnd[withEnd.length - 1];
}

/** Planned start time per item, which items are done, and the countdown for the current one. */
export function planTiming(svc, now = Date.now()) {
  const items = playable(svc);
  const out = { items: {} };
  const time = activeServiceTime(svc, now);
  const preTotal = items.filter((i) => i.position === 'pre').reduce((n, i) => n + (i.length || 0), 0);
  let t = time ? time.start - preTotal * 1000 : null;
  const curIdx = items.findIndex((i) => i.id === svc.current?.itemId);
  items.forEach((it, idx) => {
    const info = { start: t != null ? hhmm(new Date(t)) : null, done: curIdx > -1 && idx < curIdx };
    if (idx === curIdx) {
      const elapsed = (now - new Date(svc.current.startedAt)) / 1000;
      info.remaining = (it.length || 0) - elapsed;
    }
    out.items[it.id] = info;
    if (t != null) t += (it.length || 0) * 1000;
  });
  return out;
}

export function currentInfo(svc, now = Date.now()) {
  const items = playable(svc);
  const idx = items.findIndex((i) => i.id === svc.current?.itemId);
  if (idx === -1) return null;
  const item = items[idx];
  const elapsed = Math.max(0, (now - new Date(svc.current.startedAt)) / 1000);
  return { item, elapsed, remaining: (item.length || 0) - elapsed, next: items[idx + 1] || null };
}

/** Countdown to the service, time remaining in it, or how far over it is. */
export function serviceClock(svc, now = Date.now()) {
  const t = activeServiceTime(svc, now);
  if (!t) return null;
  if (now < t.start) return { label: `${t.name || 'Service'} starts in`, seconds: (t.start - now) / 1000, tone: '', sub: `at ${hhmm(new Date(t.start))}` };
  if (now < t.end) {
    const left = (t.end - now) / 1000;
    return { label: 'Service time remaining', seconds: left, tone: left < 300 ? 'warn' : '', sub: `planned end ${hhmm(new Date(t.end))}` };
  }
  return { label: 'Over planned end by', seconds: (now - t.end) / 1000, tone: 'bad', sub: `planned end ${hhmm(new Date(t.end))}` };
}

/** Where the order of service comes from, in words. */
export function planSource(svc) {
  return { pco: 'Planning Center', manual: 'Manual plan', propresenter: 'ProPresenter playlist' }[svc.source] || 'Plan';
}
