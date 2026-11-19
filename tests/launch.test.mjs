import test from 'node:test';
import assert from 'node:assert/strict';

import { LaunchTimer, launchTarget } from '../js/launch.js';

const MPH = 1.609344;
const target = launchTarget('us');

/** Feed speed samples (mph) at a fixed interval; returns the timer. */
function run(samplesMph, intervalMs = 100) {
  const t = new LaunchTimer();
  samplesMph.forEach((mph, i) => t.track(mph * MPH, i * intervalMs, target));
  return t;
}

test('times a clean 0–60 run', () => {
  // stopped for 1 s, then +1.2 mph per 100 ms -> reaches 60 mph after 5.0 s of motion
  const samples = [...Array(10).fill(0), ...Array.from({ length: 52 }, (_, i) => (i + 1) * 1.2)];
  const t = run(samples);
  assert.ok(t.last != null, 'run should complete');
  assert.ok(Math.abs(t.last - 5.0) < 0.1, `got ${t.last}`);
  assert.equal(t.best, t.last);
  assert.equal(t.running, false);
});

test('a gentle pull-away that never reaches 60 is abandoned after 30 s', () => {
  const samples = [0, 0, ...Array(400).fill(35)]; // 40 s at 35 mph
  const t = run(samples);
  assert.equal(t.last, null);
  assert.equal(t.running, false);
});

test('lifting off cancels the run', () => {
  const samples = [0, 0, 10, 20, 30, 40, 30, 50, 60];
  const t = run(samples);
  assert.equal(t.last, null);
});

test('best keeps the quickest of several runs; rolling starts are ignored', () => {
  const quick = [0, 0, ...Array.from({ length: 45 }, (_, i) => (i + 1) * 1.4)]; // ~4.3 s
  const slow = [0, 0, ...Array.from({ length: 70 }, (_, i) => (i + 1) * 0.9)]; // ~6.7 s
  const t = new LaunchTimer();
  let clock = 0;
  for (const mph of [...slow, ...quick, ...Array.from({ length: 40 }, (_, i) => 61 + i)]) {
    t.track(mph * MPH, (clock += 100), target);
  }
  assert.ok(t.best < 4.6 && t.best > 4.0, `best ${t.best}`);
  assert.ok(t.last < 4.6, 'last is the quick run; the rolling 61+ mph stretch is not a launch');
});
