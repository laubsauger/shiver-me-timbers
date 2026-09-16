/**
 * §T.186 — the NPC's picture of its own boat is MEASURED from the real physics, and its helm limits keep it out of
 * the hook envelope.
 *
 * WHY: the speed profile and the steer map are built from `capability.ts`, a committed table. If the physics (or
 * the TEMPORARY stand-in thrust, T166) moves and the table does not, every NPC brakes for corners it could take
 * flat or flies into corners it cannot turn — silently, as "the AI is slow / runs wide". So the table is re-measured
 * here with the same code that produced it, and must agree.
 *
 * The lock schedule is the NPC's no-hook guarantee (physics-log T179 part 3: half lock hooks from C_v 7, full lock
 * from C_v 3; USER: a high-speed hook is a legit crash for a player's aggressive helm, not something a rival does by
 * accident). It is checked in the worst case the controller can produce — full throttle held through the entry at
 * the pilot's own helm rate. Extra helm must increase bank; the 4 MW stress hull must still hook past the schedule.
 */
import { describe, expect, it } from 'vitest';
import { CHINE_BEAM, DEG, HELM_RATE, MEASURED, TOP_SPEED, curvatureAt, lockLimit } from '../src/race/ai/capability';
import { measureCapability, measureLockEntry, measureTurn } from '../src/race/ai/measure';

const close = (a: number, b: number, rel: number, abs: number): boolean => Math.abs(a - b) <= Math.max(abs, rel * Math.abs(b));

describe('§T.186 measured capability', () => {
  it('the committed table is what the physics measures today (re-run capability.ts#MEASURED from measure.ts if not)', () => {
    const m = measureCapability();
    const bad: string[] = [];
    if (!close(m.topSpeed, MEASURED.topSpeed, 0.01, 0.05)) bad.push(`topSpeed ${m.topSpeed} vs ${MEASURED.topSpeed}`);
    for (const key of ['accel', 'coast', 'reverse'] as const) {
      expect(m[key].length, key).toBe(MEASURED[key].length);
      m[key].forEach(([v, a], k) => {
        if (v !== MEASURED[key][k][0] || !close(a, MEASURED[key][k][1], 0.02, 0.02)) bad.push(`${key}[${v}] ${a} vs ${MEASURED[key][k][1]}`);
      });
    }
    m.turns.forEach((col, c) => {
      col.rows.forEach(([v, k, t], r) => {
        const [v0, k0, t0] = MEASURED.turns[c].rows[r];
        if (!close(v, v0, 0.01, 0.05) || !close(k, k0, 0.02, 2e-5) || !close(t, t0, 0.02, 0.01)) bad.push(`turn ${col.steerDeg}° row ${r}: [${v}, ${k}, ${t}] vs [${v0}, ${k0}, ${t0}]`);
      });
    });
    expect(bad, JSON.stringify(m)).toEqual([]);
  }, 120_000);

  it('turning capability is not a constant lateral g: curvature at the lock falls with speed, lateral accel rises', () => {
    // why the profile bisects on the table instead of v = √(a_lat/κ) with one number
    const lock = 12.5 * DEG;
    const speeds = [6, 10, 14, 18, 22, 25];
    for (let k = 1; k < speeds.length; k++) expect(curvatureAt(speeds[k], lock)).toBeLessThan(curvatureAt(speeds[k - 1], lock));
    const aLat = (v: number): number => v * v * curvatureAt(v, lock);
    expect(aLat(25) / aLat(10)).toBeGreaterThan(2);
  });

  it('a positive drive angle turns the bow to port — the sign the pilot inverts for a starboard curvature', () => {
    expect(measureTurn(14, 10 * DEG, {}, 4).yawSign).toBe(-1);
  }, 60_000);
});

describe('§T.186 no-hook lock schedule', () => {
  // up to the measured top speed (T196: 33.4 m/s on the engine model; the list ended at the stand-in's 29.5)
  const speeds = [6, 10, 14, 18, 22, 26, 30, TOP_SPEED - 0.5];

  it('at the schedule, full throttle through a 15°/s helm entry never departs (default drives, 6 m/s to top speed)', () => {
    for (const v of speeds) {
      const r = measureLockEntry(v, lockLimit(v), {}, 10, HELM_RATE);
      expect(r.departed, `${v} m/s at ${(lockLimit(v) / DEG).toFixed(1)}°: peak tilt ${r.maxTiltDeg.toFixed(1)}°`).toBe(false);
    }
  }, 120_000);

  it('the schedule also holds for faster drives (4 MW power scale, C_v 7–10), the speeds half and full lock hook at with a 30°/s helm', () => {
    for (const cv of [7, 8, 10]) {
      const v = cv * Math.sqrt(9.81 * CHINE_BEAM);
      const r = measureLockEntry(v, lockLimit(v), { standInDrivePowerW: 4e6 }, 10, HELM_RATE);
      expect(r.departed, `C_v ${cv} at ${(lockLimit(v) / DEG).toFixed(1)}°: peak tilt ${r.maxTiltDeg.toFixed(1)}°`).toBe(false);
    }
  }, 120_000);

  it('past the schedule bank increases, and 50 % past it still hooks the 4 MW stress hull at C_v 7–10', () => {
    // Separating topsides from planing removes the old stock-drive capsizes. More helm still banks harder;
    // the higher-power mutation keeps a real departure case without requiring stock boats to roll over.
    for (const v of speeds) {
      const safe = measureLockEntry(v, lockLimit(v), {}, 10, HELM_RATE);
      const wide = measureLockEntry(v, 1.6 * lockLimit(v), {}, 10, HELM_RATE);
      expect(wide.maxTiltDeg, `${v} m/s: additional helm increases bank`).toBeGreaterThan(safe.maxTiltDeg);
    }
    for (const cv of [7, 8, 10]) {
      const v = cv * Math.sqrt(9.81 * CHINE_BEAM);
      expect(measureLockEntry(v, 1.5 * lockLimit(v), { standInDrivePowerW: 4e6 }, 10, HELM_RATE).departed, `C_v ${cv}`).toBe(true);
    }
  }, 120_000);
});
