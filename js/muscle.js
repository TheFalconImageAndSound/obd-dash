// Muscle Dash: a restomod / stock-car analog cluster on a carbon-fibre panel.
// Big chrome-bezel tach and speedometer with sprung needles, a peak-RPM tell-tale
// needle, a row of auxiliary gauges, a SHIFT lamp, jewel warning lamps, a trip
// meter and a 0–60 timer. Needles sweep to full scale when the dash starts.

import { SIGNAL_BY_KEY, toDisplay, formatValue, unitLabel } from './pids.js';
import { LaunchTimer, launchTarget, launchLabel } from './launch.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const AUX_COUNT = 6;
const AUX_PRIORITY = ['coolant', 'oilTemp', 'battery', 'fuel', 'boost', 'iat', 'throttle', 'timing', 'load', 'ecuVolt', 'stft1', 'ltft1'];

const LAMPS = [
  { id: 'cel', label: 'CHECK ENGINE', color: 'amber' },
  { id: 'batt', label: 'BATT', key: 'battery', color: 'red' },
  { id: 'temp', label: 'TEMP', key: 'coolant', color: 'red' },
  { id: 'oil', label: 'OIL', key: 'oilTemp', color: 'red' },
  { id: 'fuel', label: 'FUEL', key: 'fuel', color: 'amber' },
  { id: 'gps', label: 'GPS', color: 'green' },
];

const CONTROLS = [
  { action: 'gps', label: 'GPS', toggle: true },
  { action: 'record', label: 'REC', toggle: true },
  { action: 'peaks', label: 'RESET' },
  { action: 'focus', label: 'FOCUS', toggle: true },
  { action: 'style:race', label: 'RACE' },
  { action: 'style:standard', label: 'STANDARD' },
];

