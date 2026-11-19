import { BleTransport } from './ble.js';
import { SimTransport } from './sim.js';
import { Elm327, sleep } from './elm327.js';
import {
  SIGNALS,
  SIGNAL_BY_KEY,
  SIGNAL_BY_PID,
  HERO_KEYS,
  DEFAULT_TILES,
  FREEZE_FRAME_PIDS,
  unitLabel,
  toDisplay,
  formatValue,
  barGeometry,
  decimals,
} from './pids.js';
import { describeDtc } from './dtc.js';
import { GpsSpeed } from './gps.js';
import { RaceDash } from './race.js';

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...kids.filter((k) => k != null && k !== false));
  return n;
}

function icon(id) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('class', 'ic');
  const u = document.createElementNS(SVGNS, 'use');
  u.setAttribute('href', '#' + id);
  s.append(u);
  return s;
}

// =============================================================== settings

const SETTINGS_KEY = 'obddash.settings.v1';
const settings = loadSettings();

function loadSettings() {
  const defaults = {
    units: /^en-US$/i.test(navigator.language || '') ? 'us' : 'metric',
    redline: 6500,
    tiles: DEFAULT_TILES,
    keepAwake: true,
    verbose: false,
    speedSource: 'obd', // 'obd' (car's speed sensor) or 'gps' (phone)
    dashStyle: 'auto', // 'auto' (race dash on iPad/tablets), 'standard' or 'race'
  };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return defaults;
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* private mode — settings just won't persist */
  }
}

// =============================================================== state

const state = {
  transport: null,
  elm: null,
  connecting: false,
  connected: false,
  vehicle: false,
  busy: false,
  tab: 'dash',
  values: {}, // signal key -> latest value (metric)
  dead: new Set(), // signals that keep coming back NO DATA
  codes: null,
  vin: undefined,
  info: {},
};

const gps = new GpsSpeed({ onUpdate: onGpsUpdate });

const useGps = () => settings.speedSource === 'gps';

/** Speed in km/h from whichever source is selected. */
function speedNow() {
  return useGps() ? gps.speed : state.values.speed ?? null;
}

/** Label under the big speed number (units, plus GPS status when GPS is the source). */
function speedUnitText(speed) {
  const unit = settings.units === 'us' ? 'MPH' : 'KM/H';
  if (!useGps()) return unit;
  return speed != null ? `${unit} · GPS` : gps.status === 'ok' ? 'GPS · NO SIGNAL' : 'WAITING FOR GPS';
}

// iPad (iPadOS reports itself as a Mac with a touchscreen) or any tablet-sized touch screen.
const IS_IPAD = /iPad/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isTablet = () => IS_IPAD || (navigator.maxTouchPoints > 0 && Math.min(screen.width, screen.height) >= 700);
const raceOn = () => settings.dashStyle === 'race' || (settings.dashStyle === 'auto' && isTablet());

function has(key) {
  const sig = SIGNAL_BY_KEY[key];
  if (key === 'speed' && useGps()) return state.connected;
  if (!sig || state.dead.has(key) || !state.connected) return false;
  if (sig.source === 'atrv') return true;
  if (sig.needs) return !!sig.needs(has);
  return state.vehicle && !!state.elm?.supported.has(sig.pid);
}

function valueOf(key) {
  if (key === 'speed') return speedNow();
  const sig = SIGNAL_BY_KEY[key];
  if (sig.derive) return sig.derive({ ...state.values, speed: speedNow() });
  return state.values[key] ?? null;
}

function activeTiles() {
  return settings.tiles.filter((k) => SIGNAL_BY_KEY[k] && !HERO_KEYS.includes(k) && has(k));
}

async function readSignal(key) {
  const sig = SIGNAL_BY_KEY[key];
  const quiet = !settings.verbose;
  if (sig.source === 'atrv') return state.elm.readVoltage({ quiet });
  return sig.decode(await state.elm.readPid(sig.pid, { quiet }));
}

// =============================================================== live-data polling

function pollKeys() {
  const want = new Set();
  const add = (k) => {
    const sig = SIGNAL_BY_KEY[k];
    if (k === 'speed' && useGps()) return; // phone supplies speed; don't spend car bandwidth on it
    if (sig.needs) (sig.needs(has) || []).forEach(add);
    else if (has(k)) want.add(k);
  };
  const shown = raceOn() && raceDash.built ? raceDash.pollKeys() : activeTiles();
  [...HERO_KEYS, ...shown].forEach(add);
  // RPM and speed are "hot": read between every other value so the tach and shift lights stay lively.
  const hot = HERO_KEYS.filter((k) => want.has(k));
  const fast = [];
  const slow = [];
  for (const k of want) {
    if (hot.includes(k)) continue;
    (SIGNAL_BY_KEY[k].rate === 'fast' ? fast : slow).push(k);
  }
  return { hot, fast, slow };
}

const VEHICLE_GONE = new Set(['UNABLE TO CONNECT', 'BUS INIT ERROR', 'CAN ERROR', 'BUS ERROR']);

