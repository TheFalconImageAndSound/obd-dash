// 0–60 mph (or 0–100 km/h) timer shared by the special dashboards.
// Arms when stopped, starts on roll-out, stops at the target speed.
// A run is abandoned if you lift off or it takes over 30 seconds.

export class LaunchTimer {
  constructor() {
    this.reset();
  }

  reset() {
    this.armed = true;
    this.start = null;
    this.stillAt = null;
    this.peak = 0;
    this.last = null;
    this.best = null;
  }

  get running() {
    return this.start != null;
  }

  elapsed(now) {
    return this.start == null ? null : (now - this.start) / 1000;
  }

  track(speedKmh, now, targetKmh) {
    if (speedKmh == null) return;
    if (speedKmh < 1.5) {
      this.armed = true;
      this.start = null;
      this.stillAt = now;
      return;
    }
    if (this.armed && this.start == null) {
      // Moving now, stopped at the previous sample: the launch happened in between.
      this.start = this.stillAt != null ? (this.stillAt + now) / 2 : now;
      this.armed = false;
      this.peak = 0;
    }
    if (this.start == null) return;
    this.peak = Math.max(this.peak, speedKmh);
    if (speedKmh < this.peak - 8 || now - this.start > 30000) {
      this.start = null;
      return;
    }
    if (speedKmh >= targetKmh) {
      const t = (now - this.start) / 1000;
      this.last = t;
      this.best = this.best == null ? t : Math.min(this.best, t);
      this.start = null;
    }
  }
}

export const launchTarget = (units) => (units === 'us' ? 96.5606 : 100);
export const launchLabel = (units) => (units === 'us' ? '0–60' : '0–100');