function svgEl(tag, attrs = {}) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
const polar = (deg, r) => {
  const a = (deg * Math.PI) / 180;
  return [100 + r * Math.cos(a), 100 + r * Math.sin(a)];
};
function arcPath(from, to, r) {
  const [x0, y0] = polar(from, r);
  const [x1, y1] = polar(to, r);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** Gauge face specs for the auxiliary gauges, in display units. */
function auxSpec(key, units) {
  const us = units === 'us';
  const sig = SIGNAL_BY_KEY[key];
  const unit = unitLabel(sig, units);
  const tens = (step) => (v) => (Math.round(v) % step === 0 ? String(Math.round(v)) : '');
  switch (key) {
    case 'coolant':
      return us
        ? { title: 'WATER', unit, min: 100, max: 260, major: 40, minor: 10, red: [[230, 260]] }
        : { title: 'WATER', unit, min: 40, max: 130, major: 30, minor: 10, red: [[110, 130]] };
    case 'oilTemp':
      return us
        ? { title: 'OIL', unit, min: 100, max: 300, major: 50, minor: 10, red: [[270, 300]] }
        : { title: 'OIL', unit, min: 40, max: 140, major: 20, minor: 10, red: [[130, 140]] };
    case 'battery':
    case 'ecuVolt':
      return { title: key === 'battery' ? 'VOLTS' : 'ECU VOLTS', unit, min: 8, max: 18, major: 2, minor: 1, red: [[8, 11], [16, 18]] };
    case 'fuel':
      return { title: 'FUEL', unit: '', min: 0, max: 100, major: 25, minor: 12.5, red: [[0, 12]], label: (v) => ({ 0: 'E', 50: '½', 100: 'F' })[v] ?? '' };
    case 'boost':
      return us
        ? { title: 'BOOST', unit, min: -15, max: 20, major: 5, minor: 2.5, label: tens(10), red: [[17, 20]] }
        : { title: 'BOOST', unit, min: -100, max: 140, major: 20, minor: 10, label: tens(40), red: [[120, 140]] };
    case 'iat':
      return us ? { title: 'AIR', unit, min: 0, max: 200, major: 50, minor: 10, red: [[160, 200]] } : { title: 'AIR', unit, min: -20, max: 100, major: 20, minor: 5, red: [[70, 100]] };
    case 'throttle':
    case 'load':
      return { title: key === 'throttle' ? 'THROTTLE' : 'LOAD', unit, min: 0, max: 100, major: 25, minor: 5 };
    case 'timing':
      return { title: 'TIMING', unit, min: -10, max: 50, major: 10, minor: 5 };
    case 'stft1':
    case 'ltft1':
      return { title: key === 'stft1' ? 'ST TRIM' : 'LT TRIM', unit, min: -30, max: 30, major: 10, minor: 5, red: [[-30, -20], [20, 30]] };
    default: {
      const lo = toDisplay(sig, sig.min, units) ?? 0;
      const hi = toDisplay(sig, sig.max, units) ?? 100;
      return { title: sig.short.toUpperCase(), unit, min: Math.floor(lo), max: Math.ceil(hi), major: (hi - lo) / 4, minor: (hi - lo) / 20 };
    }
  }
}

/** One analog gauge with a spring-damped needle. */
class Gauge {
  constructor(spec, { big = false, peak = false, inset = true, logo = false } = {}) {
    this.spec = spec;
    this.big = big;
    this.start = big ? 135 : 150;
    this.sweep = big ? 270 : 240;
    this.rest = this.start - 4; // needle resting on its stop pin
    this.angle = this.rest;
    this.vel = 0;
    this.target = this.rest;
    this.peakAngle = null;
    this.svg = this.render({ peak, inset, logo });
    this.drawn = null;
  }

  angleFor(v) {
    const { min, max } = this.spec;
    const f = Math.min(1.03, Math.max(-0.03, (v - min) / (max - min)));
    return this.start + this.sweep * f;
  }

  render({ peak, inset, logo }) {
    const s = this.spec;
    const svg = svgEl('svg', { viewBox: '0 0 200 200', class: 'mm-gauge' + (this.big ? ' big' : ''), role: 'img' });
    svg.append(
      svgEl('circle', { cx: 100, cy: 100, r: 98, fill: 'url(#mmChrome)' }),
      svgEl('circle', { cx: 100, cy: 100, r: 92.5, fill: 'url(#mmChromeIn)' }),
      svgEl('circle', { cx: 100, cy: 100, r: 89.5, fill: '#020202' }),
      svgEl('circle', { cx: 100, cy: 100, r: 88.5, fill: 'url(#mmFace)' })
    );
    for (const [a, b] of s.red || []) {
      svg.append(svgEl('path', { d: arcPath(this.angleFor(a), this.angleFor(b), 82), class: 'mm-redzone' }));
    }
    const count = Math.round((s.max - s.min) / s.minor);
    const near = (x) => Math.abs(x - Math.round(x)) < 1e-6;
    const inRed = (v) => (s.red || []).some(([a, b]) => v >= a - 1e-6 && v <= b + 1e-6);
    for (let i = 0; i <= count; i++) {
      const v = s.min + i * s.minor;
      const major = near((v - s.min) / s.major);
      const mid = !major && s.major / s.minor >= 4 && near((v - s.min) / (s.major / 2));
      const a = this.angleFor(v);
      const [x1, y1] = polar(a, 86);
      const [x2, y2] = polar(a, major ? 72 : mid ? 76.5 : 79.5);
      svg.append(svgEl('line', { x1, y1, x2, y2, class: `mm-tick${major ? ' major' : mid ? ' mid' : ''}${inRed(v) ? ' red' : ''}` }));
      if (major) {
        const text = s.label ? s.label(Math.round(v * 100) / 100) : String(Math.round(v * 100) / 100);
        if (text) {
          const [lx, ly] = polar(a, this.big ? 60 : 58);
          const t = svgEl('text', { x: lx.toFixed(1), y: ly.toFixed(1), class: `mm-num${inRed(v) ? ' red' : ''}` });
          t.textContent = text;
          svg.append(t);
        }
      }
    }
    // Titles
    const title = svgEl('text', { x: 100, y: this.big ? 66 : 74, class: 'mm-title' });
    title.textContent = s.title;
    svg.append(title);
    this.unitText = svgEl('text', { x: 100, y: this.big ? 77 : 85, class: 'mm-unit' });
    this.unitText.textContent = s.unit || '';
    svg.append(this.unitText);
    if (logo) {
      const img = svgEl('image', { href: 'icons/falcon-mark.png', x: 86, y: 112, width: 28, height: 28, opacity: 0.85 });
      svg.append(img);
    }
    // Digital inset
    if (inset) {
      const w = this.big ? 58 : 60;
      const y = this.big ? 146 : 138;
      svg.append(svgEl('rect', { x: 100 - w / 2, y, width: w, height: 20, rx: 3, class: 'mm-lcd-bg' }));
      this.lcd = svgEl('text', { x: 100, y: y + 15, class: 'mm-lcd' });
      this.lcd.textContent = '--';
      svg.append(this.lcd);
    }
    // Peak tell-tale needle (behind the main needle)
    if (peak) {
      this.peakNeedle = svgEl('g', { class: 'mm-peak', transform: `rotate(${this.rest} 100 100) translate(100 100)` });
      this.peakNeedle.append(svgEl('polygon', { points: '0,-1.2 80,-0.5 80,0.5 0,1.2' }));
      this.peakNeedle.style.display = 'none';
      svg.append(this.peakNeedle);
    }
    // Main needle
    this.needle = svgEl('g', { class: 'mm-needle', transform: `rotate(${this.rest} 100 100) translate(100 100)` });
    const len = this.big ? 84 : 78;
    this.needle.append(
      svgEl('polygon', { points: `-20,-3 ${len - 3},-1 ${len},0 ${len - 3},1 -20,3`, class: 'mm-needle-body' }),
      svgEl('polygon', { points: `-20,-3 ${len - 3},-1 ${len},0 ${len - 3},0 -20,0`, class: 'mm-needle-hi' })
    );
    svg.append(this.needle);
    svg.append(
      svgEl('circle', { cx: 100, cy: 100, r: this.big ? 11 : 10, fill: 'url(#mmCap)' }),
      svgEl('circle', { cx: 100, cy: 100, r: 3.2, fill: '#111' }),
      svgEl('path', { d: 'M 22 92 A 78 78 0 0 1 178 92 C 150 66 50 66 22 92 Z', fill: 'url(#mmGlass)', class: 'mm-glass' })
    );
    return svg;
  }

  set(value) {
    this.value = value;
    this.target = value == null ? this.rest : this.angleFor(value);
  }

  setPeak(value) {
    if (!this.peakNeedle) return;
    this.peakAngle = value == null ? null : this.angleFor(value);
    this.peakNeedle.style.display = this.peakAngle == null ? 'none' : '';
    if (this.peakAngle != null) this.peakNeedle.setAttribute('transform', `rotate(${this.peakAngle.toFixed(2)} 100 100) translate(100 100)`);
  }

  /** Spring-damper needle: slightly under-damped, so it overshoots a touch and settles. */
  frame(dt, target = this.target) {
    const k = this.big ? 160 : 70;
    const c = 2 * Math.sqrt(k) * 0.62;
    let t = dt;
    while (t > 0) {
      const h = Math.min(t, 1 / 120);
      const acc = k * (target - this.angle) - c * this.vel;
      this.vel += acc * h;
      this.angle += this.vel * h;
      // Stop pins at both ends: the needle bounces off instead of swinging past.
      const hi = this.fullScale + 4;
      if (this.angle > hi) {
        this.angle = hi;
        this.vel = -Math.abs(this.vel) * 0.25;
      } else if (this.angle < this.rest) {
        this.angle = this.rest;
        this.vel = Math.abs(this.vel) * 0.25;
      }
      t -= h;
    }
    const a = this.angle.toFixed(2);
    if (a !== this.drawn) {
      this.needle.setAttribute('transform', `rotate(${a} 100 100) translate(100 100)`);
      this.drawn = a;
    }
  }

  get fullScale() {
    return this.start + this.sweep;
  }
}

/** A realistic 2×2 twill carbon-fibre tile, drawn once on a canvas. */
function carbonTile(cssSize = 24) {
  const dpr = 2;
  const n = 4;
  const size = cssSize * dpr;
  const cell = size / n;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const vertical = (x + y) % 4 < 2;
      const x0 = x * cell;
      const y0 = y * cell;
      const grad = vertical ? g.createLinearGradient(x0, 0, x0 + cell, 0) : g.createLinearGradient(0, y0, 0, y0 + cell);
      // Tows facing the light read brighter than those running across it.
      const [edge, mid] = vertical ? ['#0d0e10', '#34363b'] : ['#08090a', '#1c1d20'];
      grad.addColorStop(0, edge);
      grad.addColorStop(0.5, mid);
      grad.addColorStop(1, edge);
      g.fillStyle = grad;
      g.fillRect(x0, y0, cell, cell);
      // fine fibres
      g.strokeStyle = vertical ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.03)';
      g.lineWidth = 1;
      for (let i = 1; i < 6; i++) {
        const o = (cell * i) / 6;
        g.beginPath();
        if (vertical) {
          g.moveTo(x0 + o, y0);
          g.lineTo(x0 + o, y0 + cell);
        } else {
          g.moveTo(x0, y0 + o);
          g.lineTo(x0 + cell, y0 + o);
        }
        g.stroke();
      }
    }
  }
  return c.toDataURL('image/png');
}

