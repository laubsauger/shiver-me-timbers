/**
 * §T.190 on §T.187 — THE TOWER REACH BAR IS WHERE THE LAP'S SEA BREAKS.
 *
 * Why this exists: the circuit is designed around its sandbar being the lap's
 * big water ("breaking waves = ramps"), and under the attenuation-only shoaling
 * of §V.72 the bar was the CALMEST water on the lap. These tests sample the real
 * circuit — its own seabed, its own shelter field, the reference sea its
 * sectors are measured in — through the CpuOcean mirror the boats float on.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED, and why (§Rule 8): "the bar has the
 * HIGHEST water on the lap". Linear theory says it does not. The reference sea
 * is Hs 2.83 m and the crest is ~3 m deep, so depth-limited breaking caps the
 * crest at γ·d while the exposed straights keep the open swell; and the FFT
 * tiles cannot shorten the wavelength near shore, so the drawn faces are not
 * steeper either. What physics DOES give the bar is: it is the only place on
 * the lap where the sea is breaking, the highest sea for its depth, and far
 * more water than the attenuation law left there. A taller/steeper ramp needs a
 * crest-asymmetry or bar-bore term — a user decision, see docs/ocean/shoaling.md.
 * (§T.193 added the crest asymmetry: see the last block.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTowerReach, towerReachSites, type TowerReachWorld } from '../src/circuit/towerReach';
import { createShelterField, REFERENCE_SEA, type ShelterField } from '../src/circuit/shelter';
import { resampleClosed } from '../src/circuit/courseLine';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import { seaPhysicsParams } from '../src/params/seaPhysics';
import {
  shoalBandGains,
  shoalingCoefficient,
  shoalWavenumber,
  surfBreakingFactor,
  surfBreakingIntensity,
  tanhCpu,
} from '../src/ocean/shoaling';
import { cascadeBand, spectralHeightVariance, spectralMeanWavenumber } from '../src/ocean/oceanMath';
import { bandPropagation } from '../src/ocean/shoalAsymmetry';
import { SpectrumScheduler } from '../src/ocean/spectrumRebuild';

const SEED = 1965;

interface Row { x: number; z: number; d: number; hs: number; brk: number; onBar: boolean }

let world: TowerReachWorld;
let shelter: ShelterField;
let rows: Row[];
let ks: number[];
let sig: number[];

beforeAll(() => {
  world = buildTowerReach(SEED);
  const sites = towerReachSites(SEED).sites;
  shelter = createShelterField(world.heightmaps.map((hm, i) => ({ heightmap: hm, center: sites[i].position })));
  const p = { ...REFERENCE_SEA };
  const open = -shelter.seabed.openHeight;
  ks = [0, 1, 2].map((i) =>
    shoalWavenumber(spectralMeanWavenumber(p.resolution, p.cascades[i].domain, p, cascadeBand(i, p.splitWavelengths)), open, p));
  sig = [0, 1, 2].map((i) =>
    Math.sqrt(spectralHeightVariance(p.resolution, p.cascades[i].domain, p, cascadeBand(i, p.splitWavelengths))));
  const sea = new CpuOcean(SEED, p, seaPhysicsParams);
  sea.setSeabed(shelter.seabed, open);
  sea.setFetch(shelter.fetch);
  const pts = resampleClosed(world.course.referenceLine, 20);
  const series = pts.map(() => [] as number[]);
  for (let t = 0; t <= 90; t += 0.5) {
    sea.update(t);
    pts.forEach(([x, z], j) => series[j].push(sea.heightAt(x, z, t)));
  }
  const crossings = world.bars.map((b) => b.crossing).filter((c): c is [number, number] => c !== null);
  rows = pts.map(([x, z], j) => {
    const s = series[j];
    const m = s.reduce((a, b) => a + b, 0) / s.length;
    const sd = Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / s.length);
    const d = Math.max(-shelter.seabed.heightAt(x, z), 0);
    const hs0 = 4 * Math.hypot(...ks.map((k, i) => sig[i] * shoalingCoefficient(k, d)));
    return {
      x, z, d, hs: 4 * sd,
      brk: surfBreakingIntensity(surfBreakingFactor(hs0, d, p)),
      onBar: crossings.some((c) => Math.hypot(c[0] - x, c[1] - z) < 60),
    };
  });
}, 600_000);

afterAll(() => {
  shelter?.dispose();
  world?.dispose();
});

describe('§T.190 Tower Reach: the bar is where the sea breaks', () => {
  it('the reference line crosses a bar, and samples it', () => {
    expect(rows.some((r) => r.onBar)).toBe(true);
    expect(rows.length).toBeGreaterThan(150);
  });

  it('breaking happens on the bar and nowhere else on the lap', () => {
    // corridor ≥ 6.2 m everywhere but the bar (circuit contract) ⟹ a working
    // sea may only break over the bar; a surf line anywhere else would be a
    // breaker in the racing corridor the course author never placed
    const bar = rows.filter((r) => r.onBar);
    const rest = rows.filter((r) => !r.onBar);
    expect(Math.max(...bar.map((r) => r.brk))).toBeGreaterThan(0.3);
    expect(Math.max(...rest.map((r) => r.brk))).toBe(0);
  });

  it('the bar carries the lap\'s highest sea for its depth (the floated mirror, measured)', () => {
    const ratio = (r: Row) => r.hs / Math.max(r.d, 1e-6);
    const barBest = Math.max(...rows.filter((r) => r.onBar).map(ratio));
    const restBest = Math.max(...rows.filter((r) => !r.onBar).map(ratio));
    expect(barBest).toBeGreaterThan(restBest);
  });

  it('the bar crest holds far more water than the attenuation-only law left it', () => {
    // the defect §T.190 was filed for: 23–29% of the swell kept over the crest
    const p = { ...REFERENCE_SEA };
    const crest = rows.filter((r) => r.onBar).reduce((a, r) => (r.d < a.d ? r : a));
    const old = 4 * Math.hypot(...ks.map((k, i) => sig[i] * tanhCpu(k * crest.d)));
    const g = shoalBandGains(crest.d, ks, sig, null, p, []);
    const now = 4 * Math.hypot(...ks.map((_, i) => sig[i] * g[i]));
    expect(now / old).toBeGreaterThan(1.4);
    // and the mirror the boats float on carries it
    expect(crest.hs).toBeGreaterThan(1.4 * old);
  });
});

describe('§T.193 Tower Reach: the shoaling harmonic turns the bar\'s faces into ramps', () => {
  /**
   * Front-face slope (m/m over 1 m) and the 5 m ramp (crest height minus the
   * surface 5 m ahead of it along the travel direction ŝ of cascade 0 — the face
   * a boat meets head-on) on the reference line, every 0.5 s for 90 s, with the
   * harmonic on and off over the same realization. Per point: the maximum and
   * the 99th percentile over time (the max of a finite sample is a noisy
   * extreme; the p99 is the ramp you meet a few times a lap).
   */
  interface Faces { bar: boolean; exposed: boolean; front: number; ramp: number; f99: number; r99: number }
  let on: Faces[];
  let off: Faces[];

  function lapFaces(gain: number): Faces[] {
    const p = { ...REFERENCE_SEA, shoalAsymmetryGain: gain };
    const sched = new SpectrumScheduler(SEED, p);
    const dir = bandPropagation(sched.current.cascades[0].h0);
    const sea = new CpuOcean(SEED, p, seaPhysicsParams, sched);
    sea.setSeabed(shelter.seabed, -shelter.seabed.openHeight);
    sea.setFetch(shelter.fetch);
    const pts = resampleClosed(world.course.referenceLine, 20);
    const crossings = world.bars.map((b) => b.crossing).filter((c): c is [number, number] => c !== null);
    const fronts = pts.map(() => [] as number[]);
    const ramps = pts.map(() => [] as number[]);
    const y = new Float64Array(20);
    for (let t = 0; t <= 90; t += 0.5) {
      sea.update(t);
      pts.forEach(([x, z], j) => {
        for (let s = -7; s <= 12; s++) y[s + 7] = sea.heightAt(x + dir.x * s, z + dir.z * s, t);
        let front = 0;
        let ramp = 0;
        for (let i = 1; i <= 13; i++) {
          front = Math.max(front, y[i] - y[i + 1]);
          if (y[i] >= y[i - 1] && y[i] >= y[i + 1]) ramp = Math.max(ramp, y[i] - y[i + 5]);
        }
        fronts[j].push(front);
        ramps[j].push(ramp);
      });
    }
    const p99 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.99)];
    return pts.map(([x, z], j) => {
      const bar = crossings.some((c) => Math.hypot(c[0] - x, c[1] - z) < 60);
      return {
        bar,
        exposed: !bar && shelter.kAt(x, z) > 0.9 && -shelter.seabed.heightAt(x, z) > 8,
        front: Math.max(...fronts[j]),
        ramp: Math.max(...ramps[j]),
        f99: p99(fronts[j]),
        r99: p99(ramps[j]),
      };
    });
  }
  const best = (rows: Faces[], pick: (r: Faces) => number, where: (r: Faces) => boolean) =>
    Math.max(...rows.filter(where).map(pick));

  beforeAll(() => {
    on = lapFaces(1);
    off = lapFaces(0);
  }, 600_000);

  it('the bar\'s faces steepen and its ramps grow; the exposed straights keep their sea', () => {
    // measured (seed 1965): bar p99 front 0.396 → 0.455, p99 ramp 1.29 → 1.68 m;
    // exposed p99 front 0.427 → 0.427, max ramp 1.686 → 1.686 m.
    // mutation: gain 0, or the harmonic's tilt sign flipped (the ramp is on the back)
    const isBar = (r: Faces) => r.bar;
    const isExposed = (r: Faces) => r.exposed;
    expect(best(on, (r) => r.f99, isBar)).toBeGreaterThan(1.1 * best(off, (r) => r.f99, isBar));
    expect(best(on, (r) => r.r99, isBar)).toBeGreaterThan(1.2 * best(off, (r) => r.r99, isBar));
    expect(Math.abs(best(on, (r) => r.f99, isExposed) / best(off, (r) => r.f99, isExposed) - 1)).toBeLessThan(0.02);
    expect(Math.abs(best(on, (r) => r.ramp, isExposed) / best(off, (r) => r.ramp, isExposed) - 1)).toBeLessThan(0.02);
  });

  it('on the reference seed the bar has the lap\'s steepest faces and biggest ramps', () => {
    // measured (seed 1965): bar p99 front 0.455 vs exposed 0.427; p99 ramp 1.68 vs
    // 1.44 m; max ramp 1.85 vs 1.69 m. The steepest bar point is its seaward
    // flank (d ≈ 6 m), where waves are tallest just before they break, not the
    // 3 m crest line, which breaking has already capped.
    // NOT TRUE ON EVERY SEED, said so (Rule 8): seeds 42 and 777 keep taller
    // exposed swells (max crest 4.6/4.3 m vs 3.2/3.3 m on the bar), and their
    // exposed p99 front slopes (0.515, 0.420) beat the bar's (0.420, 0.347).
    // See docs/ocean/shoaling.md §T.193.
    const isBar = (r: Faces) => r.bar;
    const isExposed = (r: Faces) => r.exposed;
    expect(best(on, (r) => r.f99, isBar)).toBeGreaterThan(best(on, (r) => r.f99, isExposed));
    expect(best(on, (r) => r.r99, isBar)).toBeGreaterThan(best(on, (r) => r.r99, isExposed));
    expect(best(on, (r) => r.ramp, isBar)).toBeGreaterThan(best(on, (r) => r.ramp, isExposed));
  });
});
