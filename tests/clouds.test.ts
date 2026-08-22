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
import * as THREE from 'three/webgpu';
import {
  generateClusters,
  silhouetteRadius,
  clusterShapeAt,
  stormFieldKey,
  countLobes,
  multiScatteredValue,
  baseGlowValue,
  lobeSunValue,
  stormBaseDarkValue,
  shaftSlots,
  hgPhaseValue,
  forwardScatterValue,
  powderValue,
  lobeReliefValue,
  fluffShapeValue,
  type SilhouetteProfile,
} from '../src/clouds/cloudCores';
import { keyLight } from '../src/sky/moonCycle';
import { hash3Cpu, fadeCpu } from '../src/terrain/noiseCpu';
import { createWeatherSystem } from '../src/weather';
import { createWeatherSample } from '../src/weather/sampler';
import { weatherParams } from '../src/params/weather';
import { skyParams } from '../src/params/sky';
import {
  resolveCloudPalette,
  resolveDomeAmbient,
  resolveKeyTint,
  keyWeights,
  srgbLightness,
} from '../src/clouds/cloudPalette';
import {
  advanceBandDrift,
  bandCoverageAt,
  bandShapeAt,
  bandSkyAt,
  bandSunAt,
  bandNonDegenerate,
} from '../src/clouds/cloudBands';
import {
  cloudParams,
  clampCoverage,
  cloudLayoutKey,
  type CloudParams,
} from '../src/params/clouds';

/**
 * A copy of the shipped cloud params taken at MODULE LOAD, i.e. before any
 * test body runs. `weather.apply('storm')` mutates the shared `cloudParams`
 * registry entry in place — that is the point of the preset system — and the
 * §V.63 block below calls it, so any later test reading `cloudParams` directly
 * is reading a storm sky. The §B90 blocks pin PIXELS, so they need the
 * shipped fair-weather numbers and cannot share that object.
 */
const PRISTINE: CloudParams = { ...cloudParams };

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

describe('localised storm field shapes each cluster (§V46)', () => {
  /** a cell centred on +X: everything with x > 1500 is stormy */
  const halfSky = (x: number): number => (x > 1500 ? 1 : 0);

  it('one sky holds fair-weather cumulus AND an anvil at the same time', () => {
    // this is the user ask in one assertion: blue skies and sunny, with a
    // storm cloud in the distance. If the field is ignored, every cluster
    // gets the same shape and one of these two counts is zero.
    const cs = generateClusters(2024, cloudParams, (x) => halfSky(x));
    const fair = cs.filter((c) => c.storm < 0.5);
    const stormy = cs.filter((c) => c.storm >= 0.5);
    expect(fair.length).toBeGreaterThan(0);
    expect(stormy.length).toBeGreaterThan(0);

    // and they are genuinely different clouds, not the same shape relabelled
    const height = (c: (typeof cs)[number]): number =>
      Math.max(...c.lobes.map((l) => l.y)) - Math.min(...c.lobes.map((l) => l.y));
    const fairH = height(fair[0]) / fair[0].radius;
    const stormH = height(stormy[0]) / stormy[0].radius;
    expect(stormH).toBeGreaterThan(fairH * 1.8);
  });

  it('a stormy cluster keeps its SITE — the cell must not push the cloud away', () => {
    // if storm strength moved a cluster, it would slide out of the cell that
    // created it and oscillate; the rain would then never be under the cloud
    const clear = generateClusters(77, cloudParams, () => 0);
    const heavy = generateClusters(77, cloudParams, () => 1);
    for (let i = 0; i < clear.length; i++) {
      expect(heavy[i].x).toBeCloseTo(clear[i].x, 6);
      expect(heavy[i].z).toBeCloseTo(clear[i].z, 6);
    }
  });

  it('drifting the field one quantisation step nudges lobes, never reshuffles', () => {
    // WHY: the field drifts continuously, so clusters are regenerated often.
    // The rng stream must stay storm-independent or lobe identity is lost and
    // the whole sky reshuffles every step instead of morphing.
    const a = generateClusters(4242, cloudParams, () => 0.5);
    const b = generateClusters(4242, cloudParams, () => 0.5 + 1 / cloudParams.stormQuantSteps);
    expect(b.length).toBe(a.length);
    for (let i = 0; i < a.length; i++) {
      expect(b[i].lobes.length).toBe(a[i].lobes.length);
      for (let j = 0; j < a[i].lobes.length; j++) {
        // same lobe, moved a little — a reshuffle would break this badly
        expect(b[i].lobes[j].seed).toBeCloseTo(a[i].lobes[j].seed, 12);
        const moved = Math.hypot(
          b[i].lobes[j].x - a[i].lobes[j].x,
          b[i].lobes[j].y - a[i].lobes[j].y,
          b[i].lobes[j].z - a[i].lobes[j].z,
        );
        expect(moved).toBeLessThan(a[i].radius * 0.35);
      }
    }
  });

  it('a hostile sampler cannot put NaN in an instance buffer (§V28)', () => {
    for (const bad of [() => Number.NaN, () => Infinity, () => -5, () => 99]) {
      for (const c of generateClusters(9, cloudParams, bad)) {
        expect(c.storm).toBeGreaterThanOrEqual(0);
        expect(c.storm).toBeLessThanOrEqual(1);
        for (const l of c.lobes) {
          expect(Number.isFinite(l.x + l.y + l.z + l.rx + l.ry + l.rz)).toBe(true);
          expect(Number.isFinite(l.storm)).toBe(true);
        }
      }
    }
  });

  it('the storm key quantises, so a drifting field does not rebuild every frame', () => {
    const cs = generateClusters(5, cloudParams, () => 0);
    const steps = cloudParams.stormQuantSteps;
    const at = (v: number): string => stormFieldKey(cs, () => v, steps);
    // a sub-step drift is invisible to the rebuild gate...
    expect(at(0.5)).toBe(at(0.5 + 0.4 / steps));
    // ...a full step is not
    expect(at(0.5)).not.toBe(at(0.5 + 1.2 / steps));
  });

  it('clusterShapeAt is a continuous blend, not a threshold (§V7 no code path)', () => {
    const prev = clusterShapeAt(cloudParams, 0);
    expect(prev.anvilSpread).toBe(cloudParams.anvilSpread);
    expect(clusterShapeAt(cloudParams, 1).anvilSpread).toBe(cloudParams.stormAnvilSpread);
    let last = prev.anvilSpread;
    for (let i = 1; i <= 20; i++) {
      const s = clusterShapeAt(cloudParams, i / 20);
      expect(s.anvilSpread).toBeGreaterThanOrEqual(last);
      last = s.anvilSpread;
    }
    // and the cap really does overhang once the field is fully stormy
    const full = clusterShapeAt(cloudParams, 1);
    expect(silhouetteRadius(0.85, full)).toBeGreaterThan(silhouetteRadius(0.45, full) * 1.5);
  });
});