let defsInstalled = false;
function installDefs() {
  if (defsInstalled) return;
  defsInstalled = true;
  const s = svgEl('svg', { width: 0, height: 0, 'aria-hidden': 'true', style: 'position:absolute;width:0;height:0' });
  s.innerHTML = `
    <defs>
      <linearGradient id="mmChrome" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#fafafa"/><stop offset=".2" stop-color="#8b8d90"/><stop offset=".42" stop-color="#ffffff"/>
        <stop offset=".6" stop-color="#55575b"/><stop offset=".8" stop-color="#dcdcdc"/><stop offset="1" stop-color="#6a6c70"/>
      </linearGradient>
      <linearGradient id="mmChromeIn" x1="1" y1="1" x2="0" y2="0">
        <stop offset="0" stop-color="#e9e9e9"/><stop offset=".5" stop-color="#5d6064"/><stop offset="1" stop-color="#c7c7c7"/>
      </linearGradient>
      <radialGradient id="mmFace" cx=".5" cy=".42" r=".62">
        <stop offset="0" stop-color="#202226"/><stop offset=".72" stop-color="#0b0c0e"/><stop offset="1" stop-color="#030303"/>
      </radialGradient>
      <radialGradient id="mmCap" cx=".35" cy=".3" r=".75">
        <stop offset="0" stop-color="#ffffff"/><stop offset=".35" stop-color="#b9bbbe"/><stop offset=".75" stop-color="#45484c"/><stop offset="1" stop-color="#161718"/>
      </radialGradient>
      <linearGradient id="mmGlass" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffffff" stop-opacity=".16"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
      </linearGradient>
      <filter id="mmShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur in="SourceAlpha" stdDeviation="1.6"/><feOffset dx="1.5" dy="3" result="o"/>
        <feComponentTransfer><feFuncA type="linear" slope=".55"/></feComponentTransfer>
        <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>`;
  document.body.append(s);
}

