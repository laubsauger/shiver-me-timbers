/**
 * SPEED-LIMITED LOCK + HELM SLEW (§T.182; §T.179 USER DECISION: physics honest, the default assist limits the drive
 * angle with speed so ordinary full-stick play never hooks; with it off the hull hooks exactly where the physics does).
 *
 * THE CURVE IS THE MEASURED ENVELOPE, NOT A TASTE KNOB. Raw physics (assists off, flat water, 30°/s helm held at a
 * fixed drive angle for 20 s after a speed-held straight, throttle frozen; scratch sweep T182, same harness as
 * physics-log T179 part 3), peak heel in degrees, H = hooked (heel or slip past 45°):
 *
 *   C_v   12°   14°   16°   18°   20°   24°   30°
 *   1     8     9     11    12    13    15    18
 *   1.5   15    17    19    21    23    29    40
 *   2     18    21    24    28    36    H     H
 *   2.5   18    21    25    33    44    H     H
 *   3     17    20    24    33    40    H     H
 *   4     16    20    24    29    H     H     H
 *   5     17    21    26    H     H     H     H
 *   6     19    24    31    H     H     H     H
 *   7     22    26    H     H     H     H     H
 *   8     24    H     H     H     H     H     H
 *   9     25    H     H     H     H     H     H
 *   10    29    H     H     H     H     H     H
 *
 * RULE: lock(C_v) = min(first hooking angle − 2°, largest angle with peak heel ≤ 30°) on that 2° grid, made
 * non-increasing with speed (C_v 4 alone would allow 18°; a lock that OPENS as she speeds up reads as a bug).
 * Then re-validated DYNAMICALLY, the lock read off the live speed as she slows in the turn with full stick held
 * (tests/speedboatAssist.test.ts, C_v 3–10: no hook, heel ≤ 35°). That pass tightened C_v 1.5/2 from 24°/18° to
 * 20°/16°: a C_v 3 turn bleeds to C_v 1.6 (U/U_a 0.54) and the wider lock there peaked at 33.9° of heel, 14 s in;
 * now 24.2°. (Limiting how fast the lock may OPEN, 3°/s, changed nothing measurable and was removed.)
 * At top speed (42 m/s, C_v 8.8) the rule gives the ±12° the user asked for. The margin there is ONE grid step
 * (14° hooks), and the 30°/s helm is part of it: at 60°/s the curve ALONE hooks at C_v 7 and 10 (with the heel
 * guard below it does not: peak heel 23.5–26.4°).
 */
import { GRAVITY } from './simSample';

/** chine beam of deepV12 (HULL_DATA.spec.chineHalfBeam·2) — C_v = U/√(g·B), the envelope's speed axis */
export const ENVELOPE_BEAM = 2.3;

/** [C_v, drive lock deg] — piecewise linear, flat beyond the ends */
export const SAFE_LOCK_CURVE: readonly (readonly [number, number])[] = Object.freeze([
  [1.0, 30],
  [1.5, 20],
  [2.0, 16],
  [2.5, 16],
  [5.0, 16],
  [6.0, 14],
  [7.0, 14],
  [8.0, 12],
  [10.0, 12],
]);

export function speedCoefficient(speed: number, beam = ENVELOPE_BEAM): number {
  return speed / Math.sqrt(GRAVITY * beam);
}

/** the curve's lock at a C_v, rad */
export function safeLockRad(cv: number): number {
  const c = SAFE_LOCK_CURVE;
  let deg: number;
  if (cv <= c[0][0]) deg = c[0][1];
  else if (cv >= c[c.length - 1][0]) deg = c[c.length - 1][1];
  else {
    let i = 1;
    while (c[i][0] < cv) i++;
    const t = (cv - c[i - 1][0]) / (c[i][0] - c[i - 1][0]);
    deg = c[i - 1][1] + (c[i][1] - c[i - 1][1]) * t;
  }
  return (deg * Math.PI) / 180;
}

/**
 * HEEL GUARD (part of the same dial). The curve above is FLAT-WATER data; in a sea the curve alone hooks almost
 * everywhere. The hook is a heel runaway (physics-log T179 round 2: past ~22° the inner panel goes flat and grip
 * collapses), so the lock is scaled down with heel, through the helm, as a driver eases off when the chine digs:
 * ×1 up to 20°, linearly to ×0.3 at 32°.
 * Measured (T182 scratch; crossing swell 0.6·A sin(k₁…) + 0.3·A sin(k₂…), λ 100 m / 52 m, deep-water ω; A 0.66 and 1;
 * 4 sea headings × both turn directions × C_v 4/6/8/10 = 64 runs, full stick 20 s):
 *   curve alone          63 / 64 hook
 *   guard 20°→32°, ×0.3  27 / 64 hook  (C_v 4: 2, 6: 2, 8: 11, 10: 12)   ← kept
 *   guard 16°→28°, ×0.3  23 / 64;  18°→30°, ×0.2  21 / 64;  20°→30°, ×0  21 / 64 — no variant fixes C_v 8–10.
 * Flat water, guard on: peak heel 23.0–24.6° at C_v 3–10 (35° bar), and at 60°/s helm no hook either.
 * WHY NO VARIANT FIXES IT: the raw physics hooks in that sea at drive angles no assist can refuse a racer — C_v 8:
 * 4° of drive hooks 3/16, 6° 9/16; C_v 10: 4° 8/16, 6° 11/16 (flat water: 12° is steady). That is a hull
 * roll-stability-in-waves problem for the physics owner (docs/speedboat/controls.md hooks), pinned by an `it.fails`
 * in tests/speedboatAssist.test.ts. COST of the guard: in a flat steady turn at top speed the heel sits in the guard
 * band, so the lock in force settles near 9° instead of the curve's 12° (C_v 10: 8.8°). Nominal lock stays ±12°.
 */
export const HEEL_GUARD_START = (20 * Math.PI) / 180;
export const HEEL_GUARD_FULL = (32 * Math.PI) / 180;
export const HEEL_GUARD_MIN = 0.3;

export function heelGuard(rollRad: number): number {
  const a = Math.abs(rollRad);
  if (!(a > HEEL_GUARD_START)) return 1;
  const t = Math.min(1, (a - HEEL_GUARD_START) / (HEEL_GUARD_FULL - HEEL_GUARD_START));
  return 1 - (1 - HEEL_GUARD_MIN) * t;
}

/** the lock the helm may use: raw drive lock blended toward the heel-guarded safe curve by the dial (never above the raw lock) */
export function assistedLockRad(speed: number, driveLockRad: number, dial: number, rollRad = 0): number {
  const d = dial < 0 ? 0 : dial > 1 ? 1 : dial;
  const safe = Math.min(driveLockRad, safeLockRad(speedCoefficient(speed)) * heelGuard(rollRad));
  return driveLockRad + (safe - driveLockRad) * d;
}

/**
 * One helm step: stick (−1…1, + = right) → drive angle, rad, in HullWater's sign, which is the SAME sense: + yaws the
 * bow toward body −x, and body −x is the pilot's RIGHT (y up, z bow, right-handed ⇒ +x is to port; the page's
 * structure test measures D turning her right). The target is stick·lock; the helm moves toward it at `rateRad`/s.
 * A target that shrinks because the lock closed with speed is followed at the same rate (no snap).
 */
export function stepHelm(helmRad: number, stick: number, lockRad: number, rateRad: number, dt: number): number {
  const s = stick < -1 ? -1 : stick > 1 ? 1 : stick;
  const target = s * lockRad;
  const max = rateRad * dt;
  const d = target - helmRad;
  return helmRad + (d > max ? max : d < -max ? -max : d);
}
