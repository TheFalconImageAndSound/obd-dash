// A simulated ELM327 adapter plugged into a simulated car.
// Lets you explore the app without a vehicle, and lets the tests exercise the real
// protocol code (multi-frame CAN replies, several ECUs answering, the "1" hint, etc.).

const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const noise = (amp) => (Math.random() - 0.5) * 2 * amp;
const word = (v) => {
  const n = clamp(Math.round(v), 0, 0xffff);
  return [n >> 8, n & 0xff];
};
const pctByte = (v) => clamp(Math.round((v * 255) / 100), 0, 255);
const trimByte = (v) => clamp(Math.round((v * 128) / 100 + 128), 0, 255);

const SUPPORTED = [0x01, 0x04, 0x05, 0x06, 0x07, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x1f, 0x21, 0x2f, 0x31, 0x33, 0x42, 0x46, 0x49, 0x5c, 0xa4];
const VIN = 'DEMO0BD2SIM000001';

const dtcBytes = (code) => {
  const sys = 'PCBU'.indexOf(code[0]);
  return [(sys << 6) | (parseInt(code[1], 16) << 4) | parseInt(code[2], 16), parseInt(code.slice(3), 16)];
};

// Readiness monitors this fake car has (spark ignition): catalyst, EVAP, O2, O2 heater, EGR.
const MONITORS_AVAILABLE = 0xe5;
const MONITOR_COMPLETION_ORDER = [0x40, 0x20, 0x80, 0x01, 0x04];

export class SimTransport {
  constructor({ fast = false } = {}) {
    this.name = 'Demo car (simulated)';
    this.canReconnect = false;
    this.onData = () => {};
    this.onDisconnect = () => {};
    this.fast = fast;
    this.inbuf = '';
    this.closed = false;
    this._reset();
    this.start = now();
    this.lastTick = this.start;
    this.car = { speed: 0, rpm: 780, throttle: 0, coolant: 26, oil: 24, fuel: 63.5, clearDist: 412.6, milDist: 38.2, runtime: 0, load: 20, map: 32, maf: 2.2 };
    this.dtc = {
      mil: true,
      stored: ['P0301', 'P0420', 'P0442'],
      pending: ['P0171'],
      permanent: ['P0420'],
      clearedAt: null,
      freeze: { dtc: 'P0301', pids: { 0x0c: word(2450 * 4), 0x0d: [64], 0x05: [88 + 40], 0x04: [pctByte(42)], 0x11: [pctByte(22)], 0x06: [trimByte(-2.3)], 0x07: [trimByte(7)], 0x0b: [58], 0x0f: [30 + 40], 0x10: word(1430) } },
    };
  }

  _reset() {
    this.echo = true;
    this.spaces = true;
    this.searched = false;
  }

  async connect() {
    await wait(this.fast ? 0 : 500);
  }

  async disconnect() {
    this.closed = true;
    setTimeout(() => this.onDisconnect({ manual: true }), 0);
  }

  async write(text) {
    if (this.closed) throw new Error('Not connected');
    this.inbuf += text;
    let i;
    while ((i = this.inbuf.indexOf('\r')) !== -1) {
      const line = this.inbuf.slice(0, i);
      this.inbuf = this.inbuf.slice(i + 1);
      this._handle(line);
    }
  }

  _handle(line) {
    this._tick();
    const cmd = line.replace(/\s+/g, '').toUpperCase();
    const { lines, delay = 0 } = this._respond(cmd);
    const out = (this.echo ? line + '\r' : '') + lines.join('\r') + '\r\r>';
    const latency = this.fast ? 0 : 15 + Math.random() * 20 + delay;
    setTimeout(() => {
      if (this.closed) return;
      // Deliver in 20-byte pieces like real BLE notifications.
      for (let i = 0; i < out.length; i += 20) this.onData(out.slice(i, i + 20));
    }, latency);
  }

  // ------------------------------------------------------------- car model