export class MuscleDash {
  /** ctx: same contract as RaceDash */
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.built = false;
    this.aux = [];
    this.trip = 0;
    this.lastUpdate = null;
    this.launch = new LaunchTimer();
    this.peakRpm = null;
    this.rpmSmooth = 0;
    this.speedSmooth = 0;
    this.sweepAt = null;
    this.drawn = {};
  }

  resetPeaks() {
    this.peakRpm = null;
    this.trip = 0;
    this.launch.reset();
    if (this.built) this.update();
  }

  pollKeys() {
    const keys = this.aux.filter((a) => a.supported).map((a) => a.key);
    if (this.ctx.has('mil')) keys.push('mil');
    return keys;
  }

  build() {
    installDefs();
    this.root.textContent = '';
    this.root.style.setProperty('--carbon', `url(${carbonTile()})`);

    // Header: plaque, lamps, switches
    const head = el('div', 'mm-head');
    const plaque = el('div', 'mm-plaque');
    const logo = el('img');
    logo.src = 'icons/falcon-mark.png';
    logo.alt = '';
    plaque.append(logo, el('span', null, 'OBD DASH'), el('b', null, 'Muscle'));
    this.statusEl = el('span', 'mm-status');
    plaque.append(this.statusEl);
    const lamps = el('div', 'mm-lamps');
    this.lamps = LAMPS.map((l) => {
      const wrap = el('span', `mm-lamp ${l.color}`);
      wrap.append(el('i'), el('span', null, l.label));
      lamps.append(wrap);
      return { ...l, node: wrap, on: null };
    });
    const ctrls = el('div', 'mm-ctrls');
    this.ctrls = {};
    for (const c of CONTROLS) {
      const b = el('button', 'mm-btn');
      b.type = 'button';
      b.append(el('i'), el('span', null, c.label));
      if (c.toggle) b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => this.ctx.onAction(c.action));
      ctrls.append(b);
      this.ctrls[c.action] = b;
    }
    head.append(plaque, lamps, ctrls);

    // Main: tach, center column, speedometer
    const main = el('div', 'mm-main');
    this.tachWrap = el('div', 'mm-big');
    this.speedoWrap = el('div', 'mm-big');
    const center = el('div', 'mm-center');
    this.shift = el('div', 'mm-shift');
    this.shift.append(el('span', null, 'SHIFT'));
    this.tripEl = el('div', 'mm-meter');
    this.tripLabel = el('span', 'mm-meter-label', 'TRIP');
    this.tripDigits = el('span', 'mm-drum', '000.0');
    this.tripEl.append(this.tripLabel, this.tripDigits);
    this.launchEl = el('div', 'mm-meter');
    this.launchLabelEl = el('span', 'mm-meter-label', '0–60');
    this.launchDigits = el('span', 'mm-drum', '--.--');
    this.launchBest = el('span', 'mm-meter-sub', 'BEST --');
    this.launchEl.append(this.launchLabelEl, this.launchDigits, this.launchBest);
    this.gearEl = el('div', 'mm-gear');
    this.gearNum = el('b', null, '–');
    this.gearEl.append(el('span', 'mm-meter-label', 'GEAR'), this.gearNum);
    center.append(this.shift, this.gearEl, this.tripEl, this.launchEl);
    main.append(this.tachWrap, center, this.speedoWrap);

    // Auxiliary gauge row
    this.auxRow = el('div', 'mm-aux');

    this.root.append(head, main, this.auxRow);
    this.built = true;
    this.refreshSlots();
  }

  /** (Re)build gauges for the current units, redline and supported values. */
  refreshSlots() {
    if (!this.built) return;
    const { ctx } = this;
    const units = ctx.settings.units;
    const max = ctx.gaugeMax();
    const red = ctx.settings.redline;

    this.tach = new Gauge(
      { title: 'RPM', unit: '×1000', min: 0, max, major: 1000, minor: 250, red: [[Math.min(red, max), max]], label: (v) => String(v / 1000) },
      { big: true, peak: true, logo: true }
    );
    const speedMax = units === 'us' ? 160 : 280;
    this.speedo = new Gauge(
      {
        title: units === 'us' ? 'MPH' : 'KM/H',
        unit: '',
        min: 0,
        max: speedMax,
        major: 20,
        minor: units === 'us' ? 5 : 10,
        label: (v) => (units === 'us' || v % 40 === 0 ? String(v) : ''),
      },
      { big: true }
    );
    this.tachWrap.replaceChildren(this.tach.svg);
    this.speedoWrap.replaceChildren(this.speedo.svg);

    // Aux: first AUX_COUNT supported values, padded with unsupported ones.
    const supported = AUX_PRIORITY.filter((k) => ctx.has(k)).slice(0, AUX_COUNT);
    const padding = AUX_PRIORITY.filter((k) => !supported.includes(k)).slice(0, AUX_COUNT - supported.length);
    this.aux = [...supported, ...padding].map((key) => {
      const gauge = new Gauge(auxSpec(key, units));
      const isSupported = supported.includes(key);
      gauge.svg.classList.toggle('na', !isSupported);
      return { key, gauge, supported: isSupported, sig: SIGNAL_BY_KEY[key] };
    });
    this.auxRow.replaceChildren(
      ...this.aux.map((a) => {
        const w = el('div', 'mm-small');
        w.append(a.gauge.svg);
        return w;
      })
    );
    this.launchLabelEl.textContent = launchLabel(units);
    this.drawn = {};
    this.update();
  }

  /** Called when the dash is shown: needles sweep to full scale and back. */
  sweep() {
    this.sweepAt = performance.now();
  }

  update() {
    if (!this.built) return;
    const { ctx } = this;
    const units = ctx.settings.units;
    const now = performance.now();
    const values = ctx.values();

    const rpm = ctx.valueOf('rpm');
    const speedKmh = ctx.speedKmh();
    this.tach.set(rpm);
    this.speedo.set(toDisplay(SIGNAL_BY_KEY.speed, speedKmh, units));
    if (rpm != null) this.peakRpm = Math.max(this.peakRpm ?? 0, rpm);
    this.tach.setPeak(this.peakRpm);

    for (const a of this.aux) {
      const v = a.supported ? ctx.valueOf(a.key) : null;
      const d = toDisplay(a.sig, v, units);
      a.gauge.set(d);
      if (a.gauge.lcd) {
        const text = !a.supported ? 'N/A' : d == null ? '--' : `${formatValue(a.sig, d, units)}${a.key === 'fuel' ? '%' : ''}`;
        if (text !== a.lcdText) a.gauge.lcd.textContent = a.lcdText = text;
      }
      const level = v == null || !a.sig.level ? null : a.sig.level(v, values);
      a.gauge.svg.classList.toggle('warn', level === 'warn');
      a.gauge.svg.classList.toggle('crit', level === 'crit');
    }

    // Trip meter: integrate speed over time.
    if (this.lastUpdate != null && speedKmh != null) {
      const dtH = Math.min(2000, now - this.lastUpdate) / 3600000;
      this.trip += speedKmh * dtH;
    }
    this.lastUpdate = now;
    const tripDisplay = toDisplay(SIGNAL_BY_KEY.clearDist, this.trip, units) ?? 0;
    this.tripDigits.textContent = tripDisplay.toFixed(1).padStart(5, '0');
    this.tripLabel.textContent = `TRIP ${units === 'us' ? 'MI' : 'KM'}`;

    this.launch.track(speedKmh, now, launchTarget(units));
    if (!this.launch.running) this.launchDigits.textContent = this.launch.last == null ? '--.--' : this.launch.last.toFixed(2).padStart(5, '0');
    this.launchBest.textContent = `BEST ${this.launch.best == null ? '--' : this.launch.best.toFixed(2)}`;
    this.launchEl.classList.toggle('running', this.launch.running);

    // Warning lamps
    for (const l of this.lamps) {
      let on = false;
      let crit = false;
      if (l.id === 'cel') on = !!ctx.milOn();
      else if (l.id === 'gps') on = ctx.settings.speedSource === 'gps' && speedKmh != null;
      else if (ctx.has(l.key)) {
        const v = ctx.valueOf(l.key);
        const sig = SIGNAL_BY_KEY[l.key];
        const level = v == null || !sig.level ? null : sig.level(v, values);
        on = !!level;
        crit = level === 'crit';
      }
      const state = on ? (crit ? 'crit' : 'on') : 'off';
      if (state !== l.on) {
        l.node.classList.toggle('on', on);
        l.node.classList.toggle('crit', crit);
        l.on = state;
      }
    }
    if (this.statusEl) this.statusEl.textContent = ctx.statusText();
  }

  frame(dt) {
    if (!this.built) return;
    const { ctx } = this;
    const now = performance.now();
    // Start-up sweep: up to full scale, then back down to the live value.
    let sweepTarget = null;
    if (this.sweepAt != null) {
      const t = now - this.sweepAt;
      if (t < 650) sweepTarget = 'full';
      else if (t > 1600) this.sweepAt = null;
    }
    const gauges = [this.tach, this.speedo, ...this.aux.map((a) => a.gauge)];
    for (const g of gauges) g.frame(dt, sweepTarget === 'full' ? g.fullScale : g.target);

    // SHIFT lamp: on near redline, flashing past it.
    const rpmT = ctx.valueOf('rpm');
    const red = ctx.settings.redline;
    const shift = rpmT == null ? '' : rpmT >= red ? 'flash' : rpmT >= red - 300 ? 'on' : '';
    if (shift !== this.drawn.shift) {
      this.shift.classList.toggle('on', shift === 'on' || shift === 'flash');
      this.shift.classList.toggle('flash', shift === 'flash');
      this.drawn.shift = shift;
    }

    // Digital insets: smoothed RPM and speed
    const units = ctx.settings.units;
    this.rpmSmooth += ((rpmT ?? 0) - this.rpmSmooth) * Math.min(1, dt * 12);
    const spd = ctx.speedKmh();
    this.speedSmooth += ((spd ?? 0) - this.speedSmooth) * Math.min(1, dt * 8);
    const rpmText = rpmT == null ? '----' : String(Math.round(this.rpmSmooth / 10) * 10);
    if (rpmText !== this.drawn.rpm) this.tach.lcd.textContent = this.drawn.rpm = rpmText;
    const spdText = spd == null ? '--' : String(Math.round(toDisplay(SIGNAL_BY_KEY.speed, this.speedSmooth, units)));
    if (spdText !== this.drawn.spd) this.speedo.lcd.textContent = this.drawn.spd = spdText;
    const unitText = ctx.speedUnitText(spd).includes('GPS') ? (spd == null ? 'GPS…' : 'GPS') : '';
    if (unitText !== this.drawn.unit) this.speedo.unitText.textContent = this.drawn.unit = unitText;

    if (this.launch.running) this.launchDigits.textContent = this.launch.elapsed(now).toFixed(2).padStart(5, '0');

    const gear = ctx.gear();
    const gearText = gear ?? '–';
    if (gearText !== this.drawn.gear) {
      this.gearNum.textContent = this.drawn.gear = gearText;
      this.gearEl.classList.toggle('lit', gear != null);
    }
  }

  setControls({ gps, recording, recText, focus }) {
    if (!this.built) return;
    this.ctrls.gps.setAttribute('aria-pressed', String(!!gps));
    this.ctrls.record.setAttribute('aria-pressed', String(!!recording));
    this.ctrls.record.querySelector('span').textContent = recording ? recText || 'STOP' : 'REC';
    this.ctrls.focus.setAttribute('aria-pressed', String(!!focus));
  }
}
