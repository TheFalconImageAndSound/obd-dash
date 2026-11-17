// ELM327 protocol driver: a serialized command queue, response parsing,
// and helpers for the OBD-II services the app uses.
//
// Works with any transport that has `write(text)` and calls `onData(text)`.

import { decodeDtc, decodeDtcMessages, decodeMonitorStatus } from './dtc.js';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');

export const PROTOCOLS = {
  0: 'Automatic',
  1: 'SAE J1850 PWM',
  2: 'SAE J1850 VPW',
  3: 'ISO 9141-2',
  4: 'ISO 14230-4 KWP (5-baud init)',
  5: 'ISO 14230-4 KWP (fast init)',
  6: 'ISO 15765-4 CAN (11-bit, 500 kbps)',
  7: 'ISO 15765-4 CAN (29-bit, 500 kbps)',
  8: 'ISO 15765-4 CAN (11-bit, 250 kbps)',
  9: 'ISO 15765-4 CAN (29-bit, 250 kbps)',
  A: 'SAE J1939 CAN',
  B: 'User CAN 1',
  C: 'User CAN 2',
};

const FRIENDLY = {
  'NO DATA': 'The car didn’t answer that request (it may not support it).',
  'UNABLE TO CONNECT': 'The adapter can’t reach the car’s computer. Turn the ignition ON (or start the engine) and try again.',
  'BUS INIT ERROR': 'The adapter couldn’t start talking to the car. Turn the ignition ON and try again.',
  'CAN ERROR': 'CAN bus error. Make sure the adapter is pushed all the way into the OBD port and the ignition is ON.',
  'BUS ERROR': 'Vehicle bus error. Check the adapter is seated firmly.',
  'BUS BUSY': 'The vehicle bus is busy. Try again.',
  'BUFFER FULL': 'The adapter’s buffer overflowed.',
  'FB ERROR': 'Adapter feedback error.',
  'DATA ERROR': 'The car sent a garbled reply.',
  'RX ERROR': 'The adapter received a corrupted reply.',
  'LV RESET': 'The adapter reset because of low voltage.',
  'ACT ALERT': 'The adapter went to sleep.',
  STOPPED: 'The request was interrupted.',
  ERROR: 'The adapter reported an error.',
  '?': 'The adapter didn’t understand that command.',
  TIMEOUT: 'The adapter didn’t answer in time.',
  DISCONNECTED: 'The adapter disconnected.',
};

const ERROR_CODES = [
  'BUS INIT ERROR',
  'UNABLE TO CONNECT',
  'NO DATA',
  'CAN ERROR',
  'BUS ERROR',
  'BUS BUSY',
  'BUFFER FULL',
  'FB ERROR',
  'DATA ERROR',
  'RX ERROR',
  'LV RESET',
  'ACT ALERT',
  'STOPPED',
  'ERROR',
];

export class ElmError extends Error {
  constructor(code, detail = '') {
    super(FRIENDLY[code] || code);
    this.name = 'ElmError';
    this.code = code;
    this.detail = detail;
  }
}

/** Negative response codes the car may send back (service 7F xx NRC). */
export function nrcText(nrc) {
  switch (nrc) {
    case 0x11:
      return 'The car doesn’t support this request.';
    case 0x12:
      return 'The car doesn’t support this sub-request.';
    case 0x21:
      return 'The car is busy — try again.';
    case 0x22:
      return 'The car refused right now. Turn the engine OFF but leave the ignition ON, then try again.';
    case 0x31:
      return 'Request out of range.';
    case 0x78:
      return 'The car is still working on it.';
    default:
      return `The car refused the request (code ${hex2(nrc ?? 0)}).`;
  }
}

function errorCodeOf(line) {
  const compact = line.toUpperCase().replace(/[^A-Z?]/g, '');
  if (compact === '?') return '?';
  for (const code of ERROR_CODES) if (compact.includes(code.replace(/ /g, ''))) return code;
  return null;
}

