import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAlerts } from '../server/alerts.js';

const cfg = { alerts: { rfLowDbm: -80, batteryMinutes: 30, batteryBars: 1 } };
const mics = [{ id: 'rx.1', label: 'HH 1' }];
const state = (m) => ({ receivers: {}, propresenter: {}, switchers: {}, mics: { 'rx.1': { online: true, txType: 'SLXD2', ...m } } });

test('alerts: with nobody assigned (no service live), a switched-on mic is still watched', () => {
  const none = { people: [], assignments: {} };
  const keys = computeAlerts(state({ rfDbm: -90, battMinutes: 10 }), none, mics, cfg).map((a) => a.key);
  assert.deepEqual(keys.sort(), ['batt:rx.1', 'rf:rx.1']);
  // Assigned but only "assigned" (not picked up): weak RF isn't flagged during a service.
  const assigned = { people: [{ id: 'p', name: 'Ana' }], assignments: { 'rx.1': { personId: 'p', status: 'assigned' } } };
  assert.deepEqual(computeAlerts(state({ rfDbm: -90 }), assigned, mics, cfg).map((a) => a.key), []);
});
