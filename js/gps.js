// Phone GPS speed (Geolocation API) as an alternative speedometer source.
// Uses the speed the phone reports; if it doesn't report one, estimates it
// from the distance between accurate consecutive fixes.

const EARTH_RADIUS_M = 6371000;
const GOOD_ACCURACY_M = 35; // ignore fixes vaguer than this for distance-based speed
const STANDSTILL_MPS = 0.5; // below ~1 mph counts as stopped (GPS jitters while parked)

export function haversineMeters(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export class GpsSpeed {
  constructor({ geolocation = globalThis.navigator?.geolocation, onUpdate = () => {}, staleMs = 8000, now = () => Date.now() } = {}) {
    this.geo = geolocation;
    this.onUpdate = onUpdate;
    this.staleMs = staleMs;
    this.now = now;
    this.watchId = null;
    this.kmh = null;
    this.at = 0;
    this.last = null;
    this.status = 'off'; // off | waiting | ok | denied | unsupported
    this.message = '';
  }

  get active() {
    return this.watchId != null;
  }

  /** Speed in km/h, or null if there's no recent fix. */
  get speed() {
    return this.kmh != null && this.now() - this.at <= this.staleMs ? this.kmh : null;
  }

  start() {
    if (this.active) return;
    if (!this.geo) {
      this._set('unsupported', 'This browser can’t use the phone’s GPS.');
      return;
    }
    this.kmh = null;
    this.last = null;
    this._set('waiting', 'Waiting for GPS…');
    this.watchId = this.geo.watchPosition(
      (pos) => this._fix(pos),
      (err) => this._error(err),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    );
  }

  stop() {
    if (this.watchId != null) this.geo.clearWatch(this.watchId);
    this.watchId = null;
    this.kmh = null;
    this.last = null;
    if (this.status !== 'off') this._set('off', '');
  }

  _fix(pos) {
    const c = pos.coords;
    const t = pos.timestamp || this.now();
    const accurate = (c.accuracy ?? Infinity) <= GOOD_ACCURACY_M;
    let mps = Number.isFinite(c.speed) && c.speed >= 0 ? c.speed : null;
    if (mps == null && accurate && this.last) {
      const dt = (t - this.last.t) / 1000;
      if (dt >= 0.5) mps = haversineMeters(this.last, c) / dt;
    }
    if (accurate || !this.last) this.last = { latitude: c.latitude, longitude: c.longitude, t };
    if (mps == null) {
      if (this.status !== 'ok') this._set('waiting', 'Waiting for GPS…');
      return;
    }
    this.kmh = mps < STANDSTILL_MPS ? 0 : mps * 3.6;
    this.at = this.now();
    this._set('ok', '');
  }

  _error(err) {
    if (err?.code === 1) {
      this.stop();
      this._set(
        'denied',
        'Location access is off. Allow it for this browser to use GPS speed (iPhone: Settings → Bluefy → Location → While Using the App).'
      );
      return;
    }
    // Timeouts and lost signal: keep watching; the watch recovers on its own.
    this._set(this.kmh != null ? 'ok' : 'waiting', err?.code === 2 ? 'No GPS signal' : 'Waiting for GPS…');
  }

  _set(status, message) {
    this.status = status;
    this.message = message;
    this.onUpdate(this);
  }
}
