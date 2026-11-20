// Race Dash: a full-screen, race-car style dashboard (auto-selected on iPad / tablets).
// Shift-light LEDs, a segmented RPM bar, big speed + RPM, data columns, a bottom
// data strip with session peaks and a 0–60 timer, and warning telltales.

import { SIGNAL_BY_KEY, unitLabel, toDisplay, formatValue, barGeometry } from './pids.js';
import { LaunchTimer, launchTarget, launchLabel } from './launch.js';

// Each zone shows the first `count` values this car supports, in priority order.
const ZONES = [
  { id: 'left', count: 3, keys: ['coolant', 'oilTemp', 'battery', 'iat', 'ambient', 'ecuVolt'] },
  { id: 'right', count: 3, keys: ['boost', 'throttle', 'load', 'pedal', 'timing', 'maf'] },
  {
    id: 'bottom',
    count: 7,
    keys: ['iat', 'fuel', 'economy', 'timing', 'stft1', 'ltft1', 'maf', 'load', 'throttle', 'catTemp', 'lambda', 'ambient', 'baro', 'runtime'],
  },
];

const TELLTALES = [
  { id: 'cel', label: 'CHECK ENGINE' },
  { id: 'batt', label: 'BATT', key: 'battery' },
  { id: 'temp', label: 'TEMP', key: 'coolant' },
  { id: 'oil', label: 'OIL', key: 'oilTemp' },
  { id: 'fuel', label: 'FUEL', key: 'fuel' },
];

const CONTROLS = [
  { action: 'gear', label: 'GEAR', toggle: true },
  { action: 'gps', label: 'GPS', toggle: true },
  { action: 'record', label: 'REC', toggle: true, cls: 'rec' },
  { action: 'peaks', label: 'RESET PEAKS' },
  { action: 'focus', label: 'FOCUS', toggle: true },
  { action: 'style:muscle', label: 'MUSCLE' },
  { action: 'style:standard', label: 'STANDARD' },
];

const LEDS = 15;
const SEGMENTS = 96;
const SEG_W = 10;
const SVGNS = 'http://www.w3.org/2000/svg';

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function svg(tag, attrs = {}) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

