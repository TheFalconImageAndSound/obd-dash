// Which gear is the transmission in?
//
// Most cars don't report it over standard OBD-II, so we work it out: in any one
// gear, engine RPM ÷ road speed is a fixed number (the gear's overall ratio).
// The estimator watches RPM and speed while you drive steadily, learns each
// distinct ratio, and numbers them from the highest ratio (1st) down.
// What it learns is saved per car, so it gets better every drive.

const MATCH = 0.06; // a reading within ~6% of a learned ratio belongs to that gear
const CONFIRM = 15; // steady readings needed before a ratio counts as a gear
const STEADY = 0.025; // consecutive readings must agree within ~2.5% (not mid-shift / clutch in)
const MAX_CLUSTERS = 14;
const MIN_LEARN_KMH = 15; // integer km/h readings are too coarse below this
const MIN_RPM = 700;

export class GearEstimator {
  constructor({ storage = null, now = () => Date.now() } = {}) {
    this.storage = storage;
    this.now = now;
    this.key = null;
    this.clusters = []; // { L: ln(rpm per km/h), n: readings }
    this.prev = null;
    this.dirty = false;
    this.savedAt = 0;
  }

  /** Switch to (and load) the profile for a car. */
  load(carKey) {
    this.key = `obddash.gears.${carKey || 'default'}`;
    this.clusters = [];
    this.prev = null;
    try {
      const data = JSON.parse(this.storage?.getItem(this.key) || 'null');
      if (Array.isArray(data?.clusters)) {
        this.clusters = data.clusters
          .filter((c) => Number.isFinite(c.L) && Number.isFinite(c.n) && c.n > 0)
          .map((c) => ({ L: c.L, n: Math.min(c.n, 400) }));
      }
    } catch {
      /* unreadable profile: start fresh */
    }
  }

  save(force = false) {
    if (!this.key || !this.storage || (!this.dirty && !force)) return;
    if (!force && this.now() - this.savedAt < 15000) return;
    try {
      const keep = this.clusters.filter((c) => c.n >= 5).map((c) => ({ L: +c.L.toFixed(5), n: c.n }));
      this.storage.setItem(this.key, JSON.stringify({ clusters: keep, updated: new Date(this.now()).toISOString() }));
    } catch {
      /* storage full or blocked */
    }
    this.dirty = false;
    this.savedAt = this.now();
  }

  reset() {
    this.clusters = [];
    this.prev = null;
    this.dirty = true;
    this.save(true);
  }

  /** Feed a reading. Only steady, in-gear driving teaches it anything. */
  sample(rpm, speedKmh) {
    if (rpm == null || speedKmh == null || speedKmh < MIN_LEARN_KMH || rpm < MIN_RPM) {
      this.prev = null;
      return;
    }
    const L = Math.log(rpm / speedKmh);
    const prev = this.prev;
    this.prev = L;
    if (prev == null || Math.abs(L - prev) > STEADY) return;

    let best = null;
    let bestD = Infinity;
    for (const c of this.clusters) {
      const d = Math.abs(c.L - L);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (best && bestD < MATCH) {
      best.n += 1;
      best.L += (L - best.L) / Math.min(best.n, 200);
    } else {
      this.clusters.push({ L, n: 1 });
      if (this.clusters.length > MAX_CLUSTERS) {
        this.clusters.sort((a, b) => b.n - a.n);
        this.clusters.length = MAX_CLUSTERS;
      }
    }
    this.merge();
    this.dirty = true;
    this.save();
  }

  merge() {
    this.clusters.sort((a, b) => a.L - b.L);
    for (let i = 0; i < this.clusters.length - 1; ) {
      const a = this.clusters[i];
      const b = this.clusters[i + 1];
      if (b.L - a.L < MATCH) {
        const n = a.n + b.n;
        this.clusters.splice(i, 2, { L: (a.L * a.n + b.L * b.n) / n, n });
      } else i++;
    }
  }

  /** Learned gears, 1st first. With `count` set, keeps the `count` best-established ratios. */
  gears(count = 0) {
    let list = this.clusters.filter((c) => c.n >= CONFIRM);
    if (count > 0 && list.length > count) list = [...list].sort((a, b) => b.n - a.n).slice(0, count);
    return [...list].sort((a, b) => b.L - a.L);
  }

  get learned() {
    return this.gears().length;
  }

  /** Gear number for the current RPM and speed, or null (stopped, shifting, clutch in, or not learned yet). */
  gearFor(rpm, speedKmh, count = 0) {
    if (rpm == null || speedKmh == null || speedKmh < 3 || rpm < 400) return null;
    const L = Math.log(rpm / speedKmh);
    const tol = Math.max(MATCH, 0.7 / speedKmh); // speed comes in whole km/h, so allow more slack when slow
    let best = -1;
    let bestD = Infinity;
    this.gears(count).forEach((c, i) => {
      const d = Math.abs(c.L - L);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best >= 0 && bestD <= tol ? best + 1 : null;
  }
}

/**
 * Mode 01 PID A4, "Transmission actual gear" (newer cars only):
 * A bit 1 = reading supported, B bits 7–4 = gear (0 = neutral).
 */
export function decodeGearPid(d) {
  if (!d || d.length < 2 || !(d[0] & 0x02)) return null;
  return d[1] >> 4;
}
