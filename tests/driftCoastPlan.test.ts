/**
 * Our island's plan (src/drift/wandering/coast.ts OURS_PLAN; the user, 2026-10-30, from the air: "does it really need
 * to be such an even width? … this perfectly straight and even bar, unnecessarily so"). What must hold:
 *
 *   - THE WALK'S BEACH IS THE SAME (to a micrometre): from w2's landing to w5 the eye walks it, and the swash sim's
 *     domain (swashSim.ts SWASH: along −110..+90, off −14.5..+19.5), the dressing and the shoreline are tuned on it.
 *     Over along −175..+275, from the lagoon floor in to the eye's line along the top of the beach (off −8), the ground
 *     is what it was; behind it (the scrub and the forest floor, which feel the far shore through motuHeight's smooth
 *     min) it moves by ≤ 3 cm;
 *   - the island is no longer an even bar: its width varies threefold and more, with a neck and a lobe;
 *   - our island's radio tower stands on land where it stood (radioTower.ts OURS_MAST);
 *   - the spit carries the island on past where its point was, out into the lagoon;
 *   - THE WATERLINE WANDERS WITHOUT A BEAT (the user, 2026-11-02, a zigzag drawn over the 735 s view: the wet line
 *     "too wonky, too wobbly … not so regular … different rhythms and intervals"): along the walk's beach no single
 *     alongshore wavelength over 4–80 m carries more than a quarter of the waterline's wander (its beach cusps had
 *     been one sine every 24 m: 53–60 % of it).
 */
import { describe, expect, it } from 'vitest';
import { OURS_PLAN, oursHeight } from '../src/drift/wandering/coast';
import { OURS_MAST } from '../src/drift/wandering/radioTower';
import { SWASH } from '../src/drift/wandering/swashSim';

describe('our island\'s plan', () => {
  it('leaves the walk\'s beach and the swash sim\'s sand exactly as they were', () => {
    // (the sim's domain in beach coordinates: off = −(x0 offset) …, along = −(z offset) …)
    const off0 = -(SWASH.x0 + SWASH.nx * SWASH.cell);
    const off1 = -SWASH.x0;
    const along0 = -(SWASH.z0 + SWASH.nz * SWASH.cell);
    const along1 = -SWASH.z0;
    for (let a = along0; a <= along1; a += 0.7) {
      for (let o = off0; o <= off1; o += 0.31) expect(Math.abs(oursHeight(a, o) - oursHeight(a, o, false))).toBeLessThan(1e-6);
    }
    // the whole walk, from the lagoon's floor in to the eye's line along the top of the beach (beats.ts: off −8)
    for (let a = -175; a <= 275; a += 1.3) {
      for (let o = -8; o <= 320; o += 1.7) expect(Math.abs(oursHeight(a, o) - oursHeight(a, o, false))).toBeLessThan(1e-6);
    }
  });

  it('moves the scrub and forest floor behind the walk\'s berm by no more than 3 cm', () => {
    let worst = 0;
    for (let a = -175; a <= 275; a += 2.3) {
      for (let o = -130; o <= -8; o += 1.9) worst = Math.max(worst, Math.abs(oursHeight(a, o) - oursHeight(a, o, false)));
    }
    expect(worst).toBeLessThan(0.03);
  });

  it('is no longer an even bar: a neck, a lobe, the width varying threefold and more', () => {
    const widths = Array.from({ length: 121 }, (_, i) => OURS_PLAN.width(-900 + i * 10));
    expect(Math.max(...widths) / Math.min(...widths.filter((w) => w > 0))).toBeGreaterThan(3.5);
    expect(OURS_PLAN.width(-400)).toBeLessThan(120);
    expect(OURS_PLAN.width(-680)).toBeGreaterThan(360);
  });

  it('keeps our island\'s radio tower on land, and carries the island out along the spit', () => {
    expect(oursHeight(OURS_MAST.along, OURS_MAST.off)).toBeGreaterThan(1.5);
    // (the old point ended at +440; the spit stands out of the water on to +640, well out into the lagoon)
    expect(OURS_PLAN.shore(560)).toBeGreaterThan(OURS_PLAN.shore(480) + 30);
    expect(OURS_PLAN.shore(640)).toBeGreaterThan(OURS_PLAN.shore(560) + 40);
    for (const a of [480, 560, 640]) {
      // its crest out of the water
      let top = -Infinity;
      for (let o = -100; o <= 400; o += 2) top = Math.max(top, oursHeight(a, o));
      expect(top, `at along ${a}`).toBeGreaterThan(0.5);
    }
  });

  it('wanders its waterline along the walk\'s beach with no dominant period (no regular zigzag of cusps)', () => {
    const dz = 0.5;
    for (const level of [0.05, 0.15, 0.3]) {
      // the waterline's off (m) at `level` m over the sea, every 0.5 m along −100..+156 (the walk's sand)
      const xs: number[] = [];
      for (let along = -100; along < 156; along += dz) {
        let land = -30;
        let sea = 40;
        for (let k = 0; k < 30; k++) {
          const m = (land + sea) / 2;
          if (oursHeight(along, m) > level) land = m;
          else sea = m;
        }
        xs.push((land + sea) / 2);
      }
      // less its 120 m running mean (the plan's own curve), then its power by wavelength
      const n = xs.length;
      const d = xs.map((x, i) => {
        let s = 0;
        let c = 0;
        for (let k = Math.max(0, i - 120); k < Math.min(n, i + 120); k++) (s += xs[k]), c++;
        return x - s / c;
      });
      let total = 0;
      let peak = 0;
      for (let f = 1; f < n / 2; f++) {
        const lambda = (n * dz) / f;
        if (lambda < 4 || lambda > 80) continue;
        let re = 0;
        let im = 0;
        for (let i = 0; i < n; i++) {
          const a = (2 * Math.PI * f * i) / n;
          re += d[i] * Math.cos(a);
          im -= d[i] * Math.sin(a);
        }
        const p = re * re + im * im;
        total += p;
        peak = Math.max(peak, p);
      }
      expect(peak / total).toBeLessThan(0.25);
    }
  });
});
