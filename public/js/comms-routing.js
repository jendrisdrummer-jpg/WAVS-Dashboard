// Who hears whom on comms. Shared by the comms engine (browser) and the server tests.
//
// Speakers and listeners are people on phones plus "ports" (audio interface inputs and outputs,
// e.g. WING talkback in, a WING bus out). Each person has, per channel:
//   perms[ch] = { talk, listen }   set by the producer / a lead
//   listen[ch] = true|false        their own speaker on/off (only within perms)
//   volume[ch] = 0..1              their own level for that channel
//   talking[ch] = true|false       live: holding / latched TALK on that channel
// A muted person can still listen but never talks.

/** Is `s` talking on channel `ch` right now? */
export function speaking(s, ch) {
  return Boolean(!s.muted && s.perms?.[ch]?.talk && s.talking?.[ch]);
}

/** How loud `l` hears channel `ch` (0 = not listening). */
export function hearing(l, ch) {
  if (!l.perms?.[ch]?.listen || l.listen?.[ch] === false) return 0;
  const v = l.volume?.[ch];
  return typeof v === 'number' ? Math.max(0, Math.min(1, v)) : 1;
}

/** Gain from speaker `s` into listener `l`: the loudest channel they share. Nobody hears themself. */
export function gain(s, l, channels) {
  if (s.key === l.key) return 0;
  let g = 0;
  for (const ch of channels) if (speaking(s, ch)) g = Math.max(g, hearing(l, ch));
  return g;
}

/**
 * Turn comms state into engine endpoints.
 * Returns { speakers: [...], listeners: [...] }, each with a `key`
 * ("m:<memberId>" for people, "p:<portId>" for interface ports).
 */
export function endpoints(state) {
  const chIds = state.channels.map((c) => c.id);
  const all = Object.fromEntries(chIds.map((c) => [c, { talk: true, listen: true }]));
  const people = state.members.filter((m) => m.online).map((m) => ({ ...m, key: `m:${m.id}` }));
  const ins = (state.ports || []).filter((p) => p.kind === 'in').map((p) => ({
    key: `p:${p.id}`, perms: all, muted: Boolean(p.muted), talking: Object.fromEntries((p.channels || []).map((c) => [c, true])),
  }));
  const outs = (state.ports || []).filter((p) => p.kind === 'out').map((p) => ({
    key: `p:${p.id}`, perms: all, listen: Object.fromEntries(chIds.map((c) => [c, (p.channels || []).includes(c)])),
  }));
  return { channels: chIds, speakers: [...people, ...ins], listeners: [...people, ...outs] };
}

/** Full gain matrix: matrix[speakerKey][listenerKey] = 0..1 */
export function matrix(state) {
  const { channels, speakers, listeners } = endpoints(state);
  const out = {};
  for (const s of speakers) {
    out[s.key] = {};
    for (const l of listeners) out[s.key][l.key] = gain(s, l, channels);
  }
  return out;
}

/** Channels a member is currently talking on (for "who's talking" displays). */
export function talkingOn(m, channels) {
  return channels.filter((c) => speaking(m, c.id));
}
