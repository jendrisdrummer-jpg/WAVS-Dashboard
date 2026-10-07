import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Schedule, ymd } from '../server/schedule.js';

const withSchedule = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavs-sched-'));
  try { return fn(new Schedule(dir), dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};
const at = (s) => new Date(s).getTime();

test('schedule: an event with several services; the next one goes live before it starts', () => withSchedule((sc, dir) => {
  const ev = sc.addEvent({ name: 'Spring Conference' });
  const a = sc.addService({ name: 'Fri 7pm Opening', start: '2026-05-01T19:00', eventId: ev.id, mics: { 'rx.1': { personId: 'p1' } } });
  const b = sc.addService({ name: 'Sat 9am Session 2', start: '2026-05-02T09:00', eventId: ev.id });
  const c = sc.addService({ name: 'Sat 11am Session 3', start: '2026-05-02T11:00', eventId: ev.id });
  assert.throws(() => sc.addService({ name: 'x', start: 'tomorrow' }), /date and start time/);

  // Nothing live: the first one goes live 90 minutes before it starts.
  assert.equal(sc.due(at('2026-05-01T17:00')), null);
  assert.equal(sc.due(at('2026-05-01T17:31'))?.id, a.id);
  sc.setLive(a.id);
  assert.equal(sc.next().id, b.id);

  // Saturday 7:31: 90 minutes before Session 2, and the opening night is long over.
  assert.equal(sc.due(at('2026-05-02T07:31'), at('2026-05-01T20:30'))?.id, b.id);
  sc.setLive(b.id);
  assert.equal(sc.get(a.id).state, 'done');

  // Back-to-back: Session 2 is still running (planned to end 10:40), so Session 3 waits for it…
  assert.equal(sc.due(at('2026-05-02T09:45'), at('2026-05-02T10:40')), null);
  // …but never later than 15 minutes before Session 3 starts.
  assert.equal(sc.due(at('2026-05-02T10:45'), at('2026-05-02T11:30'))?.id, c.id);

  sc.setOptions({ auto: false });
  assert.equal(sc.due(at('2026-05-02T10:59')), null);

  // Saved to disk.
  assert.equal(new Schedule(dir).data.services.length, 3);
}));

test('schedule: changes made while live are kept with the service; duplicating copies mics', () => withSchedule((sc) => {
  const s = sc.addService({ name: 'Sunday', start: '2026-05-03T09:00', plan: { source: 'manual', text: '5:00 Welcome' }, mics: { 'rx.1': { personId: 'p1' } } });
  sc.setLive(s.id);
  sc.syncLive({ mics: { 'rx.1': { personId: 'p2', note: 'spare battery' } } });
  assert.deepEqual(sc.get(s.id).mics, { 'rx.1': { personId: 'p2', note: 'spare battery' } });
  const copy = sc.duplicate(s.id, { start: '2026-05-10T09:00' });
  assert.equal(copy.state, 'planned');
  assert.deepEqual(copy.mics, sc.get(s.id).mics);
  assert.equal(copy.plan.text, '5:00 Welcome');
}));

test('schedule: weekly and every-other-week templates fill the weeks ahead', () => withSchedule((sc) => {
  const now = new Date('2026-05-04T12:00'); // a Monday
  const t = sc.saveTemplate({ name: 'Sunday 9:00', weekday: 0, time: '09:00', every: 1, from: '2026-05-04', weeksAhead: 4, mics: { 'rx.1': { personId: 'p1' } } });
  sc.materialize({ now });
  let sundays = sc.data.services.filter((s) => s.templateId === t.id).map((s) => s.start).sort();
  assert.deepEqual(Schedule.dates(t, now), ['2026-05-10', '2026-05-17', '2026-05-24', '2026-05-31']);
  assert.ok(sundays.includes('2026-05-10T09:00'));

  // Change one week by hand; then change the template: the hand-changed one stays as it is.
  const may17 = sc.data.services.find((s) => s.start === '2026-05-17T09:00');
  sc.updateService(may17.id, { name: 'Baptism Sunday' });
  sc.saveTemplate({ ...t, id: t.id, time: '10:00', from: '2026-05-04', weeksAhead: 4 });
  sc.materialize({ now });
  assert.equal(sc.get(may17.id).name, 'Baptism Sunday');
  assert.equal(sc.get(may17.id).start, '2026-05-17T09:00');
  sundays = sc.data.services.filter((s) => s.templateId === t.id && !s.edited).map((s) => s.start.slice(11));
  assert.ok(sundays.length && sundays.every((x) => x === '10:00'));

  // Deleting one week doesn't bring it back.
  const may24 = sc.data.services.find((s) => s.start.startsWith('2026-05-24'));
  sc.removeService(may24.id);
  sc.materialize({ now });
  assert.ok(!sc.data.services.some((s) => s.start.startsWith('2026-05-24')));

  // Every other week, counted from the first Sunday on/after "from".
  const t2 = sc.saveTemplate({ name: 'Youth', weekday: 3, time: '19:00', every: 2, from: '2026-05-04', weeksAhead: 5 });
  assert.deepEqual(Schedule.dates(t2, now), ['2026-05-06', '2026-05-20', '2026-06-03']);

  // Removing the template drops its untouched upcoming services, keeps the changed one.
  sc.removeTemplate(t.id, { now });
  assert.ok(sc.get(may17.id));
  assert.equal(sc.data.services.filter((s) => s.name === 'Sunday 9:00').length, 0);
  assert.equal(ymd(new Date('2026-05-04T23:59')), '2026-05-04');
}));

test('schedule: undo going live puts the previous service back; the undone one waits to be started by hand', () => withSchedule((sc) => {
  const a = sc.addService({ name: 'Session 1', start: '2026-05-02T09:00' });
  const b = sc.addService({ name: 'Session 2', start: '2026-05-02T11:00' });
  sc.setLive(a.id, { undo: { greenroom: 'before-a' } });
  sc.setLive(b.id, { undo: { greenroom: 'before-b' } });
  assert.ok(sc.canUndo());
  assert.equal(sc.view().undo, undefined); // the saved state isn't sent to browsers

  const u = sc.undoLive();
  assert.equal(u.greenroom, 'before-b');
  assert.equal(sc.data.liveId, a.id);
  assert.equal(sc.get(a.id).state, 'live');
  assert.equal(sc.get(a.id).endedAt, undefined);
  assert.equal(sc.get(b.id).state, 'planned');
  assert.ok(!sc.canUndo());
  assert.throws(() => sc.undoLive(), /Nothing to undo/);

  // It won't go live by itself again, but Next service still goes to it.
  assert.equal(sc.due(at('2026-05-02T10:59'), at('2026-05-02T10:00')), null);
  assert.equal(sc.next().id, b.id);
  sc.setLive(b.id);
  assert.equal(sc.get(b.id).noAuto, undefined);

  // End: done, nothing live, no undo.
  sc.endLive();
  assert.equal(sc.data.liveId, null);
  assert.equal(sc.get(b.id).state, 'done');
  assert.ok(!sc.canUndo());
  assert.throws(() => sc.endLive(), /No service is live/);
}));

test('schedule: End service and Clear can be undone', () => withSchedule((sc) => {
  const a = sc.addService({ name: 'Session 1', start: '2026-05-02T09:00' });
  sc.setLive(a.id);
  sc.endLive({ undo: { greenroom: 'during-a' } });
  assert.ok(sc.canUndo());
  assert.equal(sc.undoLive().greenroom, 'during-a');
  assert.equal(sc.data.liveId, a.id);
  assert.equal(sc.get(a.id).state, 'live');

  sc.endLive();
  sc.data.undo = { greenroom: 'old plan', serviceId: null, cleared: true };
  assert.ok(sc.canUndo());
  assert.equal(sc.undoLive().greenroom, 'old plan');
  assert.equal(sc.data.liveId, null);
  assert.ok(!sc.canUndo());
}));