describe('live cloud palette (§T.39 day cycle, §B.19 guard)', () => {
  const MIDDAY = 0x99def9; // scene.fog.color measured at noon
  const SUNSET = 0xfdb669; // ...and at timeOfDay 17.75
  // pathological inputs included on purpose: the guards below are meant to
  // hold for ANY colour the sky rig could ever publish, not just these two
  const HAZES = [MIDDAY, SUNSET, 0xa1e7ff, 0xff9542, 0xffffff, 0x000000, 0xff0000, 0x00ff88];
  const sun = new THREE.Color();
  const sky = new THREE.Color();
  const fog = new THREE.Color();
  const dome = new THREE.Color();
  const lum = (c: THREE.Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

  it('no fog → the authored colours come back untouched', () => {
    resolveCloudPalette(cloudParams, null, null, sun, sky);
    expect(sun.getHex()).toBe(cloudParams.sunColor);
    expect(sky.getHex()).toBe(cloudParams.skyColor);
  });

  it('warms AND deepens the sunlit faces at golden hour', () => {
    // the §T.39 report was "clouds render lavender-blue under a fully warm
    // sky". Warming the hue is only half of it — a sunset sun is also dimmer,
    // and a cloud that only changes hue reads as a midday cloud in a hat.
    //
    // §B90/§V80: the hour is NAMED here rather than implied by an argument.
    // The warmth weight is the sky's own `lowSunWarmth`, a function of sun
    // elevation, so the property belongs to an HOUR — feeding a warm colour in
    // at a midday clock is not a golden hour and must not behave like one.
    const restore = skyParams.timeOfDay;
    try {
      skyParams.timeOfDay = 17.75; // sun elevation 3.6°, warmth 1.0
      const before = new THREE.Color().setHex(cloudParams.sunColor);
      resolveKeyTint(fog);
      resolveDomeAmbient(dome);
      resolveCloudPalette(cloudParams, fog, dome, sun, sky);
      expect(sun.r).toBeGreaterThan(sun.b);
      expect(srgbLightness(sun)).toBeLessThan(srgbLightness(before) - 0.05);
      // ...and the FILL goes the other way, which is the whole §B.49 point:
      // the dome overhead at a sunset is violet, not orange
      expect(sky.b).toBeGreaterThan(sky.r);
    } finally {
      skyParams.timeOfDay = restore;
    }
  });

  it('does NOT turn sunlit faces blue at midday, whatever the key is', () => {
    // §B90 re-cut. This used to assert `sun.getHex() === cloudParams.sunColor`
    // for a cyan haze — a DECISION (that the warmth gate happened to read 0),
    // not the property, and it passed for the whole time the clouds were grey
    // under a pink sky. The property is that a midday sun is white-to-warm and
    // the lit faces must never go cool, and it has to hold even if something
    // hands this a cool colour.
    const restore = skyParams.timeOfDay;
    try {
      // ...and it is asserted against the REAL key at every daylight hour,
      // which is the only input that can reach this in the shipped rig. Handing
      // it a cyan colour by hand WOULD tint the faces cyan, and that is
      // correct: it would mean the sun itself had turned cyan. The old test
      // asserted the opposite and it is what let §B90 stand — the gate it was
      // really pinning (`warmth == 0`) also read 0.13 at an hour when the sky
      // was 0.44 into its own sunset.
      for (const t of [7, 9, 12, 15, 17, 17.75]) {
        skyParams.timeOfDay = t;
        resolveDomeAmbient(dome);
        resolveKeyTint(fog);
        resolveCloudPalette(cloudParams, fog, dome, sun, sky);
        expect(sun.r, `t=${t}`).toBeGreaterThan(sun.b);
        // the skylight goes the other way — that IS the ambient bouncing in
        expect(sky.b, `t=${t}`).toBeGreaterThan(sky.r);
      }
      // a midday cloud is WHITE, and must stay white: the fix must not paint
      // an orange sunset over noon
      skyParams.timeOfDay = 12;
      resolveDomeAmbient(dome);
      resolveKeyTint(fog);
      resolveCloudPalette(cloudParams, fog, dome, sun, sky);
      expect(sun.r - sun.b).toBeLessThan(0.35);
    } finally {
      skyParams.timeOfDay = restore;
    }
  });

  it('KEEPS THE TONAL RANGE for every possible haze — the actual §B.19 guard', () => {
    // §B.19 was not "the colours were wrong", it was that sunColor and
    // skyColor are ADDED and both were near-white, so the lit face and the
    // shadow face landed on the same clipped white and the clouds had no
    // range at all. State that directly: a shadow face must stay far darker
    // than a lit one, whatever the atmosphere does.
    for (const hex of HAZES) {
      resolveCloudPalette(cloudParams, fog.setHex(hex), dome.setHex(hex), sun, sky);
      const lit = lum(sun) * 0.95 + lum(sky) * cloudParams.skyMax;
      const shadow = lum(sky) * cloudParams.skyMin * 0.85;
      expect(shadow / lit, `haze #${hex.toString(16)}`).toBeLessThan(0.35);
    }
  });

  it('and never re-approaches the summed clipping point', () => {
    // the old near-white pair summed to ~1.8 linear on every channel
    for (const hex of HAZES) {
      resolveCloudPalette(cloudParams, fog.setHex(hex), dome.setHex(hex), sun, sky);
      for (const ch of ['r', 'g', 'b'] as const) {
        expect(sun[ch] * 0.95 + sky[ch] * cloudParams.skyMax).toBeLessThan(1.45);
      }
    }
  });

  it('the skylight LEVEL stays authored — only its hue follows the sky', () => {
    // how much ambient a cloud receives is an art decision, not a readout of
    // the haze. The midday haze is near-white; tracking its brightness is
    // precisely the move that caused §B.19.
    const base = srgbLightness(new THREE.Color().setHex(cloudParams.skyColor));
    for (const hex of HAZES) {
      resolveCloudPalette(cloudParams, fog.setHex(hex), dome.setHex(hex), sun, sky);
      expect(Math.abs(srgbLightness(sky) - base), `haze #${hex.toString(16)}`).toBeLessThan(0.08);
    }
  });

  it('the sunlight may only darken, never brighten', () => {
    // one-directional by construction (Math.min on the target lightness);
    // brightening is the direction §B.19 failed in
    const base = srgbLightness(new THREE.Color().setHex(cloudParams.sunColor));
    for (const hex of HAZES) {
      resolveCloudPalette(cloudParams, fog.setHex(hex), dome.setHex(hex), sun, sky);
      expect(srgbLightness(sun), `haze #${hex.toString(16)}`).toBeLessThan(base + 0.02);
    }
  });

  it('a storm cluster still lands darker and cooler than a fair one', () => {
    // per-cluster colour comes out of the CHANNEL mix, not a second uniform:
    // stormSunCut removes far more sun than stormSkyCut removes sky, so the
    // storm mass shifts toward skyColor. If these ever invert, storm clouds
    // would read as the BRIGHT ones.
    expect(cloudParams.stormSunCut).toBeGreaterThan(cloudParams.stormSkyCut);
    resolveCloudPalette(cloudParams, fog.setHex(MIDDAY), dome.setHex(MIDDAY), sun, sky);
    const fair = lum(sun) * 0.95 + lum(sky) * 0.63;
    const stormy =
      lum(sun) * 0.95 * (1 - cloudParams.stormSunCut) +
      lum(sky) * 0.63 * (1 - cloudParams.stormSkyCut);
    expect(stormy).toBeLessThan(fair * 0.6);
  });
});

/**
 * The fluff is the ONLY layer allowed to soften a cloud edge — §V11b forbids
 * softening the cores themselves, because a sculpted silhouette is the whole
 * point of making them meshes. So "the fluff exists" is not the property that
 * matters; "the fluff puts alpha OUTSIDE the polygon" is. It did not: the
 * sprite was smaller than the lobe it was meant to feather, so the layer drew
 * ~400 instances of fill every frame and contributed 1.6% alpha at the rim.
 *
 * CPU transliteration of the sprite falloff in cloudCores.ts (`shape^power`
 * times the hollow-centre ring). If the two drift the numbers below stop
 * meaning anything, so keep them together.
 */
const fluffAlphaAt = (rNorm: number, p: CloudParams): number => {
  const r2 = Math.min(1, rNorm * rNorm);
  const shape = Math.max(0, 1 - r2);
  const t = Math.min(1, Math.max(0, r2 / Math.max(0.02, p.fluffRing)));
  const hollow = 1 - p.fluffHollow + p.fluffHollow * (t * t * (3 - 2 * t));
  return Math.pow(shape, p.fluffPower) * hollow;
};

/** mean projected radius of a lobe, in units of its own mean radius: the
 *  horizontal semi-axis is `size * lerp(0.9, 1.25, rng)` and relief averages
 *  to 1 (mx_noise is zero-mean), so the silhouette a fluff sprite has to
 *  reach past sits at ~1.075 mean radii. */
const MEAN_LOBE_RIM = (0.9 + 1.25) / 2;

describe('fluff actually feathers the rim (§V11b: cores stay sculpted)', () => {
  it('the sprite must OVERHANG the lobe, or it softens nothing', () => {
    // a sprite of radius `fluffScale` mean-radii is pure interior below
    // MEAN_LOBE_RIM, and its own falloff has decayed to nothing well before
    // that. 1.25 (the shipped value until 2026-08-12) failed this.
    expect(cloudParams.fluffScale).toBeGreaterThan(MEAN_LOBE_RIM * 1.6);
  });

  it('and carry real alpha AT the rim, not a rounding error', () => {
    // RELATIVE to the lobe it feathers, not absolute. The lobe's peak density
    // is `coverage * lobeDensity` — both factors are on the fluff too — so
    // pinning an absolute number here would silently stop meaning anything the
    // moment either moves, which is exactly what happened when `lobeDensity`
    // arrived and took the cores off "near-opaque disc" (§V11b chord profile).
    const seedMean = 0.8; // iSeed*0.4 + 0.6 over a uniform seed
    const lobePeak = cloudParams.coverage * cloudParams.lobeDensity;
    const atRim =
      fluffAlphaAt(MEAN_LOBE_RIM / cloudParams.fluffScale, cloudParams) *
      seedMean *
      cloudParams.fluffAlpha *
      lobePeak;
    // visible against the lobe underneath...
    expect(atRim).toBeGreaterThan(lobePeak * 0.1);
    // ...but still a skirt, not a second opaque disc, or the flat billboard
    // shading buries the lobe's sculpted lighting
    expect(atRim).toBeLessThan(lobePeak * 0.5);
  });

  it('softness is not uniform: tops and sunward shoulders stay crisp', () => {
    // the user's actual note — "not everywhere, of course; sometimes clouds do
    // have quite sharp edges". A cloud feathered evenly all round reads as
    // fake in exactly the same way as one that is sharp all round.
    expect(cloudParams.fluffTopSharp).toBeGreaterThan(0);
    expect(cloudParams.fluffSunSharp).toBeGreaterThan(0);
    // and both must leave SOME feather at the top, or the crisp/soft contrast
    // becomes a hard-edged cap sitting on a fuzzy base
    expect(cloudParams.fluffTopSharp).toBeLessThan(1);
    expect(cloudParams.fluffSunSharp).toBeLessThan(1);
  });
});

describe('composite alpha ramp is the softness knob (§V11 stage 3)', () => {
  it('the erosion gate is never narrower than the body curve it multiplies', () => {
    // coverage is an additive SUM of premultiplied lobe alphas, so the visible
    // edge lives entirely in the low-coverage ramp. body = 1-exp(-density*cov)
    // reaches 0.9 at cov = ln(10)/density; if the gate's own width sits below
    // that, the GATE is the hard edge and no amount of blur can help. The
    // shipped 0.55 against density 1.6 was 2.6x too narrow.
    const bodyRamp = Math.log(10) / cloudParams.alphaDensity;
    expect(cloudParams.alphaSoftNear).toBeGreaterThanOrEqual(bodyRamp);
  });

  it('near soft, far sharp — the talk\'s own depth threshold (00:20:57)', () => {
    // "clouds in the distance appear sharper and look like they're further
    // away whereas clouds overhead remain soft and fuzzy"
    expect(cloudParams.alphaSoftNear).toBeGreaterThan(cloudParams.alphaSoftFar);
  });

  it('the high-frequency fray exists and is finer than the wobble', () => {
    // the low-frequency lookup has a period of roughly half a cloud: it slides
    // a silhouette around as one piece, it cannot fray it. The talk packs a
    // second, higher-frequency noise for exactly this.
    expect(cloudParams.edgeHiErode).toBeGreaterThan(0);
    expect(cloudParams.edgeHiScale).toBeGreaterThan(1);
  });
});

/**
 * THE FOUR FIXES for "dark, gloomy, brown lumps" (user 2026-08-13, screenshot
 * docs/bugs/bug-clouds-dark-blobs.png). Each of these encodes a MEASURED
 * quantity, because every one of the four defects was invisible as a number
 * until someone measured it and obvious afterwards.
 */
describe('cloud lighting: key/fill separation (§B.19 lineage, §T.39)', () => {
  const sun = new THREE.Color();
  const sky = new THREE.Color();
  const dome = new THREE.Color();
  const haze = new THREE.Color();

  /** hue distance on the wheel, 0..180 */
  const hueGap = (a: THREE.Color, b: THREE.Color): number => {
    const x = { h: 0, s: 0, l: 0 };
    const y = { h: 0, s: 0, l: 0 };
    a.getHSL(x, THREE.SRGBColorSpace);
    b.getHSL(y, THREE.SRGBColorSpace);
    const d = Math.abs(x.h - y.h) * 360;
    return d > 180 ? 360 - d : d;
  };

  it('THE FILL IS NOT THE KEY — the whole "brown lump" defect in one number', () => {
    // Measured before the fix, at timeOfDay 17.3: key hue 35°, fill hue 29°,
    // SIX DEGREES apart, because both were driven from scene.fog.color (the
    // horizon haze). A cumulus then differs between its lit and shadow faces
    // only in brightness, and a mass with no hue change across its form reads
    // as a flat lump — which is exactly what the user photographed. Driving
    // the fill from the sky DOME instead gives 149.8°.
    resolveDomeAmbient(dome);
    resolveCloudPalette(cloudParams, haze.setHex(0xfdb669), dome, sun, sky);
    expect(hueGap(sun, sky)).toBeGreaterThan(90);
  });

  it('and stays separated across the whole day, not just at the sunset', () => {
    // §B90: the key is no longer "any colour the sky could publish" — it is
    // `keyLight().color`, a bounded family (ember → orange → cream → moon
    // blue). Feeding arbitrary hexes here would be testing a function that no
    // longer exists; the hour is the free variable now, and it is swept.
    const restore = skyParams.timeOfDay;
    try {
      for (const t of [6.5, 9, 12, 15, 17.3, 17.75, 18.5, 20]) {
        skyParams.timeOfDay = t;
        resolveDomeAmbient(dome);
        resolveKeyTint(haze);
        resolveCloudPalette(cloudParams, haze, dome, sun, sky);
        expect(hueGap(sun, sky), `t=${t}`).toBeGreaterThan(60);
      }
    } finally {
      skyParams.timeOfDay = restore;
    }
  });

  it('a warm haze cannot warm the FILL — the two inputs stay two', () => {
    // the collapse this guards is not "the numbers were wrong", it is one
    // input doing two jobs. Cool dome + hot haze must give a cool fill.
    resolveCloudPalette(
      cloudParams,
      haze.setHex(0xff6a00),
      dome.setHex(0x3a4a90),
      sun,
      sky,
    );
    expect(sky.b).toBeGreaterThan(sky.r * 1.5);
    // ...while the KEY still takes the haze's warmth, or the sunset is gone
    expect(sun.r).toBeGreaterThan(sun.b);
  });

  it('the dome is read from the sky, not re-derived (§T.39 single owner)', () => {
    const restore = skyParams.timeOfDay;
    try {
      skyParams.timeOfDay = 12;
      resolveDomeAmbient(dome);
      const noon = dome.clone();
      skyParams.timeOfDay = 17.3;
      resolveDomeAmbient(dome);
      // it moves with the sky's own clock; a constant here would mean the
      // clouds had stopped tracking the day
      expect(noon.equals(dome)).toBe(false);
    } finally {
      skyParams.timeOfDay = restore;
    }
  });
});

describe('cloud lighting: multiple scattering + base uplight (§V.56)', () => {
  const p = cloudParams;
  /** the worst face measured in the diagnosis: buried, facing away and down */
  const WORST_DIRECT = 0.229 * 0.44 * 0.18;
  /** a fully lit outer top */
  const BEST_DIRECT = 0.953;
  const SUNSET_KEY_Y = Math.sin((10.14 * Math.PI) / 180);

  it('the darkest face is no longer 1.8% of the key', () => {
    // that number is what "dark and gloomy" was: px 87,60,37 against a sky at
    // 213,149,135. A cumulus base is 30-60% of its top in reality, because
    // multiple scattering carries light through the cloud — and NOTHING in
    // this system modelled that, since the transmission term dies both at
    // coverage 3-6 and beyond ~20° from the sun.
    expect(WORST_DIRECT).toBeLessThan(0.02); // the measurement, pinned
    expect(multiScatteredValue(WORST_DIRECT, p)).toBeGreaterThan(0.15);
  });

  it('...and the lit end is untouched, which is why it is a FLOOR', () => {
    // a floor that also moved the top would just be a brightness knob
    expect(multiScatteredValue(BEST_DIRECT, p)).toBeGreaterThan(0.94);
  });

  it('KEEPS THE FORM: the range within one cloud stays wide', () => {
    // the first tuning of this pass overshot — floor 0.28 + glow 0.55 put a
    // lit top and its own underside six percent apart in pixels, which is
    // §B.19's flatness again wearing a bright hat. Range is the contract.
    const top = lobeSunValue(BEST_DIRECT, -1, SUNSET_KEY_Y, p);
    const far = lobeSunValue(0, 0, SUNSET_KEY_Y, p);
    expect(top / far).toBeGreaterThan(3);
  });

  it('the base uplight fires at a low key and is gone at a high one', () => {
    // at sunset the sun passes UNDER the deck and lights the bases; at midday
    // it cannot, and a glowing base at noon would read as broken
    expect(baseGlowValue(1, SUNSET_KEY_Y, p)).toBeGreaterThan(0.1);
    expect(baseGlowValue(1, Math.sin(Math.PI / 3), p)).toBe(0);
  });

  it('and only on downward faces, so it cannot double the lit top', () => {
    expect(baseGlowValue(0, SUNSET_KEY_Y, p)).toBe(0);
    expect(lobeSunValue(BEST_DIRECT, -1, SUNSET_KEY_Y, p)).toBeLessThan(1);
  });

  it('every face stays bounded — §V44 on an additive light slot', () => {
    for (const d of [-5, 0, 0.5, 1, 9, NaN]) {
      for (const down of [-2, 0, 1, 7, NaN]) {
        for (const y of [-1, 0, 0.3, 1]) {
          const v = lobeSunValue(d, down, y, p);
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(2);
        }
      }
    }
  });
});

describe('cloud composition: distant sky, merged masses (§V43)', () => {
  const p = cloudParams;
  const clusters = generateClusters(1, p);
  const widthDeg = (c: (typeof clusters)[number]): number =>
    2 * Math.atan((c.radius * p.clusterFlatten) / Math.hypot(c.x, c.y, c.z)) * (180 / Math.PI);

  it('is not a ceiling of boulders over the player', () => {
    // measured on the shipped layout: mean angular width 27.7°, largest 50.2°
    // at 1028 m, every cluster inside 2.6 km. The references are mostly
    // DISTANT cloud over open sky.
    const w = clusters.map(widthDeg);
    const mean = w.reduce((s, v) => s + v, 0) / w.length;
    expect(mean).toBeLessThan(16);
    expect(Math.max(...w)).toBeLessThan(40);
  });

  it('spreads over depth instead of piling into the near ring', () => {
    // sqrt(u) is uniform per unit AREA; a straight lerp is uniform in RADIUS
    // and an annulus's area grows with radius, so the straight lerp crowds the
    // near ring. Median distance therefore sits well past the ring's midpoint.
    const d = clusters.map((c) => Math.hypot(c.x, c.z)).sort((a, b) => a - b);
    const midpoint = (p.ringInner + p.ringOuter) / 2;
    expect(d[Math.floor(d.length / 2)]).toBeGreaterThan(midpoint);
    expect(d[d.length - 1] / d[0]).toBeGreaterThan(2);
  });

  it('a cluster is ONE mass, not a pile of separated potatoes', () => {
    // the old `pow(rng(), 0.6)` was documented as centre-biased and is the
    // opposite — an exponent below 1 pushes samples toward the RIM, so lobes
    // were laid out to cover the footprint rather than to overlap inside it.
    let intersecting = 0;
    let total = 0;
    for (const c of clusters) {
      for (const a of c.lobes) {
        let best = Infinity;
        for (const b of c.lobes) {
          if (a === b) continue;
          const gap =
            Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) / (a.radius + b.radius);
          if (gap < best) best = gap;
        }
        if (Number.isFinite(best)) {
          total++;
          if (best < 1) intersecting++;
        }
      }
    }
    expect(intersecting / total).toBeGreaterThan(0.9);
  });

  it('still fits the instance capacity at the panel maxima (§V28)', () => {
    expect(countLobes(clusters)).toBeLessThanOrEqual(p.maxLobes);
  });

  it('the depth range covers the ring it now places clusters on', () => {
    // maxCloudDist maps distance to the packed depth channel, which drives the
    // blur radius AND the near-soft/far-sharp alpha ramp. Leave it at 4 km
    // with a 9.5 km ring and every distant cluster saturates at depth 1.
    expect(p.maxCloudDist).toBeGreaterThan(p.ringOuter);
  });
});

