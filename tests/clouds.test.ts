/**
 * §V2 determinism extends to seeded visuals: cloud cluster layout must be a
 * pure function of (seed, params) or multiplayer clients would render
 * different skies from the same SimState seed. Also guards the §V16 contract
 * that coverage is a bounded 0..1 tunable and that params drive cluster
 * counts (a silent params/generator drift would desync panel and sky), and
 * the §V7/§V11b contract that a storm anvil is reachable from calm cumulus
 * by moving PARAMS ONLY — if `silhouetteRadius` ever needs a branch to make
 * a monument, the weather preset system has been broken.
 */
import { describe, expect, it } from 'vitest';
import {
  generateClusters,
  silhouetteRadius,
  countLobes,
} from '../src/clouds/cloudCores';
import {
  cloudParams,
  clampCoverage,
  cloudLayoutKey,
  type CloudParams,
} from '../src/params/clouds';

const testParams: CloudParams = {
  ...cloudParams,
  clusterCount: 7,
  lobesMin: 5,
  lobesMax: 9,
};

/** the storm patch from the §V11b report — anvil monuments, params only */
const stormParams: CloudParams = {
  ...cloudParams,
  clusterHeight: 2.6,
  heightBias: 1.0,
  domeExponent: 8,
  waistWidth: 0.42,
  waistHeight: 0.55,
  anvilStart: 0.55,
  capRound: 0.95,
  anvilSpread: 1.2,
};

describe('cloud cluster generation (§V11 + §V2 seeded determinism)', () => {
  it('same seed → identical lobe layout', () => {
    const a = generateClusters(1234, testParams);
    const b = generateClusters(1234, testParams);
    expect(b).toEqual(a);
  });

  it('different seed → different layout', () => {
    const a = generateClusters(1234, testParams);
    const b = generateClusters(4321, testParams);
    expect(JSON.stringify(b)).not.toEqual(JSON.stringify(a));
  });

  it('cluster count matches params', () => {
    expect(generateClusters(7, testParams)).toHaveLength(testParams.clusterCount);
    expect(generateClusters(7, cloudParams)).toHaveLength(cloudParams.clusterCount);
  });

  it('lobe counts stay inside [lobesMin, lobesMax]', () => {
    for (const cluster of generateClusters(99, testParams)) {
      expect(cluster.lobes.length).toBeGreaterThanOrEqual(testParams.lobesMin);
      expect(cluster.lobes.length).toBeLessThanOrEqual(testParams.lobesMax);
    }
  });

  it('clusters sit on the configured ring and altitude band', () => {
    for (const c of generateClusters(5, testParams)) {
      const dist = Math.hypot(c.x, c.z);
      expect(dist).toBeGreaterThanOrEqual(testParams.ringInner - 1e-9);
      expect(dist).toBeLessThanOrEqual(testParams.ringOuter + 1e-9);
      expect(c.y).toBeGreaterThanOrEqual(testParams.altitudeMin);
      expect(c.y).toBeLessThanOrEqual(testParams.altitudeMax);
    }
  });

  it('the default sky fits inside the instance capacity (§V28)', () => {
    expect(countLobes(generateClusters(1, cloudParams))).toBeLessThanOrEqual(
      cloudParams.maxLobes,
    );
    // and the panel maxima must too, or a slider drag drops lobes silently
    const maxed: CloudParams = { ...cloudParams, clusterCount: 32, lobesMin: 64, lobesMax: 64 };
    expect(countLobes(generateClusters(1, maxed))).toBeLessThanOrEqual(cloudParams.maxLobes);
  });

  it('every lobe carries finite geometry — no NaN reaches an instance buffer', () => {
    for (const c of generateClusters(31, stormParams)) {
      for (const l of c.lobes) {
        for (const v of [l.x, l.y, l.z, l.rx, l.ry, l.rz, l.dirX, l.dirY, l.dirZ]) {
          expect(Number.isFinite(v)).toBe(true);
        }
        expect(l.rx).toBeGreaterThan(0);
        expect(l.ry).toBeGreaterThan(0);
        expect(l.rz).toBeGreaterThan(0);
        expect(l.interior).toBeGreaterThanOrEqual(0);
        expect(l.interior).toBeLessThanOrEqual(1);
        expect(Math.hypot(l.dirX, l.dirY, l.dirZ)).toBeCloseTo(1, 6);
      }
    }
  });
});

