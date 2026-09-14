/**
 * THE SPEEDBOAT'S THREE SEAS (src/params/speedboatSea.ts SPEEDBOAT_SEAS, docs/speedboat/sea-presets.md).
 *
 * USER (playtest + trailer review 2026-09-14): "calibrate how hard a swell we present … the sea has wider intervals
 * between waves, more deep-ocean swell … in certain places maybe use lee."
 *
 * WHY each test exists:
 *  - LONG, LOW SWELL CARRIES THE SEA. The race's old Working sea was an 11 m/s wind sea (peak λ 95 m, T 7.8 s) carrying
 *    2.5 of its 2.8 m: short steep faces a 12 m hull stuffs into. The felt slope (waves ≥ 12 m, the ones a 12 m hull
 *    follows rather than bridges) must stay under that sea's, and the swell must be ocean swell (T ≥ 8 s).
 *  - THE LEE IS WHERE THE COURSE WAS DRAWN. Tower Reach's sectors were measured on the 1.68π bearing; the ladder's
 *    `calm` (0.62π) put the start straight in open swell (K 1.00) and sheltered the exposed straights. Every speedboat
 *    sea must shelter the sheltered gates and leave the exposed ones open.
 *  - THE PAGE APPLIES THEM: a boat-select label reaches `weather.apply` with the ocean override, and the override
 *    replaces the rung's targets (so switching back to a plain rung restores it).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { REFERENCE_SEA, createShelterField } from '../src/circuit/shelter';
import { buildTowerReach, type TowerReachWorld } from '../src/circuit/towerReach';
import { TOWER_REACH_SWELL_DIRECTION } from '../src/circuit/towerReachLayout';
import { cascadeBand, swellWavelengthFor, waveSpectrum } from '../src/ocean/oceanMath';
import { oceanParams, type OceanParams } from '../src/params/ocean';
import { SPEEDBOAT_SEAS, type SpeedboatSeaName } from '../src/params/speedboatSea';
import { seaPhysicsParams } from '../src/params/seaPhysics';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import { TOWER_REACH_SEED } from '../src/speedboat/page/course';
import { SEA_PRESET, seaApplyArgs } from '../src/speedboat/page/raceSettings';
import { SEA_OPTIONS } from '../src/speedboat/ui/boatSelect';
import { applyWeatherPreset } from '../src/weather/applyPreset';
import { weatherPresets } from '../src/weather/presets';
import type { Course } from '../src/race/types';

const NAMES = Object.keys(SPEEDBOAT_SEAS) as SpeedboatSeaName[];
const seaOf = (patch: Partial<OceanParams>): OceanParams => ({ ...structuredClone(oceanParams), ...patch }) as OceanParams;

/** Hs = 4√m₀ over the three cascades, and the RMS slope (deg) of the waves at least `lmin` metres long */
function moments(p: OceanParams, lmin = 12): { hs: number; feltSlopeDeg: number } {
  let v = 0;
  let s2 = 0;
  const N = 128;
  for (let i = 0; i < 3; i++) {
    const domain = p.cascades[i].domain;
    const band = cascadeBand(i, p.splitWavelengths);
    for (let m = 0; m < N; m++)
      for (let n = 0; n < N; n++) {
        const kx = (2 * Math.PI * (n - N / 2)) / domain;
        const kz = (2 * Math.PI * (m - N / 2)) / domain;
        const k = Math.hypot(kx, kz);
        if (!(k > band.kMin && k <= band.kMax) || k < 1e-9) continue;
        const e = 2 * (Math.sqrt(waveSpectrum(kx, kz, p) / 2) / domain) ** 2;
        v += e;
        if (k <= (2 * Math.PI) / lmin) s2 += k * k * e;
      }
  }
  return { hs: 4 * Math.sqrt(v), feltSlopeDeg: (Math.atan(Math.sqrt(s2)) * 180) / Math.PI };
}

