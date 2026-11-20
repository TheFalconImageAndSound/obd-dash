// Transmission gear, as reported by the car itself.
//
// Mode 01 PID A4, "Transmission actual gear", is supported by some newer cars:
// A bit 1 = the reading is supported, B bits 7–4 = current gear (0 = neutral).
// Cars that don't support it simply don't show a gear — nothing is guessed.

export function decodeGearPid(d) {
  if (!d || d.length < 2 || !(d[0] & 0x02)) return null;
  return d[1] >> 4;
}

/** Remove gear-ratio data saved by an earlier version that estimated the gear. */
export function forgetLearnedGears(storage = globalThis.localStorage) {
  try {
    const old = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith('obddash.gears.')) old.push(k);
    }
    old.forEach((k) => storage.removeItem(k));
  } catch {
    /* storage blocked */
  }
}
