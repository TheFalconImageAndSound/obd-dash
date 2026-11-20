import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeGearPid, forgetLearnedGears } from '../js/gear.js';
import { Elm327 } from '../js/elm327.js';
import { SimTransport } from '../js/sim.js';

test('decodes the car-reported gear (PID A4)', () => {
  assert.equal(decodeGearPid([0x02, 0x30, 0x0b, 0xb8]), 3);
  assert.equal(decodeGearPid([0x02, 0x00, 0x00, 0x00]), 0, 'neutral');
  assert.equal(decodeGearPid([0x00, 0x30, 0, 0]), null, 'reading not supported');
  assert.equal(decodeGearPid([0x02]), null, 'too short');
});

test('the demo car reports its gear through PID A4', async () => {
  const sim = new SimTransport({ fast: true });
  const elm = new Elm327(sim);
  assert.equal(await elm.initialize(), true);
  assert.ok(elm.supported.has(0xa4), 'A4 listed in the supported PIDs (via the 0x60/0x80/0xA0 ranges)');
  const gear = decodeGearPid(await elm.readPid(0xa4));
  assert.ok(Number.isInteger(gear) && gear >= 1 && gear <= 6, `gear ${gear}`);
});

test('old learned-gear data is cleared', () => {
  const m = new Map([
    ['obddash.gears.VIN1', '{}'],
    ['obddash.gears.demo', '{}'],
    ['obddash.settings.v1', '{}'],
  ]);
  const storage = {
    get length() {
      return m.size;
    },
    key: (i) => [...m.keys()][i],
    removeItem: (k) => m.delete(k),
  };
  forgetLearnedGears(storage);
  assert.deepEqual([...m.keys()], ['obddash.settings.v1']);
});
