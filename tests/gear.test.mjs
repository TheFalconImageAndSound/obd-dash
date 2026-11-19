import test from 'node:test';
import assert from 'node:assert/strict';

import { GearEstimator, decodeGearPid } from '../js/gear.js';

// rpm per km/h for a 6-speed (1st..6th)
const RATIOS = [118, 70, 48, 36, 29, 24];

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

/** Drive through every gear: steady stretches with noise and whole-km/h speeds, plus messy shifts. */
function drive(est, { gears = RATIOS, seconds = 4, seed = 1 } = {}) {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  for (let g = 0; g < gears.length; g++) {
    const startKmh = 18 + g * 22;
    for (let i = 0; i < seconds * 10; i++) {
      const kmh = Math.round(startKmh + i * 0.4);
      const rpm = kmh * gears[g] * (1 + rand() * 0.01);
      est.sample(rpm, kmh);
    }
    // the shift: clutch in, revs drop, wildly different ratios for a moment
    for (let i = 0; i < 6; i++) est.sample(900 + rand() * 2000, startKmh + 15);
  }
}

test('learns six gears and numbers them from the highest ratio', () => {
  const est = new GearEstimator();
  drive(est);
  assert.equal(est.learned, 6);
  RATIOS.forEach((r, i) => assert.equal(est.gearFor(60 * r, 60), i + 1, `gear ${i + 1}`));
});

test('returns null when stopped, mid-shift or between ratios', () => {
  const est = new GearEstimator();
  drive(est);
  assert.equal(est.gearFor(800, 0), null);
  assert.equal(est.gearFor(800, 2), null);
  assert.equal(est.gearFor(60 * 58, 60), null, 'halfway between 2nd and 3rd is no gear');
});

test('tolerates coarse whole-km/h speed at low speed', () => {
  const est = new GearEstimator();
  drive(est);
  // 1st gear at ~7.4 km/h reported as 7: 9% ratio error, still 1st
  assert.equal(est.gearFor(7.4 * 118, 7), 1);
});

test('nothing is learned from unsteady readings', () => {
  const est = new GearEstimator();
  for (let i = 0; i < 300; i++) est.sample(1000 + (i % 2) * 1500, 40); // flapping between two ratios every reading
  assert.equal(est.learned, 0);
});

test('gear count setting drops a spurious ratio', () => {
  const est = new GearEstimator();
  drive(est, { seconds: 6 });
  // a short, steady stretch of torque-converter slip creates a weak extra ratio
  for (let i = 0; i < 20; i++) est.sample(40 * 150, 40);
  assert.equal(est.learned, 7);
  assert.equal(est.gearFor(60 * 70, 60, 6), 2, 'with 6 gears set, 2nd is still 2nd');
  assert.equal(est.gearFor(60 * 70, 60), 3, 'auto mode counts the spurious ratio');
});

test('saves and reloads per car; relearn clears it', () => {
  let clock = 0;
  const storage = memoryStorage();
  const a = new GearEstimator({ storage, now: () => (clock += 1000) });
  a.load('VIN123');
  drive(a);
  a.save(true);
  const b = new GearEstimator({ storage });
  b.load('VIN123');
  assert.equal(b.learned, 6);
  assert.equal(b.gearFor(80 * 36, 80), 4);
  b.load('OTHERCAR');
  assert.equal(b.learned, 0, 'a different car starts fresh');
  b.load('VIN123');
  b.reset();
  const c = new GearEstimator({ storage });
  c.load('VIN123');
  assert.equal(c.learned, 0);
});

test('decodes the car-reported gear (PID A4)', () => {
  assert.equal(decodeGearPid([0x02, 0x30, 0x0b, 0xb8]), 3);
  assert.equal(decodeGearPid([0x02, 0x00, 0x00, 0x00]), 0);
  assert.equal(decodeGearPid([0x00, 0x30, 0, 0]), null, 'not supported flag');
});