const poller = {
  running: false,
  gen: 0,
  start() {
    if (this.running) return;
    this.running = true;
    this.loop(++this.gen);
  },
  stop() {
    this.running = false;
    this.gen++;
  },
  async loop(gen) {
    const alive = () => this.running && gen === this.gen && state.elm;
    const fails = {};
    let slowIdx = 0;
    let timeouts = 0;
    while (alive()) {
      const { hot, fast, slow } = pollKeys();
      // Fast values every cycle, plus one slow value per cycle in rotation,
      // with RPM/speed interleaved between them.
      const rest = [...fast];
      if (slow.length) rest.push(slow[slowIdx++ % slow.length]);
      const batch = [];
      for (let i = 0; i < Math.max(rest.length, hot.length); i++) {
        if (hot.length) batch.push(hot[i % hot.length]);
        if (i < rest.length) batch.push(rest[i]);
      }
      if (!batch.length) {
        await sleep(400);
        continue;
      }
      const t0 = performance.now();
      for (const key of batch) {
        if (!alive()) return;
        try {
          state.values[key] = await readSignal(key);
          fails[key] = 0;
          timeouts = 0;
        } catch (err) {
          if (!alive() || err.code === 'DISCONNECTED') return;
          if (err.code === 'TIMEOUT') {
            if (++timeouts >= 4) {
              timeouts = 0;
              vehicleLost('The adapter stopped answering. Tap Retry to reset it.');
              break;
            }
            continue;
          }
          if (VEHICLE_GONE.has(err.code) && SIGNAL_BY_KEY[key].source !== 'atrv') {
            vehicleLost();
            break;
          }
          fails[key] = (fails[key] || 0) + 1;
          if (fails[key] >= 3) {
            state.dead.add(key);
            delete state.values[key];
            renderTiles();
          }
        }
        updateTiles();
      }
      recorder.sample();
      const spent = performance.now() - t0;
      if (spent < 50) await sleep(50 - spent);
    }
  },
};

function updatePolling() {
  const should = state.connected && !state.busy && state.tab === 'dash' && !document.hidden;
  if (should) poller.start();
  else poller.stop();
}

function vehicleLost(message) {
  state.vehicle = false;
  updateBanner(message);
  renderTiles();
  updateHeader();
}

// =============================================================== connect / disconnect

function setConnectStatus(text) {
  $('connectStatus').hidden = !text;
  if (text) $('connectStatusText').textContent = text;
  for (const id of ['btnConnect', 'btnDemo', 'btnConnectAll']) $(id).disabled = !!text || (id !== 'btnDemo' && !bleUsable);
  $('btnConnectAll').hidden = !bleUsable;
}

function showConnectError(text) {
  $('connectError').hidden = !text;
  $('connectError').textContent = text || '';
}

function bleErrorText(err) {
  const name = err?.name || '';
  const msg = err?.message || String(err);
  if (name === 'NotFoundError') {
    return 'No adapter was selected. If yours didn’t appear: make sure it’s plugged in (its light is on) and the ignition is ON, then try “Show all Bluetooth devices”.';
  }
  if (name === 'SecurityError') return 'Bluetooth needs a secure (https://) page.';
  if (name === 'NotAllowedError') {
    return 'Bluetooth permission is blocked. Allow “Nearby devices” (Android) or Bluetooth for your browser, then try again.';
  }
  if (msg.includes('Bluetooth layout')) return msg;
  if (name === 'NetworkError' || /gatt|connection/i.test(msg)) {
    return 'Couldn’t open a connection to the adapter. Close any other OBD app that might be using it, unplug the adapter for 10 seconds, and try again.';
  }
  return msg;
}

async function connect(kind, opts = {}) {
  if (state.connecting || state.connected) return;
  state.connecting = true;
  showConnectError(null);
  const transport = kind === 'demo' ? new SimTransport() : new BleTransport();
  transport.onLog = (text) => logLine('info', text);
  setConnectStatus(kind === 'demo' ? 'Starting the demo car…' : 'Choose your adapter from the list…');
  try {
    await transport.connect({ ...opts, onStatus: (msg) => setConnectStatus(msg) });
  } catch (err) {
    state.connecting = false;
    setConnectStatus(null);
    if (err?.name === 'NotFoundError' && /cancel/i.test(err.message)) return; // closed the picker
    showConnectError(bleErrorText(err));
    return;
  }

  const elm = new Elm327(transport, { onLog: logLine });
  Object.assign(state, { transport, elm, values: {}, dead: new Set(), codes: null, vin: undefined, info: {} });
  transport.onDisconnect = (info) => onTransportDisconnect(info);
  logLine('info', `Connected to ${transport.name}`);

  let vehicleOk = false;
  try {
    vehicleOk = await elm.initialize((msg) => setConnectStatus(msg));
  } catch (err) {
    state.connecting = false;
    setConnectStatus(null);
    showConnectError(`The adapter connected but didn’t respond: ${err.message}`);
    transport.onDisconnect = () => {};
    transport.disconnect().catch(() => {});
    Object.assign(state, { transport: null, elm: null });
    return;
  }
  state.connecting = false;
  state.connected = true;
  state.vehicle = vehicleOk;
  setConnectStatus(null);
  enterApp();
}

function enterApp() {
  $('screen-connect').hidden = true;
  $('screen-app').hidden = false;
  buildGauge();
  applyDashStyle();
  renderCodes();
  updateBanner();
  updateHeader();
  updateUnitsUi();
  setTab('dash');
  updateWakeLock();
  updateGps();
  if (!state.vehicle) toast('Connected to the adapter, but the car isn’t answering yet.', 'error');
}

async function onTransportDisconnect({ manual }) {
  state.elm?.abort('DISCONNECTED');
  poller.stop();
  if (manual || !state.connected) {
    teardown();
    return;
  }
  if (state.transport?.canReconnect) {
    state.busy = true;
    updateHeader();
    toast('Lost the adapter — reconnecting…');
    for (let attempt = 1; attempt <= 3 && state.connected; attempt++) {
      await sleep(1000 * attempt);
      try {
        await state.transport.reconnect();
        state.vehicle = await state.elm.initialize();
        state.busy = false;
        toast('Reconnected');
        updateBanner();
        renderTiles();
        updateHeader();
        updatePolling();
        return;
      } catch {
        /* try again */
      }
    }
  }
  teardown('The adapter disconnected. Check it’s still plugged in, then connect again.');
}

function teardown(message) {
  poller.stop();
  recorder.stop(true);
  Object.assign(state, { connected: false, vehicle: false, busy: false, elm: null, transport: null });
  updateWakeLock();
  updateGps();
  setFocus(false);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $('screen-app').hidden = true;
  $('screen-connect').hidden = false;
  setConnectStatus(null);
  showConnectError(message || null);
  logLine('info', 'Disconnected');
}

