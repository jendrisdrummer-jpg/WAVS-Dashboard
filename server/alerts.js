/**
 * Turn live state into a prioritised alert list.
 * Levels: critical > serious > warning. Each alert has a stable `key` so the UI
 * can tell new alerts (chime) from ones it has already shown.
 */
export function computeAlerts(state, greenroom, mics, cfg) {
  const out = [];
  const t = cfg.alerts;
  const push = (level, key, text) => out.push({ level, key, text });

  for (const rx of Object.values(state.receivers)) {
    if (rx.placeholder) continue; // added ahead of time, no IP address yet
    if (!rx.online) push('critical', `rx:${rx.id}`, `Receiver "${rx.name}" offline${rx.error ? ` (${rx.error})` : ''}`);
  }
  for (const pp of Object.values(state.propresenter)) {
    if (pp.placeholder) continue;
    if (!pp.online) push('serious', `pp:${pp.id}`, `ProPresenter "${pp.name}" not responding`);
  }
  for (const sw of Object.values(state.switchers)) {
    if (sw.placeholder) continue;
    if (!sw.online) push('warning', `sw:${sw.id}`, `Switcher "${sw.name}" offline${sw.error ? ` (${sw.error})` : ''}`);
    else if (sw.ftb) push('warning', `ftb:${sw.id}`, `${sw.name}: Fade to black is ON`);
  }

  // Nobody has a mic (no service live): any mic that's switched on counts as in use for the
  // weak-RF warning, so a sound check or rehearsal is still watched.
  const nobodyAssigned = !Object.values(greenroom.assignments).some((a) => a.personId && a.status !== 'returned');
  for (const meta of mics) {
    const m = state.mics[meta.id];
    if (!m || !m.online) continue;
    const a = greenroom.assignments[meta.id];
    const person = a && greenroom.people.find((p) => p.id === a.personId);
    const who = person ? `${person.name} (${meta.label})` : meta.label;
    const inUse = a && (a.status === 'picked-up' || a.status === 'on-stage');
    const txOn = isTxOn(m);

    if (inUse && !txOn) push(a.status === 'on-stage' ? 'critical' : 'serious', `tx:${meta.id}`, `${who}: transmitter off / no RF`);
    if (!txOn) continue;
    if (isBatteryLow(m, t)) {
      const detail = m.battMinutes != null ? `${m.battMinutes} min left` : `${m.battBars}/5 bars`;
      push(inUse ? 'serious' : 'warning', `batt:${meta.id}`, `${who}: low battery (${detail})`);
    }
    if ((inUse || nobodyAssigned) && m.rfDbm != null && m.rfDbm < t.rfLowDbm) push('warning', `rf:${meta.id}`, `${who}: weak RF (${m.rfDbm} dBm)`);
    if (m.interference) push('serious', `int:${meta.id}`, `${who}: RF interference detected`);
    if (a?.status === 'on-stage' && m.txMuted) push('warning', `mute:${meta.id}`, `${who}: transmitter muted while on stage`);
  }

  const rank = { critical: 0, serious: 1, warning: 2 };
  return out.sort((x, y) => rank[x.level] - rank[y.level]);
}

/** A transmitter counts as "on" when the receiver identifies it, or we see real RF. */
export function isTxOn(m) {
  return Boolean(m.txType) || (m.rfDbm != null && m.rfDbm > -110);
}

/** Runtime (minutes) is more precise than bars, so it wins when the transmitter reports it. */
export function isBatteryLow(m, t) {
  if (m.battMinutes != null) return m.battMinutes <= t.batteryMinutes;
  if (m.battPercent != null) return m.battPercent <= t.batteryBars * 20;
  return m.battBars != null && m.battBars <= t.batteryBars;
}
