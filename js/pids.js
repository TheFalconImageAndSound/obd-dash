// Live-data signals: Mode 01 PIDs, adapter voltage, and a few derived values.
// Every value is stored in metric and converted for display.

import { decodeGearPid } from './gear.js';

const pct = (d) => (d[0] * 100) / 255;
const trim = (d) => ((d[0] - 128) * 100) / 128;
const word = (d) => d[0] * 256 + d[1];
const temp = (d) => d[0] - 40;

const STD_KPA = 101.3;
const GAS_AFR = 14.7;
const GAS_G_PER_L = 740;

const tempLevel = (warn, crit) => (v) => (v >= crit ? 'crit' : v >= warn ? 'warn' : null);
const trimLevel = (v) => (Math.abs(v) >= 20 ? 'crit' : Math.abs(v) >= 10 ? 'warn' : null);
const voltLevel = (v, values) => {
  if (v < 11.5) return 'crit';
  if (v > 15.2) return 'warn';
  const running = (values.rpm ?? 0) > 400;
  if (running && v < 13.0) return 'warn';
  if (!running && v < 12.2) return 'warn';
  return null;
};

export const SIGNALS = [
  { key: 'rpm', pid: 0x0c, label: 'Engine RPM', short: 'RPM', kind: 'rpm', min: 0, max: 8000, dec: 0, rate: 'fast', decode: (d) => word(d) / 4 },
  { key: 'speed', pid: 0x0d, label: 'Vehicle speed', short: 'Speed', kind: 'speed', min: 0, max: 240, dec: 0, rate: 'fast', decode: (d) => d[0] },
  { key: 'coolant', pid: 0x05, label: 'Coolant temperature', short: 'Coolant', kind: 'temp', min: 40, max: 120, dec: 0, rate: 'slow', decode: temp, level: tempLevel(105, 112) },
  { key: 'battery', source: 'atrv', label: 'Battery voltage (at OBD port)', short: 'Battery', kind: 'volt', min: 10, max: 16, dec: 1, rate: 'slow', level: voltLevel },
  { key: 'throttle', pid: 0x11, label: 'Throttle position', short: 'Throttle', kind: 'percent', min: 0, max: 100, dec: 0, rate: 'fast', decode: pct },
  { key: 'load', pid: 0x04, label: 'Calculated engine load', short: 'Load', kind: 'percent', min: 0, max: 100, dec: 0, rate: 'fast', decode: pct },
  { key: 'iat', pid: 0x0f, label: 'Intake air temperature', short: 'Intake air', kind: 'temp', min: -20, max: 80, dec: 0, rate: 'slow', decode: temp, level: tempLevel(60, 75) },
  { key: 'fuel', pid: 0x2f, label: 'Fuel level', short: 'Fuel', kind: 'percent', min: 0, max: 100, dec: 0, rate: 'slow', decode: pct, level: (v) => (v < 8 ? 'crit' : v < 15 ? 'warn' : null) },
  { key: 'timing', pid: 0x0e, label: 'Ignition timing advance', short: 'Timing', kind: 'deg', min: -10, max: 50, dec: 1, rate: 'fast', decode: (d) => d[0] / 2 - 64, bipolar: true },
  {
    key: 'boost',
    label: 'Boost / vacuum (MAP − barometric)',
    short: 'Boost',
    kind: 'pressure',
    range: { metric: [-100, 150], us: [-15, 22] },
    dec: { metric: 0, us: 1 },
    bipolar: true,
    needs: (has) => (has('map') ? ['map', ...(has('baro') ? ['baro'] : [])] : null),
    derive: (v) => (v.map == null ? null : v.map - (v.baro ?? STD_KPA)),
  },
  {
    key: 'economy',
    label: 'Fuel economy (estimated, gasoline)',
    short: 'Economy',
    kind: 'economy',
    range: { metric: [25, 0], us: [0, 50] },
    dec: 1,
    needs: (has) => (has('speed') && (has('fuelRate') || has('maf')) ? ['speed', has('fuelRate') ? 'fuelRate' : 'maf'] : null),
    derive: (v) => {
      const litersPerHour = v.fuelRate ?? (v.maf != null ? (v.maf * 3600) / (GAS_AFR * GAS_G_PER_L) : null);
      if (litersPerHour == null || v.speed == null || v.speed < 3) return null;
      return (litersPerHour / v.speed) * 100; // L/100 km
    },
  },
  { key: 'oilTemp', pid: 0x5c, label: 'Engine oil temperature', short: 'Oil temp', kind: 'temp', min: 40, max: 150, dec: 0, rate: 'slow', decode: temp, level: tempLevel(130, 140) },
  { key: 'maf', pid: 0x10, label: 'Mass air flow', short: 'MAF', kind: 'flow', min: 0, max: 150, dec: 1, rate: 'fast', decode: (d) => word(d) / 100 },
  { key: 'map', pid: 0x0b, label: 'Intake manifold pressure', short: 'MAP', kind: 'pressure', min: 0, max: 255, dec: { metric: 0, us: 1 }, rate: 'fast', decode: (d) => d[0] },
  { key: 'stft1', pid: 0x06, label: 'Short-term fuel trim, bank 1', short: 'STFT B1', kind: 'percent', min: -25, max: 25, dec: 1, rate: 'fast', decode: trim, bipolar: true, level: trimLevel },
  { key: 'ltft1', pid: 0x07, label: 'Long-term fuel trim, bank 1', short: 'LTFT B1', kind: 'percent', min: -25, max: 25, dec: 1, rate: 'slow', decode: trim, bipolar: true, level: trimLevel },
  { key: 'stft2', pid: 0x08, label: 'Short-term fuel trim, bank 2', short: 'STFT B2', kind: 'percent', min: -25, max: 25, dec: 1, rate: 'fast', decode: trim, bipolar: true, level: trimLevel },
  { key: 'ltft2', pid: 0x09, label: 'Long-term fuel trim, bank 2', short: 'LTFT B2', kind: 'percent', min: -25, max: 25, dec: 1, rate: 'slow', decode: trim, bipolar: true, level: trimLevel },
  { key: 'pedal', pid: 0x49, label: 'Accelerator pedal position', short: 'Pedal', kind: 'percent', min: 0, max: 100, dec: 0, rate: 'fast', decode: pct },
  { key: 'ambient', pid: 0x46, label: 'Outside air temperature', short: 'Outside', kind: 'temp', min: -30, max: 50, dec: 0, rate: 'slow', decode: temp },
  { key: 'ecuVolt', pid: 0x42, label: 'Control module voltage', short: 'ECU volts', kind: 'volt', min: 10, max: 16, dec: 1, rate: 'slow', decode: (d) => word(d) / 1000, level: voltLevel },
  { key: 'catTemp', pid: 0x3c, label: 'Catalyst temperature, bank 1', short: 'Cat temp', kind: 'temp', min: 0, max: 1000, dec: 0, rate: 'slow', decode: (d) => word(d) / 10 - 40, level: tempLevel(900, 1000) },
  { key: 'fuelRate', pid: 0x5e, label: 'Engine fuel rate', short: 'Fuel rate', kind: 'fuelrate', min: 0, max: 30, dec: 1, rate: 'fast', decode: (d) => word(d) / 20 },
  { key: 'lambda', pid: 0x44, label: 'Commanded air-fuel equivalence (λ)', short: 'Cmd λ', kind: 'ratio', min: 0.7, max: 1.3, dec: 2, rate: 'fast', decode: (d) => (2 * word(d)) / 65536, bipolar: true, zero: 1 },
  { key: 'baro', pid: 0x33, label: 'Barometric pressure', short: 'Baro', kind: 'pressure', min: 70, max: 105, dec: { metric: 0, us: 1 }, rate: 'slow', decode: (d) => d[0] },
  { key: 'runtime', pid: 0x1f, label: 'Run time since engine start', short: 'Run time', kind: 'time', min: 0, max: 3600, dec: 0, rate: 'slow', decode: word, noBar: true },
  { key: 'clearDist', pid: 0x31, label: 'Distance since codes cleared', short: 'Since clear', kind: 'distance', min: 0, max: 1000, dec: 0, rate: 'slow', decode: word, noBar: true },
  // Gear the car reports itself (PID A4, newer cars only); otherwise the app estimates it.
  { key: 'gearPid', pid: 0xa4, label: 'Transmission gear (reported)', short: 'Gear', kind: 'flag', min: 0, max: 10, dec: 0, rate: 'fast', decode: decodeGearPid, hidden: true, noBar: true },
  // Current gear, reported or estimated (worked out in app.js). Used for logging.
  { key: 'gear', label: 'Gear', short: 'Gear', kind: 'flag', min: 0, max: 10, dec: 0, hidden: true, noBar: true },
  // Check-engine light on/off (Mode 01 PID 01, bit 7). Not a tile; drives the race dash warning light.
  { key: 'mil', pid: 0x01, label: 'Check-engine light', short: 'CEL', kind: 'flag', min: 0, max: 1, dec: 0, rate: 'slow', decode: (d) => (d[0] & 0x80 ? 1 : 0), hidden: true, noBar: true },
  { key: 'milDist', pid: 0x21, label: 'Distance driven with check-engine light on', short: 'CEL dist.', kind: 'distance', min: 0, max: 1000, dec: 0, rate: 'slow', decode: word, noBar: true },
];