async function disconnect() {
  const t = state.transport;
  state.connected = false;
  try {
    await t?.disconnect();
  } catch {
    /* already gone */
  }
  teardown();
}

// =============================================================== header, banner, tabs

function setTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll('.tabs [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const v of ['dash', 'codes', 'vehicle', 'console']) $('view-' + v).hidden = v !== tab;
  updatePolling();
  if (tab === 'codes' && !state.codes && state.vehicle) scanCodes();
  if (tab === 'vehicle') loadVehicleInfo();
  if (tab === 'console') $('consoleLog').scrollTop = $('consoleLog').scrollHeight;
}

function updateHeader() {
  if (!state.connected) return;
  const dot = $('connDot');
  dot.className = 'dot ' + (state.busy ? 'busy' : state.vehicle ? 'ok' : 'warn');
  $('connName').textContent = state.transport?.name || 'Adapter';
  const proto = state.vehicle ? state.elm.protocolName.split(' (')[0] : 'Car not responding';
  const v = state.values.battery ?? state.info.voltage;
  $('connSub').textContent = [proto, v != null ? `${v.toFixed(1)} V` : null].filter(Boolean).join(' · ');
}

function updateBanner(message) {
  const banner = $('vehicleBanner');
  banner.hidden = !state.connected || state.vehicle;
  if (banner.hidden) return;
  const err = state.elm?.lastVehicleError;
  $('vehicleBannerText').textContent =
    message ||
    (err && err.code !== 'NO DATA'
      ? err.message
      : 'The adapter is connected but the car isn’t answering. Turn the ignition ON (or start the engine), then tap Retry.');
}

async function retryVehicle() {
  const btn = $('btnRetryVehicle');
  btn.disabled = true;
  btn.textContent = 'Trying…';
  await withBusy(async () => {
    state.vehicle = await state.elm.initialize().catch(() => false);
    state.dead.clear();
  });
  btn.disabled = false;
  btn.textContent = 'Retry';
  updateBanner();
  renderTiles();
  updateHeader();
  toast(state.vehicle ? 'Connected to the car' : 'Still no answer from the car', state.vehicle ? '' : 'error');
}

async function withBusy(fn) {
  if (state.busy || !state.connected) return;
  state.busy = true;
  updatePolling();
  updateHeader();
  try {
    return await fn();
  } finally {
    state.busy = false;
    updatePolling();
    updateHeader();
  }
}

// =============================================================== gauge

const G = { cx: 160, cy: 160, r: 136 };

function polar(deg, r = G.r) {
  const a = (deg * Math.PI) / 180;
  return [G.cx + r * Math.cos(a), G.cy + r * Math.sin(a)];
}

