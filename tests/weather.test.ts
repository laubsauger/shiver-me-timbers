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
import {
  applyWeatherPreset,
  createWeatherSystem,
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
  const clouds = {
    coverage: 0.65,
    sunColor: 0xfff1d4,
    skyColor: 0xe9eff5,
    clusterCount: 10, // NOT in any preset
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
  it('raises amplitude AND raises jacobianFoamBias (inject where J < bias)', () => {
    const { swell, storm } = weatherPresets;
    expect(storm.ocean.amplitude).toBeGreaterThan(swell.ocean.amplitude);
    expect(storm.ocean.jacobianFoamBias).toBeGreaterThan(
      swell.ocean.jacobianFoamBias,
    );
  });

  it('calm sits below swell on both — the same dial, turned the other way', () => {
    const { calm, swell } = weatherPresets;
    expect(calm.ocean.amplitude).toBeLessThan(swell.ocean.amplitude);
    expect(calm.ocean.jacobianFoamBias).toBeLessThan(
      swell.ocean.jacobianFoamBias,
    );
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
    expect(fakes.clouds.clusterCount).toBe(10);
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
