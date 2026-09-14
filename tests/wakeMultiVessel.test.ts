/**
 * §T.195 EVERY BOAT MARKS THE WATER — the multi-vessel wake source pipeline (docs/wake/w6-multivessel.md).
 * USER: 'we're missing the wakes and all that from npcs; only our boat shows any kind of reaction on the water'.
 *
 * WHY these tests: the player-anchored domain (§V105) holds up to eight boats in ONE source buffer (§V104). A rival
 * must make the SAME wake the player would at the same speed — not a fainter or a doubled one — or a pack reads as
 * one real boat and seven decals; a rival at the edge of the domain must never be half-splatted, or the periodic
 * transform throws her clipped pressure into the opposite corner as ringing; and the shared field must be a
 * function of the boats' steps alone (§V2).
 *
 * One contact tow (SpeedboatTow: HullWater on rigid6 at 15 m/s) supplies every boat's samples, translated to her
 * lane — eight identical contacts, so any difference between their wakes is the pipeline's.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { SpeedboatTow } from '../src/wake/speedboatTow';
import { WAKE_SPEEDBOAT_TIER } from '../src/wake/wakeCalibration';
import { WAKE_MAX_VESSELS, WakeSim, type VesselWakeInput } from '../src/wake/wakeSim';
import {
  WAKE_SPLAT_RADIUS_SIGMAS,
  WakeSolverCpu,
  defaultSponge,
  splatSigma,
  vesselDomainWeight,
  type HydroSample,
} from '../src/wake/wakeSolverMath';
import type { PropWashInput } from '../src/wake/propWash';
import { simFoamRateAtCpu } from '../src/flowfoam/simFoam';
import { flowFoamParams } from '../src/params/flowfoam';

/** the churn alone: no breaking dose, and no stern (emerge) churn so bow and transom are told apart */
const flowFoamParamsForChurn = { simBreakRate: 0, simChurnRate: flowFoamParams.simChurnRate, simSternChurn: 0, simSlickPerFoam: 1 };

const U = 15;
const DT = 1 / 30;
const SECONDS = 8;

/** rivals' lanes relative to the hero (m): astern and abeam, inside the unsponged interior of a hero-anchored domain */
const LANES: readonly [number, number][] = [
  [-60, 70],
  [-60, -70],
  [-120, 130],
  [-120, -130],
  [-180, 45],
  [-180, -45],
  [-240, 110],
];

interface Frame {
  samples: HydroSample[];
  jets: PropWashInput[];
}

/** the tow's samples + jets moved by (dx, dz) (and turned by `yaw` about the hero origin, rad) */
function moved(f: Frame, ox: number, oz: number, dx: number, dz: number, yaw = 0): Frame {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const rot = (x: number, z: number): [number, number] => [ox + dx + c * (x - ox) + s * (z - oz), oz + dz - s * (x - ox) + c * (z - oz)];
  return {
    samples: f.samples.map((q) => {
      const [x, z] = rot(q.x, q.z);
      return { ...q, x, z };
    }),
    jets: f.jets.map((j) => {
      const [x, z] = rot(j.x, j.z);
      return { ...j, x, z, dirX: c * j.dirX + s * j.dirZ, dirZ: -s * j.dirX + c * j.dirZ };
    }),
  };
}

interface PondRun {
  cpu: WakeSolverCpu;
  heroX: number;
  counts: { vessels: number; culled: number; overflowed: number; sources: number; weights: number[] };
}

/**
 * Tow the hero along +x for SECONDS; `rivals(t, hero)` returns the rivals' inputs that tick. The GPU driver builds
 * the ONE source buffer (WakeSim.tick: domain anchor, rivals' weights) and the CPU solver integrates it.
 */