function arcPath(from, to, r = G.r) {
  const [x0, y0] = polar(from, r);
  const [x1, y1] = polar(to, r);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

const gaugeMax = () => Math.max(4000, Math.ceil((settings.redline + 1000) / 1000) * 1000);

function buildGauge() {
  const max = gaugeMax();
  const angle = (rpm) => 135 + (270 * rpm) / max;
  $('gTrack').setAttribute('d', arcPath(135, 405));
  $('gValue').setAttribute('d', arcPath(135, 405));
  $('gRed').setAttribute('d', arcPath(angle(Math.min(settings.redline, max)), 405));
  const ticks = $('gTicks');
  ticks.textContent = '';
  for (let rpm = 0; rpm <= max; rpm += 500) {
    const a = angle(rpm);
    const major = rpm % 1000 === 0;
    const [x0, y0] = polar(a, G.r - 13);
    const [x1, y1] = polar(a, G.r - (major ? 26 : 20));
    const line = document.createElementNS(SVGNS, 'line');
    Object.entries({ x1: x0, y1: y0, x2: x1, y2: y1 }).forEach(([k, v]) => line.setAttribute(k, v.toFixed(2)));
    line.setAttribute('class', `g-tick${major ? ' major' : ''}${rpm >= settings.redline ? ' red' : ''}`);
    ticks.append(line);
    if (major) {
      const [lx, ly] = polar(a, G.r - 42);
      const t = document.createElementNS(SVGNS, 'text');
      t.setAttribute('x', lx.toFixed(1));
      t.setAttribute('y', (ly + 5).toFixed(1));
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('class', 'g-label');
      t.textContent = rpm / 1000;
      ticks.append(t);
    }
  }
  hero.drawn = {};
}

const hero = { rpm: 0, speed: 0, last: 0, drawn: {}, cls: '' };

function frame(ts) {
  requestAnimationFrame(frame);
  if (state.tab !== 'dash' || !state.connected) return;
  const dt = hero.last ? Math.min(0.1, (ts - hero.last) / 1000) : 0.016;
  hero.last = ts;
  if (raceOn()) {
    raceDash.frame(dt);
    return;
  }
  const rpmT = state.values.rpm;
  const spdT = speedNow();
  hero.rpm += ((rpmT ?? 0) - hero.rpm) * Math.min(1, dt * 9);
  hero.speed += ((spdT ?? 0) - hero.speed) * Math.min(1, dt * 7);

  const pct = Math.max(0, Math.min(100, (hero.rpm / gaugeMax()) * 100));
  const dash = `${pct.toFixed(2)} 100`;
  if (dash !== hero.drawn.dash) {
    const v = $('gValue');
    v.setAttribute('stroke-dasharray', dash);
    v.style.visibility = pct < 0.4 ? 'hidden' : '';
    hero.drawn.dash = dash;
  }
  const rpmText = rpmT == null ? '--' : String(Math.round(hero.rpm / 10) * 10);
  if (rpmText !== hero.drawn.rpm) $('gRpm').textContent = hero.drawn.rpm = rpmText;
  const spd = toDisplay(SIGNAL_BY_KEY.speed, hero.speed, settings.units);
  const spdText = spdT == null ? '--' : String(Math.round(spd));
  if (spdText !== hero.drawn.speed) $('gSpeed').textContent = hero.drawn.speed = spdText;

  const unitText = speedUnitText(spdT);
  if (unitText !== hero.drawn.unit) $('gSpeedUnit').textContent = hero.drawn.unit = unitText;

  const cls = rpmT == null ? '' : hero.rpm >= settings.redline ? 'over' : hero.rpm >= settings.redline - 600 ? 'near' : '';
  if (cls !== hero.cls) {
    $('hero').classList.remove('near', 'over');
    if (cls) $('hero').classList.add(cls);
    hero.cls = cls;
  }
}
requestAnimationFrame(frame);

// =============================================================== tiles

const tileEls = new Map();

function renderTiles() {
  const wrap = $('tiles');
  wrap.textContent = '';
  tileEls.clear();
  const keys = activeTiles();
  for (const key of keys) {
    const sig = SIGNAL_BY_KEY[key];
    const num = el('span', { class: 'num', text: '--' });
    const bar = el('i');
    const tile = el(
      'div',
      { class: 'tile' + (sig.noBar ? ' nobar' : ''), title: sig.label },
      el('div', { class: 'tile-label', text: sig.short }),
      el('div', { class: 'tile-value' }, num, el('span', { class: 'unit', text: unitLabel(sig, settings.units) })),
      el('div', { class: 'tile-bar' }, bar)
    );
    wrap.append(tile);
    tileEls.set(key, { tile, num, bar, last: null });
  }
  if (!keys.length && state.vehicle) {
    wrap.append(el('p', { class: 'muted small', text: 'No gauges selected — tap “Gauges” to add some.' }));
  }
  if (raceOn()) raceDash.refreshSlots();
  updateTiles();
}

function updateTiles() {
  for (const [key, t] of tileEls) {
    const sig = SIGNAL_BY_KEY[key];
    const v = valueOf(key);
    const d = toDisplay(sig, v, settings.units);
    const text = formatValue(sig, d, settings.units);
    if (text !== t.last) {
      t.num.textContent = text;
      t.last = text;
    }
    const g = barGeometry(sig, d, settings.units);
    t.bar.style.left = `${(g.left * 100).toFixed(1)}%`;
    t.bar.style.width = `${(g.width * 100).toFixed(1)}%`;
    const level = v == null || !sig.level ? null : sig.level(v, state.values);
    t.tile.classList.toggle('warn', level === 'warn');
    t.tile.classList.toggle('crit', level === 'crit');
    t.tile.classList.toggle('na', v == null);
  }
  if (raceOn()) raceDash.update();
  updateHeader();
}

// =============================================================== race dash

const raceDash = new RaceDash($('raceDash'), {
  settings,
  has,
  valueOf,
  values: () => state.values,
  speedKmh: speedNow,
  speedUnitText,
  gaugeMax,
  milOn: () => (state.values.mil != null ? state.values.mil === 1 : !!state.codes?.status?.mil),
  statusText: () => {
    if (!state.connected) return '';
    const proto = state.vehicle ? state.elm.protocolName.split(' (')[0] : 'CAR NOT RESPONDING';
    return `${state.transport?.name || 'ADAPTER'} · ${proto}`.toUpperCase();
  },
  onAction: (action) => {
    if (action === 'gps') setSpeedSource(useGps() ? 'obd' : 'gps');
    else if (action === 'record') recorder.toggle();
    else if (action === 'peaks') {
      raceDash.resetPeaks();
      toast('Peaks and 0–60 times reset.');
    } else if (action === 'focus') setFocus(!document.body.classList.contains('race-focus'));
    else if (action === 'standard') setDashStyle('standard');
    syncRaceControls();
  },
});

function syncRaceControls() {
  raceDash.setControls({
    gps: useGps(),
    recording: !!recorder.rec,
    recText: $('recLabel').textContent.replace('Stop', 'STOP'),
    focus: document.body.classList.contains('race-focus'),
  });
}

/** Show the race dash or the standard dash, per settings and device. */
function applyDashStyle() {
  const race = raceOn();
  $('view-dash').classList.toggle('race-mode', race);
  $('raceDash').hidden = !race;
  if (race && !raceDash.built) raceDash.build();
  if (!race) setFocus(false);
  for (const b of document.querySelectorAll('[data-dashstyle]')) b.setAttribute('aria-checked', String(b.dataset.dashstyle === settings.dashStyle));
  renderTiles();
  syncRaceControls();
}

function setDashStyle(style) {
  settings.dashStyle = style;
  saveSettings();
  applyDashStyle();
  if (style !== 'auto') toast(style === 'race' ? 'Race dash on.' : 'Standard dash on. Switch back any time under Vehicle → Settings.');
}

/** Focus mode hides the app's top bar so the race dash fills the screen. */
function setFocus(on) {
  document.body.classList.toggle('race-focus', on);
  syncRaceControls();
}

// =============================================================== units & settings

function setUnits(units) {
  settings.units = units;
  saveSettings();
  updateUnitsUi();
  renderTiles();
  renderCodes();
  renderVehicleInfo();
}

function updateUnitsUi() {
  $('btnUnits').textContent = settings.units === 'us' ? 'US units' : 'Metric';
  $('gSpeedUnit').textContent = settings.units === 'us' ? 'MPH' : 'KM/H';
  hero.drawn.speed = null;
  hero.drawn.unit = null;
  for (const b of document.querySelectorAll('[data-units]')) b.setAttribute('aria-checked', String(b.dataset.units === settings.units));
}

function initSettingsUi() {
  $('setRedline').value = settings.redline;
  $('setKeepAwake').checked = settings.keepAwake;
  $('setVerbose').checked = settings.verbose;
  $('setRedline').addEventListener('change', (e) => {
    const v = Math.round(Number(e.target.value) / 250) * 250;
    settings.redline = Math.min(12000, Math.max(3000, Number.isFinite(v) && v ? v : 6500));
    e.target.value = settings.redline;
    saveSettings();
    buildGauge();
    raceDash.buildRpmBar();
  });
  for (const b of document.querySelectorAll('[data-dashstyle]')) b.addEventListener('click', () => setDashStyle(b.dataset.dashstyle));
  $('btnRaceDash').addEventListener('click', () => setDashStyle('race'));
  $('raceDash').hidden = true;
  for (const b of document.querySelectorAll('[data-dashstyle]')) b.setAttribute('aria-checked', String(b.dataset.dashstyle === settings.dashStyle));
  $('setKeepAwake').addEventListener('change', (e) => {
    settings.keepAwake = e.target.checked;
    saveSettings();
    updateWakeLock();
  });
  $('setVerbose').addEventListener('change', (e) => {
    settings.verbose = e.target.checked;
    saveSettings();
  });
  for (const b of document.querySelectorAll('[data-units]')) b.addEventListener('click', () => setUnits(b.dataset.units));
  $('btnUnits').addEventListener('click', () => setUnits(settings.units === 'us' ? 'metric' : 'us'));
  for (const b of document.querySelectorAll('[data-speedsrc]')) b.addEventListener('click', () => setSpeedSource(b.dataset.speedsrc));
  $('btnGps').addEventListener('click', () => setSpeedSource(useGps() ? 'obd' : 'gps'));
  updateUnitsUi();
  updateSpeedUi();
}

// =============================================================== GPS speedometer

function updateGps() {
  if (useGps() && state.connected && !document.hidden) gps.start();
  else gps.stop();
  updateSpeedUi();
}

function onGpsUpdate(g) {
  if (g.status === 'denied' || g.status === 'unsupported') {
    toast(g.message, 'error');
    setSpeedSource('obd', { quiet: true });
    return;
  }
  updateTiles(); // economy uses speed too
}

function setSpeedSource(source, { quiet = false } = {}) {
  if (settings.speedSource === source) return;
  settings.speedSource = source;
  saveSettings();
  updateGps();
  if (!quiet) toast(source === 'gps' ? 'Speed now comes from the phone’s GPS.' : 'Speed now comes from the car.');
}

function updateSpeedUi() {
  $('btnGps').setAttribute('aria-pressed', String(useGps()));
  for (const b of document.querySelectorAll('[data-speedsrc]')) b.setAttribute('aria-checked', String(b.dataset.speedsrc === settings.speedSource));
  hero.drawn.unit = null;
  syncRaceControls();
}

// =============================================================== customize tiles

function openCustomize() {
  const list = $('customizeList');
  list.textContent = '';
  for (const sig of SIGNALS) {
    if (HERO_KEYS.includes(sig.key) || sig.hidden) continue;
    const supported = !state.vehicle || has(sig.key);
    const cb = el('input', { type: 'checkbox', value: sig.key });
    cb.checked = settings.tiles.includes(sig.key);
    cb.disabled = !supported;
    list.append(
      el(
        'label',
        { class: supported ? null : 'unsupported' },
        cb,
        el('span', {}, sig.label, el('small', { text: supported ? unitLabel(sig, settings.units) || 'time' : 'Not supported by this car' }))
      )
    );
  }
  const dlg = $('dlgCustomize');
  dlg.returnValue = '';
  dlg.showModal();
}

$('dlgCustomize').addEventListener('close', () => {
  const dlg = $('dlgCustomize');
  if (dlg.returnValue === 'save') {
    const checked = new Set([...dlg.querySelectorAll('input:checked')].map((i) => i.value));
    settings.tiles = SIGNALS.map((s) => s.key).filter((k) => checked.has(k));
  } else if (dlg.returnValue === 'reset') {
    settings.tiles = [...DEFAULT_TILES];
  } else return;
  saveSettings();
  renderTiles();
});

// =============================================================== trouble codes

function setCodesBusy(text) {
  $('codesBusy').hidden = !text;
  if (text) $('codesBusyText').textContent = text;
  for (const id of ['btnScan', 'btnClear']) $(id).disabled = !!text;
}

async function scanCodes() {
  if (!state.connected) return;
  if (!state.vehicle) {
    toast('The car isn’t answering — turn the ignition ON and tap Retry.', 'error');
    return;
  }
  await withBusy(async () => {
    const elm = state.elm;
    const r = { at: new Date() };
    setCodesBusy('Checking the check-engine light…');
    try {
      r.status = await elm.readMonitorStatus();
    } catch (err) {
      r.statusError = err;
    }
    for (const [name, mode] of [
      ['stored', 0x03],
      ['pending', 0x07],
      ['permanent', 0x0a],
    ]) {
      setCodesBusy(`Reading ${name} codes…`);
      try {
        r[name] = await elm.readDtcs(mode);
      } catch (err) {
        r[name] = { codes: [], error: err };
      }
    }
    if (r.stored.codes.length || r.status?.mil) {
      setCodesBusy('Reading freeze frame…');
      try {
        r.freeze = await elm.readFreezeFrame(FREEZE_FRAME_PIDS.filter((p) => elm.supported.has(p)));
      } catch {
        r.freeze = null;
      }
    }
    state.codes = r;
  });
  setCodesBusy(null);
  renderCodes();
}

function renderCodes() {
  const r = state.codes;
  const mil = $('milCard');
  $('btnCopyReport').disabled = !r;
  if (!r) {
    mil.className = 'card mil';
    $('milTitle').textContent = 'Check-engine light';
    $('milSub').textContent = 'Tap “Scan for codes” to read trouble codes.';
    for (const k of ['Stored', 'Pending', 'Permanent']) {
      $('list' + k).textContent = '';
      $('count' + k).textContent = '–';
      $('count' + k).className = 'pill';
    }
    $('freezeCard').hidden = true;
    $('readinessCard').hidden = true;
    $('codesUpdated').textContent = '';
    $('codesBadge').hidden = true;
    return;
  }

  const s = r.status;
  const nStored = r.stored.codes.length;
  if (s) {
    mil.className = 'card mil ' + (s.mil ? 'on' : 'off');
    $('milTitle').textContent = s.mil ? 'Check-engine light is ON' : 'Check-engine light is OFF';
    $('milSub').textContent = s.mil
      ? `${nStored || s.dtcCount} stored code${(nStored || s.dtcCount) === 1 ? '' : 's'} turned it on.`
      : nStored
        ? `${nStored} stored code${nStored === 1 ? '' : 's'}, but none are lighting the lamp.`
        : r.pending.codes.length
          ? 'No stored codes. Keep an eye on the pending ones below.'
          : 'No trouble codes stored.';
  } else {
    mil.className = 'card mil';
    $('milTitle').textContent = 'Couldn’t read light status';
    $('milSub').textContent = r.statusError?.message || '';
  }

  renderCodeList('Stored', r.stored, 'stored');
  renderCodeList('Pending', r.pending, 'pending');
  renderCodeList('Permanent', r.permanent, 'permanent');

  const badgeCount = nStored + r.pending.codes.length;
  $('codesBadge').hidden = !badgeCount;
  $('codesBadge').textContent = badgeCount;

  // Freeze frame
  const ff = r.freeze;
  $('freezeCard').hidden = !ff;
  if (ff) {
    $('freezeDtc').textContent = ff.dtc;
    const dl = $('freezeList');
    dl.textContent = '';
    for (const [pid, bytes] of ff.values) {
      const sig = SIGNAL_BY_PID[pid];
      if (!sig?.decode) continue;
      const d = toDisplay(sig, sig.decode(bytes), settings.units);
      dl.append(kv(sig.short, `${formatValue(sig, d, settings.units)} ${unitLabel(sig, settings.units)}`.trim()));
    }
    if (!dl.childElementCount) dl.append(kv('Snapshot', 'No values stored'));
  }

  // Readiness monitors
  $('readinessCard').hidden = !s || !s.monitors.length;
  if (s && s.monitors.length) {
    const periodic = s.monitors.filter((m) => !m.continuous);
    const notReady = periodic.filter((m) => !m.complete).length;
    const pill = $('readyPill');
    pill.textContent = notReady ? `${notReady} not ready` : 'All complete';
    pill.className = 'pill ' + (notReady ? 'warn' : 'ok');
    $('readySub').textContent = notReady
      ? 'Some emissions self-tests haven’t finished since codes were last cleared or the battery was disconnected. Normal mixed driving (city + highway over a few days) completes them. Many US inspection programs allow one incomplete monitor on 2001+ vehicles.'
      : 'All emissions self-tests have finished — a good sign for an inspection, as long as the check-engine light is off.';
    const ul = $('readinessList');
    ul.textContent = '';
    for (const m of s.monitors) {
      ul.append(
        el(
          'li',
          {},
          el('span', { text: m.name }),
          el('span', { class: 'state ' + (m.complete ? 'ok' : 'no'), text: m.complete ? '✓ Complete' : '… Incomplete' })
        )
      );
    }
  }
  $('codesUpdated').textContent = `Last scanned ${r.at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function renderCodeList(Kind, res, cls) {
  const ul = $('list' + Kind);
  const count = $('count' + Kind);
  ul.textContent = '';
  if (res.error) {
    count.textContent = '?';
    count.className = 'pill';
    ul.append(el('li', { class: 'empty', text: res.error.message }));
    return;
  }
  if (Kind === 'Permanent' && res.negative != null && !res.codes.length) {
    count.textContent = 'n/a';
    count.className = 'pill';
    ul.append(el('li', { class: 'empty', text: 'This car doesn’t report permanent codes.' }));
    return;
  }
  const n = res.codes.length;
  count.textContent = n;
  count.className = 'pill ' + (!n ? 'ok' : Kind === 'Stored' ? 'crit' : 'warn');
  if (!n) {
    ul.append(el('li', { class: 'empty', text: 'None' }));
    return;
  }
  for (const code of res.codes) {
    const d = describeDtc(code);
    const link = el(
      'a',
      { href: `https://www.google.com/search?q=${encodeURIComponent(code + ' OBD2 code')}`, target: '_blank', rel: 'noopener' },
      'Look it up',
      icon('i-ext')
    );
    ul.append(
      el(
        'li',
        { class: 'code' },
        el('span', { class: 'code-id ' + cls, text: code }),
        el('span', { class: 'code-text', text: d.text }),
        el('span', { class: 'code-meta' }, el('span', { text: d.area }), link),
        d.hint ? el('span', { class: 'code-hint', text: d.hint }) : null
      )
    );
  }
}

