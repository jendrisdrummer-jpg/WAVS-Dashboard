import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, splitMessages } from '../server/drivers/shure.js';
import { parseVmix } from '../server/drivers/switchers.js';
import { computeAlerts } from '../server/alerts.js';

test('splits a stream into complete messages and keeps the partial tail', () => {
  const { messages, rest } = splitMessages('< REP 1 BATT_BARS 004 >< REP 2 CHAN_NAME {Pastor  } >< REP 3 FREQ');
  assert.deepEqual(messages, [' REP 1 BATT_BARS 004 ', ' REP 2 CHAN_NAME {Pastor  } ']);
  assert.equal(rest, '< REP 3 FREQ');
});

test('parses channel reports', () => {
  assert.deepEqual(parseMessage('REP 2 CHAN_NAME {Pastor John   }'), { kind: 'channel', channel: 2, data: { chanName: 'Pastor John' } });
  assert.deepEqual(parseMessage('REP 1 FREQUENCY 0578350').data, { freqMHz: 578.35 });
  assert.deepEqual(parseMessage('REP 1 BATT_BARS 003').data, { battBars: 3 });
  assert.deepEqual(parseMessage('REP 1 BATT_BARS 255').data, { battBars: null });
  assert.deepEqual(parseMessage('REP 1 BATT_RUN_TIME 65535').data, { battMinutes: null });
  assert.deepEqual(parseMessage('REP 1 BATT_RUN_TIME 00125').data, { battMinutes: 125 });
  assert.deepEqual(parseMessage('REP 4 TX_TYPE UNKN').data, { txType: null });
  assert.deepEqual(parseMessage('REP 4 TX_TYPE ULXD2').data, { txType: 'ULXD2' });
  assert.deepEqual(parseMessage('REP 1 TX_MUTE_STATUS ON').data, { txMuted: true });
  assert.equal(parseMessage('REP 1 SOMETHING_NEW 12'), null);
});

test('parses device reports', () => {
  assert.deepEqual(parseMessage('REP MODEL {ULXD4Q                          }'), { kind: 'device', data: { model: 'ULXD4Q' } });
});

test('parses meter samples', () => {
  assert.deepEqual(parseMessage('SAMPLE 3 ALL XB 090 035'), { kind: 'meter', channel: 3, data: { antenna: 'XB', rfDbm: -38, audioDbfs: -15 } });
});

test('parses vMix XML tally', () => {
  const xml = '<vmix><version>27.0</version><inputs><input key="a" number="1" title="Wide &amp; Stage">W</input><input key="b" number="2" title="Pastor">P</input></inputs><active>2</active><preview>1</preview><fadeToBlack>False</fadeToBlack><recording>True</recording><streaming>False</streaming></vmix>';
  const s = parseVmix(xml);
  assert.equal(s.program.name, 'Pastor');
  assert.equal(s.preview.name, 'Wide & Stage');
  assert.equal(s.recording, true);
  assert.equal(s.streaming, false);
});

test('alerts: on-stage mic with transmitter off is critical; low battery flagged', () => {
  const cfg = { alerts: { batteryBars: 1, batteryMinutes: 30, rfLowDbm: -90 } };
  const slots = [{ id: 'rx.1', label: 'HH 1' }, { id: 'rx.2', label: 'HH 2' }];
  const state = {
    receivers: { rx: { id: 'rx', name: 'RX', online: true } },
    propresenter: {}, switchers: {},
    mics: {
      'rx.1': { online: true, txType: null, rfDbm: -128 },
      'rx.2': { online: true, txType: 'ULXD2', rfDbm: -50, battBars: 1 },
    },
  };
  const greenroom = { people: [{ id: 'p1', name: 'Sam' }], assignments: { 'rx.1': { personId: 'p1', status: 'on-stage' } } };
  const alerts = computeAlerts(state, greenroom, slots, cfg);
  assert.equal(alerts[0].level, 'critical');
  assert.match(alerts[0].text, /Sam \(HH 1\): transmitter off/);
  assert.ok(alerts.some((a) => a.key === 'batt:rx.2' && a.level === 'warning'));
});
