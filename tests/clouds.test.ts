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
} from '../src/clouds/cloudCores';
import { skyParams } from '../src/params/sky';
import {
  resolveCloudPalette,
  resolveDomeAmbient,
  srgbLightness,
} from '../src/clouds/cloudPalette';
import {
  advanceBandDrift,
  bandCoverageAt,
  bandShapeAt,
  bandSkyAt,
  bandSunAt,
} from '../src/clouds/cloudBands';
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
    const before = new THREE.Color().setHex(cloudParams.sunColor);
    resolveCloudPalette(cloudParams, fog.setHex(SUNSET), dome.setHex(SUNSET), sun, sky);
    expect(sun.r).toBeGreaterThan(sun.b);
    expect(sky.r).toBeGreaterThan(sky.b);
    expect(srgbLightness(sun)).toBeLessThan(srgbLightness(before) - 0.05);
  });

  it('does NOT turn sunlit faces blue at midday, when the haze is cyan', () => {
    resolveCloudPalette(cloudParams, fog.setHex(MIDDAY), dome.setHex(MIDDAY), sun, sky);
    // the sun term is gated on WARMTH, so a cyan haze leaves it alone
    expect(sun.getHex()).toBe(cloudParams.sunColor);
    // the skylight does follow it — that IS the ambient bouncing into the cloud
    expect(sky.b).toBeGreaterThan(sky.r);
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
    // the lobe underneath is at `coverage` alpha; anything below a few percent
    // of that is invisible against it no matter how wide the sprite is
    const seedMean = 0.8; // iSeed*0.4 + 0.6 over a uniform seed
    const atRim =
      fluffAlphaAt(MEAN_LOBE_RIM / cloudParams.fluffScale, cloudParams) *
      seedMean *
      cloudParams.fluffAlpha *
      cloudParams.coverage;
    expect(atRim).toBeGreaterThan(0.1);
    // ...but the sprite must still be a skirt, not a second opaque disc, or
    // the flat billboard shading buries the lobe's sculpted lighting
    expect(atRim).toBeLessThan(cloudParams.coverage * 0.5);
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
    const restore = skyParams.timeOfDay;
    try {
      for (const t of [6.5, 9, 12, 15, 17.3, 18.5, 20]) {
        skyParams.timeOfDay = t;
        resolveDomeAmbient(dome);
        // the haze as it actually is at that hour would be better, but the
        // guard has to hold for ANY haze the sky could publish (§B.19's own
        // test makes the same argument)
        for (const hex of [0xfdb669, 0x99def9, 0xff9542]) {
          resolveCloudPalette(cloudParams, haze.setHex(hex), dome, sun, sky);
          expect(hueGap(sun, sky), `t=${t} haze #${hex.toString(16)}`).toBeGreaterThan(60);
        }
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