function kv(label, value, mono = false) {
  return el('div', {}, el('dt', { text: label }), el('dd', { class: mono ? 'mono' : null, text: value }));
}

function openClearDialog() {
  if (!state.vehicle) {
    toast('The car isn’t answering — turn the ignition ON and tap Retry.', 'error');
    return;
  }
  const dlg = $('dlgClear');
  $('clearAck').checked = false;
  $('btnClearConfirm').disabled = true;
  dlg.returnValue = '';
  dlg.showModal();
}

$('clearAck').addEventListener('change', (e) => {
  $('btnClearConfirm').disabled = !e.target.checked;
});

$('dlgClear').addEventListener('close', () => {
  if ($('dlgClear').returnValue === 'confirm' && $('clearAck').checked) clearCodes();
});

async function clearCodes() {
  if (state.tab !== 'codes') setTab('codes');
  let result = null;
  await withBusy(async () => {
    setCodesBusy('Clearing codes…');
    try {
      result = await state.elm.clearDtcs();
    } catch (err) {
      result = { ok: false, reason: err.message };
    }
  });
  setCodesBusy(null);
  if (!result) return;
  if (result.ok) {
    logLine('info', 'Trouble codes cleared');
    toast('Codes cleared — checking again…');
  } else {
    toast(result.reason || 'The car didn’t confirm the clear.', 'error');
  }
  await sleep(1000);
  await scanCodes();
}

