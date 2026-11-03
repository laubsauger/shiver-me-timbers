/**
 * THE BIOLUMINESCENT SURF (params biolum, off by default; the user, 2026-11-02: glowing plankton for "the rather dark
 * beach section at the end"), its two pure-in-t parts:
 *   - THE GLOW the swash sim carries (swashSim.ts THE GLOW, on its CPU reference): plankton light only where the water
 *     is stirred — a lake at rest stays dark — and a breaking wave's light flashes and is gone within a couple of
 *     seconds while the foam it made lingers (a glow that lingered with the foam would lie on the water as the flat,
 *     static band the brief rules out: "never a flat glow");
 *   - THE ONSET (biolumGlow.ts BIOLUM_ONSET; the 2026-11-03 note on the master: "it needs to fade in slowly and
 *     smoothly, instead of suddenly appearing"): the glow as the frame shows it — each pass's darkness gate by its own
 *     Sun, × its weight in w5–w6's dissolve, × the onset — rises over tens of seconds with no step a frame;
 *   - THE PRINTS (biolum.ts createFootfalls): where the wanderers' feet came down, found from the walk's own history,
 *     so they fall under the walkers, left and right in turn a step apart, none while a walker stands still, none
 *     older than their life — and the same prints for a frame whatever frames were drawn before it (every frame of the
 *     film is a pure function of t: render lanes draw in any order).
 */
import { describe, expect, it } from 'vitest';
import { float, vec3 } from 'three/tsl';
import { stepSwashCpu, swashAtRest, SWASH_DT, SWASH, type SwashGrid } from '../src/drift/wandering/swashSim';
import { createFilmCoast } from '../src/drift/wandering/coast';
import { C1_FOLLOW, beatStarts, beatSun, beatsAt, spec } from '../src/drift/wandering/beats';
import { wanderer, wetSand } from '../src/drift/wandering/props';
import { createFootfalls } from '../src/drift/wandering/biolum';
import { biolumOnset, biolumSunGate } from '../src/drift/wandering/biolumGlow';

/** our beach's profile at its middle (as tests/swashSim.test.ts): m over the sea at m from the waterline */
function beachStrip(nz: number): { nx: number; nz: number; bed: Float64Array } {
  const PROFILE: Array<[number, number]> = [[-24, -0.94], [-20, -0.87], [-16, -0.76], [-12, -0.64], [-8, -0.48], [-4, -0.25], [0, 0.06], [4, 0.4], [8, 0.74], [12, 1.04], [16, 1.3]];
  const at = (x: number): number => {
    for (let k = 1; k < PROFILE.length; k++) if (x <= PROFILE[k][0]) return PROFILE[k - 1][1] + ((x - PROFILE[k - 1][0]) / (PROFILE[k][0] - PROFILE[k - 1][0])) * (PROFILE[k][1] - PROFILE[k - 1][1]);
    return PROFILE[PROFILE.length - 1][1];
  };
  const nx = SWASH.nx;
  const bed = new Float64Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) bed[i + j * nx] = at(SWASH.x0 + (i + 0.5) * SWASH.cell);
  return { nx, nz, bed };
}
const withGlow = (g: SwashGrid): SwashGrid => ({ ...g, glow: new Float64Array(g.h.length) });
const clone = (g: SwashGrid): SwashGrid => ({ ...g, h: g.h.slice(), hu: g.hu.slice(), hv: g.hv.slice(), foam: g.foam.slice(), wet: g.wet.slice(), glaze: g.glaze.slice(), strand: g.strand.slice(), glow: g.glow?.slice() });