  _tick() {
    const t = (now() - this.start) / 1000;
    const dt = Math.min(0.5, (now() - this.lastTick) / 1000);
    this.lastTick = now();
    const c = this.car;
    const phase = t % 42;
    let target;
    if (phase < 5) target = 0; // idle at a light
    else if (phase < 14) target = 55 + 20 * Math.sin(t * 1.3); // pull away
    else if (phase < 24) target = 30 + 6 * Math.sin(t * 0.7); // cruise
    else if (phase < 30) target = 88; // on-ramp
    else target = 0; // coast, then brake
    c.throttle += (target - c.throttle) * Math.min(1, dt * 4);
    const braking = phase >= 35;
    const accel = c.throttle * 0.11 - 0.0009 * c.speed * c.speed - (braking ? 9 : 0.4);
    c.speed = clamp(c.speed + accel * dt, 0, 210);

    // Pick a gear; shift later under heavy throttle.
    const shiftScale = 1 + (c.throttle / 100) * 1.1;
    const gears = [
      [0, 118],
      [21, 70],
      [40, 48],
      [62, 36],
      [86, 29],
      [110, 24],
    ];
    let ratio = gears[0][1];
    c.gear = 1;
    gears.forEach(([minSpeed, r], i) => {
      if (c.speed >= minSpeed * shiftScale) {
        ratio = r;
        c.gear = i + 1;
      }
    });
    const targetRpm = c.speed < 4 ? 780 + c.throttle * 22 : Math.max(950, c.speed * ratio);
    c.rpm += (targetRpm - c.rpm) * Math.min(1, dt * 6);

    c.load = clamp(18 + c.throttle * 0.78 + noise(2), 0, 100);
    c.map = clamp(30 + c.throttle * 1.45 + noise(1.5), 20, 220); // small turbo
    c.maf = Math.max(1.5, (2.8 + c.throttle * 0.2) * (c.rpm / 1000));
    c.coolant += (91 - c.coolant) * Math.min(1, dt / 40);
    c.oil += (c.coolant + 6 - c.oil) * Math.min(1, dt / 70);
    c.fuel = Math.max(0, c.fuel - c.maf * dt * 0.00002);
    c.clearDist += (c.speed * dt) / 3600;
    if (this.dtc.mil) c.milDist += (c.speed * dt) / 3600;
    c.runtime += dt;
  }

  _pid(pid) {
    const c = this.car;
    switch (pid) {
      case 0x01: {
        const A = (this.dtc.mil ? 0x80 : 0) | this.dtc.stored.length;
        let incomplete = 0x04; // EVAP not yet run
        if (this.dtc.clearedAt != null) {
          const done = Math.floor((now() - this.dtc.clearedAt) / 20000);
          incomplete = MONITOR_COMPLETION_ORDER.slice(done).reduce((a, b) => a | b, 0);
        }
        return [A, 0x07, MONITORS_AVAILABLE, incomplete];
      }
      case 0x04: return [pctByte(c.load)];
      case 0x05: return [Math.round(c.coolant) + 40];
      case 0x06: return [trimByte(1 + noise(3))];
      case 0x07: return [trimByte(7.8)];
      case 0x0b: return [Math.round(c.map)];
      case 0x0c: return word(c.rpm * 4);
      case 0x0d: return [Math.round(c.speed)];
      case 0x0e: return [Math.round((10 + (c.rpm / 1000) * 3.5 - c.throttle * 0.08 + noise(1) + 64) * 2)];
      case 0x0f: return [Math.round(31 + noise(0.6)) + 40];
      case 0x10: return word(c.maf * 100);
      case 0x11: return [pctByte(14 + c.throttle * 0.82)];
      case 0x1f: return word(c.runtime);
      case 0x21: return word(c.milDist);
      case 0x2f: return [pctByte(c.fuel)];
      case 0x31: return word(c.clearDist);
      case 0x33: return [101];
      case 0x42: return word(14100 + noise(80));
      case 0x46: return [22 + 40];
      case 0x49: return [pctByte(c.throttle)];
      case 0x5c: return [Math.round(c.oil) + 40];
      case 0xa4: return [0x02, (c.gear ?? 1) << 4, 0x00, 0x00]; // transmission actual gear
      default: return null;
    }
  }

  _supportedMask(base) {
    const bytes = [0, 0, 0, 0];
    for (let i = 0; i < 32; i++) {
      const pid = base + i + 1;
      const hasNext = i === 31 && SUPPORTED.some((p) => p > pid);
      if (SUPPORTED.includes(pid) || hasNext) bytes[i >> 3] |= 0x80 >> (i & 7);
    }
    return bytes;
  }

  // ------------------------------------------------------------- ELM327 emulation

  _fmt(bytes) {
    return bytes.map(hex2).join(this.spaces ? ' ' : '');
  }

  /** Format one ECU's reply the way an ELM327 prints CAN (ISO 15765) with headers off. */
  _can(bytes) {
    if (bytes.length <= 7) return [this._fmt(bytes)];
    const sp = this.spaces ? ' ' : '';
    const lines = [bytes.length.toString(16).toUpperCase().padStart(3, '0'), `0:${sp}${this._fmt(bytes.slice(0, 6))}`];
    for (let i = 6, n = 1; i < bytes.length; i += 7, n++) {
      const chunk = bytes.slice(i, i + 7);
      while (chunk.length < 7) chunk.push(0x00);
      lines.push(`${(n % 16).toString(16).toUpperCase()}:${sp}${this._fmt(chunk)}`);
    }
    return lines;
  }