function buildReport() {
  const r = state.codes;
  const u = settings.units;
  const lines = [`OBD Dash report — ${r.at.toLocaleString()}`];
  if (state.vin) lines.push(`VIN: ${state.vin}`);
  if (state.elm) lines.push(`Protocol: ${state.elm.protocolName}`);
  if (r.status) lines.push(`Check-engine light: ${r.status.mil ? 'ON' : 'OFF'}`);
  for (const [title, res] of [
    ['Stored codes', r.stored],
    ['Pending codes', r.pending],
    ['Permanent codes', r.permanent],
  ]) {
    lines.push('', `${title}:`);
    if (!res.codes.length) lines.push('  none');
    for (const c of res.codes) lines.push(`  ${c} — ${describeDtc(c).text}`);
  }
  if (r.freeze) {
    lines.push('', `Freeze frame (${r.freeze.dtc}):`);
    for (const [pid, bytes] of r.freeze.values) {
      const sig = SIGNAL_BY_PID[pid];
      if (!sig?.decode) continue;
      lines.push(`  ${sig.label}: ${formatValue(sig, toDisplay(sig, sig.decode(bytes), u), u)} ${unitLabel(sig, u)}`.trimEnd());
    }
  }
  if (r.status?.monitors.length) {
    lines.push('', 'Readiness monitors:');
    for (const m of r.status.monitors) lines.push(`  ${m.name}: ${m.complete ? 'complete' : 'INCOMPLETE'}`);
  }
  return lines.join('\n');
}

