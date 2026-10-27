/**
 * C3's dolphin (src/drift/wandering/dolphin.ts). At last light only its outline reads, so its motion carries it
 * (the user, 2026-10-27: "motion curves and the speed / timing" over geometry). The v9 stand-in crept at 1.3 m/s
 * and bobbed in sine bumps, its body pitched by a curve of its own, and read as a hopping blob. What these hold:
 * it travels at a dolphin's pace; out of the water it falls as a body does; its body lies along its path; it
 * comes up only where the choreography says, and is out of sight between.
 */
import { describe, expect, it } from 'vitest';
import { DOLPHIN_SPAN, FLIP_TOP, SURFACINGS, dolphinPose } from '../src/drift/wandering/dolphin';

const G = 9.81;
const h = 1 / 240;

describe('the dolphin in c3', () => {
  it('travels at a dolphin pace between surfacings, slowing only for the flip', () => {
    const flipAt = SURFACINGS.find((s) => s[3] === 'flip')![0];
    for (let t = DOLPHIN_SPAN[0] + 1; t < DOLPHIN_SPAN[1] - 1; t += 0.05) {
      const v = dolphinPose(t).speed;
      expect(v).toBeLessThan(7.5);
      // (bottlenose cruising is 3–6 m/s; the stand-in's 1.3 m/s read as a float, not a swimmer)
      if (Math.abs(t - flipAt) > 3) expect(v).toBeGreaterThan(2);
    }
  });

  it('falls ballistically when out of the water, and clears it by what each leap asks', () => {
    for (const [at, , , kind, clear = 0] of SURFACINGS) {
      if (kind === 'roll') continue;
      let top = -Infinity;
      for (let t = at + 0.02; t < at + (2 * Math.sqrt(2 * G * clear)) / G - 0.02; t += 0.01) {
        const y0 = dolphinPose(t - h).y;
        const y1 = dolphinPose(t).y;
        const y2 = dolphinPose(t + h).y;
        expect((y2 - 2 * y1 + y0) / (h * h)).toBeCloseTo(-G, 1);
        top = Math.max(top, y1);
      }
      expect(top).toBeCloseTo(clear, 1);
    }
  });

  it('lies along its own path: the nose points where the body is going', () => {
    for (let t = DOLPHIN_SPAN[0] + 0.5; t < DOLPHIN_SPAN[1] - 0.5; t += 0.037) {
      const a = dolphinPose(t - h);
      const b = dolphinPose(t + h);
      const vy = (b.y - a.y) / (2 * h);
      const vh = Math.hypot(b.x - a.x, b.z - a.z) / (2 * h);
      if (vh < 0.5) continue;
      expect(dolphinPose(t).pitch).toBeCloseTo(Math.atan2(vy, vh), 1);
    }
  });

  it('is out of sight between surfacings, and its back breaks the water at each roll', () => {
    // (at last light a body a metre down is gone; an always-visible dolphin is a toy on a stick)
    for (const [at, , , kind] of SURFACINGS) {
      if (kind === 'roll') expect(dolphinPose(at).y).toBeGreaterThan(-0.3);
    }
    // (half-way between two surfacings its back, ~0.3 m over its centre, is a good way under)
    const gaps = SURFACINGS.slice(1).map((s, i) => (SURFACINGS[i][0] + s[0]) / 2);
    for (const t of gaps) expect(dolphinPose(t).y + 0.32).toBeLessThan(-0.4);
  });

  it('flips the case from high, its head up, close by the raft\'s sunward end', () => {
    const f = dolphinPose(FLIP_TOP);
    expect(f.y).toBeGreaterThan(1);
    expect(f.pitch).toBeGreaterThan(-0.2);
    // c3's raft (beats.ts): 10° right at 10 m, bow ahead; its centre log is 13.7 m (params/raft.ts), so its bow,
    // the end toward the Sun, is ~6.9 m beyond. The case has to make the deck from the snout
    const bow = [Math.sin((10 * Math.PI) / 180) * 10, Math.cos((10 * Math.PI) / 180) * 10 + 6.85];
    expect(Math.hypot(f.x - bow[0], f.z - bow[1])).toBeLessThan(5);
  });
});