/**
 * THE BANDED STRATUS LAYER — the second cloud form (user 2026-08-13: "more
 * bandy, stretched out, diffused clouds… to break up our existing clouds").
 *
 * These pin the contracts that separate a band layer from FOG and from a
 * second competitor to the cumulus, because neither failure would show up as
 * an error: a layer with no gaps is a grey wash that still renders, and a
 * layer that out-weighs the cores still renders too. The TSL graph cannot be
 * evaluated headless, so the numeric halves are CPU mirrors transliterated
 * into it (same convention as bandLimit.ts's own pair).
 */
describe('banded stratus layer (§V11 second form, §V43 SoT parity)', () => {
  const p = cloudParams;
  const sun = new THREE.Color();
  const sky = new THREE.Color();

  it('is a KNOB, not a code path — bandCoverage 0 writes nothing (§V16)', () => {
    const off = { ...p, bandCoverage: 0 };
    for (const field of [-1, -0.2, 0, 0.5, 1]) {
      expect(bandCoverageAt(field, off)).toBe(0);
    }
  });

  it('coverage stays bounded for any field value a noise sum can produce', () => {
    // §V28/§V44: what reaches the premultiplied pack must be provably in range
    for (const field of [-1e6, -3, -1, 0, 1, 3, 1e6, NaN, Infinity]) {
      const c = bandCoverageAt(field, p);
      expect(Number.isFinite(c)).toBe(true);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  });

  it('LEAVES OPEN SKY — the one thing that separates bands from fog', () => {
    // mask = field*contrast + bias, clamped. Open sky exists only while the
    // zero crossing (-bias/contrast) sits INSIDE the field's realised range.
    // Push bias up past that and the layer covers the whole hemisphere: still
    // renders, still soft, and reads as a grey wash over everything. The
    // references are roughly half open sky.
    const zeroCrossing = -p.bandBias / p.bandContrast;
    expect(zeroCrossing).toBeGreaterThan(-0.6);
    expect(bandCoverageAt(zeroCrossing - 0.05, p)).toBe(0);
    // ...and it must still be able to reach a real coverage somewhere
    expect(bandCoverageAt(0.65, p)).toBeGreaterThan(0.15);
  });

  it('fades to its own MEAN at grazing angles, not to nothing (§V70)', () => {
    // the octave fades take the FIELD to its mean correctly — the noise is
    // zero-mean — but shape() is a clamp and a pow on top, and E[f(x)] ≠
    // f(E[x]). Without the second step the layer converges to bias^gamma and
    // the bands evaporate a few degrees above the skyline, which is §V70's
    // "converges to a FLAT surface, i.e. DELETES the feature".
    const naive = Math.pow(p.bandBias, p.bandGamma);
    expect(p.bandFarMean).toBeGreaterThan(naive * 5);
    for (const field of [-1, 0, 1]) {
      expect(bandCoverageAt(field, p, 0)).toBeCloseTo(p.bandFarMean * p.bandCoverage, 6);
    }
    // ...and the mean has to be a mean: between the empty and the full shape
    expect(p.bandFarMean).toBeLessThan(bandShapeAt(1, 1, p));
  });

  it('is ANISOTROPIC — a direction-free field cannot make bands (§V58)', () => {
    const ratio = p.bandLength / p.bandWidth;
    // below ~4:1 the field reads as weather-map blotches, not bands; above
    // ~15:1 it reads as combing, which is §B.40 one system over
    expect(ratio).toBeGreaterThan(4);
    expect(ratio).toBeLessThan(15);
    expect(p.bandWarp).toBeGreaterThan(0); // ruled straight lines = §B.33
  });

  it('sits ABOVE the cumulus, which is where the references put it', () => {
    // the compositional job is to sit behind and over the cluster tops, not
    // to interleave with them
    const cumulusTop = p.altitudeMax + p.clusterRadiusMax * p.clusterHeight;
    expect(p.bandAltitude).toBeGreaterThan(cumulusTop);
  });

  it('cannot out-weigh the cumulus it is meant to break up', () => {
    // the pack is ADDITIVE, so a band crossing a cluster adds its coverage to
    // the cluster's. Cluster interiors run 3-6 (§V60); a peak band an order of
    // magnitude under that is a veil. Raise this past ~1 and the "second cloud
    // form" becomes a haze layer over the whole sky.
    expect(bandCoverageAt(1, p)).toBeLessThan(0.5);
  });

  it('has INTERNAL TONE: thin margins glow, dense cores sit under the sky', () => {
    // a wash has one value. Beer-Lambert on the sheet's own thickness is what
    // makes it read as cloud, and it is also what keeps it off the "dark and
    // gloomy" complaint the cores are still carrying — the floor is a floor.
    const thin = bandSunAt(0, 0, p);
    const dense = bandSunAt(0, 1, p);
    expect(thin).toBeGreaterThan(dense * 1.3);
    expect(dense).toBeGreaterThan(thin * 0.35);
  });

  it('brightens toward the sun — forward scatter, not a rim light', () => {
    // a thin sheet is lit by what comes THROUGH it. If this were flat the
    // layer would read as painted-on grey whatever the sun is doing.
    expect(bandSunAt(1, 0.3, p)).toBeGreaterThan(bandSunAt(0, 0.3, p) * 1.4);
  });

  it('and toward the horizon in SKYLIGHT, where the path is longest', () => {
    expect(bandSkyAt(0, p)).toBeGreaterThan(bandSkyAt(1, p));
  });

  it('never re-approaches the §B.19 summed clipping point, for any haze', () => {
    // the layer inherits the live sun/sky pair, so its own peak has to clear
    // the same ceiling the cores were retuned to. Peak = looking at the sun
    // through the thinnest margin, at the horizon where skylight is lifted.
    const sunPeak = bandSunAt(1, 0, p);
    const skyPeak = bandSkyAt(0, p);
    for (const hex of [0x99def9, 0xfdb669, 0xffffff, 0x000000, 0xff0000, 0x00ff88]) {
      resolveCloudPalette(cloudParams, new THREE.Color().setHex(hex), new THREE.Color().setHex(hex), sun, sky);
      for (const ch of ['r', 'g', 'b'] as const) {
        expect(sun[ch] * sunPeak + sky[ch] * skyPeak, `haze #${hex.toString(16)}`)
          .toBeLessThan(1.45);
      }
    }
  });

  it('keeps a real tonal range across that same palette', () => {
    // the §B.19 shape restated for this layer: peak and core must not land on
    // the same value, or the bands are one flat tone and read as a wash
    const peak = bandSunAt(1, 0, p);
    const core = bandSunAt(0, 1, p);
    resolveCloudPalette(cloudParams, new THREE.Color().setHex(0xfdb669), new THREE.Color().setHex(0xfdb669), sun, sky);
    const lit = sun.r * peak + sky.r * bandSkyAt(0, p);
    const shade = sun.r * core + sky.r * bandSkyAt(0.6, p);
    // 2.0, not the cores' 2.86 (their guard is `shadow/lit < 0.35`), and the
    // difference is physical rather than slack: a cumulus has a lit face and a
    // shadow face, a horizontal sheet has ONE orientation, so all of its range
    // comes from thickness and view/sun angle. Pushing it higher means either
    // dropping `bandThickFloor` — which is the knob standing between this
    // layer and the "dark and gloomy" complaint the cores already carry — or
    // clipping the peak. Measured 2.21 at these values.
    expect(lit / shade).toBeGreaterThan(2.0);
  });

  it('drift is an ACCUMULATED PHASE, never time × rate (§V.55)', () => {
    // §B.30 on the flags: a product is a valid offset only while the rate is
    // constant, and elapsed time multiplies every wobble in it. bandDriftSpeed
    // is a live knob, so the product would drift the whole sky backwards the
    // moment a preset lerped it.
    const acc = { x: 0, z: 0 };
    // 10 s at 4 m/s, then the knob halves for 10 s → 60 m along the axis
    for (let i = 0; i < 100; i++) advanceBandDrift(acc, 0, 4, 0.1);
    for (let i = 0; i < 100; i++) advanceBandDrift(acc, 0, 2, 0.1);
    expect(acc.x).toBeCloseTo(60, 6);
    // what `time × rate` would have given at t=20 with the CURRENT rate
    expect(acc.x).not.toBeCloseTo(20 * 2, 1);
  });

  it('drift travels along its own heading and rejects hostile dt (§V28)', () => {
    const acc = { x: 0, z: 0 };
    advanceBandDrift(acc, Math.PI / 2, 10, 1);
    expect(acc.x).toBeCloseTo(0, 6);
    expect(acc.z).toBeCloseTo(10, 6);
    const before = { ...acc };
    for (const dt of [0, -1, NaN, Infinity, 1e6]) advanceBandDrift(acc, 0, 10, dt);
    expect(acc).toEqual(before);
  });
});

/**
 * §V.63 — STORM CLOUD OVERHEAD WHEREVER IT RAINS.
 *
 * User, 2026-08-18: "we want to make sure that we have actual storm clouds
 * overhead wherever it rains."
 *
 * These tests pin the RELATIONSHIP between three systems, not any of their
 * implementations, because the bug they exist to catch was not in any one of
 * them. §V46 already made cloud SHAPE read the storm field, and it worked:
 * a cluster standing on a cell became an anvil. But cluster SITES came off a
 * ring around the world ORIGIN, while rain is sampled at the SHIP — so the
 * shape coupling was correct and the placement coupling did not exist. The
 * measured Pearson r between rain density and storm-cloud cover along a 20 min
 * sail track was 0.000, with 7 of 7 raining samples under clear sky, and
 * nothing failed: every unit test passed, because every unit was right.
 *
 * So the assertions below deliberately span modules. A test that could be
 * satisfied by src/clouds alone would not have caught this and would not catch
 * it coming back.
 */
describe('§V.63 rain and storm cloud are the same weather', () => {
  // Driven through the REAL facade, not through field.ts directly. The bug
  // this suite exists to catch lived in the wiring between three modules that
  // were each individually correct, so a test built from the parts rather than
  // from the assembled system would reproduce the bug instead of catching it.
  const weather = createWeatherSystem({ seed: 1 });
  const sample = createWeatherSample();

  /** the sky as it is actually generated: around the VIEWER, from the cells */
  const skyAt = (x: number, z: number) =>
    generateClusters(1, cloudParams, weather.stormAt,
      weather.stormCellsNear(x, z, cloudParams.stormCellRange, []));
  /** rain density a ship at (x,z) would be given — the sampler's own gate */
  const rainAt = (x: number, z: number): number =>
    weather.weatherAt(x, z, sample).rain;
  /** strongest storm cluster whose footprint covers (x,z); 0 = clear overhead */
  const cloudOver = (x: number, z: number): number => {
    let best = 0;
    for (const c of skyAt(x, z)) {
      if (Math.hypot(x - c.x, z - c.z) <= c.radius) best = Math.max(best, c.storm);
    }
    return best;
  };

  it('THE COUPLING: rain and storm-cloud cover move together over the world', () => {
    // The measurement that started this, as an assertion. Before the fix:
    // r = 0.17 on this grid, and 0.00 along a sail track — a static grid
    // centred on the origin flatters the old ring layout, which is exactly
    // why the number alone was never the point.
    const rain: number[] = [];
    const cloud: number[] = [];
    for (let x = -8000; x <= 8000; x += 800) {
      for (let z = -8000; z <= 8000; z += 800) {
        rain.push(rainAt(x, z));
        cloud.push(cloudOver(x, z));
      }
    }
    const mean = (v: number[]): number => v.reduce((s, a) => s + a, 0) / v.length;
    const mr = mean(rain);
    const mc = mean(cloud);
    let num = 0;
    let dr = 0;
    let dc = 0;
    for (let i = 0; i < rain.length; i++) {
      num += (rain[i] - mr) * (cloud[i] - mc);
      dr += (rain[i] - mr) ** 2;
      dc += (cloud[i] - mc) ** 2;
    }
    expect(num / Math.sqrt(dr * dc)).toBeGreaterThan(0.6);
  });

  it('NEVER rain from a clear sky — the assertion the user actually made', () => {
    // Stronger than the correlation and the one that would have failed
    // loudest: not "usually", not "on average". EVERY position that is given
    // rain has a storm cluster standing over it.
    let wet = 0;
    for (let x = -8000; x <= 8000; x += 400) {
      for (let z = -8000; z <= 8000; z += 400) {
        if (rainAt(x, z) <= 0.01) continue;
        wet++;
        expect(cloudOver(x, z)).toBeGreaterThan(0);
      }
    }
    expect(wet).toBeGreaterThan(100); // the sweep must actually find rain
  });

  it('and you SEE IT COMING: the cloud edge passes over you before the rain', () => {
    // Two independent guarantees, because losing either one puts the squall
    // on top of the player with no warning — and being able to read the
    // weather off the horizon is most of what makes sailing tense.
    //
    // 1. a cell gets its cloud well below the amplitude at which it rains
    expect(cloudParams.stormCellMin).toBeLessThan(weatherParams.rainThreshold);
    // 2. and the cloud's footprint strictly CONTAINS its own rain footprint
    let firstCloud = Infinity;
    let firstRain = Infinity;
    for (let x = -8000; x <= 8000; x += 25) {
      if (firstCloud === Infinity && cloudOver(x, -972) > 0) firstCloud = x;
      if (firstRain === Infinity && rainAt(x, -972) > 0.01) firstRain = x;
    }
    expect(firstCloud).toBeLessThan(firstRain);
    // and by a real margin, not a rounding accident — the drawn mass is wider
    // still (clusterFlatten and the lobe radii both push past `radius`)
    expect(firstRain - firstCloud).toBeGreaterThan(100);
  });

  it('a GLOBAL storm preset makes the whole sky stormy, not just the cells', () => {
    // The second decoupling, and the one a player would hit first: applying
    // the storm preset sets ambient storminess to 1, so rain goes to 1
    // EVERYWHERE. If the cloud layer reads only the cell field it stays
    // fair-weather cumulus and you get a downpour out of a blue sky.
    const global = createWeatherSystem({ seed: 1 });
    global.apply('storm', { lerpSeconds: 0 });
    for (const [x, z] of [[0, 0], [12345, -6789], [-40000, 25000]]) {
      expect(global.weatherAt(x, z, createWeatherSample()).rain).toBeGreaterThan(0.9);
      // ...and every cluster in the sky there is at its storm extreme
      const sky = generateClusters(1, cloudParams, global.stormAt,
        global.stormCellsNear(x, z, cloudParams.stormCellRange, []));
      expect(sky.length).toBeGreaterThan(0);
      expect(Math.min(...sky.map((c) => c.storm))).toBeGreaterThan(0.99);
    }
  });

  it('the cloud stands ON the cell, so the squall drifts as ONE thing', () => {
    // Rules out a failure that would look like a tuning problem: cloud and
    // rain both present, both moving, but answering different clocks so the
    // cloud lags or leads the wet patch.
    const cells = weather.stormCellsNear(3000, -1500, 2, []);
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      // a cell's own centre reads at least its amplitude from the sampler the
      // rain uses — this is what makes the two systems one system
      expect(weather.stormAt(cell.x, cell.z)).toBeGreaterThanOrEqual(cell.amp - 1e-9);
    }
  });

  it('a storm cloud has a DARK BASE — the strongest single cue', () => {
    // A cloud that brightens uniformly with density can never read as
    // threatening however tall or wide it is: what says "rain" is the
    // top-to-bottom contrast of an optically thick mass.
    expect(stormBaseDarkValue(1, 0, cloudParams)).toBeLessThan(
      stormBaseDarkValue(1, 1, cloudParams) * 0.6,
    );
    // and fair weather is untouched — this must not dim the whole sky
    expect(stormBaseDarkValue(0, 0, cloudParams)).toBe(1);
    expect(stormBaseDarkValue(0, 1, cloudParams)).toBe(1);
    // §V44 bounded at source, including on hostile params
    for (const st of [-1, 0, 0.5, 1, 2, NaN]) {
      for (const h of [-1, 0, 0.5, 1, 2, NaN]) {
        const v = stormBaseDarkValue(st, h, { stormBaseDark: 5 });
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('VERTICAL: a rain shaft hangs from a real cloud base, never a constant', () => {
    // "rain should originate at cloud base" — a shaft whose top is a magic
    // altitude looks detached even when the horizontal coupling is perfect.
    const sky = skyAt(0, 0);
    const slots = shaftSlots(sky, 0, 0, cloudParams.shaftCount, []);
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      const owner = sky.find((c) => c.x === s.x && c.z === s.z);
      expect(owner).toBeDefined();
      // the shaft's top IS its cloud's base, and its cloud is a storm cloud
      expect(s.base).toBe(owner?.base);
      expect(owner?.cell).not.toBeNull();
      expect(s.strength).toBeGreaterThan(0);
      // and its footprint is inside the cloud's own — no shaft in clear sky
      expect(s.radius).toBeLessThanOrEqual((owner as { radius: number }).radius);
    }
    // shafts go to the NEAREST squalls — they are a scarce, unrolled slot
    const d = slots.map((s) => Math.hypot(s.x, s.z));
    expect([...d].sort((a, b) => a - b)).toEqual(d);
  });

  it('the sky fits in the instance buffer wherever the ship is (§V28)', () => {
    // cell clusters are placed around the VIEWER, so unlike the fixed ring
    // their count is not knowable from the params alone. §V8 would warn and
    // silently drop lobes, and the dropped ones would be a storm anvil.
    let worst = 0;
    for (let x = -20000; x <= 20000; x += 2600) {
      for (let z = -20000; z <= 20000; z += 2600) {
        worst = Math.max(worst, countLobes(skyAt(x, z)));
      }
    }
    expect(worst).toBeLessThanOrEqual(cloudParams.maxLobes);
  });

  it('turning the cell list off leaves the §V46 ring behaviour intact', () => {
    // the coupling is additive: a caller that does not pass cells (tests, the
    // reflection preview) must still get exactly the sky it used to get
    const ring = generateClusters(9, cloudParams, () => 0.4, []);
    expect(ring).toHaveLength(cloudParams.clusterCount);
    expect(ring.every((c) => c.cell === null)).toBe(true);
  });
});

/**
 * ═══ §T.119 / §B90 ═══════════════════════════════════════════════════════
 *
 * USER, on a sunset frame: "you can see them being weirdly grey though it's
 * the brightest and sunniest sunset… their shape also has a tendency to
 * produce smaller little circles… we need them organic and fluffy, no perfect
 * circle anywhere."
 *
 * Two defects, and the blocks below pin them separately because they had
 * nothing to do with each other: a colour path that never read the sun, and a
 * billboard whose outline is an exact circle.
 */

// ── the composite's own colour reconstruction, as a CPU mirror ─────────────
// `colour = sunColor·(R/B) + skyColor·(G/B)` (cloudComposite.ts), then the
// renderer's ACESFilmic at `skyParams.exposure`. Reproduced here because the
// DEFECT IS ONLY VISIBLE AFTER THE TONEMAP: the pre-tonemap pair looked
// defensible the whole time — sun hue 31°, saturation 0.99 — while ACES
// resolved the lit face it produced to 239,224,220. A test on the uniforms
// alone cannot see that and is exactly the test that was already passing.
const acesTM = (x: number): number => {
  const v = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
  return Math.min(1, Math.max(0, v));
};
const linToSrgb = (c: number): number =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

/** one screen pixel of cloud, sRGB 0..1, from a (sunlight, skylight) pair */
function cloudPixel(
  sun: THREE.Color,
  sky: THREE.Color,
  rOverB: number,
  gOverB: number,
): [number, number, number] {
  const e = skyParams.exposure;
  return [
    linToSrgb(acesTM((sun.r * rOverB + sky.r * gOverB) * e)),
    linToSrgb(acesTM((sun.g * rOverB + sky.g * gOverB) * e)),
    linToSrgb(acesTM((sun.b * rOverB + sky.b * gOverB) * e)),
  ];
}
/** CHROMA, not HSL saturation. At lightness 0.92 an HSL saturation of 1.0 is a
 *  max-min spread of 0.16 — which is why the old palette could report
 *  saturation 0.94 while looking grey. Chroma cannot lie about that. */
const chroma = (c: readonly number[]): number => Math.max(...c) - Math.min(...c);
const lum = (c: readonly number[]): number =>
  0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const hueOf = (c: readonly number[]): number => {
  const t = new THREE.Color();
  t.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
  const o = { h: 0, s: 0, l: 0 };
  t.getHSL(o, THREE.SRGBColorSpace);
  return o.h * 360;
};
const hueDist = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/** the four canonical faces, as (R/B, G/B) pairs from cloudCores.ts's graph */
function faceWeights(p: CloudParams, keyY: number) {
  const ms = (d: number): number => multiScatteredValue(d, p);
  const glow = (down: number): number => baseGlowValue(down, keyY, p);
  // LIT TOP: N·S = 1, exterior, sun side, heightN 1, facing up
  const lit = { r: ms(1) + glow(0), g: p.skyMax };
  // INTERIOR: N sideways, buried, heightN 0.5, sun BEHIND THE VIEWER
  const wrapI = Math.pow(0.5, Math.max(0.05, p.sunPower));
  const dirI = wrapI * (1 - p.sunSideGain + p.sunSideGain * 0.5) * p.selfShadow;
  const interior = {
    r: ms(dirI) * powderValue(-1, 0.8, p) + forwardScatterValue(-1, 0.8, 1, p) + glow(0),
    g: (p.skyMin + (p.skyMax - p.skyMin) * 0.5) * 0.925,
  };
  // BACK-LIT RIM: sun straight behind the cloud, thin outer margin
  const rim = {
    r:
      ms(0) * powderValue(1, 0.12, p) * (hgPhaseValue(p.phaseAnisotropy, 1) * (1 - 0.12) * p.silverLining + 1) +
      forwardScatterValue(1, 0.12, 0, p) +
      glow(0.3),
    g: (p.skyMin + (p.skyMax - p.skyMin) * 0.5) * 0.925,
  };
  // SHADOWED UNDERSIDE: facing away and down, heightN 0
  const under = { r: ms(0) + glow(1), g: p.skyMin * 0.85 };
  return { lit, interior, rim, under };
}

describe('§B90 the lit face takes the SUN\'s colour', () => {
  const sun = new THREE.Color();
  const sky = new THREE.Color();
  const dome = new THREE.Color();
  const key = new THREE.Color();
  /** every hour the sun owns the key, coarse through the day and fine at dusk */
  const DAY_HOURS = [7, 8, 10, 12, 14, 16, 17, 17.3, 17.5, 17.75, 18];

  const resolve = (t: number) => {
    skyParams.timeOfDay = t;
    resolveDomeAmbient(dome);
    resolveKeyTint(key);
    resolveCloudPalette(PRISTINE, key, dome, sun, sky);
    const k = keyLight(t, skyParams);
    const f = faceWeights(PRISTINE, k.direction[1]);
    return { f, k };
  };

  it('HUE: the lit side is the sun\'s own hue, all day', () => {
    // §B90's first half in one assertion. The old path drove this off the fog
    // haze's red-minus-blue, and at timeOfDay 17 the haze is hue 68° against a
    // key at hue 28° — so the lit faces were 40° off the light that was
    // supposedly making them, on the hour the user photographed.
    const restore = skyParams.timeOfDay;
    try {
      for (const t of DAY_HOURS) {
        const { f, k } = resolve(t);
        const px = cloudPixel(sun, sky, f.lit.r, f.lit.g);
        const keyHue = hueOf(k.color);
        // near-neutral pixels have no meaningful hue, and a midday cloud
        // SHOULD be near-neutral — so the hue is only asserted where there is
        // enough chroma for it to mean anything
        if (chroma(px) < 0.05) continue;
        expect(hueDist(hueOf(px), keyHue), `t=${t}`).toBeLessThan(25);
      }
    } finally {
      skyParams.timeOfDay = restore;
    }
  });

  it('CHROMA: it carries the sun\'s colour in proportion to the hour\'s warmth', () => {
    // THE REGRESSION WITNESS. Measured on this exact mirror, lit-face chroma
    // BEFORE -> AFTER, against a key chroma of 0.737 at the deepest hour:
    //   t=12 (warm 0.00)  0.000 -> 0.000   a midday cloud is white, correctly
    //   t=17 (warm 0.44)  0.004 -> 0.039
    //   t=17.3 (warm 0.78) 0.024 -> 0.114
    //   t=17.5 (warm 0.94) 0.055 -> 0.184
    //   t=17.75 (warm 1.00) 0.075 -> 0.224   the frame the user photographed
    // The bound below is chosen to sit above every BEFORE value and below
    // every AFTER one, so this test FAILS on the code that shipped the bug —
    // which is the only thing that makes it a witness rather than a
    // description. The property is not "chroma > 0.15" (a decision that moves
    // with any palette tweak) but that the lit face carries a real fraction of
    // the key's own colour, in proportion to how warm the SKY says the hour is.
    const restore = skyParams.timeOfDay;
    try {
      for (const t of DAY_HOURS) {
        const { f, k } = resolve(t);
        const px = cloudPixel(sun, sky, f.lit.r, f.lit.g);
        const { warm } = keyWeights();
        const keyChroma = chroma([k.color[0], k.color[1], k.color[2]]);
        // QUADRATIC in `warm`, and that is the shape rather than a fudge: the
        // pixel's chroma is the product of two things that both rise as the
        // sun drops — how coloured the key is, and how far the lit face's
        // level has fallen out of ACES's shoulder, where chroma collapses.
        expect(chroma(px), `t=${t} warm=${warm.toFixed(2)}`).toBeGreaterThanOrEqual(
          0.14 * warm * warm * keyChroma,
        );
      }
    } finally {
      skyParams.timeOfDay = restore;
    }
  });

  it('...and a MIDDAY cloud is still white — the fix must not paint a sunset on noon', () => {
    const restore = skyParams.timeOfDay;
    try {
      const { f } = resolve(12);
      const px = cloudPixel(sun, sky, f.lit.r, f.lit.g);
      expect(chroma(px)).toBeLessThan(0.05);
      expect(lum(px)).toBeGreaterThan(0.8);
    } finally {
      skyParams.timeOfDay = restore;
    }
  });

  it('the INTERIOR is darker than the lit side at every hour', () => {
    // a cloud whose body is as bright as its lit top has no form — that is
    // §B.19's flatness, and it is the failure mode the darkening in this pass
    // could most easily have caused
    const restore = skyParams.timeOfDay;
    try {
      for (const t of DAY_HOURS) {
        const { f } = resolve(t);
        const lit = cloudPixel(sun, sky, f.lit.r, f.lit.g);
        const int = cloudPixel(sun, sky, f.interior.r, f.interior.g);
        expect(lum(int), `t=${t}`).toBeLessThan(lum(lit) * 0.75);
        expect(lum(int), `t=${t}`).toBeGreaterThan(0.02); // ...and never black
      }
    } finally {
      skyParams.timeOfDay = restore;
    }
  });

  it('the interior stays COOLER than the lit side — it must not out-warm it', () => {
    // The over-correction this pass had to be tuned against: `skyDarken` at
    // 0.55 dropped the violet fill far enough that the sun-coloured
    // multi-scatter floor took the interior over and it landed WARMER than the
    // lit top. That is the same flatness wearing the other hat.
    //
    // ASSERTED PRE-TONEMAP, and that is not a convenience: a lit top is
    // SUPPOSED to clip toward white, and a clipped white has a blue:red ratio
    // of exactly 1, which beats any warm colour. Comparing pixels would
    // therefore demand that the lit face be COOLER than its own shadow at
    // midday, which is nonsense. The property lives in the light, not the
    // pixel: a shadowed face must take a larger share of its light from the
    // cool fill than a sunlit one does.
    const restore = skyParams.timeOfDay;
    try {
      for (const t of [12, 17, 17.75]) {
        const { f } = resolve(t);
        const litFill = f.lit.g / (f.lit.r + f.lit.g);
        const intFill = f.interior.g / (f.interior.r + f.interior.g);
        expect(intFill, `t=${t}`).toBeGreaterThan(litFill * 1.5);
        // ...and the fill really is on the cool side of the key, at every hour
        expect(sky.b / Math.max(1e-4, sky.r), `t=${t} fill`).toBeGreaterThan(
          sun.b / Math.max(1e-4, sun.r),
        );
      }
    } finally {
      skyParams.timeOfDay = restore;
    }
  });

  it('a BACK-LIT rim is brighter than a front-lit interior — the silver lining', () => {
    // the path §T.119 says was missing. Before this pass the back rim had
    // `multiScatterFloor × silver` and nothing else: a sun-facing margin was
    // DARKER than the cloud's own body, which is the opposite of every
    // reference frame.
    const restore = skyParams.timeOfDay;
    try {
      for (const t of [10, 17.3, 17.75]) {
        const { f } = resolve(t);
        // asserted on the LIGHT first — post-ACES both faces are well into the
        // shoulder, where a 3.5x difference in radiance compresses to 1.3x in
        // pixels. The shoulder is not the contract; the radiance is.
        expect(f.rim.r, `t=${t} radiance`).toBeGreaterThan(f.interior.r * 2);
        const rim = cloudPixel(sun, sky, f.rim.r, f.rim.g);
        const int = cloudPixel(sun, sky, f.interior.r, f.interior.g);
        expect(lum(rim), `t=${t} pixel`).toBeGreaterThan(lum(int) * 1.15);
      }
    } finally {
      skyParams.timeOfDay = restore;
    }
  });

  it('NIGHT IS UNTOUCHED — the look the user says already works, pinned', () => {
    // Every §B90 term multiplies by `sunOwn`, which `keyDirectionWeight` makes
    // exactly 0 below −5.7° of sun elevation. These triples were captured from
    // this mirror BEFORE the fix and must not move: "clouds look reasonable at
    // night" is the one thing the report did not complain about.
    const restore = skyParams.timeOfDay;
    try {
      for (const [t, wantLit, wantInt] of [
        [20, [235, 235, 235], [170, 177, 193]],
        [22, [235, 235, 235], [170, 177, 193]],
        [5, [235, 235, 235], [170, 177, 193]],
      ] as [number, number[], number[]][]) {
        skyParams.timeOfDay = t;
        resolveDomeAmbient(dome);
        resolveKeyTint(key);
        resolveCloudPalette(PRISTINE, key, dome, sun, sky);
        expect(keyWeights().sunOwn, `t=${t}`).toBe(0);
        const k = keyLight(t, skyParams);
        const f = faceWeights(PRISTINE, k.direction[1]);
        const lit = cloudPixel(sun, sky, f.lit.r, f.lit.g).map((v) => Math.round(v * 255));
        const int = cloudPixel(sun, sky, f.interior.r, f.interior.g).map((v) =>
          Math.round(v * 255),
        );
        // the LIT face is bit-identical: every colour term multiplies by
        // `sunOwn`, which is exactly 0 here
        expect(lit, `t=${t} lit`).toEqual(wantLit);
        // the INTERIOR moves by TWO LEVELS, and that is stated rather than
        // hidden by choosing weights that cannot see it. `powderValue` is
        // geometry, not colour — it describes how a thin margin scatters,
        // which is as true of moonlight as of sunlight — so it is deliberately
        // NOT gated on `sunOwn` and it darkens the night body by 1.2%. Two
        // levels out of 255 is below the threshold of a visible step, and the
        // bound is asserted so a future change cannot quietly widen it.
        for (let c = 0; c < 3; c++) {
          expect(Math.abs(int[c] - wantInt[c]), `t=${t} interior ch${c}`).toBeLessThanOrEqual(2);
        }
      }
    } finally {
      skyParams.timeOfDay = restore;
    }
  });
});

describe('§T.119 single scatter: Henyey-Greenstein, forward path, powder', () => {
  const p = PRISTINE;

  it('the phase is exactly 1 straight through at the sun, and never leaves (0,1]', () => {
    // normalised to its own peak, so §V44 is satisfied AT SOURCE — nothing
    // downstream clamps it and no 4π hides in a gain
    expect(hgPhaseValue(p.phaseAnisotropy, 1)).toBeCloseTo(1, 10);
    for (const g of [0, 0.3, 0.62, 0.9, 0.95]) {
      for (let i = 0; i <= 40; i++) {
        const v = hgPhaseValue(g, -1 + (2 * i) / 40);
        expect(v, `g=${g}`).toBeGreaterThan(0);
        expect(v, `g=${g}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('IT HAS A TAIL, which is the whole reason it replaced pow(dot,6)', () => {
    // `pow(dot(sun,−V), 6)` is mathematically ZERO at 90° and beyond, so the
    // lit arc on a back-lit cumulus ended abruptly. Water droplets do not do
    // that: forward scattering dominates but the backscatter floor is real.
    // measured at the shipped g=0.62: 0.0337 at 90 deg, 0.0129 at 180 deg.
    // Both are small — a silver lining must stay a lining — but they are
    // FINITE, where a pow lobe is identically zero over that whole half.
    expect(hgPhaseValue(p.phaseAnisotropy, 0)).toBeGreaterThan(0.02);
    expect(hgPhaseValue(p.phaseAnisotropy, -1)).toBeGreaterThan(0.008);
    // ...while still being strongly forward-peaked, which is what makes it a
    // silver lining rather than an ambient lift
    expect(hgPhaseValue(p.phaseAnisotropy, 1)).toBeGreaterThan(
      hgPhaseValue(p.phaseAnisotropy, -1) * 20,
    );
  });

  it('is monotone in the scattering angle — no lobe of its own', () => {
    let prev = -1;
    for (let i = 0; i <= 200; i++) {
      const v = hgPhaseValue(p.phaseAnisotropy, -1 + (2 * i) / 200);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('g = 0 is isotropic — the family degenerates correctly (§V7)', () => {
    for (const c of [-1, -0.5, 0, 0.5, 1]) expect(hgPhaseValue(0, c)).toBeCloseTo(1, 10);
  });

  it('the forward path is largest at a THIN margin and gone in an anvil', () => {
    const thin = forwardScatterValue(1, 0.05, 0, p);
    const deep = forwardScatterValue(1, 1, 1, p);
    expect(thin).toBeGreaterThan(deep * 8);
    // ...and gone when the sun is behind the viewer, whatever the thickness
    expect(forwardScatterValue(-1, 0.05, 0, p)).toBeLessThan(thin * 0.1);
  });

  it('powder darkens a thin edge ONLY with the sun behind you (§T.119)', () => {
    // the counter-intuitive half: front-lit clouds have DARKER edges than
    // cores. It must not fire at the back-lit end or it would cancel the
    // silver lining the forward path just drew.
    expect(powderValue(-1, 0.02, p)).toBeLessThan(powderValue(-1, 1, p));
    expect(powderValue(1, 0.02, p)).toBeCloseTo(1, 10);
    expect(powderValue(0, 0.02, p)).toBeCloseTo(1, 10);
  });

  it('every new term is bounded and finite for hostile input (§V44, §V28)', () => {
    const hostile = [-1e9, -1, -0.5, 0, 0.5, 1, 1e9, NaN, Infinity, -Infinity];
    const badP = {
      ...p,
      phaseAnisotropy: NaN,
      forwardGain: Infinity,
      forwardExtinction: -5,
      powderStrength: NaN,
      powderExtinction: Infinity,
    };
    for (const a of hostile) {
      for (const b of hostile) {
        for (const c of hostile) {
          for (const q of [p, badP]) {
            const f = forwardScatterValue(a, b, c, q);
            const w = powderValue(a, b, q);
            const h = hgPhaseValue(a, b);
            expect(Number.isFinite(f)).toBe(true);
            expect(f).toBeGreaterThanOrEqual(0);
            expect(f).toBeLessThanOrEqual(2);
            expect(Number.isFinite(w)).toBe(true);
            expect(w).toBeGreaterThanOrEqual(0);
            expect(w).toBeLessThanOrEqual(1);
            expect(Number.isFinite(h)).toBe(true);
          }
        }
      }
    }
  });

  it('the whole sunlight channel still cannot reach the §B.19 clipping point', () => {
    // the pair is ADDED in the composite, so a new additive path into R is
    // exactly the shape §B.19 failed in. Worst case: the brightest rim the
    // graph can produce against the fullest fill.
    const worstR =
      1 * powderValue(-1, 1, p) * (hgPhaseValue(p.phaseAnisotropy, 1) * p.silverLining + 1) +
      forwardScatterValue(1, 0, 0, p) +
      Math.min(2, p.baseGlow);
    const sun = new THREE.Color();
    const sky = new THREE.Color();
    const dome = new THREE.Color();
    const restore = skyParams.timeOfDay;
    try {
      for (const t of [6, 9, 12, 15, 17.75, 20]) {
        skyParams.timeOfDay = t;
        resolveDomeAmbient(dome);
        resolveKeyTint(sun);
        resolveCloudPalette(PRISTINE, sun, dome, sun, sky);
        for (const ch of ['r', 'g', 'b'] as const) {
          expect(sun[ch] * Math.min(2, worstR) + sky[ch] * p.skyMax, `t=${t} ${ch}`).toBeLessThan(
            2.6,
          );
        }
      }
    } finally {
      skyParams.timeOfDay = restore;
    }
  });
});

/**
 * ═══ §T.119(b) SILHOUETTE ════════════════════════════════════════════════
 *
 * USER: "no perfect circle anywhere". A circle IS a constant-curvature arc, so
 * the tell is a SPIKE in the curvature histogram — and it has to be measured
 * in ABSOLUTE bins, because binning over each curve's own range hides it
 * (a wilder curve gets wider bins and looks flatter).
 */

/** trilinear value noise on the project's own hash3Cpu, zero-mean in [-1,1].
 *  NOT a third noise (§T.112c): the graph runs `mx_noise_float`, which has no
 *  CPU twin, and what these tests assert is a property of the COMPOSITION
 *  that must hold for any reasonable zero-mean field (§V80). See
 *  `lobeReliefValue`'s note for the full argument. */
function noise3Cpu(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const tx = fadeCpu(x - xi), ty = fadeCpu(y - yi), tz = fadeCpu(z - zi);
  let v = 0;
  for (let c = 0; c < 8; c++) {
    const cx = c & 1, cy = (c >> 1) & 1, cz = (c >> 2) & 1;
    const w = (cx ? tx : 1 - tx) * (cy ? ty : 1 - ty) * (cz ? tz : 1 - tz);
    v += w * hash3Cpu(xi + cx, yi + cy, zi + cz);
  }
  return v * 2 - 1;
}

/** curvature of a closed polar curve r(θ), sampled uniformly */
function polarCurvature(r: readonly number[]): number[] {
  const n = r.length;
  const h = (Math.PI * 2) / n;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const rm = r[(i - 1 + n) % n], r0 = r[i], rp = r[(i + 1) % n];
    const d1 = (rp - rm) / (2 * h);
    const d2 = (rp - 2 * r0 + rm) / (h * h);
    out.push((r0 * r0 + 2 * d1 * d1 - r0 * d2) / Math.pow(r0 * r0 + d1 * d1, 1.5));
  }
  return out;
}

/**
 * Fullest bin of a FIXED-WIDTH curvature histogram, plus the concave fraction.
 * Bins are absolute (width 0.2 over κ ∈ [−2, 6]) because a unit-radius circle
 * sits at κ = 1 exactly and the whole question is whether samples pile up
 * there. `concave` is the second, independent tell: a circle — and any union
 * of convex arcs — has NO negative curvature anywhere.
 */
function curvatureStats(r: readonly number[]): { peak: number; concave: number } {
  const K_LO = -2, K_HI = 6, BINS = 40;
  const k = polarCurvature(r);
  const h = new Array(BINS).fill(0);
  let concave = 0;
  for (const v of k) {
    if (v < 0) concave++;
    const i = Math.floor(((Math.min(K_HI, Math.max(K_LO, v)) - K_LO) / (K_HI - K_LO)) * BINS);
    h[Math.min(BINS - 1, i)]++;
  }
  return { peak: Math.max(...h) / k.length, concave: concave / k.length };
}

const SAMPLES = 720;
/** the fluff sprite's zero-crossing radius at each angle, by bisection */
function fluffOutline(
  p: Pick<CloudParams, 'fluffBreak' | 'fluffBreakScale'>,
  seed: number,
  amp = 1,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t = (i / SAMPLES) * Math.PI * 2;
    const cx = Math.cos(t), cy = Math.sin(t);
    let lo = 0.05, hi = 2.5;
    for (let b = 0; b < 50; b++) {
      const m = (lo + hi) / 2;
      if (fluffShapeValue(cx * m, cy * m, seed, p, noise3Cpu, amp) > 0) lo = m;
      else hi = m;
    }
    out.push((lo + hi) / 2);
  }
  return out;
}
/** one great-circle cross-section of a lobe's radial displacement */
function lobeOutline(p: SilhouetteProfile, seed: number, vertical: boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t = (i / SAMPLES) * Math.PI * 2;
    const d: [number, number, number] = vertical
      ? [Math.cos(t), Math.sin(t), 0]
      : [Math.cos(t), 0, Math.sin(t)];
    out.push(lobeReliefValue(d, seed, 1, 0, p, noise3Cpu));
  }
  return out;
}
const SEEDS = Array.from({ length: 24 }, (_, i) => i / 24);
const mean = (a: readonly number[]): number => a.reduce((x, y) => x + y, 0) / a.length;

describe('§T.119(b) no perfect circle anywhere in the silhouette', () => {
  const p = PRISTINE;

  it('THE FLUFF SPRITE WAS THE CIRCLE — an exact one, and it is now not', () => {
    // This is where the user's "smaller little circles" actually came from,
    // and it is not the lobes (see the next test, where they already passed).
    // `shape = 1 − |q|²` puts the zero-crossing at |q| = 1 for EVERY angle,
    // and `fluffScale 2.1` makes the sprite overhang the polygonal union it
    // feathers — so on a small cloud that exact circle IS the outline.
    //
    // MEASURED on this mirror: fluffBreak 0 → every curvature sample in ONE
    // bin (1.000) with zero concavity, the textbook signature. Shipped 0.35 →
    // fullest bin 0.214, concave 0.383.
    const flat = { fluffBreak: 0, fluffBreakScale: p.fluffBreakScale };
    for (const seed of SEEDS.slice(0, 4)) {
      const s = curvatureStats(fluffOutline(flat, seed));
      expect(s.peak, 'the defect, pinned').toBeCloseTo(1, 6);
      expect(s.concave, 'the defect, pinned').toBe(0);
    }
    const peaks: number[] = [], conc: number[] = [];
    for (const seed of SEEDS) {
      const s = curvatureStats(fluffOutline(p, seed));
      peaks.push(s.peak);
      conc.push(s.concave);
    }
    // no spike at a constant radius...
    expect(Math.max(...peaks)).toBeLessThan(0.45);
    expect(mean(peaks)).toBeLessThan(0.30);
    // ...and real concavity, which a union of convex arcs cannot have at all
    expect(mean(conc)).toBeGreaterThan(0.2);
  });

  it('...and it degrades back to the exact disc when it goes sub-pixel (§V.48b)', () => {
    // mx_noise_float is zero-mean, so fading an octave's amplitude to zero IS
    // fading it to that octave's own mean — and at sub-pixel size the exact
    // disc is the CORRECT answer, not a regression. Without this the break-up
    // would turn into per-pixel speckle along every distant rim, which is the
    // §V.48 symptom this project has found nine times.
    for (const seed of SEEDS.slice(0, 4)) {
      const s = curvatureStats(fluffOutline(p, seed, 0));
      expect(s.peak).toBeCloseTo(1, 6);
    }
  });

  it('the LOBES were already non-circular — and this says so, rather than claiming credit', () => {
    // §V80, and worth stating plainly: the two-octave relief that shipped
    // already had fullest bin 0.395 and 46% concavity, i.e. it was NOT the
    // source of the circles. A perfect sphere (relief 0) measures 1.000/0.000
    // on the same mirror, which is what makes that number meaningful.
    const sphere: SilhouetteProfile = { ...p, lobeRelief: 0, silhouetteWarp: 0, baseFlatten: 0 };
    const s0 = curvatureStats(lobeOutline(sphere, 0.3, true));
    expect(s0.peak).toBeCloseTo(1, 6);
    expect(s0.concave).toBe(0);
    const peaks = SEEDS.map((seed) => curvatureStats(lobeOutline(p, seed, true)).peak);
    expect(Math.max(...peaks)).toBeLessThan(0.5);
  });

  it('the silhouette is ANISOTROPIC — wider than tall, which a ball is not', () => {
    // §V58 in the sky: a direction-free field cannot make oriented features,
    // so the direction is put in explicitly (`silhouetteSquash`). Measured as
    // roughness — mean |Δr| per sample — around a VERTICAL great circle
    // against a HORIZONTAL one. Shipped params give 1.22; the isotropic
    // control gives 0.95, i.e. no preferred direction at all.
    const rough = (a: readonly number[]): number => {
      let t = 0;
      for (let i = 0; i < a.length; i++) t += Math.abs(a[(i + 1) % a.length] - a[i]);
      return t / a.length;
    };
    const ratio = (q: SilhouetteProfile): number =>
      mean(SEEDS.map((s) => rough(lobeOutline(q, s, true)))) /
      mean(SEEDS.map((s) => rough(lobeOutline(q, s, false))));
    expect(ratio(p)).toBeGreaterThan(1.1);
    // ...and it is the SQUASH that does it, not luck of the seed
    const iso: SilhouetteProfile = { ...p, silhouetteSquash: 1, silhouetteShear: 0 };
    expect(ratio(iso)).toBeLessThan(1.05);
    expect(ratio(p)).toBeGreaterThan(ratio(iso) * 1.15);
  });

  it('the BASE is flatter than the top, and the top carries the fine detail', () => {
    // a cumulus condenses at one altitude, so its underside is a plane and its
    // crown is cauliflower. A sphere has neither.
    const below = mean(SEEDS.map((s) => lobeReliefValue([0, -1, 0], s, 1, 0, p, noise3Cpu)));
    const above = mean(SEEDS.map((s) => lobeReliefValue([0, 1, 0], s, 1, 0, p, noise3Cpu)));
    expect(below).toBeLessThan(above);
    // the finest octave is reserved for the crown: zeroing `cauliflowerTop`
    // must change the TOP and leave the base alone
    const noCauli: SilhouetteProfile = { ...p, cauliflowerTop: 0 };
    const topDelta = Math.abs(
      lobeReliefValue([0.2, 0.98, 0], 0.5, 1, 0, p, noise3Cpu) -
        lobeReliefValue([0.2, 0.98, 0], 0.5, 1, 0, noCauli, noise3Cpu),
    );
    const baseDelta = Math.abs(
      lobeReliefValue([0.2, -0.98, 0], 0.5, 1, 0, p, noise3Cpu) -
        lobeReliefValue([0.2, -0.98, 0], 0.5, 1, 0, noCauli, noise3Cpu),
    );
    expect(baseDelta).toBeGreaterThan(topDelta);
  });

  it('the shear leans the field with the WIND, not with an axis of its own', () => {
    // one wind in this sky (§V.55 applied to a direction): the lobes shear on
    // the same heading `bandDriftDirDeg` drifts the stratus deck along, so
    // rotating the wind must rotate the silhouette.
    const a = lobeReliefValue([0.3, 0.6, 0.2], 0.4, 1, 0, p, noise3Cpu);
    const b = lobeReliefValue([0.3, 0.6, 0.2], 0.4, 0, 1, p, noise3Cpu);
    expect(a).not.toBeCloseTo(b, 4);
    // ...and with the shear off, the wind cannot reach it at all
    const noShear: SilhouetteProfile = { ...p, silhouetteShear: 0 };
    expect(lobeReliefValue([0.3, 0.6, 0.2], 0.4, 1, 0, noShear, noise3Cpu)).toBeCloseTo(
      lobeReliefValue([0.3, 0.6, 0.2], 0.4, 0, 1, noShear, noise3Cpu),
      12,
    );
  });

  it('is DETERMINISTIC and can never invert the radius (§V2, §V44)', () => {
    for (const seed of SEEDS) {
      for (let i = 0; i < 64; i++) {
        const t = (i / 64) * Math.PI * 2;
        const d: [number, number, number] = [Math.cos(t) * 0.8, Math.sin(t) * 0.6, 0.2];
        const a = lobeReliefValue(d, seed, 1, 0, p, noise3Cpu);
        const b = lobeReliefValue(d, seed, 1, 0, p, noise3Cpu);
        expect(a).toBe(b);
        expect(a).toBeGreaterThan(0); // a negative factor turns the lobe inside out
        expect(a).toBeLessThan(2.5);
      }
    }
  });

  it('survives hostile params and hostile directions without NaN (§V28)', () => {
    const bad: SilhouetteProfile = {
      lobeRelief: NaN,
      lobeReliefScale: Infinity,
      silhouetteWarp: -3,
      silhouetteWarpScale: NaN,
      silhouetteSquash: 0,
      silhouetteShear: Infinity,
      cauliflowerTop: NaN,
      baseFlatten: 9,
    };
    // NOTE what this asserts and what it cannot: the MIRROR is total, because
    // it finite-guards every param read. The GRAPH's guard is the finite-check
    // at the push site in clouds/index.ts — WGSL's own `max`/`clamp` are
    // undefined on NaN, so a shader cannot catch it from the inside.
    for (const d of [[0, 0, 0], [1, 0, 0], [0, -1, 0], [1e9, 1e9, 1e9]] as [number, number, number][]) {
      for (const q of [p, bad]) {
        for (const seed of [0, 0.5, NaN]) {
          const v = lobeReliefValue(d, seed, 1, 0, q, noise3Cpu);
          // a hostile PARAM may legitimately produce a NaN-free zero; what it
          // may never do is put a NaN into a vertex buffer
          expect(Number.isNaN(v), `d=${d} seed=${seed}`).toBe(false);
        }
      }
    }
    for (const s of [0, 0.5]) {
      for (const q of [{ fluffBreak: NaN, fluffBreakScale: 0 }, PRISTINE]) {
        const v = fluffShapeValue(0.5, 0.5, s, q, noise3Cpu);
        expect(Number.isNaN(v)).toBe(false);
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('§B91 the banded deck stops drawing where its own map degenerates', () => {
  const p = PRISTINE;
  /** eye at 2 m under the shipped 2100 m deck */
  const RISE = p.bandAltitude - 2;
  /** sin(elevation) at which `bandRange` starts clamping */
  const UP_CLAMP = RISE / p.bandRange;

  it('THE DEFECT: below the clamp the hit point carries NO elevation information', () => {
    // User, on a night frame: "the clouds bending 90° and pointing vertically
    // into the sea". It is not a bend. Once `rise/up` exceeds `bandRange` the
    // clamp freezes the ray/plane hit onto a circle of CONSTANT RADIUS, so the
    // sampled field depends on azimuth alone — every feature is then painted
    // as a column of constant value, i.e. a mathematically exact vertical
    // stripe. This states the degeneracy directly: two rays at the same
    // azimuth and different elevations land on the same point.
    const hitRadius = (up: number): number =>
      Math.min(Math.max(1e-4, RISE) / Math.max(1e-4, up), p.bandRange);
    expect(hitRadius(UP_CLAMP * 0.5)).toBe(hitRadius(UP_CLAMP * 0.1));
    // ...and the elevation it reaches to is 3.5°, high enough to be a band of
    // sky rather than a hairline
    expect((Math.asin(UP_CLAMP) * 180) / Math.PI).toBeGreaterThan(2);
  });

  it('...and horizonFade alone does NOT cover it, which is why it shipped', () => {
    // the layer already had a horizon fade; at the top of the degenerate zone
    // it is still ~0.75, so the stripes rendered at nearly full strength
    const fade = (up: number): number => 1 - Math.exp(-up / Math.max(1e-4, p.bandHorizonFade));
    expect(fade(UP_CLAMP)).toBeGreaterThan(0.5);
  });

  it('THE FIX: structure is exactly 0 through the whole degenerate zone', () => {
    const nd = (up: number): number =>
      bandNonDegenerate(up, RISE, p.bandRange, p.bandDegenerateFade);
    // ...including at the mathematical horizon, exactly — `range` is
    // `min(reach, bandRange)`, so the ratio is 1 there and no EPS floor leaks
    // a fraction of a percent of structure through
    expect(nd(0)).toBe(0);
    expect(nd(UP_CLAMP * 0.01)).toBe(0);
    expect(nd(UP_CLAMP * 0.99)).toBe(0);
    expect(nd(UP_CLAMP)).toBe(0);
    // ...and it is fully back well inside a degree of sky above the clamp
    expect(nd(UP_CLAMP / (1 - p.bandDegenerateFade))).toBeCloseTo(1, 6);
    expect(nd(1)).toBe(1);
  });

  it('AND IT CLOSES THE HORIZONTAL LINE, the half a horizon fade misses', () => {
    // The second symptom, and the one that made the first attempt at this fix
    // wrong. Immediately ABOVE the clamp the coordinate's screen footprint is
    // enormous and `bandLimitAmplitude` has already taken the structure to ~0;
    // immediately BELOW, the frozen hit point collapses that footprint and the
    // structure snaps back to full. That step is the dead-straight horizontal
    // cut across the whole sky in docs/raft2100/lookdev/pitch/night.png, at
    // ~3.8° by pixel count against a clamp computed at 3.53°.
    //
    // A weight that is 1 at the boundary and falls only below it removes the
    // stripes and LEAVES THE LINE. So the property is that the weight is
    // already 0 at the boundary and rises continuously from there — no step
    // anywhere, in either direction.
    const nd = (up: number): number =>
      bandNonDegenerate(up, RISE, p.bandRange, p.bandDegenerateFade);
    let prev = 0;
    let biggestStep = 0;
    const N = 4000;
    for (let i = 0; i <= N; i++) {
      const v = nd((i / N) * UP_CLAMP * 4);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12); // monotone: never a dip
      biggestStep = Math.max(biggestStep, v - prev);
      prev = v;
    }
    // no jump anywhere near the size of the 0→1 snap the bug drew
    expect(biggestStep).toBeLessThan(0.02);
  });

  it('and it dissolves into the layer\'s own MEAN, not into a hole (§V70)', () => {
    // the veil must still THIN toward the sea — the night reference has it
    // brightening as it approaches the water — so the degenerate zone loses
    // its STRUCTURE, not its coverage. `bandShapeAt` at resolved 0 is exactly
    // `bandFarMean`, which is what an infinitely distant pixel really sees.
    for (const field of [-1, -0.3, 0, 0.4, 1]) {
      const atHorizon = bandShapeAt(
        field,
        bandNonDegenerate(1e-6, RISE, p.bandRange, p.bandDegenerateFade),
        p,
      );
      expect(atHorizon).toBeCloseTo(p.bandFarMean, 9);
    }
    expect(p.bandFarMean).toBeGreaterThan(0);
  });

  it('no view elevation in the degenerate zone keeps ANY structure', () => {
    // the sweep the §V22 reviewer would otherwise have to do by eye
    const full = Math.abs(bandShapeAt(1, 1, p) - bandShapeAt(-1, 1, p));
    expect(full).toBeGreaterThan(0.1); // the control: there IS structure to lose
    for (let i = 0; i <= 400; i++) {
      const up = (i / 400) * UP_CLAMP;
      const resolved = bandNonDegenerate(up, RISE, p.bandRange, p.bandDegenerateFade);
      const spread = Math.abs(bandShapeAt(1, resolved, p) - bandShapeAt(-1, resolved, p));
      expect(spread, `up=${up.toFixed(6)}`).toBe(0);
    }
  });


  it('is finite for every hostile input a freecam can produce (§V28)', () => {
    for (const up of [-1, 0, 1e-9, 1, NaN, Infinity]) {
      for (const rise of [-500, 0, 2098, NaN, Infinity]) {
        for (const range of [0, 1, 34000, NaN, -5]) {
          const v = bandNonDegenerate(up, rise, range, NaN);
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
