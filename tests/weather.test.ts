/**
 * T6 weather presets — the tests encode §V7's exact promise:
 * presets are PURE DATA patches over params (no special code paths), the
 * storm preset raises amplitude AND raises jacobianFoamBias (more foam),
 * and applying one is nothing but writing values into the live registry
 * objects — every param not named in a patch stays untouched.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearParamsRegistry,
  registerParams,
} from '../src/params/registry';
import { weatherParams } from '../src/params/weather';
import { oceanParams } from '../src/params/ocean';
import { skyParams } from '../src/params/sky';
import { cloudParams } from '../src/params/clouds';
import { cascadeBand, effectiveChoppiness, spectralSteepness } from '../src/ocean/oceanMath';
import { jacobianSigma } from '../src/foam/foamMath';
import {
  advanceDrift,
  applyWeatherPreset,
  blendSample,
  createWeatherSample,
  createWeatherSystem,
  hashCell,
  hazeAnisotropy,
  hazeContract,
  hazeDensityScale,
  resetPresetWarnings,
  sanitizeFieldConfig,
  stormAt,
  weatherPresets,
} from '../src/weather';

beforeEach(() => {
  clearParamsRegistry();
});

/** live fake params objects standing in for the real systems */
function registerFakes() {
  const ocean = {
    amplitude: 1.0,
    windSpeed: 9,
    choppiness: 1.4,
    jacobianFoamBias: 0.55,
    resolution: 512, // NOT in any preset — must never change
  };
  const sky = {
    hazeStrength: 0.9,
    sunIntensity: 3.2,
    ambientIntensity: 0.85,
    timeOfDay: 10.5, // NOT in any preset
  };
  // the full cloud preset key set (§V11b silhouette family included) — a fake
  // missing keys the preset names would trip applyPreset's §B.18 warning,
  // which is exactly the noise that warning exists to make
  const clouds = {
    coverage: 0.65,
    sunColor: 0xfff1d4,
    skyColor: 0xe9eff5,
    clusterCount: 10,
    ringInner: 900,
    ringOuter: 2600,
    altitudeMin: 340,
    altitudeMax: 620,
    clusterRadiusMin: 180,
    clusterRadiusMax: 360,
    clusterFlatten: 1.35,
    clusterHeight: 0.95,
    heightBias: 1.6,
    lobeScaleMin: 0.17,
    lobeScaleMax: 0.31,
    domeExponent: 2.2,
    waistWidth: 0.9,
    waistHeight: 0.7,
    anvilStart: 0.75,
    capRound: 0.9,
    anvilSpread: 0,
    rtWidth: 768, // NOT in any preset
  };
  const ropes = { slack: 0.25 }; // whole system absent from presets
  registerParams('ocean', ocean);
  registerParams('sky', sky);
  registerParams('clouds', clouds);
  registerParams('ropes', ropes);
  return { ocean, sky, clouds, ropes };
}

describe('presets are pure data (§V7: only param values, no code)', () => {
  it('survives JSON round-trip unchanged — serializable, no functions', () => {
    const roundTripped = JSON.parse(JSON.stringify(weatherPresets));
    expect(roundTripped).toEqual(weatherPresets);
  });

  it('every leaf is a number — patches are param values, nothing else', () => {
    for (const preset of Object.values(weatherPresets)) {
      for (const patch of Object.values(preset)) {
        for (const value of Object.values(patch)) {
          expect(typeof value).toBe('number');
        }
      }
    }
  });

  it('all presets patch the same key set — switching is fully reversible', () => {
    const shape = (p: object) =>
      Object.entries(p)
        .map(([sys, patch]) => `${sys}:${Object.keys(patch).sort().join(',')}`)
        .sort()
        .join('|');
    const swellShape = shape(weatherPresets.swell);
    expect(shape(weatherPresets.calm)).toBe(swellShape);
    expect(shape(weatherPresets.storm)).toBe(swellShape);
  });

  it('swell mirrors the params-module defaults — applying it restores factory state', () => {
    for (const [key, value] of Object.entries(weatherPresets.swell.ocean)) {
      expect(oceanParams[key as keyof typeof oceanParams]).toBe(value);
    }
    for (const [key, value] of Object.entries(weatherPresets.swell.sky)) {
      expect(skyParams[key as keyof typeof skyParams]).toBe(value);
    }
    for (const [key, value] of Object.entries(weatherPresets.swell.clouds)) {
      expect(cloudParams[key as keyof typeof cloudParams]).toBe(value);
    }
  });
});

