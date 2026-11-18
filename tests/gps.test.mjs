import test from 'node:test';
import assert from 'node:assert/strict';

import { GpsSpeed, haversineMeters } from '../js/gps.js';

function fakeGeo() {
  const geo = {
    ok: null,
    err: null,
    cleared: false,
    watchPosition(ok, err) {
      geo.ok = ok;
      geo.err = err;
      return 7;
    },
    clearWatch(id) {
      geo.cleared = id === 7;
    },
  };
  return geo;
}

// Positions about 10 m apart (north) at 1 s intervals ≈ 36 km/h.
const METERS_PER_DEG_LAT = 111195;
const fix = (t, metersNorth, extra = {}) => ({
  timestamp: t,
  coords: { latitude: 30 + metersNorth / METERS_PER_DEG_LAT, longitude: -90, accuracy: 5, speed: null, ...extra },
});

test('haversine distance', () => {
  const d = haversineMeters({ latitude: 30, longitude: -90 }, { latitude: 30 + 100 / METERS_PER_DEG_LAT, longitude: -90 });
  assert.ok(Math.abs(d - 100) < 0.5, `got ${d}`);
});

test('uses the speed the phone reports (m/s -> km/h)', () => {
  let clock = 1000;
  const geo = fakeGeo();
  const g = new GpsSpeed({ geolocation: geo, now: () => clock });
  g.start();
  assert.equal(g.status, 'waiting');
  assert.equal(g.speed, null);
  geo.ok(fix(clock, 0, { speed: 25 }));
  assert.equal(g.status, 'ok');
  assert.ok(Math.abs(g.speed - 90) < 1e-9);
});

test('computes speed from positions when the phone reports none', () => {
  let clock = 1000;
  const geo = fakeGeo();
  const g = new GpsSpeed({ geolocation: geo, now: () => clock });
  g.start();
  geo.ok(fix(1000, 0));
  assert.equal(g.speed, null, 'one fix is not enough');
  clock = 2000;
  geo.ok(fix(2000, 10));
  assert.ok(Math.abs(g.speed - 36) < 0.5, `got ${g.speed}`);
});

test('ignores vague fixes for distance-based speed, and treats jitter as stopped', () => {
  let clock = 1000;
  const geo = fakeGeo();
  const g = new GpsSpeed({ geolocation: geo, now: () => clock });
  g.start();
  geo.ok(fix(1000, 0));
  clock = 2000;
  geo.ok(fix(2000, 400, { accuracy: 120 })); // wild, inaccurate jump
  assert.equal(g.speed, null);
  clock = 3000;
  geo.ok(fix(3000, 0.3)); // 30 cm in 2 s while parked
  assert.equal(g.speed, 0);
});

test('negative speed from the phone means "unknown"', () => {
  const geo = fakeGeo();
  const g = new GpsSpeed({ geolocation: geo, now: () => 1000 });
  g.start();
  geo.ok(fix(1000, 0, { speed: -1 }));
  assert.equal(g.speed, null);
  assert.equal(g.status, 'waiting');
});

test('speed goes blank when fixes stop arriving', () => {
  let clock = 1000;
  const geo = fakeGeo();
  const g = new GpsSpeed({ geolocation: geo, now: () => clock, staleMs: 8000 });
  g.start();
  geo.ok(fix(clock, 0, { speed: 10 }));
  clock += 7000;
  assert.ok(g.speed > 0);
  clock += 2000;
  assert.equal(g.speed, null);
});

test('permission denied stops the watch and reports it', () => {
  const geo = fakeGeo();
  const seen = [];
  const g = new GpsSpeed({ geolocation: geo, onUpdate: (s) => seen.push(s.status) });
  g.start();
  geo.err({ code: 1, message: 'denied' });
  assert.equal(g.status, 'denied');
  assert.equal(geo.cleared, true);
  assert.equal(g.active, false);
  assert.match(g.message, /Location access is off/);
  assert.deepEqual(seen, ['waiting', 'off', 'denied']);
});

test('no geolocation support', () => {
  const g = new GpsSpeed({ geolocation: null });
  g.start();
  assert.equal(g.status, 'unsupported');
  assert.equal(g.active, false);
});