function pond(rivals: (hx: number, hero: Frame) => VesselWakeInput[]): PondRun {
  const tow = new SpeedboatTow(U, 0.6);
  const sim = new WakeSim(WAKE_SPEEDBOAT_TIER);
  const cpu = new WakeSolverCpu({ n: WAKE_SPEEDBOAT_TIER.n, texel: WAKE_SPEEDBOAT_TIER.texel });
  let counts = { vessels: 0, culled: 0, overflowed: 0, sources: 0, weights: [] as number[] };
  let hx = 0;
  const samples: HydroSample[] = [];
  for (let k = 1; k <= Math.round(SECONDS / DT); k++) {
    hx = U * k * DT;
    tow.advanceTo(hx);
    tow.samples(samples);
    const hero: Frame = { samples: samples.map((q) => ({ ...q })), jets: tow.jets().map((j) => ({ ...j })) };
    const pose = tow.pose;
    const others = rivals(pose.position[0], hero);
    sim.tick(pose, hero.samples, tow.hull.stemZ, DT, hero.jets, others);
    counts = {
      vessels: sim.vesselCount,
      culled: sim.vesselsCulled,
      overflowed: sim.vesselsOverflowed,
      sources: sim.sources.count + sim.sources.jetCount,
      weights: sim.vessels.slice(0, sim.vesselCount).map((v) => v.weight),
    };
    cpu.setCenter(sim.solver.centerX, sim.solver.centerZ);
    cpu.setDomainVelocity(sim.domainVelocity.x, sim.domainVelocity.z);
    cpu.splat(sim.sources);
    cpu.step(DT);
  }
  return { cpu, heroX: hx, counts };
}

/** Σ ζ² over world box [x0, x1] × [z0, z1] */
function boxEnergy(s: WakeSolverCpu, x0: number, x1: number, z0: number, z1: number): number {
  let e = 0;
  for (let j = 0; j < s.n; j++) {
    const wz = s.centerZ + (j - s.n / 2) * s.texel;
    if (wz < z0 || wz > z1) continue;
    for (let i = 0; i < s.n; i++) {
      const wx = s.centerX + (i - s.n / 2) * s.texel;
      if (wx < x0 || wx > x1) continue;
      const z = s.zeta[j * s.n + i];
      e += z * z;
    }
  }
  return e;
}

/** the box one boat's own near wake owns: 40 m astern of her origin to 8 m ahead, ±14 m across */
const wakeBox = (s: WakeSolverCpu, x: number, z: number): number => boxEnergy(s, x - 40, x + 8, z - 14, z + 14);

describe('§T.195 eight towed boats in the pond make eight wakes (one source buffer, one solve)', () => {
  let single: PondRun;
  let fleet: PondRun;

  beforeAll(() => {
    single = pond(() => []);
    fleet = pond((hx, hero) =>
      LANES.map(([dx, dz]) => {
        const f = moved(hero, hx, 0, dx, dz);
        return { samples: f.samples, jets: f.jets, x: hx + dx, z: dz, vx: U, vz: 0 };
      }),
    );
  }, 240_000);

  it('every rival is taken whole at full weight: 8 vessels, none culled or skipped, sources = 8 × one boat', () => {
    expect(single.counts.vessels).toBe(1);
    expect(fleet.counts.vessels).toBe(WAKE_MAX_VESSELS);
    expect(fleet.counts.culled).toBe(0);
    expect(fleet.counts.overflowed).toBe(0);
    expect(fleet.counts.weights.every((w) => w === 1)).toBe(true);
    expect(fleet.counts.sources).toBe(8 * single.counts.sources);
  });

  it("each rival's near wake carries the lone tow's energy within ±15% (not missing, not doubled, not the hero's)", () => {
    const ref = wakeBox(single.cpu, single.heroX, 0);
    expect(ref).toBeGreaterThan(0);
    const ratios = [[0, 0] as const, ...LANES].map(([dx, dz]) => wakeBox(fleet.cpu, fleet.heroX + dx, dz) / ref);
    // eslint-disable-next-line no-console
    console.info('[wakeMultiVessel] per-wake energy / lone tow:', ratios.map((r) => r.toFixed(3)).join(' '));
    for (const r of ratios) {
      expect(r).toBeGreaterThan(0.85);
      expect(r).toBeLessThan(1.15);
    }
  });

  it('…and the lone run has nothing in those rival boxes (the energy there is the rivals\')', () => {
    const ref = wakeBox(single.cpu, single.heroX, 0);
    for (const [dx, dz] of LANES) expect(wakeBox(single.cpu, single.heroX + dx, dz) / ref).toBeLessThan(0.05);
  });
});