async function copyReport() {
  if (!state.codes) return;
  const text = buildReport();
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = el('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Report copied — paste it into a text or email.');
}

// =============================================================== vehicle info

async function loadVehicleInfo(force = false) {
  renderVehicleInfo();
  if (!state.connected) return;
  await withBusy(async () => {
    const elm = state.elm;
    try {
      state.info.voltage = await elm.readVoltage();
    } catch {
      /* ignore */
    }
    if (state.vehicle) {
      if (state.vin === undefined || force) {
        try {
          state.vin = await elm.readVin();
        } catch {
          state.vin = null;
        }
      }
      for (const key of ['clearDist', 'milDist', 'runtime']) {
        if (!has(key)) continue;
        try {
          state.info[key] = await readSignal(key);
        } catch {
          /* ignore */
        }
      }
    }
  });
  renderVehicleInfo();
}

function renderVehicleInfo() {
  const dl = $('infoList');
  dl.textContent = '';
  if (!state.connected) return;
  const elm = state.elm;
  const u = settings.units;
  dl.append(kv('Adapter', state.transport.name));
  dl.append(kv('Adapter chip', [elm.info.version, elm.info.device].filter(Boolean).join(' · ') || '—'));
  if (state.transport.channel) dl.append(kv('Bluetooth channel', state.transport.channel, true));
  const v = state.info.voltage ?? state.values.battery;
  dl.append(kv('Battery', v != null ? `${v.toFixed(1)} V` : '—'));
  dl.append(kv('Car connection', state.vehicle ? 'Connected' : 'Not responding'));
  dl.append(kv('Protocol', state.vehicle ? elm.protocolName : '—'));
  dl.append(kv('VIN', state.vin === undefined ? (state.vehicle ? 'Reading…' : '—') : state.vin || 'Not reported', true));
  if (state.vehicle) {
    const live = SIGNALS.filter((s) => s.pid != null && !s.hidden && elm.supported.has(s.pid)).length;
    dl.append(kv('Live values available', `${live} (${elm.supported.size} PIDs)`));
  }
  for (const key of ['clearDist', 'milDist', 'runtime']) {
    if (state.info[key] == null) continue;
    const sig = SIGNAL_BY_KEY[key];
    dl.append(kv(sig.label, `${formatValue(sig, toDisplay(sig, state.info[key], u), u)} ${unitLabel(sig, u)}`.trim()));
  }
}

// =============================================================== console

function logLine(kind, text) {
  const log = $('consoleLog');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const prefix = { tx: '› ', rx: '‹ ', err: '! ', info: '· ' }[kind] || '';
  log.append(el('div', { class: kind }, el('time', { text: new Date().toLocaleTimeString([], { hour12: false }) }), prefix + text));
  while (log.childElementCount > 800) log.firstElementChild.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
}

async function sendConsole(raw) {
  const cmd = raw.trim().toUpperCase();
  if (!cmd) return;
  if (!state.connected) {
    logLine('err', 'Not connected');
    return;
  }
  if (/^0?4$/.test(cmd.replace(/\s+/g, ''))) {
    openClearDialog();
    return;
  }
  try {
    await state.elm.send(cmd, { timeout: 15000 });
  } catch {
    /* already logged */
  }
}

// =============================================================== recording