describe('the glow the swash carries', () => {
  it('stays dark in still water: the plankton light only where the water is stirred', () => {
    const { nx, bed } = beachStrip(2);
    let a = withGlow(swashAtRest(nx, 2, SWASH.cell, bed));
    let b = clone(a);
    for (let n = 0; n < 2000; n++) {
      stepSwashCpu(a, b, n * SWASH_DT, SWASH_DT, { seaward: 'wall', ends: 'open', friction: true, infiltration: true });
      [a, b] = [b, a];
    }
    expect(Math.max(...a.glow!)).toBe(0);
  });

  it('flashes where a wave breaks and is gone within a couple of seconds, while the foam it made lingers', () => {
    const { nx, bed } = beachStrip(2);
    let a = withGlow(swashAtRest(nx, 2, SWASH.cell, bed));
    let b = clone(a);
    const n0 = Math.round(590 / SWASH_DT);
    const n1 = Math.round(640 / SWASH_DT);
    // each cell's glow and foam, every 0.05 s
    const every = Math.round(0.05 / SWASH_DT);
    const glow: number[][] = [];
    const foam: number[][] = [];
    for (let n = n0; n < n1; n++) {
      stepSwashCpu(a, b, n * SWASH_DT, SWASH_DT, { seaward: 'generate', ends: 'open', z0: 12, friction: true, infiltration: true });
      [a, b] = [b, a];
      if ((n - n0) % every) continue;
      glow.push(Array.from(a.glow!.subarray(0, nx)));
      foam.push(Array.from(a.foam.subarray(0, nx)));
    }
    // (the waves broke and lit the water: a flash near whole somewhere, after the warm-up)
    const warm = Math.round(15 / 0.05);
    let peak = 0;
    for (let s = warm; s < glow.length; s++) peak = Math.max(peak, ...glow[s]);
    expect(peak).toBeGreaterThan(0.6);
    // (at each flash — a cell's glow at a local peak over 0.5 — how long until it is a tenth of it, and how much of the
    // foam is left then)
    const fades: number[] = [];
    const foamLeft: number[] = [];
    for (let i = 0; i < nx; i++) {
      for (let s = warm; s < glow.length - 80; s++) {
        const g = glow[s][i];
        if (g < 0.5 || g < glow[s - 1][i] || g < glow[s + 1][i]) continue;
        let k = s;
        while (k < glow.length - 1 && glow[k][i] > 0.1 * g) k++;
        fades.push((k - s) * 0.05);
        if (foam[s][i] > 0.2) foamLeft.push(foam[k][i] / foam[s][i]);
      }
    }
    fades.sort((x, y) => x - y);
    foamLeft.sort((x, y) => x - y);
    const median = (v: number[]): number => v[Math.floor(v.length / 2)];
    console.log(`[biolum glow] ${fades.length} flashes: to a tenth in ${median(fades).toFixed(2)} s median, ${fades[Math.floor(fades.length * 0.9)].toFixed(2)} s 90th; foam left then ${(median(foamLeft) * 100).toFixed(0)} %`);
    expect(fades.length).toBeGreaterThan(20);
    // a flash and a fade: most within ~2 s, never a light that lies on (the brief: "fade over a second or two")
    expect(median(fades)).toBeLessThan(2.2);
    expect(fades[Math.floor(fades.length * 0.9)]).toBeLessThan(3.5);
    // while the foam that break made is still there, at twice the light's share or more: the light is the break's, not the foam's
    expect(median(foamLeft)).toBeGreaterThan(0.2);
  });
});