  _dtcReply(sid, codes) {
    return this._can([sid, codes.length, ...codes.flatMap(dtcBytes)]);
  }

  _respond(cmd) {
    if (!cmd) return { lines: [] };

    if (cmd.startsWith('AT')) {
      const a = cmd.slice(2);
      if (a === 'Z' || a === 'WS') {
        this._reset();
        return { lines: ['', 'ELM327 v1.5'], delay: 250 };
      }
      if (a === 'I') return { lines: ['ELM327 v1.5'] };
      if (a === '@1') return { lines: ['OBDII to RS232 Interpreter'] };
      if (a === 'RV') return { lines: [`${(14.2 + noise(0.05)).toFixed(1)}V`] };
      if (a === 'DPN') return { lines: [this.searched ? 'A6' : '0'] };
      if (a === 'DP') return { lines: [this.searched ? 'AUTO, ISO 15765-4 (CAN 11/500)' : 'AUTO'] };
      if (/^E[01]$/.test(a)) {
        this.echo = a[1] === '1';
        return { lines: ['OK'] };
      }
      if (/^S[01]$/.test(a)) {
        this.spaces = a[1] === '1';
        return { lines: ['OK'] };
      }
      if (/^SP[0-9A-C]$/.test(a)) {
        this.searched = false;
        return { lines: ['OK'] };
      }
      if (/^(L[01]|H[01]|AT[012]|ST[0-9A-F]{2}|D|M[01]|CAF[01]|AL|NL|R[01])$/.test(a)) return { lines: ['OK'] };
      return { lines: ['?'] };
    }

    if (!/^[0-9A-F]+$/.test(cmd) || cmd.length < 2) return { lines: ['?'] };
    // A trailing single digit is the ELM327 "expected responses" hint.
    const hex = cmd.length % 2 ? cmd.slice(0, -1) : cmd;
    const bytes = hex.match(/../g).map((h) => parseInt(h, 16));
    const mode = bytes[0];

    let delay = 0;
    const prefix = [];
    if (!this.searched) {
      this.searched = true;
      prefix.push('SEARCHING...');
      delay = 1200;
    }
    const reply = (lines) => ({ lines: [...prefix, ...lines], delay });
    const noData = reply(['NO DATA']);

    switch (mode) {
      case 0x01: {
        const pid = bytes[1];
        if (pid === undefined) return reply(['?']);
        if (pid % 0x20 === 0) {
          const mask = this._supportedMask(pid);
          if (pid > 0 && !SUPPORTED.some((p) => p > pid)) return noData;
          return reply([this._fmt([0x41, pid, ...mask])]);
        }
        const data = this._pid(pid);
        return data ? reply([this._fmt([0x41, pid, ...data])]) : noData;
      }
      case 0x02: {
        const [, pid, frame = 0] = bytes;
        const ff = this.dtc.freeze;
        if (frame !== 0) return noData;
        if (pid === 0x02) return reply([this._fmt([0x42, 0x02, 0x00, ...(ff ? dtcBytes(ff.dtc) : [0, 0])])]);
        const data = ff?.pids[pid];
        return data ? reply([this._fmt([0x42, pid, 0x00, ...data])]) : noData;
      }
      case 0x03:
        // Engine computer + transmission computer both answer.
        return reply([...this._dtcReply(0x43, this.dtc.stored), ...this._dtcReply(0x43, [])]);
      case 0x07:
        return reply(this._dtcReply(0x47, this.dtc.pending));
      case 0x0a:
        return reply(this._dtcReply(0x4a, this.dtc.permanent));
      case 0x04:
        Object.assign(this.dtc, { mil: false, stored: [], pending: [], freeze: null, clearedAt: now() });
        this.car.clearDist = 0;
        this.car.milDist = 0;
        return reply(['44', '44']);
      case 0x09: {
        const pid = bytes[1];
        if (pid === 0x00) return reply([this._fmt([0x49, 0x00, 0x55, 0x40, 0x00, 0x00])]);
        if (pid === 0x02) return reply(this._can([0x49, 0x02, 0x01, ...[...VIN].map((ch) => ch.charCodeAt(0))]));
        return noData;
      }
      default:
        return noData;
    }
  }
}