describe('§T.195 a rival outside the domain is dropped whole; one crossing into it fades in, with no wrap', () => {
  it('vesselDomainWeight: 0 whenever any splat would touch the border, smoothstep across the sponge band, 1 inside', () => {
    const n = WAKE_SPEEDBOAT_TIER.n;
    const texel = WAKE_SPEEDBOAT_TIER.texel;
    const domain = n * texel;
    const sponge = defaultSponge(n, texel);
    const reach = WAKE_SPLAT_RADIUS_SIGMAS * splatSigma(0.3, texel, n);
    const r = 6.5;
    const w = (x: number, z: number): number => vesselDomainWeight(x, z, r, reach, 0, 0, domain, sponge);
    const edge = domain / 2 - r - reach;
    expect(w(edge, 0)).toBe(0);
    expect(w(0, -edge - 1e-6)).toBe(0);
    expect(w(edge + 50, 0)).toBe(0);
    expect(w(edge - 1, 0)).toBeGreaterThan(0);
    expect(w(edge - sponge.width * domain, 0)).toBe(1);
    expect(w(0, 0)).toBe(1);
    // monotone across the band
    let prev = 0;
    for (let e = 0; e <= sponge.width * domain; e += 5) {
      const v = w(edge - e, 0);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(w(Number.NaN, 0)).toBe(0);
  });

  it('WakeSim: a rival beyond the border adds no source and is counted culled; the hero-only buffer is bit-identical', () => {
    const tow = new SpeedboatTow(U, 0.6);
    tow.advanceTo(30);
    const s: HydroSample[] = tow.samples();
    const j = tow.jets();
    const a = new WakeSim(WAKE_SPEEDBOAT_TIER);
    const b = new WakeSim(WAKE_SPEEDBOAT_TIER);
    a.tick(tow.pose, s, tow.hull.stemZ, DT, j);
    const far = moved({ samples: s, jets: [...j] }, 30, 0, 0, 400);
    b.tick(tow.pose, s, tow.hull.stemZ, DT, j, [{ samples: far.samples, jets: far.jets, x: 30, z: 400, vx: U, vz: 0 }]);
    expect(b.vesselsCulled).toBe(1);
    expect(b.vesselCount).toBe(1);
    expect(b.sources.count).toBe(a.sources.count);
    expect(b.sources.jetCount).toBe(a.sources.jetCount);
    expect(Array.from(b.sources.data.subarray(0, b.sources.count * 5))).toEqual(Array.from(a.sources.data.subarray(0, a.sources.count * 5)));
    expect(Array.from(b.sources.jetData.subarray(0, b.sources.jetCount * 5))).toEqual(Array.from(a.sources.jetData.subarray(0, a.sources.jetCount * 5)));
  });

  it('a rival inside the sponge band is pushed at her weight: Σ fy of her sources = weight · Σ fy of her contact', () => {
    const tow = new SpeedboatTow(U, 0.6);
    tow.advanceTo(30);
    const s: HydroSample[] = tow.samples();
    const sim = new WakeSim(WAKE_SPEEDBOAT_TIER);
    sim.tick(tow.pose, s, tow.hull.stemZ, DT, []);
    const half = (WAKE_SPEEDBOAT_TIER.n * WAKE_SPEEDBOAT_TIER.texel) / 2;
    const z = sim.solver.centerZ + half - 45; // inside the grid, inside the 67 m sponge band
    const r = moved({ samples: s, jets: [] }, 30, 0, 0, z);
    sim.tick(tow.pose, s, tow.hull.stemZ, DT, [], [{ samples: r.samples, jets: [], x: 30, z, vx: U, vz: 0 }]);
    expect(sim.vesselCount).toBe(2);
    const w = sim.vessels[1].weight;
    expect(w).toBeGreaterThan(0);
    expect(w).toBeLessThan(1);
    let hero = 0;
    let rival = 0;
    for (let k = 0; k < sim.sources.count; k++) {
      if (k < s.length) hero += sim.sources.data[k * 5 + 2];
      else rival += sim.sources.data[k * 5 + 2];
    }
    const own = s.reduce((a, q) => a + Math.max(0, q.fy), 0);
    expect(hero).toBeCloseTo(own, 6);
    expect(rival / own).toBeCloseTo(w, 9);
  });

  it('a rival running in across the +z border: the opposite (−z) border band stays < 1e-3 of what she lays inside', () => {
    const half = (WAKE_SPEEDBOAT_TIER.n * WAKE_SPEEDBOAT_TIER.texel) / 2;
    const run = pond((hx, hero) => {
      const t = hx / U;
      // heading −z (yaw −90° about the hero origin), starting 30 m beyond the +z border, crossing at U
      const z = half + 30 - U * t;
      const f = moved(hero, hx, 0, -60, z, -Math.PI / 2);
      return [{ samples: f.samples, jets: f.jets, x: hx - 60, z, vx: 0, vz: -U }];
    });
    const s = run.cpu;
    const x0 = run.heroX - 60 - 80;
    const x1 = run.heroX - 60 + 80;
    const inside = boxEnergy(s, x0, x1, 20, s.centerZ + half);
    const wrapped = boxEnergy(s, x0, x1, s.centerZ - half, s.centerZ - half + 60);
    // eslint-disable-next-line no-console
    console.info(`[wakeMultiVessel] crossing rival: inside ${inside.toExponential(3)} wrapped ${wrapped.toExponential(3)} ratio ${(wrapped / inside).toExponential(3)}`);
    expect(inside).toBeGreaterThan(0);
    expect(wrapped / inside).toBeLessThan(1e-3);
  }, 120_000);
});

describe('§T.195 the sim foam churns each hull at its OWN velocity (vessel mode)', () => {
  it('a rival running the other way lays her bury foam at HER bow, not where the hero\'s velocity would put it', () => {
    // the hero at the origin heading +x at 10 m/s, a rival 60 m off heading −x at 10 m/s; one head field for both
    const cpu = new WakeSolverCpu({ n: 128, texel: 0.5 });
    const hull = (cx: number, cz: number): HydroSample[] =>
      [-4, -2, 0, 2, 4].flatMap((dx) => [-1, 1].map((dz) => ({ x: cx + dx, z: cz + dz, fy: 6000, footprint: 0.6, depth: 0.3 })));
    const sim = new WakeSim({ n: 128, texel: 0.5 });
    const heroPose = { position: [0, 0, 0], quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2], velocity: [10, 0, 0] };
    const rival = hull(-5, 20);
    sim.tick(heroPose, hull(0, 0), 5, 1 / 60, [], [{ samples: rival, jets: [], x: -5, z: 20, vx: -10, vz: 0 }]);
    cpu.setCenter(sim.solver.centerX, sim.solver.centerZ);
    cpu.splat(sim.sources);
    cpu.step(1 / 60, { slope: true });
    expect(sim.vesselCount).toBe(2);
    const p = { ...flowFoamParamsForChurn };
    const slot = (k: number) => {
      const v = sim.vessels[k];
      return { x: v.x, z: v.z, radius: v.radius, vx: v.vx, vz: v.vz, lift: 1, depth: 0.3 };
    };
    const frame = { hullVelX: 10, hullVelZ: 0, lift: 1, depth: 0.3 };
    // W8: vessel mode also gates the churn at the air-entrainment onset; 0 here isolates the per-vessel velocity
    const at = (x: number, z: number, vessels: boolean): number =>
      simFoamRateAtCpu(cpu, x, z, 0.234, vessels ? { ...frame, vessels: [slot(0), slot(1)], airOnset: 0 } : frame, p)[0];
    // her bow is at −x (she runs −x): bury there, nothing at her transom (sternChurn 0 in this test)
    const bow = at(-9.5, 20, true);
    const stern = at(-0.5, 20, true);
    expect(bow).toBeGreaterThan(0);
    expect(stern).toBeLessThan(bow * 0.1);
    // the single-hull graph advects her head at the hero's +x: the foam swaps ends (the defect vessel mode fixes)
    expect(at(-0.5, 20, false)).toBeGreaterThan(at(-9.5, 20, false));
    // and the hero herself reads the same either way to 0.1% (her share → 1 next to her; the rival 20 m off weighs e^−6.5)
    expect(Math.abs(at(4.5, 0, true) / at(4.5, 0, false) - 1)).toBeLessThan(1e-3);
  });
});