const recorder = {
  rec: null,
  timer: null,
  toggle() {
    if (this.rec) this.stop(true);
    else this.start();
  },
  start() {
    const shown = raceOn() ? raceDash.pollKeys().filter((k) => k !== 'mil') : activeTiles();
    const keys = [...new Set([...HERO_KEYS.filter(has), ...shown])];
    if (!keys.length) {
      toast('Nothing to record yet — the car isn’t sending live data.', 'error');
      return;
    }
    this.rec = { keys, units: settings.units, gps: useGps(), rows: [], started: Date.now() };
    $('btnRecord').classList.add('recording');
    const tick = () => {
      const s = Math.round((Date.now() - this.rec.started) / 1000);
      $('recLabel').textContent = `Stop ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      syncRaceControls();
    };
    tick();
    this.timer = setInterval(tick, 1000);
    toast('Recording — tap Stop to save a CSV file.');
  },
  sample() {
    const r = this.rec;
    if (!r) return;
    r.rows.push([
      new Date().toISOString(),
      ...r.keys.map((k) => {
        const sig = SIGNAL_BY_KEY[k];
        const d = toDisplay(sig, valueOf(k), r.units);
        return d == null ? '' : d.toFixed(Math.max(1, decimals(sig, r.units)));
      }),
    ]);
    if (r.rows.length > 500000) r.rows.shift();
  },
  stop(save) {
    const r = this.rec;
    if (!r) return;
    this.rec = null;
    clearInterval(this.timer);
    $('btnRecord').classList.remove('recording');
    $('recLabel').textContent = 'Record';
    syncRaceControls();
    if (save && r.rows.length) downloadCsv(r);
  },
};

function downloadCsv(r) {
  const esc = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const header = [
    'time',
    ...r.keys.map((k) => {
      const sig = SIGNAL_BY_KEY[k];
      const unit = unitLabel(sig, r.units);
      const label = k === 'speed' && r.gps ? 'GPS speed' : sig.label;
      return unit ? `${label} (${unit})` : label;
    }),
  ];
  const csv = [header.map(esc).join(','), ...r.rows.map((row) => row.join(','))].join('\n');
  const stamp = new Date(r.started).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const a = el('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: `obd-log-${stamp}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast(`Saved ${r.rows.length} samples to a CSV file.`);
}

// =============================================================== wake lock, toast, fullscreen

let wakeLock = null;
async function updateWakeLock() {
  const want = settings.keepAwake && state.connected && !document.hidden;
  if (want && !wakeLock && 'wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    } catch {
      /* not allowed right now */
    }
  } else if (!want && wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

let toastTimer = null;
function toast(message, kind = '') {
  const t = $('toast');
  t.textContent = message;
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), kind === 'error' ? 6000 : 3500);
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    toast('Full screen isn’t available in this browser.');
  }
}

// =============================================================== startup

let bleUsable = false;

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

async function checkSupport() {
  const note = $('supportNote');
  let html = '';
  if (!window.isSecureContext) {
    html = '<b>Bluetooth needs a secure page.</b> Open the app from its https:// address. Demo mode still works.';
  } else if (!BleTransport.supported && isIOS) {
    // Every iPhone browser except Web-Bluetooth browsers like Bluefy is Safari underneath.
    html = navigator.standalone
      ? '<b>Home-screen apps on iPhone can’t use Bluetooth.</b> Open this page in the free <b>Bluefy</b> browser instead.'
      : '<b>On iPhone, use the free Bluefy browser.</b> Safari and other iPhone browsers can’t talk to Bluetooth adapters. Install <b>Bluefy – Web BLE Browser</b> from the App Store, then open this page in it.';
    html += '<div class="note-actions"><button type="button" class="btn small" id="btnCopyLink">Copy link for Bluefy</button></div>';
  } else if (!BleTransport.supported) {
    html = '<b>This browser can’t use Bluetooth.</b> Use Chrome on Android, Chrome / Edge on Windows, Mac or ChromeOS, or Bluefy on iPhone. Demo mode still works.';
  } else {
    bleUsable = true;
    if (!(await BleTransport.available())) html = '<b>Bluetooth looks turned off.</b> Turn it on, then tap Connect.';
  }
  note.hidden = !html;
  note.innerHTML = html;
  $('btnCopyLink')?.addEventListener('click', async () => {
    const url = location.href.split(/[?#]/)[0];
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied — open Bluefy and paste it into the address bar.');
    } catch {
      toast(url);
    }
  });
  setConnectStatus(null);
}

function wireEvents() {
  $('btnConnect').addEventListener('click', () => connect('ble'));
  $('btnConnectAll').addEventListener('click', () => connect('ble', { showAll: true }));
  $('btnDemo').addEventListener('click', () => connect('demo'));
  $('btnDisconnect').addEventListener('click', disconnect);
  $('btnRetryVehicle').addEventListener('click', retryVehicle);
  for (const b of document.querySelectorAll('.tabs [data-tab]')) b.addEventListener('click', () => setTab(b.dataset.tab));
  $('btnCustomize').addEventListener('click', openCustomize);
  $('btnRecord').addEventListener('click', () => recorder.toggle());
  $('btnFullscreen').addEventListener('click', toggleFullscreen);
  $('btnScan').addEventListener('click', scanCodes);
  $('btnClear').addEventListener('click', openClearDialog);
  $('btnCopyReport').addEventListener('click', copyReport);
  $('btnRefreshInfo').addEventListener('click', () => loadVehicleInfo(true));
  $('consoleForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('consoleInput');
    sendConsole(input.value);
    input.value = '';
  });
  for (const chip of document.querySelectorAll('.chip[data-cmd]')) chip.addEventListener('click', () => sendConsole(chip.dataset.cmd));
  $('btnClearLog').addEventListener('click', () => ($('consoleLog').textContent = ''));
  document.addEventListener('visibilitychange', () => {
    updatePolling();
    updateWakeLock();
    updateGps();
  });
}

// Installable app (PWA)
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('btnInstall').hidden = false;
});
$('btnInstall').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  $('btnInstall').hidden = true;
});

const isLocalDev = ['localhost', '127.0.0.1'].includes(location.hostname) && !new URLSearchParams(location.search).has('sw');
if ('serviceWorker' in navigator && window.isSecureContext && !isLocalDev) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

wireEvents();
initSettingsUi();
checkSupport();
// The race dash sizes itself to the space under the app bar.
new ResizeObserver(([entry]) => {
  document.documentElement.style.setProperty('--appbar-h', `${Math.round(entry.target.getBoundingClientRect().height)}px`);
}).observe(document.querySelector('.appbar'));
// iPhone can't full-screen a web page; hide the button where it wouldn't work.
if (!document.fullscreenEnabled) $('btnFullscreen').hidden = true;
logLine('info', 'Ready. Connect an adapter to start.');

// Handy for poking at the app from the browser console.
window.obdDash = { state, settings };
