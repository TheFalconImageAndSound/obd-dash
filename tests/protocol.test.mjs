// Run with:  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

import { Elm327, parseMessages, cleanLines, ElmError } from '../js/elm327.js';
import { decodeDtc, decodeDtcMessages, decodeMonitorStatus, describeDtc } from '../js/dtc.js';
import { SIGNAL_BY_KEY, toDisplay, formatValue, barGeometry } from '../js/pids.js';
import { SimTransport } from '../js/sim.js';

test('cleanLines drops echo, SEARCHING and blank lines', () => {
  assert.deepEqual(cleanLines('0100\rSEARCHING...\r41 00 BE 3F A8 13\r\r', '0100'), ['41 00 BE 3F A8 13']);
  assert.deepEqual(cleanLines('BUS INIT: ...OK\r41 0C 1A F8\r'), ['41 0C 1A F8']);
});

test('parseMessages: single frames from two ECUs', () => {
  assert.deepEqual(parseMessages(['4301013301', '4300']), [
    [0x43, 0x01, 0x01, 0x33, 0x01],
    [0x43, 0x00],
  ]);
});

test('parseMessages: CAN multi-frame is reassembled and padding trimmed', () => {
  const msgs = parseMessages(['008', '0: 43 03 03 01 04 20', '1: 04 42 00 00 00 00 00']);
  assert.deepEqual(msgs, [[0x43, 0x03, 0x03, 0x01, 0x04, 0x20, 0x04, 0x42]]);
});

test('parseMessages: errors become ElmError', () => {
  assert.throws(() => parseMessages(['NO DATA']), (e) => e instanceof ElmError && e.code === 'NO DATA');
  assert.throws(() => parseMessages(['UNABLE TO CONNECT']), (e) => e.code === 'UNABLE TO CONNECT');
  assert.throws(() => parseMessages(['BUS INIT: ...ERROR']), (e) => e.code === 'BUS INIT ERROR');
  assert.throws(() => parseMessages(['?']), (e) => e.code === '?');
});

test('decodeDtc covers all four systems', () => {
  assert.equal(decodeDtc(0x01, 0x33), 'P0133');
  assert.equal(decodeDtc(0x03, 0x01), 'P0301');
  assert.equal(decodeDtc(0x42, 0x01), 'C0201');
  assert.equal(decodeDtc(0x9a, 0xbc), 'B1ABC');
  assert.equal(decodeDtc(0xc1, 0x00), 'U0100');
});

test('decodeDtcMessages: CAN uses the count byte', () => {
  const r = decodeDtcMessages([[0x43, 0x02, 0x03, 0x01, 0x04, 0x20, 0xaa, 0xaa], [0x43, 0x00]], 0x03, true);
  assert.deepEqual(r.codes, ['P0301', 'P0420']);
  assert.equal(r.responded, true);
});

test('decodeDtcMessages: legacy protocols skip 0000 padding', () => {
  const r = decodeDtcMessages([[0x43, 0x01, 0x33, 0x00, 0x00, 0x00, 0x00]], 0x03, false);
  assert.deepEqual(r.codes, ['P0133']);
});

test('decodeDtcMessages: negative response is reported', () => {
  const r = decodeDtcMessages([[0x7f, 0x0a, 0x11]], 0x0a, true);
  assert.deepEqual(r.codes, []);
  assert.equal(r.negative, 0x11);
});

test('decodeMonitorStatus: MIL, count and incomplete monitors', () => {
  const s = decodeMonitorStatus([0x83, 0x07, 0xe5, 0x04]);
  assert.equal(s.mil, true);
  assert.equal(s.dtcCount, 3);
  assert.equal(s.diesel, false);
  const evap = s.monitors.find((m) => m.name.startsWith('Evaporative'));
  assert.equal(evap.complete, false);
  assert.equal(s.monitors.find((m) => m.name === 'Catalyst').complete, true);
  assert.equal(s.monitors.length, 3 + 5);
});

test('describeDtc: known, manufacturer and fallback', () => {
  assert.match(describeDtc('P0420').text, /Catalyst System Efficiency/);
  assert.equal(describeDtc('P1234').manufacturer, true);
  assert.equal(describeDtc('P3400').manufacturer, false);
  assert.equal(describeDtc('P3399').manufacturer, true);
  assert.match(describeDtc('P0304').text, /Cylinder 4 Misfire/);
  assert.ok(describeDtc('P0304').hint);
});

