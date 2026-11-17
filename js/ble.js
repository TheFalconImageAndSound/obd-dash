// Web Bluetooth transport for BLE ELM327 adapters
// (Veepeak OBDCheck BLE / BLE+ and the common clone families).
//
// The adapter exposes a "serial over BLE" service: one characteristic we write
// commands to, and one that notifies us with the adapter's text replies.

// Full 128-bit UUIDs (rather than 16-bit shorthands) so every Web Bluetooth
// implementation accepts them — including Bluefy on iPhone.
const uuid16 = (n) => `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
const SERVICE_UUIDS = [
  uuid16(0xfff0), // Veepeak OBDCheck BLE / BLE+ and many ELM327 BLE adapters (FFF1 notify, FFF2 write)
  uuid16(0xffe0), // HM-10 style adapters (FFE1 notify + write)
  uuid16(0x18f0), // Vlink-style adapters (2AF0 notify, 2AF1 write)
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2', // Vgate iCar Pro BLE
];

const NAME_PREFIXES = ['VEEPEAK', 'Veepeak', 'OBD', 'IOS-Vlink', 'V-LINK', 'vLinker', 'Android-Vlink'];

const CHUNK = 20; // safe BLE write size without MTU negotiation

export class BleTransport {
  constructor() {
    this.device = null;
    this.rx = null;
    this.tx = null;
    this.onData = () => {};
    this.onDisconnect = () => {};
    this._manual = false;
    this._decoder = new TextDecoder();
    this._encoder = new TextEncoder();
    this._handleNotify = this._handleNotify.bind(this);
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

  async connect({ showAll = false } = {}) {
    const options = showAll
      ? { acceptAllDevices: true, optionalServices: SERVICE_UUIDS }
      : {
          filters: [
            ...NAME_PREFIXES.map((namePrefix) => ({ namePrefix })),
            ...SERVICE_UUIDS.map((uuid) => ({ services: [uuid] })),
          ],
          optionalServices: SERVICE_UUIDS,
        };
    this.device = await navigator.bluetooth.requestDevice(options);
    this.device.addEventListener('gattserverdisconnected', this._handleGattDisconnect);
    await this._open();
  }

  async reconnect() {
    if (!this.device) throw new Error('No adapter to reconnect to');
    await this._open();
  }

  async _open() {
    this._manual = false;
    const server = await this.device.gatt.connect();
    const { rx, tx } = await findSerialCharacteristics(server);
    this.rx = rx;
    this.tx = tx;
    rx.addEventListener('characteristicvaluechanged', this._handleNotify);
    await rx.startNotifications();
  }

  async write(text) {
    if (!this.tx || !this.device?.gatt?.connected) throw new Error('Adapter is not connected');
    const bytes = this._encoder.encode(text);
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const chunk = bytes.slice(i, i + CHUNK);
      if (this.tx.properties.writeWithoutResponse && this.tx.writeValueWithoutResponse) {
        await this.tx.writeValueWithoutResponse(chunk);
      } else if (this.tx.writeValueWithResponse) {
        await this.tx.writeValueWithResponse(chunk);
      } else {
        await this.tx.writeValue(chunk);
      }
    }
  }

  async disconnect() {
    this._manual = true;
    try {
      this.rx?.removeEventListener('characteristicvaluechanged', this._handleNotify);
      if (this.device?.gatt?.connected) await this.rx?.stopNotifications();
    } catch {
      /* already gone */
    }
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    else this.onDisconnect({ manual: true });
  }

  _handleNotify(event) {
    const v = event.target.value;
    this.onData(this._decoder.decode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)));
  }

  _handleGattDisconnect() {
    this.rx?.removeEventListener('characteristicvaluechanged', this._handleNotify);
    this.onDisconnect({ manual: this._manual });
  }
}

async function findSerialCharacteristics(server) {
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

  for (const service of services) {
    let chars;
    try {
      chars = await service.getCharacteristics();
    } catch {
      continue;
    }
    const rx = chars.find((c) => c.properties.notify || c.properties.indicate);
    const tx =
      chars.find((c) => c !== rx && (c.properties.write || c.properties.writeWithoutResponse)) ||
      chars.find((c) => c.properties.write || c.properties.writeWithoutResponse);
    if (rx && tx) return { rx, tx };
  }
  throw new Error(
    "Connected, but this device doesn't look like an OBD adapter. Make sure you picked your Veepeak (it usually shows as “VEEPEAK”)."
  );
}