export const SIGNAL_BY_KEY = Object.fromEntries(SIGNALS.map((s) => [s.key, s]));
export const SIGNAL_BY_PID = Object.fromEntries(SIGNALS.filter((s) => s.pid != null).map((s) => [s.pid, s]));

export const HERO_KEYS = ['rpm', 'speed'];
export const DEFAULT_TILES = ['coolant', 'battery', 'throttle', 'load', 'iat', 'fuel', 'timing', 'boost', 'economy', 'oilTemp', 'stft1', 'ltft1'];

/** PIDs worth reading from a freeze frame (Mode 02). */
export const FREEZE_FRAME_PIDS = [0x0c, 0x0d, 0x05, 0x04, 0x11, 0x06, 0x07, 0x08, 0x09, 0x0b, 0x0f, 0x10];

const KINDS = {
  rpm: { metric: 'rpm', us: 'rpm' },
  speed: { metric: 'km/h', us: 'mph', toUs: (v) => v * 0.621371 },
  temp: { metric: '°C', us: '°F', toUs: (v) => v * 1.8 + 32 },
  percent: { metric: '%', us: '%' },
  volt: { metric: 'V', us: 'V' },
  deg: { metric: '°', us: '°' },
  flow: { metric: 'g/s', us: 'g/s' },
  pressure: { metric: 'kPa', us: 'psi', toUs: (v) => v * 0.145038 },
  distance: { metric: 'km', us: 'mi', toUs: (v) => v * 0.621371 },
  time: { metric: '', us: '' },
  flag: { metric: '', us: '' },
  ratio: { metric: 'λ', us: 'λ' },
  fuelrate: { metric: 'L/h', us: 'gal/h', toUs: (v) => v * 0.264172 },
  economy: { metric: 'L/100km', us: 'mpg', toUs: (v) => (v > 0 ? 235.215 / v : null) },
};