describe('the speedboat seas are long, low swell, calm → working → open', () => {
  const old = moments(seaOf(weatherPresets.swell.ocean));
  const m = Object.fromEntries(NAMES.map((n) => [n, moments(seaOf({ ...weatherPresets[SPEEDBOAT_SEAS[n].weather].ocean, ...SPEEDBOAT_SEAS[n].ocean }))])) as Record<SpeedboatSeaName, ReturnType<typeof moments>>;

  it('deep-ocean swell on the course bearing, ordered in height, every one flatter to ride than the old Working sea', () => {
    for (const n of NAMES) {
      const o = SPEEDBOAT_SEAS[n].ocean;
      expect(o.swellDirection, n).toBeCloseTo(TOWER_REACH_SWELL_DIRECTION, 9);
      expect(o.swellPeriod, n).toBeGreaterThanOrEqual(8);
      expect(o.swellPeriod, n).toBeLessThanOrEqual(14);
      expect(swellWavelengthFor(o.swellPeriod), n).toBeGreaterThanOrEqual(95);
      expect(weatherPresets, n).toHaveProperty(SPEEDBOAT_SEAS[n].weather);
      // the swell is the bigger train: its own Hs (4·RMS) is at least half the total
      expect(4 * o.swellAmplitude, n).toBeGreaterThan(0.5 * m[n].hs);
      expect(m[n].feltSlopeDeg, `${n} felt slope vs old Working sea ${old.feltSlopeDeg.toFixed(1)}°`).toBeLessThan(0.75 * old.feltSlopeDeg);
    }
    expect(m.calm.hs).toBeLessThan(m.working.hs);
    expect(m.working.hs).toBeLessThan(m.open.hs);
    // what the hull FLOATS on (and the GPU draws, same h0): the realised surface, not the spectrum's bookkeeping, which
    // under-counts the variance 2× (docs/speedboat/sea-presets.md "Realised vs spectrum")
    const realised = (n: SpeedboatSeaName): number => {
      const o = new CpuOcean(2100, seaOf({ ...weatherPresets[SPEEDBOAT_SEAS[n].weather].ocean, ...SPEEDBOAT_SEAS[n].ocean }), { ...structuredClone(seaPhysicsParams), hullDraft: 0.54 });
      o.update(30);
      let s1 = 0;
      let s2 = 0;
      let k = 0;
      for (let x = 0; x < 1000; x += 9)
        for (let z = 0; z < 1000; z += 9) {
          const h = o.pressureHeadAt(x, z, 30);
          s1 += h;
          s2 += h * h;
          k++;
        }
      return 4 * Math.sqrt(s2 / k - (s1 / k) ** 2);
    };
    expect(realised('calm')).toBeLessThan(0.3);
    expect(realised('working')).toBeGreaterThan(0.3);
    expect(realised('working')).toBeLessThan(0.6);
    // open: the jumps preset — big enough to launch off, not a storm
    expect(realised('open')).toBeGreaterThan(1.2);
    expect(realised('open')).toBeLessThan(1.7);
  });
});

describe('the lee is where the course was drawn, on every speedboat sea', () => {
  let world: TowerReachWorld;
  beforeAll(() => {
    world = buildTowerReach(TOWER_REACH_SEED);
  }, 180_000);
  const gatesOf = (c: Course) => c.elements.flatMap((e) => (e.kind === 'gate' ? [e.gate] : []));

  it('sheltered gates K ≤ 0.5 and exposed gates K ≥ 0.8; both kinds on the lap', () => {
    for (const n of NAMES) {
      const shelter = createShelterField(world.heightmaps.map((hm, i) => ({ heightmap: hm, center: world.sites[i].position })), undefined, { ...REFERENCE_SEA, ...SPEEDBOAT_SEAS[n].ocean });
      let sheltered = 0;
      let exposed = 0;
      for (const g of gatesOf(world.course)) {
        const k = (shelter.kAt((g.left[0] + g.right[0]) / 2, (g.left[1] + g.right[1]) / 2) + shelter.kAt(g.left[0], g.left[1]) + shelter.kAt(g.right[0], g.right[1])) / 3;
        if (g.sector === 'sheltered') {
          expect(k, `${n} ${g.id} (sheltered)`).toBeLessThanOrEqual(0.5);
          sheltered++;
        } else {
          expect(k, `${n} ${g.id} (exposed)`).toBeGreaterThanOrEqual(0.8);
          exposed++;
        }
      }
      shelter.dispose();
      expect(sheltered).toBeGreaterThanOrEqual(3);
      expect(exposed).toBeGreaterThanOrEqual(3);
    }
  }, 180_000);
});

describe('the page applies them', () => {
  it('boat-select labels resolve to the speedboat seas; the override replaces the rung targets and a plain rung restores them', () => {
    expect(seaApplyArgs(SEA_PRESET['Working sea'])).toEqual(['breeze', { ocean: SPEEDBOAT_SEAS.working.ocean }]);
    expect(seaApplyArgs(SEA_PRESET.Squall, 0)).toEqual(['squall', { lerpSeconds: 0 }]);
    for (const opt of SEA_OPTIONS) expect(SEA_PRESET[opt], opt).toBeDefined();
    const shipped = structuredClone(oceanParams);
    try {
      const [name, opts] = seaApplyArgs('open', 0);
      applyWeatherPreset(name, opts);
      for (const [k, v] of Object.entries(SPEEDBOAT_SEAS.open.ocean)) expect(oceanParams[k as keyof OceanParams], k).toBe(v);
      applyWeatherPreset('swell', { lerpSeconds: 0 });
      for (const [k, v] of Object.entries(weatherPresets.swell.ocean)) expect(oceanParams[k as keyof OceanParams], k).toBe(v);
    } finally {
      Object.assign(oceanParams, shipped);
    }
  });
});