describe('storm vs swell (§V7: amp up + foam bias up → big foam patches)', () => {
  /**
   * How rare a foam event each preset asks for, as a σ-multiple of ITS OWN
   * sea (§V36): z = (1 − bias) / σ(summed jacobian), with σ built from the
   * live spectrum. SMALLER z = more of the surface foams.
   *
   * This is the promise §V7 actually makes; `jacobianFoamBias` on its own is
   * NOT a proxy for it. A storm sea is ~3× steeper than a swell sea, so the
   * identical bias number already foams far more there — which is why the
   * storm preset can (and now does) sit BELOW swell's number while producing
   * ~18× the coverage. Asserting "storm's bias is the bigger number" passed
   * happily through the entire period when the foam sim produced no swell
   * whitecaps at all, because it never looked at a sea.
   */
  const foamRarity = (patch: { amplitude: number; windSpeed: number; choppiness: number; jacobianFoamBias: number }) => {
    const p = { ...oceanParams, ...patch };
    let steepnessVariance = 0;
    for (let i = 0; i < 3; i++) {
      const s = spectralSteepness(
        p.resolution,
        p.cascades[i].domain,
        p,
        cascadeBand(i, p.splitWavelengths),
      );
      steepnessVariance += s * s;
    }
    const steepnessRms = Math.sqrt(steepnessVariance);
    const lambda = effectiveChoppiness(p.choppiness, steepnessRms, p.choppinessFoldLimit);
    return (1 - patch.jacobianFoamBias) / jacobianSigma(steepnessRms, lambda);
  };

  it('storm foams far more than swell: bigger seas AND a lower σ-bar', () => {
    const { swell, storm } = weatherPresets;
    expect(storm.ocean.amplitude).toBeGreaterThan(swell.ocean.amplitude);
    // storm ≈1.3σ (broad patches), swell ≈2.5σ (sparse caps)
    expect(foamRarity(storm.ocean)).toBeLessThan(foamRarity(swell.ocean));
    expect(foamRarity(storm.ocean)).toBeLessThan(1.6);
    expect(foamRarity(swell.ocean)).toBeGreaterThan(2);
  });

  it('swell still foams: sparse caps, not a bare sea (the user-visible bug)', () => {
    // §B: the sim was gating each cascade at 5–8σ, i.e. nothing, for a long
    // time. A swell sea must sit in the range where whitecaps are occasional
    // but present — "in some little spots here and there" (user).
    expect(foamRarity(weatherPresets.swell.ocean)).toBeLessThan(3);
  });

  it('calm sits below swell on both — the same dial, turned the other way', () => {
    const { calm, swell } = weatherPresets;
    expect(calm.ocean.amplitude).toBeLessThan(swell.ocean.amplitude);
    // rarer than swell: a glassy sea foams only where it truly folds
    expect(foamRarity(calm.ocean)).toBeGreaterThan(foamRarity(swell.ocean));
  });
});

describe('apply writes ONLY patched keys (§V7: no other code path)', () => {
  it('instant apply sets patch values, leaves every other param untouched', () => {
    const fakes = registerFakes();
    const ropesBefore = JSON.parse(JSON.stringify(fakes.ropes));
    applyWeatherPreset('storm', { lerpSeconds: 0 });
    // patched keys hit their targets exactly
    expect(fakes.ocean.amplitude).toBe(weatherPresets.storm.ocean.amplitude);
    expect(fakes.ocean.jacobianFoamBias).toBe(
      weatherPresets.storm.ocean.jacobianFoamBias,
    );
    expect(fakes.clouds.sunColor).toBe(weatherPresets.storm.clouds.sunColor);
    // unpatched keys on patched systems: untouched
    expect(fakes.ocean.resolution).toBe(512);
    expect(fakes.sky.timeOfDay).toBe(10.5);
    expect(fakes.clouds.rtWidth).toBe(768);
    // system absent from the preset: fully untouched
    expect(fakes.ropes).toEqual(ropesBefore);
  });

  it('systems missing from the registry are skipped, not fatal', () => {
    // nothing registered at all — parallel param modules may not have landed
    expect(() => applyWeatherPreset('storm', { lerpSeconds: 0 })).not.toThrow();
  });
});