export function unitLabel(sig, units) {
  const k = KINDS[sig.kind];
  return units === 'us' ? k.us : k.metric;
}

export function toDisplay(sig, value, units) {
  if (value == null || !Number.isFinite(value)) return null;
  const k = KINDS[sig.kind];
  return units === 'us' && k.toUs ? k.toUs(value) : value;
}

export function displayRange(sig, units) {
  if (sig.range) return sig.range[units];
  return [toDisplay(sig, sig.min, units), toDisplay(sig, sig.max, units)];
}

export function decimals(sig, units) {
  return typeof sig.dec === 'object' ? sig.dec[units] : sig.dec ?? 0;
}

export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function formatValue(sig, display, units) {
  if (display == null || !Number.isFinite(display)) return '--';
  if (sig.kind === 'time') return formatDuration(display);
  const dec = decimals(sig, units);
  const text = display.toFixed(dec);
  return text === `-${(0).toFixed(dec)}` ? (0).toFixed(dec) : text;
}

/** Fraction 0..1 of the bar, plus where the bar starts (for values that can go negative). */
export function barGeometry(sig, display, units) {
  if (display == null) return { left: 0, width: 0 };
  const [lo, hi] = displayRange(sig, units);
  const frac = (x) => Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  const f = frac(display);
  if (!sig.bipolar) return { left: 0, width: f };
  const z = frac(toDisplay(sig, sig.zero ?? 0, units) ?? 0);
  return { left: Math.min(z, f), width: Math.abs(f - z) };
}