test('PID decoders and unit conversion', () => {
  const rpm = SIGNAL_BY_KEY.rpm;
  assert.equal(rpm.decode([0x1a, 0xf8]), 1726);
  const coolant = SIGNAL_BY_KEY.coolant;
  assert.equal(coolant.decode([0x7b]), 83);
  assert.equal(formatValue(coolant, toDisplay(coolant, 90, 'us'), 'us'), '194');
  const speed = SIGNAL_BY_KEY.speed;
  assert.equal(formatValue(speed, toDisplay(speed, 100, 'us'), 'us'), '62');
  const boost = SIGNAL_BY_KEY.boost;
  assert.equal(boost.derive({ map: 170, baro: 100 }), 70);
  const g = barGeometry(SIGNAL_BY_KEY.stft1, -5, 'us');
  assert.ok(g.left < 0.5 && Math.abs(g.left + g.width - 0.5) < 1e-9);
});

// --- End-to-end against the simulated adapter ------------------------------------

async function connectSim() {
  const sim = new SimTransport({ fast: true });
  await sim.connect();
  const elm = new Elm327(sim);
  const ok = await elm.initialize();
  return { sim, elm, ok };
}

test('sim: initialize detects CAN protocol, supported PIDs and count hint', async () => {
  const { elm, ok } = await connectSim();
  assert.equal(ok, true);
  assert.equal(elm.protocol, '6');
  assert.equal(elm.isCan, true);
  assert.equal(elm.useCountHint, true);
  for (const pid of [0x0c, 0x0d, 0x05, 0x42, 0x5c]) assert.ok(elm.supported.has(pid), `PID ${pid.toString(16)}`);
  assert.ok(!elm.supported.has(0x5e));
  assert.equal(elm.info.version, 'ELM327 v1.5');
});

test('sim: live PID reads and voltage', async () => {
  const { elm } = await connectSim();
  const rpm = SIGNAL_BY_KEY.rpm.decode(await elm.readPid(0x0c));
  assert.ok(rpm > 500 && rpm < 8000, `rpm ${rpm}`);
  const v = await elm.readVoltage();
  assert.ok(v > 13 && v < 15);
  await assert.rejects(elm.readPid(0x5e), (e) => e.code === 'NO DATA');
});

test('sim: read codes, freeze frame, VIN, then clear', async () => {
  const { elm } = await connectSim();
  const stored = await elm.readDtcs(0x03);
  assert.deepEqual(stored.codes, ['P0301', 'P0420', 'P0442']);
  assert.deepEqual((await elm.readDtcs(0x07)).codes, ['P0171']);
  assert.deepEqual((await elm.readDtcs(0x0a)).codes, ['P0420']);

  const status = await elm.readMonitorStatus();
  assert.equal(status.mil, true);
  assert.equal(status.dtcCount, 3);

  const ff = await elm.readFreezeFrame([0x0c, 0x05, 0x5e]);
  assert.equal(ff.dtc, 'P0301');
  assert.equal(SIGNAL_BY_KEY.rpm.decode(ff.values.get(0x0c)), 2450);
  assert.ok(!ff.values.has(0x5e));

  assert.equal(await elm.readVin(), 'DEMO0BD2SIM000001');

  assert.deepEqual(await elm.clearDtcs(), { ok: true });
  assert.deepEqual((await elm.readDtcs(0x03)).codes, []);
  const after = await elm.readMonitorStatus();
  assert.equal(after.mil, false);
  assert.ok(after.monitors.some((m) => !m.complete), 'monitors reset after clearing');
  assert.equal(await elm.readFreezeFrame([0x0c]), null);
});

test('sim: works with spaces on and echo on (no ATS0/ATE0)', async () => {
  const sim = new SimTransport({ fast: true });
  const elm = new Elm327(sim);
  const lines = await elm.send('0100');
  assert.deepEqual(parseMessages(lines)[0].slice(0, 2), [0x41, 0x00]);
  elm.isCan = true;
  assert.deepEqual((await elm.readDtcs(0x03)).codes, ['P0301', 'P0420', 'P0442']);
});