describe('silhouette family (§V11b sculpted form, §V7 params-only storms)', () => {
  it('calm cumulus is widest at the base and tapers to the top', () => {
    const base = silhouetteRadius(0, cloudParams);
    const mid = silhouetteRadius(0.5, cloudParams);
    const top = silhouetteRadius(0.98, cloudParams);
    expect(base).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(top);
  });

  it('the SAME function makes an anvil once anvilSpread is turned up', () => {
    // A monument (talk "Clouds: Concept") is a narrow waist under an
    // overhanging cap. That is the whole shape test: the cap must be WIDER
    // than the trunk below it, which a plain cumulus profile can never be.
    const waist = silhouetteRadius(0.45, stormParams);
    const cap = silhouetteRadius(0.85, stormParams);
    expect(cap).toBeGreaterThan(waist * 1.5);

    // calm must NOT accidentally satisfy it, or the test proves nothing
    const calmWaist = silhouetteRadius(0.45, cloudParams);
    const calmCap = silhouetteRadius(0.85, cloudParams);
    expect(calmCap).toBeLessThan(calmWaist);
  });

  it('radius stays positive and finite across the whole height range', () => {
    for (const p of [cloudParams, stormParams]) {
      for (let i = 0; i <= 40; i++) {
        const r = silhouetteRadius(i / 40, p);
        expect(Number.isFinite(r)).toBe(true);
        expect(r).toBeGreaterThan(0);
      }
    }
  });

  it('degenerate profile params cannot divide by zero (§V28)', () => {
    const degenerate: CloudParams = {
      ...cloudParams,
      waistHeight: 0,
      anvilStart: 1,
      capRound: 1,
      anvilSpread: 1,
    };
    for (let i = 0; i <= 20; i++) {
      expect(Number.isFinite(silhouetteRadius(i / 20, degenerate))).toBe(true);
    }
  });
});

describe('layout key drives regeneration (§V7 presets take effect live)', () => {
  it('changing a shape param changes the key', () => {
    const before = cloudLayoutKey(cloudParams);
    expect(cloudLayoutKey({ ...cloudParams, anvilSpread: 1.2 })).not.toBe(before);
    expect(cloudLayoutKey({ ...cloudParams, clusterHeight: 2.6 })).not.toBe(before);
    expect(cloudLayoutKey(stormParams)).not.toBe(before);
  });

  it('changing a pure-shading param does NOT (no needless rebuilds)', () => {
    const before = cloudLayoutKey(cloudParams);
    expect(cloudLayoutKey({ ...cloudParams, coverage: 0.5 })).toBe(before);
    expect(cloudLayoutKey({ ...cloudParams, sunColor: 0x112233 })).toBe(before);
    expect(cloudLayoutKey({ ...cloudParams, selfShadow: 0.9 })).toBe(before);
  });
});

describe('coverage param bounds (§V16)', () => {
  it('clamps into [0,1]', () => {
    expect(clampCoverage(-0.5)).toBe(0);
    expect(clampCoverage(0)).toBe(0);
    expect(clampCoverage(0.65)).toBe(0.65);
    expect(clampCoverage(1)).toBe(1);
    expect(clampCoverage(3)).toBe(1);
  });

  it('non-finite input falls back to 0, never NaN density on the GPU', () => {
    expect(clampCoverage(Number.NaN)).toBe(0);
    expect(clampCoverage(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampCoverage(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('default coverage param is itself in bounds', () => {
    expect(clampCoverage(cloudParams.coverage)).toBe(cloudParams.coverage);
  });
});