describe('transition lerp (storms roll in, they do not snap)', () => {
  it('numeric params move monotonically and land exactly on target', () => {
    const { ocean } = registerFakes();
    const t = applyWeatherPreset('storm', { lerpSeconds: 2 });
    const seen: number[] = [ocean.amplitude];
    for (let i = 0; i < 20; i++) {
      t.update(0.1);
      seen.push(ocean.amplitude);
    }
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]); // monotonic rise
    }
    // partway it is strictly between the endpoints (actually lerping)
    expect(seen[10]).toBeGreaterThan(weatherPresets.swell.ocean.amplitude);
    expect(seen[10]).toBeLessThan(weatherPresets.storm.ocean.amplitude);
    // completes: exact target after lerpSeconds, and flagged done
    expect(ocean.amplitude).toBe(weatherPresets.storm.ocean.amplitude);
    expect(t.done).toBe(true);
    t.update(0.1); // post-completion update is a safe no-op
    expect(ocean.amplitude).toBe(weatherPresets.storm.ocean.amplitude);
  });

  it('hex colors never blend — they snap start→target at the midpoint', () => {
    const { clouds } = registerFakes();
    const start = clouds.sunColor;
    const target = weatherPresets.storm.clouds.sunColor;
    const t = applyWeatherPreset('storm', { lerpSeconds: 2 });
    const eps = 1e-9; // skip the exact-midpoint step: float accumulation
    for (let i = 0; i < 20; i++) {
      t.update(0.1);
      // only ever one of the two endpoints — a lerped hex int is garbage
      expect([start, target]).toContain(clouds.sunColor);
      const progress = ((i + 1) * 0.1) / 2;
      if (progress < 0.5 - eps) expect(clouds.sunColor).toBe(start);
      else if (progress > 0.5 + eps) expect(clouds.sunColor).toBe(target);
    }
    expect(clouds.sunColor).toBe(target);
  });

  it('omitted lerpSeconds uses the weatherParams tunable (§V16)', () => {
    const { ocean } = registerFakes();
    const t = applyWeatherPreset('calm');
    t.update(weatherParams.transitionSeconds);
    expect(t.done).toBe(true);
    expect(ocean.amplitude).toBe(weatherPresets.calm.ocean.amplitude);
  });
});

describe('createWeatherSystem facade', () => {
  it('tracks current preset and reports weather via the injected cb (§V3)', () => {
    registerFakes();
    const reported: string[] = [];
    const system = createWeatherSystem({
      setWeather: (w) => reported.push(w),
    });
    expect(system.current).toBe('swell'); // matches SimState initial weather
    system.apply('storm', { lerpSeconds: 2 });
    // label flips at onset, before the lerp finishes — the sim knows first
    expect(system.current).toBe('storm');
    expect(reported).toEqual(['storm']);
    system.update(2);
  });

  it('unknown preset name throws — fail loud, no silent no-op', () => {
    registerFakes();
    const system = createWeatherSystem();
    expect(() => system.apply('hurricane')).toThrow(/unknown weather preset/);
    expect(() => applyWeatherPreset('')).toThrow(/unknown weather preset/);
  });
});

/**
 * T38 / §V46 — LOCALISED weather. The point of every test below is that
 * weather stopped being one number applied to the whole world: the same
 * instant, a position 2 km away can be under a squall while this one is in
 * the clear. That is the reference read ("sun in the distance while it rains
 * above us"), and it is fully checkable headlessly because the field is pure.
 */