export class RaceDash {
  /**
   * ctx: { settings, has(key), valueOf(key), values(), speedKmh(), speedUnitText(speed), gaugeMax(),
   *        milOn(), statusText(), onAction(name) }
   */
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.built = false;
    this.cells = [];
    this.rpm = 0;
    this.speed = 0;
    this.drawn = {};
    this.resetPeaks();
  }

  resetPeaks() {
    this.peaks = { rpm: null, speed: null };
    this.launch = new LaunchTimer();
    this.drawn = {};
    if (this.built) this.update();
  }

  /** Keys this layout wants polled (supported ones only). */
  pollKeys() {
    const keys = this.cells.filter((c) => c.key && this.ctx.has(c.key)).map((c) => c.key);
    if (this.ctx.has('mil')) keys.push('mil');
    return keys;
  }

  build() {
    this.root.textContent = '';

    // Header: brand, warning lights, controls
    const head = el('div', 'rd-head');
    const brand = el('div', 'rd-brand');
    const logo = el('img');
    logo.src = 'icons/falcon-mark.png';
    logo.alt = '';
    brand.append(logo, el('span', null, 'OBD DASH'), el('b', null, 'RACE'));
    this.statusEl = el('div', 'rd-status');
    brand.append(this.statusEl);
    const tells = el('div', 'rd-tells');
    this.tells = TELLTALES.map((t) => {
      const n = el('span', 'rd-tell', t.label);
      tells.append(n);
      return { ...t, node: n, state: null };
    });
    const ctrls = el('div', 'rd-ctrls');
    this.ctrls = {};
    for (const c of CONTROLS) {
      const b = el('button', 'rd-btn' + (c.cls ? ' ' + c.cls : ''), c.label);
      b.type = 'button';
      if (c.toggle) b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => this.ctx.onAction(c.action));
      ctrls.append(b);
      this.ctrls[c.action] = b;
    }
    head.append(brand, tells, ctrls);

    // Shift lights
    const leds = el('div', 'rd-leds');
    this.leds = [];
    for (let i = 0; i < LEDS; i++) {
      const led = el('span', 'rd-led ' + (i < 5 ? 'g' : i < 10 ? 'a' : 'r'));
      leds.append(led);
      this.leds.push(led);
    }
    this.ledWrap = leds;

    // RPM bar
    const bar = el('div', 'rd-rpmbar');
    this.rpmSvg = svg('svg', { viewBox: `0 0 ${SEGMENTS * SEG_W} 40`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    this.scale = el('div', 'rd-scale');
    bar.append(this.rpmSvg, this.scale);

    // Main: left column, center, right column
    const main = el('div', 'rd-main');
    this.cols = { left: el('div', 'rd-col'), right: el('div', 'rd-col') };
    const center = el('div', 'rd-center');
    this.speedEl = el('div', 'rd-speed', '--');
    this.speedUnitEl = el('div', 'rd-speed-unit', 'MPH');
    this.rpmLine = el('div', 'rd-rpmline');
    this.rpmNum = el('span', null, '----');
    this.rpmLine.append(this.rpmNum, el('small', null, 'RPM'));
    this.gearBox = el('div', 'rd-gear');
    this.gearNum = el('b', null, '–');
    this.gearBox.append(el('span', null, 'GEAR'), this.gearNum);
    center.append(this.gearBox, this.speedEl, this.speedUnitEl, this.rpmLine);
    main.append(this.cols.left, center, this.cols.right);

    // Bottom strip
    this.bottom = el('div', 'rd-bottom');

    this.root.append(head, leds, bar, main, this.bottom);
    this.built = true;
    this.buildRpmBar();
    this.refreshSlots();
  }

  buildRpmBar() {
    if (!this.built) return;
    const max = this.ctx.gaugeMax();
    const red = this.ctx.settings.redline;
    const s = this.rpmSvg;
    s.textContent = '';
    const defs = svg('defs');
    const clip = svg('clipPath', { id: 'rdClip' });
    this.clipRect = svg('rect', { x: 0, y: 0, width: 0, height: 40 });
    clip.append(this.clipRect);
    const glow = svg('filter', { id: 'rdGlow', x: '-5%', y: '-60%', width: '110%', height: '220%' });
    glow.append(svg('feGaussianBlur', { stdDeviation: '3', result: 'b' }));
    const merge = svg('feMerge');
    merge.append(svg('feMergeNode', { in: 'b' }), svg('feMergeNode', { in: 'SourceGraphic' }));
    glow.append(merge);
    defs.append(clip, glow);
    const bg = svg('g', { class: 'rd-seg-bg' });
    const litOuter = svg('g', { filter: 'url(#rdGlow)' });
    const lit = svg('g', { class: 'rd-seg-lit', 'clip-path': 'url(#rdClip)' });
    for (let i = 0; i < SEGMENTS; i++) {
      const segRpm = (i / SEGMENTS) * max;
      const zone = segRpm >= red ? 'r' : segRpm >= red - 1500 ? 'a' : 'w';
      // Segments get taller toward redline, like a classic bar tach.
      const h = 22 + 18 * (i / (SEGMENTS - 1));
      const attrs = { x: i * SEG_W + 1, y: 40 - h, width: SEG_W - 3, height: h, rx: 1.5 };
      bg.append(svg('rect', { ...attrs, class: zone === 'r' ? 'r' : '' }));
      lit.append(svg('rect', { ...attrs, class: zone }));
    }
    litOuter.append(lit);
    s.append(defs, bg, litOuter);

    this.scale.textContent = '';
    for (let rpm = 0; rpm <= max; rpm += 1000) {
      const label = el('span', rpm >= red ? 'red' : '', String(rpm / 1000));
      label.style.left = `${(rpm / max) * 100}%`;
      this.scale.append(label);
    }
    this.drawn.clip = null;
  }

  /** Pick which values go in each slot (call when support, units or settings change). */
  refreshSlots() {
    if (!this.built) return;
    const { has } = this.ctx;
    const used = new Set();
    const picks = {};
    for (const z of ZONES) {
      const supported = z.keys.filter((k) => has(k) && !used.has(k)).slice(0, z.count);
      supported.forEach((k) => used.add(k));
      // Pad with unsupported candidates so the layout stays full (shown as N/A).
      const pad = z.keys.filter((k) => !used.has(k) && !supported.includes(k)).slice(0, z.count - supported.length);
      pad.forEach((k) => used.add(k));
      picks[z.id] = [...supported, ...pad];
    }

    this.cells = [];
    for (const id of ['left', 'right']) {
      const col = this.cols[id];
      col.textContent = '';
      for (const key of picks[id]) col.append(this.makeCell(key, 'zone-' + id));
    }
    this.bottom.textContent = '';
    for (const key of picks.bottom) this.bottom.append(this.makeCell(key, 'zone-bottom'));
    // Session specials
    this.special = {
      peakRpm: this.makeSpecial('PEAK RPM', '', 'SESSION'),
      topSpeed: this.makeSpecial('TOP SPEED', '', `${unitLabel(SIGNAL_BY_KEY.speed, this.ctx.settings.units).toUpperCase()} · SESSION`),
      launch: this.makeSpecial(launchLabel(this.ctx.settings.units), 'SEC', 'BEST --'),
    };
    this.drawn = {};
    this.update();
  }

  makeCell(key, zone) {
    const sig = SIGNAL_BY_KEY[key];
    const units = this.ctx.settings.units;
    const node = el('div', `rd-cell ${zone}`);
    const label = el('div', 'rd-label');
    label.append(el('span', null, sig.short.toUpperCase()), el('span', 'u', unitLabel(sig, units)));
    const value = el('div', 'rd-value', '--');
    const bar = el('div', 'rd-bar' + (sig.noBar ? ' none' : ''));
    const fill = el('i');
    bar.append(fill);
    node.append(label, value, bar);
    const cell = { key, sig, node, value, fill, last: null };
    this.cells.push(cell);
    return node;
  }

  makeSpecial(title, unit, sub) {
    const node = el('div', 'rd-cell zone-special');
    const label = el('div', 'rd-label');
    label.append(el('span', null, title), el('span', 'u', unit));
    const value = el('div', 'rd-value', '--');
    const subEl = el('div', 'rd-sub', sub);
    node.append(label, value, subEl);
    this.bottom.append(node);
    return { node, value, sub: subEl };
  }

  /** New data arrived: refresh cells, peaks, warning lights. */
  update() {
    if (!this.built) return;
    const { ctx } = this;
    const units = ctx.settings.units;
    const values = ctx.values();

    for (const c of this.cells) {
      const supported = ctx.has(c.key);
      const v = supported ? ctx.valueOf(c.key) : null;
      const d = toDisplay(c.sig, v, units);
      const text = supported ? formatValue(c.sig, d, units) : 'N/A';
      if (text !== c.last) {
        c.value.textContent = text;
        c.last = text;
      }
      const g = barGeometry(c.sig, d, units);
      c.fill.style.left = `${(g.left * 100).toFixed(1)}%`;
      c.fill.style.width = `${(g.width * 100).toFixed(1)}%`;
      const level = v == null || !c.sig.level ? null : c.sig.level(v, values);
      c.node.classList.toggle('warn', level === 'warn');
      c.node.classList.toggle('crit', level === 'crit');
      c.node.classList.toggle('na', !supported);
      c.node.classList.toggle('nodata', supported && v == null);
    }

    // Session peaks
    const rpm = ctx.valueOf('rpm');
    const speed = ctx.speedKmh();
    if (rpm != null) this.peaks.rpm = Math.max(this.peaks.rpm ?? 0, rpm);
    if (speed != null) this.peaks.speed = Math.max(this.peaks.speed ?? 0, speed);
    this.launch.track(speed, performance.now(), launchTarget(units));
    const sp = this.special;
    sp.peakRpm.value.textContent = this.peaks.rpm == null ? '--' : String(Math.round(this.peaks.rpm / 10) * 10);
    sp.peakRpm.node.classList.toggle('hot', (this.peaks.rpm ?? 0) >= ctx.settings.redline);
    sp.topSpeed.value.textContent = this.peaks.speed == null ? '--' : String(Math.round(toDisplay(SIGNAL_BY_KEY.speed, this.peaks.speed, units)));
    const L = this.launch;
    if (!L.running) sp.launch.value.textContent = L.last == null ? '--' : L.last.toFixed(2);
    sp.launch.sub.textContent = `BEST ${L.best == null ? '--' : L.best.toFixed(2)}`;
    sp.launch.node.classList.toggle('running', L.running);

    // Warning lights
    for (const t of this.tells) {
      let state = null;
      if (t.id === 'cel') state = ctx.milOn() ? 'crit' : null;
      else if (ctx.has(t.key)) {
        const v = ctx.valueOf(t.key);
        const sig = SIGNAL_BY_KEY[t.key];
        state = v == null || !sig.level ? null : sig.level(v, values);
      }
      if (state !== t.state) {
        t.node.classList.toggle('warn', state === 'warn');
        t.node.classList.toggle('crit', state === 'crit');
        t.state = state;
      }
    }
    if (this.statusEl) this.statusEl.textContent = ctx.statusText();
  }

  /** Animation frame: smooth RPM/speed, shift lights, RPM bar. */
  frame(dt) {
    if (!this.built) return;
    const { ctx } = this;
    const red = ctx.settings.redline;
    const max = ctx.gaugeMax();
    const rpmT = ctx.valueOf('rpm');
    const spdT = ctx.speedKmh();
    this.rpm += ((rpmT ?? 0) - this.rpm) * Math.min(1, dt * 14);
    this.speed += ((spdT ?? 0) - this.speed) * Math.min(1, dt * 8);

    const clip = ((Math.min(1, Math.max(0, this.rpm / max)) * SEGMENTS * SEG_W) | 0).toString();
    if (clip !== this.drawn.clip) {
      this.clipRect.setAttribute('width', clip);
      this.drawn.clip = clip;
    }

    // Shift lights: first LED at redline − 2400 rpm (or half of redline), last just before redline.
    const start = Math.max(red * 0.5, red - 2400);
    const step = (red - 150 - start) / (LEDS - 1);
    const lit = rpmT == null || this.rpm < start ? 0 : Math.min(LEDS, Math.floor((this.rpm - start) / step) + 1);
    const over = rpmT != null && this.rpm >= red;
    if (lit !== this.drawn.lit) {
      this.leds.forEach((led, i) => led.classList.toggle('on', i < lit));
      this.drawn.lit = lit;
    }
    if (over !== this.drawn.over) {
      this.ledWrap.classList.toggle('over', over);
      this.drawn.over = over;
    }

    const units = ctx.settings.units;
    const spdText = spdT == null ? '--' : String(Math.round(toDisplay(SIGNAL_BY_KEY.speed, this.speed, units)));
    if (spdText !== this.drawn.speed) this.speedEl.textContent = this.drawn.speed = spdText;
    const unitText = ctx.speedUnitText(spdT);
    if (unitText !== this.drawn.unit) this.speedUnitEl.textContent = this.drawn.unit = unitText;
    const rpmText = rpmT == null ? '----' : String(Math.round(this.rpm / 10) * 10);
    if (rpmText !== this.drawn.rpm) this.rpmNum.textContent = this.drawn.rpm = rpmText;
    const zone = rpmT == null ? '' : over ? 'over' : this.rpm >= red - 600 ? 'near' : '';
    if (zone !== this.drawn.zone) {
      this.rpmLine.classList.toggle('near', zone === 'near');
      this.rpmLine.classList.toggle('over', zone === 'over');
      this.drawn.zone = zone;
    }

    // Live 0–60 clock while a launch is running
    if (this.launch.running) this.special.launch.value.textContent = this.launch.elapsed(performance.now()).toFixed(1);

    const shown = ctx.gearShown();
    if (shown !== this.drawn.gearShown) this.gearBox.hidden = !(this.drawn.gearShown = shown);
    const gear = ctx.gear() ?? '–';
    if (gear !== this.drawn.gear) this.gearNum.textContent = this.drawn.gear = gear;
  }

  setControls({ gps, recording, recText, focus, gear, gearUnavailable }) {
    if (!this.built) return;
    this.ctrls.gear.setAttribute('aria-pressed', String(!!gear));
    this.ctrls.gear.classList.toggle('unavailable', !!gearUnavailable);
    this.ctrls.gps.setAttribute('aria-pressed', String(!!gps));
    this.ctrls.record.setAttribute('aria-pressed', String(!!recording));
    this.ctrls.record.textContent = recording ? recText || 'STOP' : 'REC';
    this.ctrls.focus.setAttribute('aria-pressed', String(!!focus));
  }
}
