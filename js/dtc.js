// Diagnostic trouble codes (DTCs) and readiness monitors.

import { DTC_CODES } from './dtc-codes.js';

/** Two raw bytes -> "P0301" style code. */
export function decodeDtc(a, b) {
  const system = 'PCBU'[a >> 6];
  return (
    system +
    ((a >> 4) & 0x3).toString() +
    (a & 0xf).toString(16).toUpperCase() +
    b.toString(16).toUpperCase().padStart(2, '0')
  );
}

/**
 * Decode Mode 03 / 07 / 0A replies.
 * On CAN the byte after the service ID is a count of codes; older protocols
 * send fixed 3-code lines padded with 00 00.
 */
export function decodeDtcMessages(msgs, mode, isCan) {
  const sid = 0x40 + mode;
  const codes = [];
  let responded = false;
  let negative = null;
  for (const m of msgs) {
    if (m[0] === 0x7f && m[1] === mode) {
      negative = m[2] ?? 0;
      continue;
    }
    if (m[0] !== sid) continue;
    responded = true;
    let data = m.slice(1);
    if (isCan) {
      const count = data[0] ?? 0;
      data = data.slice(1, 1 + count * 2);
    }
    for (let i = 0; i + 1 < data.length; i += 2) {
      if (data[i] === 0 && data[i + 1] === 0) continue;
      const code = decodeDtc(data[i], data[i + 1]);
      if (!codes.includes(code)) codes.push(code);
    }
  }
  return { codes, responded, negative };
}

const SYSTEMS = { P: 'Powertrain', C: 'Chassis', B: 'Body', U: 'Network' };
const P_AREAS = {
  0: 'Fuel, air & emissions',
  1: 'Fuel & air metering',
  2: 'Fuel & air metering (injectors)',
  3: 'Ignition system or misfire',
  4: 'Auxiliary emission controls',
  5: 'Speed, idle control & inputs',
  6: 'Computer & output circuits',
  7: 'Transmission',
  8: 'Transmission',
  9: 'Transmission',
  A: 'Hybrid propulsion',
  B: 'Hybrid propulsion',
  C: 'Hybrid propulsion',
};

const HINTS = [
  [
    /^P03(0\d|1[0-2])$/,
    'Misfires can overheat the catalytic converter. If the check-engine light is flashing, ease off and get it checked soon. Usual suspects: spark plugs, ignition coils, injectors, vacuum leaks.',
  ],
  [
    /^P0(171|174)$/,
    'Too much air or too little fuel. Common causes: vacuum/intake leak, dirty MAF sensor, weak fuel pump or clogged filter.',
  ],
  [/^P0(172|175)$/, 'Too much fuel. Common causes: leaking injector, high fuel pressure, dirty MAF sensor, faulty O2 sensor.'],
  [
    /^P04(20|21|30|31)$/,
    'Usually a worn catalytic converter, but exhaust leaks or a lazy downstream O2 sensor can cause it too. Fix any misfire or fuel-trim codes first.',
  ],
  [/^P04(4\d|5[0-7])$/, 'EVAP system leak or fault. Start with the easy one: make sure the gas cap clicks tight and its seal isn’t cracked.'],
  [/^P0128$/, 'The engine is warming up too slowly — most often a thermostat stuck open.'],
  [/^P010[0-4]$/, 'Mass air flow sensor problem. Check for a dirty sensor, air leaks after it, or a loose connector.'],
  [/^P056[0-3]$/, 'Charging-system voltage problem — have the battery and alternator tested.'],
  [/^U0/, 'Communication fault between the car’s computers. Check battery voltage, connectors and ground straps.'],
];

export function describeDtc(code) {
  const sys = code[0];
  const d1 = code[1];
  const known = DTC_CODES[code];
  const manufacturer =
    sys === 'P' ? d1 === '1' || (d1 === '3' && parseInt(code.slice(2), 16) < 0x400) : d1 === '1' || d1 === '2';
  const area = sys === 'P' ? P_AREAS[code[2]] : null;
  const hint = HINTS.find(([re]) => re.test(code))?.[1] || null;
  return {
    code,
    text:
      known ||
      (manufacturer ? 'Manufacturer-specific code — look up the meaning for your make' : 'Generic code (not in the offline list)'),
    area: area ? `${SYSTEMS[sys]} · ${area}` : SYSTEMS[sys] || 'Unknown system',
    manufacturer,
    known: !!known,
    hint,
  };
}

/**
 * Mode 01 PID 01: check-engine light, code count and readiness monitors.
 * Availability bits say which monitors the car has; completeness bits are 1 while a test is still incomplete.
 */
export function decodeMonitorStatus([A, B, C, D]) {
  const mil = !!(A & 0x80);
  const dtcCount = A & 0x7f;
  const diesel = !!(B & 0x08);
  const monitors = [];
  const continuous = [
    ['Misfire', 0],
    ['Fuel system', 1],
    ['Comprehensive components', 2],
  ];
  for (const [name, bit] of continuous) {
    if (B & (1 << bit)) monitors.push({ name, complete: !(B & (1 << (bit + 4))), continuous: true });
  }
  const names = diesel
    ? ['NMHC catalyst', 'NOx / SCR aftertreatment', null, 'Boost pressure', null, 'Exhaust gas sensor', 'Particulate filter', 'EGR / VVT']
    : ['Catalyst', 'Heated catalyst', 'Evaporative (EVAP) system', 'Secondary air', 'A/C refrigerant', 'Oxygen sensor', 'Oxygen sensor heater', 'EGR / VVT'];
  names.forEach((name, bit) => {
    if (name && C & (1 << bit)) monitors.push({ name, complete: !(D & (1 << bit)), continuous: false });
  });
  return { mil, dtcCount, diesel, monitors };
}