describe('storm field placement is deterministic (§V2)', () => {
  const cfg = {
    seed: 1234,
    cellSize: 2600,
    cellRadius: 1000,
    radiusVariance: 0.5,
    jitter: 0.8,
    edgeSoftness: 0.65,
    coverage: 0.4,
    intensity: 1,
    lifecycleSeconds: 420,
    lifecycleDepth: 0.45,
  };
  const noDrift = { x: 0, z: 0 };

  it('same seed + same query → identical value, every time', () => {
    for (let i = 0; i < 200; i++) {
      const x = i * 137.5;
      const z = i * -211.3;
      const a = stormAt(x, z, noDrift, 12.5, cfg);
      const b = stormAt(x, z, noDrift, 12.5, cfg);
      expect(a).toBe(b); // exact, not approximate — it is the same pure fn
    }
  });

  it('a different seed lays the cells out somewhere else', () => {
    const other = { ...cfg, seed: 99 };
    let differing = 0;
    let anyWeather = 0;
    for (let i = 0; i < 900; i++) {
      const x = i * 91;
      const z = i * 57;
      const a = stormAt(x, z, noDrift, 0, cfg);
      const b = stormAt(x, z, noDrift, 0, other);
      // most of the sea is clear at 0.4 coverage, and two layouts agreeing on
      // "clear here" proves nothing — only the covered samples carry signal
      if (a > 1e-6 || b > 1e-6) anyWeather++;
      if (Math.abs(a - b) > 1e-6) differing++;
    }
    expect(anyWeather).toBeGreaterThan(50); // the transect saw real weather
    // an independent layout must disagree on nearly every one of them
    expect(differing).toBeGreaterThan(anyWeather * 0.9);
  });

  it('hashCell is pure integer mixing — order-independent and in [0,1)', () => {
    const seen = new Set<number>();
    for (let i = -20; i <= 20; i++) {
      for (let j = -20; j <= 20; j++) {
        const h = hashCell(1234, i, j, 0);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThan(1);
        expect(hashCell(1234, i, j, 0)).toBe(h); // no internal state
        seen.add(h);
      }
    }
    // negative lattice indices must not collide with positive ones (the ship
    // sails unbounded in both directions — §V30)
    expect(seen.size).toBeGreaterThan(1600);
  });
});

