// Web Bluetooth transport for BLE ELM327 adapters
// (Veepeak OBDCheck BLE / BLE+ and the common clone families).
//
// These adapters expose "serial over Bluetooth LE": a characteristic we write
// commands to, and a characteristic that notifies us with the text replies.
// Which characteristics (and which write mode) varies by adapter and isn't
// documented, so on connect we listen on every notify channel, send a harmless
// "ATI" on each write channel / write mode, and keep whichever one answers.

// Full 128-bit UUIDs (not 16-bit shorthands) so every Web Bluetooth
// implementation accepts them — including Bluefy on iPhone.
const uuid16 = (n) => `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;

const SERVICE_UUIDS = [
  uuid16(0xfff0), // Veepeak and many ELM327 BLE adapters
  uuid16(0xffe0), // HM-10 style adapters
  uuid16(0x18f0), // Vlink-style adapters
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2', // Vgate iCar Pro style
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART service
  uuid16(0xae30), // some ESP32-based clones
];

// Write characteristics that are the command channel on common adapters — tried first.
const PREFERRED_TX = [
  uuid16(0xfff2),
  uuid16(0xffe1),
  uuid16(0x2af1),
  'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f',
  '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
  uuid16(0xae01),
];

const NAME_PREFIXES = ['VEEPEAK', 'Veepeak', 'OBD', 'IOS-Vlink', 'V-LINK', 'vLinker', 'Android-Vlink'];
const CHUNK = 20; // safe BLE write size without MTU negotiation

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(test, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (test()) return true;
    await sleep(25);
  }
  return test();
}

const shortUuid = (uuid) => {
  const m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i.exec(uuid);
  return (m ? m[1] : uuid.slice(0, 8)).toUpperCase();
};
const propText = (p = {}) =>
  [['read', 'read'], ['write', 'write'], ['writeWithoutResponse', 'writeNR'], ['notify', 'notify'], ['indicate', 'indicate']]
    .filter(([k]) => p[k])
    .map(([, label]) => label)
    .join('+') || 'none';

export class BleTransport {
  constructor({ bluetooth } = {}) {
    this.bluetooth = bluetooth || (typeof navigator !== 'undefined' ? navigator.bluetooth : null);
    this.device = null;
    this.tx = null;
    this.writeMode = 'resp';
    this.layout = '';
    this.channel = '';
    this.onData = () => {};
    this.onDisconnect = () => {};
    this.onLog = () => {};
    this._subs = [];
    this._probe = null;
    this._accept = null;
    this._manual = false;
    this._decoder = new TextDecoder();
    this._encoder = new TextEncoder();
    this._handleGattDisconnect = this._handleGattDisconnect.bind(this);
  }

  static get supported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  static async available() {
    if (!BleTransport.supported) return false;
    try {
      return await navigator.bluetooth.getAvailability();
    } catch {
      return true;
    }
  }

  get name() {
    return this.device?.name || 'Bluetooth OBD adapter';
  }

  get canReconnect() {
    return !!this.device;
  }

  async connect({ showAll = false, onStatus = () => {}, probeTimeout = 1500 } = {}) {
    this.probeTimeout = probeTimeout;
    const options = showAll
      ? { acceptAllDevices: true, optionalServices: SERVICE_UUIDS }
      : {
          filters: [...NAME_PREFIXES.map((namePrefix) => ({ namePrefix })), ...SERVICE_UUIDS.map((uuid) => ({ services: [uuid] }))],
          optionalServices: SERVICE_UUIDS,
        };
    this.device = await this.bluetooth.requestDevice(options);
    this.device.addEventListener('gattserverdisconnected', this._handleGattDisconnect);
    try {
      await this._open(onStatus);
    } catch (err) {
      // Don't leave the adapter half-connected.
      this._manual = true;
      this._unsubscribeAll();
      this.device.removeEventListener('gattserverdisconnected', this._handleGattDisconnect);
      try {
        this.device.gatt.disconnect();
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  async reconnect() {
    if (!this.device) throw new Error('No adapter to reconnect to');
    await this._open(() => {});
  }

  async _open(onStatus) {
    this._manual = false;
    this._unsubscribeAll();
    onStatus('Connecting to the adapter…');
    const server = await this.device.gatt.connect();

    onStatus('Reading the adapter’s Bluetooth services…');
    const chars = await listCharacteristics(server);
    this.layout = summarize(chars);
    this.onLog(`Bluetooth layout: ${this.layout}`);

    const notifiers = chars.filter((c) => c.props.notify || c.props.indicate);
    const writers = rankWriters(
      chars.filter((c) => c.props.write || c.props.writeWithoutResponse),
      notifiers
    );
    if (!notifiers.length || !writers.length) {
      throw new Error(
        `Connected, but this device doesn’t look like an OBD adapter. Make sure you picked your Veepeak (it usually shows as “VEEPEAK”).\n\nBluetooth layout: ${this.layout}`
      );
    }

    // Listen on every notify channel, and on the device itself (where these events also bubble).
    for (const n of notifiers) {
      const handler = (e) => this._receive(e, n, 'char');
      n.char.addEventListener('characteristicvaluechanged', handler);
      this._subs.push({ target: n.char, handler, entry: n });
      try {
        await n.char.startNotifications();
      } catch (err) {
        this.onLog(`Couldn’t subscribe to ${n.label}: ${err.message}`);
      }
    }
    const deviceHandler = (e) => this._receive(e, null, 'device');
    this.device.addEventListener('characteristicvaluechanged', deviceHandler);
    this._subs.push({ target: this.device, handler: deviceHandler, entry: null });
    await sleep(Math.min(250, this.probeTimeout));

    onStatus('Finding the adapter’s data channel…');
    const found = await this._findChannel(writers, notifiers);
    if (!found) {
      throw new Error(
        'The adapter connected over Bluetooth but never answered. Unplug it for 10 seconds, make sure no other OBD app is connected to it, then try again.' +
          `\n\nBluetooth layout (screenshot this if it keeps happening):\n${this.layout}`
      );
    }
    this.tx = found.writer.char;
    this.writeMode = found.mode;
    this._accept = { path: found.path, uuid: found.uuid };
    this.channel = `send ${found.writer.label} (${found.mode === 'resp' ? 'write' : 'write-no-response'}), reply ${found.rxLabel}`;
    this.onLog(`Using ${this.channel}`);
  }

  /** Try each write channel and write mode until the adapter answers "ATI". */
  async _findChannel(writers, notifiers) {
    const attempts = [];
    for (const writer of writers) {
      if (writer.props.write) attempts.push({ writer, mode: 'resp' });
      if (writer.props.writeWithoutResponse) attempts.push({ writer, mode: 'noresp' });
    }
    const answered = (p) => /ELM|OK|>|\?/i.test(p.text);

    const tryOnce = async (attempt) => {
      this._probe = { text: '', hits: [] };
      try {
        await this._writeRaw(attempt.writer.char, attempt.mode, 'ATI\r');
      } catch (err) {
        this._probe = null;
        this.onLog(`${attempt.writer.label} ${attempt.mode}: ${err.message}`);
        return null;
      }
      const ok = await waitUntil(() => answered(this._probe), this.probeTimeout);
      if (ok) await waitUntil(() => this._probe.text.includes('>'), 400); // let the prompt arrive
      const probe = this._probe;
      this._probe = null;
      return ok ? probe : probe.text ? { stray: probe.text } : null;
    };

    for (let pass = 0; pass < 2; pass++) {
      for (const attempt of attempts) {
        const probe = await tryOnce(attempt);
        if (!probe) continue;
        if (probe.stray) {
          this.onLog(`Unexpected data after writing to ${attempt.writer.label}: ${JSON.stringify(probe.stray)}`);
          continue;
        }
        // A slow reply to an earlier attempt could land here — confirm with a second ATI.
        await sleep(100);
        const confirm = await tryOnce(attempt);
        if (!confirm || confirm.stray) continue;
        const hit = confirm.hits.find((h) => h.path === 'char') || confirm.hits[0];
        const rx = notifiers.find((n) => n.uuid === hit.uuid);
        this.onLog(`Adapter answered: ${confirm.text.replace(/\s+/g, ' ').trim()}`);
        return { ...attempt, path: hit.path, uuid: hit.uuid, rxLabel: rx?.label || shortUuid(hit.uuid || '?') };
      }
    }
    return null;
  }

  _receive(event, entry, path) {
    const target = path === 'char' ? entry.char : event.target;
    const value = event.target?.value ?? target?.value;
    if (!value) return;
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const uuid = String(entry?.uuid || target?.uuid || '').toLowerCase();
    const text = this._decoder.decode(bytes);

    if (this._probe) {
      // While probing, events usually arrive twice (characteristic, then bubbled to the device): record, don't double.
      if (path === 'char') {
        this._probe.text += text;
        this._probe.hits.push({ path, uuid });
      } else if (!this._probe.hits.some((h) => h.path === 'char')) {
        this._probe.text += text;
        this._probe.hits.push({ path, uuid });
      }
      return;
    }
    const a = this._accept;
    if (!a || path !== a.path || (a.uuid && uuid && uuid !== a.uuid)) return;
    this.onData(text);
  }

  async _writeRaw(char, mode, text) {
    const bytes = this._encoder.encode(text);
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const chunk = bytes.slice(i, i + CHUNK);
      if (mode === 'noresp') {
        if (!char.writeValueWithoutResponse) throw new Error('write-without-response isn’t available');
        await char.writeValueWithoutResponse(chunk);
      } else if (char.writeValueWithResponse) {
        await char.writeValueWithResponse(chunk);
      } else {
        await char.writeValue(chunk);
      }
    }
  }

  async write(text) {
    if (!this.tx || this.device?.gatt?.connected === false) throw new Error('Adapter is not connected');
    await this._writeRaw(this.tx, this.writeMode, text);
  }

  _unsubscribeAll() {
    for (const s of this._subs) {
      s.target.removeEventListener('characteristicvaluechanged', s.handler);
      if (s.entry && this.device?.gatt?.connected) s.entry.char.stopNotifications?.().catch(() => {});
    }
    this._subs = [];
    this._accept = null;
  }

  async disconnect() {
    this._manual = true;
    this._unsubscribeAll();
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    else this.onDisconnect({ manual: true });
  }

  _handleGattDisconnect() {
    for (const s of this._subs) s.target.removeEventListener('characteristicvaluechanged', s.handler);
    this._subs = [];
    this._accept = null;
    this.onDisconnect({ manual: this._manual });
  }
}

async function listCharacteristics(server) {
  let services = [];
  try {
    services = (await server.getPrimaryServices()) || [];
  } catch {
    services = [];
  }
  if (!services.length) {
    // Some implementations can't list services; ask for each known one instead.
    for (const uuid of SERVICE_UUIDS) {
      try {
        services.push(await server.getPrimaryService(uuid));
      } catch {
        /* not on this device */
      }
    }
  }
  const out = [];
  for (const service of services) {
    let chars = [];
    try {
      chars = await service.getCharacteristics();
    } catch {
      continue;
    }
    for (const char of chars) {
      out.push({
        service: String(service.uuid).toLowerCase(),
        uuid: String(char.uuid).toLowerCase(),
        char,
        props: char.properties || {},
        label: `${shortUuid(service.uuid)}/${shortUuid(char.uuid)}`,
      });
    }
  }
  return out;
}

function rankWriters(writers, notifiers) {
  const score = (w) => {
    const i = PREFERRED_TX.indexOf(w.uuid);
    return (i >= 0 ? i : 50) + (notifiers.some((n) => n.service === w.service) ? 0 : 100);
  };
  return writers.map((w, i) => ({ w, i })).sort((a, b) => score(a.w) - score(b.w) || a.i - b.i).map(({ w }) => w);
}

function summarize(chars) {
  if (!chars.length) return '(no readable services)';
  const byService = new Map();
  for (const c of chars) {
    if (!byService.has(c.service)) byService.set(c.service, []);
    byService.get(c.service).push(`${shortUuid(c.uuid)}[${propText(c.props)}]`);
  }
  return [...byService].map(([svc, list]) => `${shortUuid(svc)}: ${list.join(' ')}`).join('; ');
}