/** Split a raw reply into trimmed lines, dropping echo, "SEARCHING..." and bus-init chatter. */
export function cleanLines(raw, cmd = '') {
  const echo = cmd.replace(/\s+/g, '').toUpperCase();
  return raw
    .replace(/[^\x20-\x7E\r\n]/g, '')
    .split(/[\r\n]+/)
    .map((l) => l.trim().replace(/^SEARCHING\.*\s*/i, ''))
    .filter((l) => {
      if (!l) return false;
      const c = l.replace(/\s+/g, '').toUpperCase();
      if (echo && c === echo) return false;
      if (c.startsWith('BUSINIT') && !c.includes('ERROR')) return false;
      return true;
    });
}

const hexToBytes = (hex) => {
  const out = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
};

/**
 * Turn reply lines (headers off) into messages (arrays of bytes).
 * Handles single-frame lines from one or more ECUs, plus CAN multi-frame
 * replies, which the ELM327 prints as a 3-digit byte count followed by
 * "0:", "1:", ... continuation lines.
 */
export function parseMessages(lines) {
  const messages = [];
  const errors = [];
  let multi = null;

  for (const line of lines) {
    const c = line.toUpperCase().replace(/\s+/g, '');
    if (!/^[0-9A-F:]+$/.test(c)) {
      const err = errorCodeOf(line);
      if (err) errors.push(err);
      continue;
    }
    if (/^[0-9A-F]{3}$/.test(c)) {
      multi = { len: parseInt(c, 16), bytes: [] };
      messages.push(multi);
      continue;
    }
    const frame = /^([0-9A-F]):([0-9A-F]*)$/.exec(c);
    if (frame) {
      if (!multi) {
        multi = { len: Infinity, bytes: [] };
        messages.push(multi);
      }
      multi.bytes.push(...hexToBytes(frame[2]));
      continue;
    }
    if (/^([0-9A-F]{2})+$/.test(c)) {
      multi = null;
      messages.push({ len: Infinity, bytes: hexToBytes(c) });
    }
  }

  const out = messages.map((m) => m.bytes.slice(0, m.len)).filter((b) => b.length);
  if (!out.length) throw new ElmError(errors[0] || 'NO DATA', lines.join(' '));
  return out;
}

export class Elm327 {
  constructor(transport, { onLog } = {}) {
    this.transport = transport;
    this.onLog = onLog || (() => {});
    this.buffer = '';
    this.pending = null;
    this.queue = Promise.resolve();
    this.needsDrain = false;
    this.info = { version: '', device: '' };
    this.protocol = '';
    this.isCan = true;
    this.useCountHint = false;
    this.supported = new Set();
    this.vehicleConnected = false;
    this.lastVehicleError = null;
    transport.onData = (chunk) => this._onData(chunk);
  }

  get protocolName() {
    return PROTOCOLS[this.protocol] || (this.protocol ? `Protocol ${this.protocol}` : 'Not detected');
  }