describe('field is continuous at cell edges (§V46 soft edges)', () => {
  const cfg = {
    seed: 7,
    cellSize: 2600,
    cellRadius: 1000,
    radiusVariance: 0.5,
    jitter: 0.8,
    edgeSoftness: 0.65,
    coverage: 0.6,
    intensity: 1,
    lifecycleSeconds: 0,
    lifecycleDepth: 0,
  };
  const noDrift = { x: 0, z: 0 };

  it('never jumps across a lattice boundary — a pop would be a hard step', () => {
    // 40 km transect at 0.5 m steps crosses ~15 lattice edges on each axis
    let maxStep = 0;
    let prev = stormAt(0, 0, noDrift, 0, cfg);
    for (let s = 0.5; s <= 40000; s += 0.5) {
      const v = stormAt(s, s * 0.37, noDrift, 0, cfg);
      maxStep = Math.max(maxStep, Math.abs(v - prev));
      prev = v;
    }
    // the smoothstep rim over ~650 m gives ≈0.0012/step here; a cell popping
    // in or out at a lattice edge would show up as a step near its own weight
    expect(maxStep).toBeLessThan(0.01);
  });

  it('stays continuous even when cellRadius is dragged past the clamp', () => {
    // a radius wider than half the lattice square could reach outside the 3×3
    // neighbourhood the sampler walks — sanitizeFieldConfig must clamp it
    const wild = { ...cfg, cellRadius: 9000, radiusVariance: 1 };
    expect(sanitizeFieldConfig(wild).cellRadius).toBe(cfg.cellSize / 2);
    let maxStep = 0;
    let prev = stormAt(0, 0, noDrift, 0, wild);
    for (let s = 0.5; s <= 20000; s += 0.5) {
      const v = stormAt(s, -s * 0.61, noDrift, 0, wild);
      maxStep = Math.max(maxStep, Math.abs(v - prev));
      prev = v;
    }
    expect(maxStep).toBeLessThan(0.02);
  });

  it('is bounded [0,1] and finite for adversarial params (§V28/§V44)', () => {
    const nasty = [
      { ...cfg, cellSize: 0 },
      { ...cfg, cellSize: Number.NaN },
      { ...cfg, cellRadius: -500 },
      { ...cfg, edgeSoftness: Number.NaN },
      { ...cfg, coverage: 5 },
      { ...cfg, intensity: 12 },
      { ...cfg, radiusVariance: 3, jitter: 4 },
      { ...cfg, lifecycleSeconds: Number.NaN, lifecycleDepth: 2 },
    ];
    for (const c of nasty) {
      for (let i = 0; i < 300; i++) {
        const v = stormAt(i * 313, i * -177, noDrift, i * 4.5, c);
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('weather is LOCAL, not global (§V46 — the whole point)', () => {
  const cfg = {
    seed: 4242,
    cellSize: 2600,
    cellRadius: 1000,
    radiusVariance: 0.5,
    jitter: 0.8,
    edgeSoftness: 0.65,
    coverage: 0.4,
    intensity: 1,
    lifecycleSeconds: 0,
    lifecycleDepth: 0,
  };
  const noDrift = { x: 0, z: 0 };

  it('within one horizon there is both a squall and clear sky', () => {
    // §V30 puts ~4 km of readable sea in frame; both readings must exist
    // inside it or you can never see rain overhead and sun on the horizon
    let wettest = 0;
    let driest = 1;
    for (let x = -4000; x <= 4000; x += 50) {
      for (let z = -4000; z <= 4000; z += 50) {
        const v = stormAt(x, z, noDrift, 0, cfg);
        if (v > wettest) wettest = v;
        if (v < driest) driest = v;
      }
    }
    expect(wettest).toBeGreaterThan(0.9);
    expect(driest).toBeLessThan(0.05);
  });

  it('cellIntensity 0 collapses to the old global model exactly (§V7)', () => {
    const off = { ...cfg, intensity: 0 };
    for (let i = 0; i < 500; i++) {
      expect(stormAt(i * 71, i * -29, noDrift, i, off)).toBe(0);
    }
  });
});

describe('storm cells drift downwind (§V46)', () => {
  const cfg = {
    seed: 5150,
    cellSize: 2600,
    cellRadius: 1000,
    radiusVariance: 0.4,
    jitter: 0.7,
    edgeSoftness: 0.6,
    coverage: 0.45,
    intensity: 1,
    lifecycleSeconds: 0,
    lifecycleDepth: 0,
  };

  it('drift is a pure translation of the pattern', () => {
    const drift = { x: 0, z: 0 };
    // 600 ticks of a 12 m/s wind blowing due +x at 0.5 carry
    for (let i = 0; i < 600; i++) advanceDrift(drift, 0, 12, 0.5, 1 / 60);
    expect(drift.x).toBeCloseTo(12 * 0.5 * 10, 6);
    expect(drift.z).toBeCloseTo(0, 9);
    // sampling a drifted field at p equals sampling the still field at p−drift
    for (let i = 0; i < 100; i++) {
      const x = i * 233;
      const z = i * -119;
      expect(stormAt(x, z, drift, 0, cfg)).toBe(
        stormAt(x - drift.x, z - drift.z, { x: 0, z: 0 }, 0, cfg),
      );
    }
  });

  it('drift follows the wind vector convention the sea and sails use', () => {
    const dir = Math.PI * 0.25; // the shipped oceanParams.windDirection
    const drift = { x: 0, z: 0 };
    advanceDrift(drift, dir, 10, 1, 1);
    // (cos θ, sin θ) → (x, z), identical to how main.ts builds the spray wind
    expect(drift.x).toBeCloseTo(Math.cos(dir) * 10, 9);
    expect(drift.z).toBeCloseTo(Math.sin(dir) * 10, 9);
  });

  it('drift is plain JSON data — it is what SimState has to carry (§V2)', () => {
    const drift = { x: 0, z: 0 };
    advanceDrift(drift, 1.1, 9, 0.6, 1 / 60);
    expect(JSON.parse(JSON.stringify(drift))).toEqual(drift);
    expect(Number.isFinite(drift.x) && Number.isFinite(drift.z)).toBe(true);
  });

  it('a NaN wind cannot poison the drift for the rest of the session', () => {
    const drift = { x: 3, z: -4 };
    advanceDrift(drift, Number.NaN, Number.NaN, Number.NaN, Number.NaN);
    expect(drift.x).toBe(3);
    expect(drift.z).toBe(-4);
  });
});

describe('weatherAt blends PRESET values, nothing else (§V46 + §V7)', () => {
  it('storm 0 returns the live params; storm 1 returns the storm preset', () => {
    const fakes = registerFakes();
    const out = createWeatherSample();

    blendSample(0, 'swell', out);
    expect(out.ocean.amplitude).toBe(fakes.ocean.amplitude);
    expect(out.sky.hazeStrength).toBe(fakes.sky.hazeStrength);
    expect(out.clouds.coverage).toBe(fakes.clouds.coverage);

    blendSample(1, 'swell', out);
    expect(out.ocean.amplitude).toBe(weatherPresets.storm.ocean.amplitude);
    expect(out.sky.sunIntensity).toBe(weatherPresets.storm.sky.sunIntensity);
    expect(out.clouds.coverage).toBe(weatherPresets.storm.clouds.coverage);
  });

  it('sampling never writes the params it read — the field is read-only', () => {
    const fakes = registerFakes();
    const before = JSON.parse(JSON.stringify(fakes));
    const out = createWeatherSample();
    for (let i = 0; i <= 10; i++) blendSample(i / 10, 'swell', out);
    expect(JSON.parse(JSON.stringify(fakes))).toEqual(before);
  });

  it('hex colours snap at the midpoint — a lerped 0xRRGGBB is garbage', () => {
    const fakes = registerFakes();
    const out = createWeatherSample();
    for (let i = 0; i <= 20; i++) {
      blendSample(i / 20, 'swell', out);
      expect([fakes.clouds.sunColor, weatherPresets.storm.clouds.sunColor]).toContain(
        out.clouds.sunColor,
      );
    }
  });

  it('a GLOBAL storm saturates at 1 — cells cannot double-count it', () => {
    registerFakes();
    applyWeatherPreset('storm', { lerpSeconds: 0 });
    const out = createWeatherSample();
    for (const t of [0, 0.3, 1]) {
      blendSample(t, 'storm', out);
      expect(out.storm).toBe(1);
      // live params already ARE the storm preset, so the blend is identity
      expect(out.ocean.amplitude).toBe(weatherPresets.storm.ocean.amplitude);
    }
  });

  it('rain only falls once the storm scalar clears the threshold', () => {
    registerFakes();
    const out = createWeatherSample();
    blendSample(0, 'swell', out); // an ordinary working sea
    expect(out.rain).toBe(0);
    blendSample(1, 'swell', out); // inside a squall
    expect(out.rain).toBe(1);
    // monotonic in between — density rises as you sail in, never flickers
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      blendSample(i / 20, 'swell', out);
      expect(out.rain).toBeGreaterThanOrEqual(prev);
      prev = out.rain;
    }
  });

  it('every sampled value is finite for any field strength', () => {
    registerFakes();
    const out = createWeatherSample();
    for (const t of [-1, 0, 0.5, 1, 2, Number.NaN]) {
      blendSample(t, 'calm', out);
      expect(Number.isFinite(out.storm)).toBe(true);
      expect(Number.isFinite(out.rain)).toBe(true);
      for (const sys of ['ocean', 'sky', 'clouds'] as const) {
        for (const v of Object.values(out[sys])) {
          expect(Number.isFinite(v as number)).toBe(true);
        }
      }
    }
  });
});

describe('weather system exposes the field (§T.38 integration surface)', () => {
  it('weatherAt is seeded, drifts on update, and stays read-only', () => {
    registerFakes();
    const a = createWeatherSystem({ seed: 1234 });
    const b = createWeatherSystem({ seed: 1234 });
    const c = createWeatherSystem({ seed: 4321 });
    // identical seeds agree everywhere; a different seed does not
    let differs = 0;
    let anyWeather = 0;
    for (let i = 0; i < 200; i++) {
      const x = i * 143;
      const z = i * -97;
      expect(a.stormAt(x, z)).toBe(b.stormAt(x, z));
      if (a.stormAt(x, z) > 1e-6 || c.stormAt(x, z) > 1e-6) anyWeather++;
      if (Math.abs(a.stormAt(x, z) - c.stormAt(x, z)) > 1e-6) differs++;
    }
    expect(anyWeather).toBeGreaterThan(30);
    expect(differs).toBeGreaterThan(anyWeather * 0.9);

    // update advances the pattern (oceanParams carries a non-zero wind)
    const before = { ...a.drift };
    for (let i = 0; i < 60; i++) a.update(1 / 60);
    expect(Math.hypot(a.drift.x - before.x, a.drift.z - before.z)).toBeGreaterThan(0);
    expect(a.time).toBeCloseTo(1, 6);
  });

  it('a restored drift reproduces the field exactly (§V2 replay)', () => {
    const live = createWeatherSystem({ seed: 77 });
    for (let i = 0; i < 300; i++) live.update(1 / 60);
    const saved = JSON.parse(JSON.stringify(live.drift));
    const restored = createWeatherSystem({ seed: 77, drift: saved });
    // the lifecycle also needs the same sim time; drive it there without wind
    // motion by restoring drift and re-ticking is not needed for the check at
    // t = 0 phase-free params, so compare with the lifecycle disabled
    const savedLifecycle = weatherParams.cellLifecycleSeconds;
    weatherParams.cellLifecycleSeconds = 0;
    try {
      for (let i = 0; i < 200; i++) {
        const x = i * 311;
        const z = i * 53;
        expect(restored.stormAt(x, z)).toBe(live.stormAt(x, z));
      }
    } finally {
      weatherParams.cellLifecycleSeconds = savedLifecycle;
    }
  });

  it('weatherAt fills a caller-owned sample — no per-frame allocation', () => {
    registerFakes();
    const system = createWeatherSystem({ seed: 9 });
    const mine = createWeatherSample();
    expect(system.weatherAt(0, 0, mine)).toBe(mine);
  });
});

describe('sun-anisotropic haze (§V47)', () => {
  it('peaks along the sun vector and falls off away from it', () => {
    const g = 0.55;
    expect(hazeAnisotropy(1, g)).toBeCloseTo(1, 9);
    let prev = hazeAnisotropy(1, g);
    for (let mu = 0.95; mu >= -1; mu -= 0.05) {
      const a = hazeAnisotropy(mu, g);
      expect(a).toBeLessThanOrEqual(prev + 1e-12); // monotonic decrease
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
      prev = a;
    }
    expect(hazeAnisotropy(-1, g)).toBeLessThan(0.2);
  });

  it('is bounded and finite even at g = 1 and for garbage input', () => {
    for (const g of [0, 0.5, 1, 5, -1, Number.NaN]) {
      for (const mu of [-2, -1, 0, 1, 2, Number.NaN]) {
        const a = hazeAnisotropy(mu, g);
        expect(Number.isFinite(a)).toBe(true);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThanOrEqual(1);
      }
    }
  });

  it('the murk is THICKER away from the sun than along it (the §V47 claim)', () => {
    const towardSun = hazeDensityScale(1, 1);
    const across = hazeDensityScale(0, 1);
    const away = hazeDensityScale(-1, 1);
    expect(towardSun).toBeLessThan(1); // lit patch reads through
    expect(away).toBeGreaterThan(1); // grey wall behind you
    expect(across).toBeGreaterThan(towardSun);
    expect(away).toBeGreaterThan(across);
  });

  it('storm 0 leaves the sky exactly as it renders today (§V7)', () => {
    for (const mu of [-1, -0.3, 0, 0.5, 1]) {
      expect(hazeDensityScale(mu, 0)).toBe(1);
      expect(hazeContract(mu, 0).litWeight).toBe(0);
    }
  });
});

/**
 * §V11b + §B.18 — the storm sky and the silent-drop guard.
 */
describe('the storm preset carries a SILHOUETTE, not just grey (§V11b)', () => {
  it('storm builds an anvil monument; calm stays a fair-weather puff', () => {
    const { calm, storm } = weatherPresets;
    // the anvil overhang is the single feature that separates a monument from
    // a big grey cumulus — without it storm can only tint clouds darker
    expect(calm.clouds.anvilSpread).toBe(0);
    expect(storm.clouds.anvilSpread).toBeGreaterThan(0.5);
    // towers, not pancakes: vertical extent as a multiple of cluster radius
    expect(storm.clouds.clusterHeight).toBeGreaterThan(2);
    expect(storm.clouds.clusterHeight).toBeGreaterThan(calm.clouds.clusterHeight);
    // flat-topped rather than domed, and drawn in at the waist into a stalk
    expect(storm.clouds.domeExponent).toBeGreaterThan(calm.clouds.domeExponent);
    expect(storm.clouds.waistWidth).toBeLessThan(calm.clouds.waistWidth);
    // and it SITS ON THE HORIZON — pushed out, with a low heavy base
    expect(storm.clouds.ringInner).toBeGreaterThan(calm.clouds.ringInner);
    expect(storm.clouds.altitudeMin).toBeLessThan(calm.clouds.altitudeMin);
    expect(storm.clouds.clusterRadiusMax).toBeGreaterThan(
      calm.clouds.clusterRadiusMax * 2,
    );
  });

  it('calm opens the sky with FEWER CLUSTERS, not with low coverage (§V11b)', () => {
    const { calm, swell } = weatherPresets;
    // coverage is per-lobe density on near-opaque polygonal cores now; a low
    // value ghosts every lobe instead of clearing the sky
    expect(calm.clouds.coverage).toBeGreaterThan(0.6);
    expect(calm.clouds.clusterCount).toBeLessThan(swell.clouds.clusterCount);
  });

  it('storm cloud colours stay well apart — sun + sky are SUMMED', () => {
    // color = sunColor*R + skyColor*G, so two near-whites clip on both faces
    // and the cloud reads flat. The skylight term must be clearly darker.
    for (const p of Object.values(weatherPresets)) {
      const lum = (hex: number) =>
        ((hex >> 16) & 255) * 0.2126 +
        ((hex >> 8) & 255) * 0.7152 +
        (hex & 255) * 0.0722;
      expect(lum(p.clouds.skyColor)).toBeLessThan(lum(p.clouds.sunColor) - 30);
    }
  });
});

describe('a preset can never silently drop a system again (§B.18)', () => {
  it('warns loudly when a patched system is not registered', () => {
    resetPresetWarnings();
    // nothing registered — exactly the state clouds was in for the whole
    // project, where every cloud value in every preset went nowhere in silence
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
    try {
      applyWeatherPreset('storm', { lerpSeconds: 0 });
    } finally {
      console.warn = original;
    }
    // one per patched system, each naming the system and how to fix it
    const systems = Object.keys(weatherPresets.storm);
    for (const sys of systems) {
      expect(warnings.some((w) => w.includes(`"${sys}"`))).toBe(true);
    }
    expect(warnings.some((w) => w.includes('§B.18'))).toBe(true);
  });

  it('still applies everything it CAN find — the skip stays non-fatal', () => {
    resetPresetWarnings();
    const ocean = { amplitude: 1, windSpeed: 9, choppiness: 1.4, jacobianFoamBias: 0.55 };
    registerParams('ocean', ocean); // sky + clouds deliberately absent
    const original = console.warn;
    console.warn = () => {};
    try {
      expect(() => applyWeatherPreset('storm', { lerpSeconds: 0 })).not.toThrow();
    } finally {
      console.warn = original;
    }
    expect(ocean.amplitude).toBe(weatherPresets.storm.ocean.amplitude);
  });

  it('does not repeat the same warning on every preset switch', () => {
    resetPresetWarnings();
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
    try {
      applyWeatherPreset('storm', { lerpSeconds: 0 });
      const afterFirst = warnings.length;
      for (let i = 0; i < 10; i++) applyWeatherPreset('calm', { lerpSeconds: 0 });
      expect(warnings.length).toBe(afterFirst); // reported once, not spammed
    } finally {
      console.warn = original;
    }
  });
});

describe('layout lanes are quantised so the sky is not rebuilt every frame', () => {
  it('a layout key steps; a plain key lerps smoothly', () => {
    const fakes = registerFakes();
    const original = console.warn;
    console.warn = () => {};
    let t;
    try {
      t = applyWeatherPreset('storm', { lerpSeconds: 4 });
    } finally {
      console.warn = original;
    }
    const layoutSeen = new Set<number>();
    const plainSeen = new Set<number>();
    for (let i = 0; i < 240; i++) {
      t.update(1 / 60);
      layoutSeen.add(fakes.clouds.clusterHeight); // regenerates ~400 lobes
      plainSeen.add(fakes.ocean.amplitude); // just a uniform
    }
    // the layout lane visits at most layoutLerpSteps distinct values (+ the
    // exact endpoint), so src/clouds rebuilds that many times, not 240
    expect(layoutSeen.size).toBeLessThanOrEqual(weatherParams.layoutLerpSteps + 1);
    expect(plainSeen.size).toBeGreaterThan(200); // genuinely smooth
    // and it still LANDS exactly on target — quantising progress, not value
    expect(fakes.clouds.clusterHeight).toBe(weatherPresets.storm.clouds.clusterHeight);
    expect(fakes.clouds.anvilSpread).toBe(weatherPresets.storm.clouds.anvilSpread);
  });
});