describe('the prints the wanderers leave', () => {
  const c1End = 21 + C1_FOLLOW;
  const { starts } = beatStarts(c1End);
  const coast = createFilmCoast([-40000, 0], { ground: () => ({ albedo: vec3(0.5), roughness: float(1) }) } as never);
  // (its radio towers' GLB fetch fails in node; the ground is all this reads)
  coast.ready.catch(() => {});
  const { beach, ground } = coast;
  const edge = wetSand(ground, beach);
  /** a walker's middle at t, world x, z */
  const body = (i: number, t: number): [number, number] => {
    const p = wanderer(i, t, starts.w5, edge);
    return [beach.x - p.off, beach.z - p.along];
  };

  it('fall under the walkers, left and right in turn, a step apart, none older than their life or yet to come', () => {
    const feet = createFootfalls(ground, beach);
    // (through the night of w6, where the glow shows)
    for (let t = starts.w6 + 10; t < starts.w6 + 40; t += 7.3) {
      const prints = feet(t, starts.w5);
      expect(prints.length).toBeGreaterThan(20);
      for (const p of prints) {
        expect(p.age).toBeGreaterThanOrEqual(0);
        expect(p.age).toBeLessThanOrEqual(7);
        // (within a leg's reach of where its walker was as it came down)
        const [bx, bz] = body(p.walker, t - p.age);
        expect(Math.hypot(p.x - bx, p.z - bz)).toBeLessThan(0.55);
      }
      for (const w of [0, 1, 2]) {
        const mine = prints.filter((p) => p.walker === w).sort((x, y) => y.age - x.age);
        for (let k = 1; k < mine.length; k++) {
          // left, right, left: a walk, not a hop
          expect(mine[k].side).toBe(-mine[k - 1].side);
          // a step apart (half a stride of ~1.3 m at a walk; shorter as it slows to stop)
          const d = Math.hypot(mine[k].x - mine[k - 1].x, mine[k].z - mine[k - 1].z);
          expect(d).toBeGreaterThan(0.15);
          expect(d).toBeLessThan(0.95);
        }
      }
    }
  });

  it('leave none while a walker stands still (the first stops to look out over the water 15.5–19.5 s into w5)', () => {
    const feet = createFootfalls(ground, beach);
    const t = starts.w5 + 19;
    const youngest = Math.min(...feet(t, starts.w5).filter((p) => p.walker === 0).map((p) => p.age));
    // (its pace eases out over 0.8 s before 15.5: its last step is a few seconds old)
    expect(youngest).toBeGreaterThan(2.5);
  });

  it('are the same for a frame whatever frames came before it (a pure function of t)', () => {
    const run = createFootfalls(ground, beach);
    const t = starts.w6 + 25;
    // one finder run on frame by frame up to t, one asked for t cold
    for (let s = t - 4; s < t; s += 1 / 30) run(s, starts.w5);
    const a = run(t, starts.w5);
    const b = createFootfalls(ground, beach)(t, starts.w5);
    expect(a.length).toBe(b.length);
    a.forEach((p, k) => {
      expect(p.x).toBeCloseTo(b[k].x, 9);
      expect(p.z).toBeCloseTo(b[k].z, 9);
      expect(p.age).toBeCloseTo(b[k].age, 9);
    });
  });
});

describe('the glow\'s onset with the night', () => {
  const c1End = 21 + C1_FOLLOW;
  const { starts } = beatStarts(c1End);
  /** the share of the glow the frame shows at sea time t: each pass's gate × its weight × the onset */
  const shown = (t: number): number =>
    beatsAt(t, c1End).reduce((a, p) => a + (spec(p.name)?.world === 'coast' ? p.weight * biolumSunGate(beatSun(p.name, t, c1End)[1]) : 0), 0) *
    biolumOnset(t, starts.w6);
  it('comes up over tens of seconds, never by a step from one frame to the next, and is whole in the night', () => {
    let from = NaN;
    let to = NaN;
    let jump = 0;
    let prev = shown(starts.w5);
    for (let t = starts.w5; t < starts.w6 + spec('w6')!.length; t += 1 / 30) {
      const g = shown(t);
      jump = Math.max(jump, Math.abs(g - prev));
      if (Number.isNaN(from) && g > 0.05) from = t;
      if (Number.isNaN(to) && g > 0.95) to = t;
      prev = g;
    }
    console.log(`[biolum onset] 5 % at w6 ${(from - starts.w6).toFixed(1)} s, 95 % at w6 + ${(to - starts.w6).toFixed(1)} s, largest step a frame ${jump.toFixed(4)}`);
    // (a slow rise: 5 % to 95 % over 25 s and more — the dissolve alone took it in ~10)
    expect(to - from).toBeGreaterThan(25);
    // (no frame steps it by more than 0.5 % of the whole)
    expect(jump).toBeLessThan(0.005);
    // (whole through w6's held night, none by day)
    expect(shown(starts.w6 + 40)).toBeCloseTo(1, 3);
    expect(shown(starts.w4 + 20)).toBe(0);
  });
});