  _onData(chunk) {
    this.buffer += chunk;
    let i;
    while ((i = this.buffer.indexOf('>')) !== -1) {
      const raw = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        p.resolve(raw);
      }
    }
  }

  /** Fail any in-flight command (called when the transport drops). */
  abort(code = 'DISCONNECTED') {
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      p.reject(new ElmError(code));
    }
  }

  /** Queue a command. Resolves with cleaned reply lines once the adapter's ">" prompt arrives. */
  send(cmd, { timeout = 4000, quiet = false } = {}) {
    const run = () => this._exec(cmd.trim().toUpperCase(), timeout, quiet);
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  async _exec(cmd, timeout, quiet) {
    if (this.needsDrain) await this._drain();
    this.buffer = '';
    if (!quiet) this.onLog('tx', cmd);
    let raw;
    try {
      raw = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending = null;
          reject(new ElmError('TIMEOUT', cmd));
        }, timeout);
        this.pending = {
          resolve: (text) => {
            clearTimeout(timer);
            resolve(text);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        };
        Promise.resolve(this.transport.write(cmd + '\r')).catch((err) => {
          clearTimeout(timer);
          this.pending = null;
          reject(new ElmError('DISCONNECTED', err?.message || ''));
        });
      });
    } catch (err) {
      if (err.code === 'TIMEOUT') this.needsDrain = true;
      if (!quiet) this.onLog('err', `${cmd}: ${err.message}`);
      throw err;
    }
    const lines = cleanLines(raw, cmd);
    if (!quiet) this.onLog('rx', lines.join('  ⏎  ') || '(empty)');
    return lines;
  }

  /** After a timeout, let any late reply arrive and throw it away so replies stay in sync. */
  async _drain() {
    this.needsDrain = false;
    this.pending = { resolve: () => {}, reject: () => {} };
    await sleep(700);
    this.pending = null;
    this.buffer = '';
  }

  // ---------------------------------------------------------------- setup

  async initialize(onProgress = () => {}) {
    onProgress('Resetting adapter…');
    const banner = await this.send('ATZ', { timeout: 5000 }).catch(() => []);
    await sleep(150);
    onProgress('Configuring adapter…');
    // Echo off, linefeeds off, spaces off, headers off, adaptive timing, auto protocol.
    for (const cmd of ['ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATAT1', 'ATSP0']) {
      await this.send(cmd, { timeout: 2000 }).catch(() => {});
    }
    const ati = (await this.send('ATI').catch(() => []))[0];
    this.info.version = ati || banner.find((l) => /ELM/i.test(l)) || 'Unknown';
    const dev = (await this.send('AT@1').catch(() => []))[0];
    this.info.device = dev && dev !== '?' ? dev : '';
    onProgress('Talking to the car…');
    return this.connectVehicle();
  }

  /** Detect the vehicle protocol and supported PIDs. Returns false if the car isn't answering. */
  async connectVehicle() {
    this.vehicleConnected = false;
    this.lastVehicleError = null;
    try {
      this.supported = await this.getSupportedPids();
    } catch (err) {
      this.lastVehicleError = err;
      return false;
    }
    const dpn = (await this.send('ATDPN').catch(() => []))[0] || '';
    this.protocol = dpn.replace(/^A/i, '').toUpperCase();
    this.isCan = /^[6-9A-C]$/.test(this.protocol);
    // ELM327 v1.3+ accepts a response-count hint ("010C1") so it stops waiting
    // for extra ECUs to answer — roughly doubles the dashboard refresh rate.
    try {
      const msgs = parseMessages(await this.send('01001', { timeout: 3000 }));
      this.useCountHint = msgs.some((m) => m[0] === 0x41 && m[1] === 0x00);
    } catch {
      this.useCountHint = false;
    }
    this.vehicleConnected = true;
    return true;
  }

  async getSupportedPids() {
    const supported = new Set();
    for (let base = 0; base <= 0xe0; base += 0x20) {
      if (base !== 0 && !supported.has(base)) break;
      let msgs;
      try {
        // The first request also triggers protocol auto-detection, which can take a while.
        msgs = parseMessages(await this.send('01' + hex2(base), { timeout: base === 0 ? 20000 : 4000 }));
      } catch (err) {
        if (base === 0) throw err;
        break;
      }
      for (const m of msgs) {
        if (m[0] !== 0x41 || m[1] !== base || m.length < 6) continue;
        for (let i = 0; i < 32; i++) {
          if (m[2 + (i >> 3)] & (0x80 >> (i & 7))) supported.add(base + i + 1);
        }
      }
      if (base === 0 && !supported.size) throw new ElmError('NO DATA');
    }
    return supported;
  }

  // ---------------------------------------------------------------- live data

  async readPid(pid, { quiet = true } = {}) {
    const cmd = '01' + hex2(pid) + (this.useCountHint ? '1' : '');
    const msgs = parseMessages(await this.send(cmd, { timeout: 3000, quiet }));
    const m = msgs.find((b) => b[0] === 0x41 && b[1] === pid);
    if (!m) throw new ElmError('NO DATA');
    return m.slice(2);
  }

  /** Battery voltage measured by the adapter at the OBD port (works even with the car off). */
  async readVoltage({ quiet = false } = {}) {
    const line = (await this.send('ATRV', { timeout: 2000, quiet }))[0] || '';
    const v = parseFloat(line.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(v)) throw new ElmError('?', line);
    return v;
  }

  // ---------------------------------------------------------------- diagnostics

  async readMonitorStatus() {
    const msgs = parseMessages(await this.send('0101', { timeout: 4000 }));
    const hits = msgs
      .filter((b) => b[0] === 0x41 && b[1] === 0x01 && b.length >= 6)
      .map((b) => decodeMonitorStatus(b.slice(2, 6)));
    if (!hits.length) throw new ElmError('NO DATA');
    // With several ECUs answering, the engine computer is the one reporting the most monitors.
    const primary = hits.reduce((a, b) => (b.monitors.length > a.monitors.length ? b : a));
    return {
      ...primary,
      mil: hits.some((h) => h.mil),
      dtcCount: hits.reduce((sum, h) => sum + h.dtcCount, 0),
      ecuCount: hits.length,
    };
  }

  /** mode 0x03 = stored, 0x07 = pending, 0x0A = permanent */
  async readDtcs(mode) {
    let msgs;
    try {
      msgs = parseMessages(await this.send(hex2(mode), { timeout: 8000 }));
    } catch (err) {
      if (err.code === 'NO DATA') return { codes: [], responded: false, negative: null };
      throw err;
    }
    return decodeDtcMessages(msgs, mode, this.isCan);
  }

  /** Mode 04: clear codes, freeze frame and readiness monitors; turns off the check-engine light. */
  async clearDtcs() {
    const lines = await this.send('04', { timeout: 10000 });
    const msgs = parseMessages(lines);
    if (msgs.some((m) => m[0] === 0x44)) return { ok: true };
    const neg = msgs.find((m) => m[0] === 0x7f && m[1] === 0x04);
    if (neg) return { ok: false, reason: nrcText(neg[2]) };
    return { ok: false, reason: `Unexpected reply: ${lines.join(' ')}` };
  }

  /** Mode 02: the snapshot the ECU stored when a code was set. */
  async readFreezeFrame(pids) {
    let msgs;
    try {
      msgs = parseMessages(await this.send('020200', { timeout: 4000 }));
    } catch {
      return null;
    }
    const m = msgs.find((b) => b[0] === 0x42 && b[1] === 0x02 && b.length >= 5);
    if (!m || (!m[3] && !m[4])) return null;
    const dtc = decodeDtc(m[3], m[4]);
    const values = new Map();
    for (const pid of pids) {
      try {
        const r = parseMessages(await this.send('02' + hex2(pid) + '00', { timeout: 3000 }));
        const hit = r.find((b) => b[0] === 0x42 && b[1] === pid && b.length > 3);
        if (hit) values.set(pid, hit.slice(3));
      } catch {
        /* not captured for this PID */
      }
    }
    return { dtc, values };
  }

  async readVin() {
    const msgs = parseMessages(await this.send('0902', { timeout: 6000 })).filter(
      (b) => b[0] === 0x49 && b[1] === 0x02
    );
    if (!msgs.length) return null;
    let bytes;
    if (this.isCan) {
      // 49 02 01 + 17 ASCII bytes, reassembled from multiple frames
      bytes = (msgs.find((m) => m.length >= 20) || msgs[0]).slice(3);
    } else {
      // Older protocols: five lines of 49 02 NN + 4 bytes
      bytes = msgs.sort((a, b) => a[2] - b[2]).flatMap((m) => m.slice(3));
    }
    const vin = String.fromCharCode(...bytes.filter((b) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a))).slice(-17);
    return vin.length >= 11 ? vin : null;
  }
}
