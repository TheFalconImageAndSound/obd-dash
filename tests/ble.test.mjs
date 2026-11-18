// Web Bluetooth transport against mocked adapters with different GATT layouts.
// Run with:  npm test
import test from 'node:test';
import assert from 'node:assert/strict';

import { BleTransport } from '../js/ble.js';
import { Elm327 } from '../js/elm327.js';
import { SimTransport } from '../js/sim.js';

const u16 = (n) => `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;

class MockChar extends EventTarget {
  constructor(uuid, props, adapter) {
    super();
    this.uuid = uuid;
    this.properties = { read: false, write: false, writeWithoutResponse: false, notify: false, indicate: false, ...props };
    this.adapter = adapter;
    this.value = null;
  }
  async startNotifications() {
    this.notifying = true;
    return this;
  }
  async stopNotifications() {
    this.notifying = false;
    return this;
  }
  async writeValueWithResponse(data) {
    if (!this.properties.write) throw new Error('GATT write not permitted');
    this.adapter.onWrite(this, data, 'resp');
  }
  async writeValueWithoutResponse(data) {
    if (!this.properties.writeWithoutResponse) throw new Error('GATT write-without-response not permitted');
    this.adapter.onWrite(this, data, 'noresp');
  }
}

/**
 * Build a fake adapter. `layout` maps service UUID -> { charUuid: props }.
 * `tx`/`rx` say which characteristics really carry the serial data;
 * `modes` which write modes the firmware actually processes;
 * `events`: 'both' (char + bubbled to device as a separate event), 'device' (device only).
 */
function mockAdapter({ layout, tx, rx, modes = ['resp', 'noresp'], events = 'both', silent = false }) {
  const sim = new SimTransport({ fast: true });
  const device = new EventTarget();
  device.name = 'VEEPEAK';
  const chars = {};
  const adapter = {
    writes: [],
    onWrite(char, data, mode) {
      adapter.writes.push(`${char.uuid.slice(4, 8)}:${mode}`);
      if (silent || char.uuid !== tx || !modes.includes(mode)) return; // goes nowhere
      sim.write(new TextDecoder().decode(data));
    },
  };
  const services = Object.entries(layout).map(([svcUuid, cs]) => ({
    uuid: svcUuid,
    getCharacteristics: async () =>
      Object.entries(cs).map(([cu, props]) => (chars[cu] ??= new MockChar(cu, props, adapter))),
  }));
  sim.onData = (text) => {
    const char = chars[rx];
    if (!char?.notifying) return;
    const bytes = new TextEncoder().encode(text);
    char.value = new DataView(bytes.buffer);
    if (events !== 'device') char.dispatchEvent(new Event('characteristicvaluechanged'));
    const bubbled = new Event('characteristicvaluechanged');
    Object.defineProperty(bubbled, 'target', { value: char });
    device.dispatchEvent(bubbled);
  };
  device.gatt = {
    connected: false,
    async connect() {
      this.connected = true;
      return { getPrimaryServices: async () => services, getPrimaryService: async (u) => services.find((s) => s.uuid === u) };
    },
    disconnect() {
      this.connected = false;
      device.dispatchEvent(new Event('gattserverdisconnected'));
    },
  };
  return { bluetooth: { requestDevice: async () => device }, adapter, device };
}

async function connectAndInit(opts) {
  const { bluetooth, adapter } = mockAdapter(opts);
  const t = new BleTransport({ bluetooth });
  const logs = [];
  t.onLog = (l) => logs.push(l);
  await t.connect({ probeTimeout: 150 });
  const elm = new Elm327(t);
  const vehicleOk = await elm.initialize();
  return { t, elm, vehicleOk, adapter, logs };
}

async function assertWorks(r) {
  assert.equal(r.vehicleOk, true, 'vehicle should connect');
  assert.ok(r.elm.supported.has(0x0c));
  // Duplicate or dropped data would corrupt multi-frame replies like these:
  assert.deepEqual((await r.elm.readDtcs(0x03)).codes, ['P0301', 'P0420', 'P0442']);
  assert.equal(await r.elm.readVin(), 'DEMO0BD2SIM000001');
}

test('common layout: FFF0 with FFF1 notify / FFF2 write', async () => {
  const r = await connectAndInit({
    layout: { [u16(0xfff0)]: { [u16(0xfff1)]: { notify: true, read: true }, [u16(0xfff2)]: { write: true, writeWithoutResponse: true } } },
    tx: u16(0xfff2),
    rx: u16(0xfff1),
  });
  assert.match(r.t.channel, /FFF0\/FFF2 \(write\), reply FFF0\/FFF1/);
  await assertWorks(r);
});

test('firmware ignores write-with-response: falls back to write-without-response', async () => {
  const r = await connectAndInit({
    layout: { [u16(0xfff0)]: { [u16(0xfff1)]: { notify: true }, [u16(0xfff2)]: { write: true, writeWithoutResponse: true } } },
    tx: u16(0xfff2),
    rx: u16(0xfff1),
    modes: ['noresp'],
  });
  assert.equal(r.t.writeMode, 'noresp');
  await assertWorks(r);
});

test('TI-style layout where the first writable characteristic is a decoy', async () => {
  const r = await connectAndInit({
    layout: {
      [u16(0xfff0)]: {
        [u16(0xfff1)]: { read: true, write: true },
        [u16(0xfff2)]: { read: true },
        [u16(0xfff3)]: { write: true },
        [u16(0xfff4)]: { notify: true },
        [u16(0xfff5)]: { read: true },
      },
    },
    tx: u16(0xfff3),
    rx: u16(0xfff4),
  });
  assert.match(r.t.channel, /FFF3/);
  await assertWorks(r);
});

test('real channel lives in a second service', async () => {
  const r = await connectAndInit({
    layout: {
      [u16(0xffe0)]: { [u16(0xffe1)]: { notify: true, write: true, writeWithoutResponse: true } },
      'e7810a71-73ae-499d-8c15-faa9aef0c3f2': { 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f': { notify: true, write: true, writeWithoutResponse: true } },
    },
    tx: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f',
    rx: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f',
  });
  assert.match(r.t.channel, /BEF8D6C9/);
  await assertWorks(r);
});

test('browser only reports notifications on the device (no per-characteristic events)', async () => {
  const r = await connectAndInit({
    layout: { [u16(0xfff0)]: { [u16(0xfff1)]: { notify: true }, [u16(0xfff2)]: { writeWithoutResponse: true } } },
    tx: u16(0xfff2),
    rx: u16(0xfff1),
    events: 'device',
  });
  await assertWorks(r);
});

test('adapter that never answers gives a helpful error with the Bluetooth layout', async () => {
  const { bluetooth, device } = mockAdapter({
    layout: { [u16(0xfff0)]: { [u16(0xfff1)]: { notify: true }, [u16(0xfff2)]: { write: true } } },
    tx: u16(0xfff2),
    rx: u16(0xfff1),
    silent: true,
  });
  const t = new BleTransport({ bluetooth });
  await assert.rejects(t.connect({ probeTimeout: 100 }), (err) => {
    assert.match(err.message, /never answered/);
    assert.match(err.message, /FFF0: FFF1\[notify\] FFF2\[write\]/);
    return true;
  });
  assert.equal(device.gatt.connected, false, 'disconnects after failing');
});
