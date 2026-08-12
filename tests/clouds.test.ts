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
} from '../src/clouds/cloudCores';
import { resolveCloudPalette, srgbLightness } from '../src/clouds/cloudPalette';
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
  const lum = (c: THREE.Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

  it('no fog → the authored colours come back untouched', () => {
    resolveCloudPalette(cloudParams, null, sun, sky);
    expect(sun.getHex()).toBe(cloudParams.sunColor);
    expect(sky.getHex()).toBe(cloudParams.skyColor);
  });

  it('warms AND deepens the sunlit faces at golden hour', () => {
    // the §T.39 report was "clouds render lavender-blue under a fully warm
    // sky". Warming the hue is only half of it — a sunset sun is also dimmer,
    // and a cloud that only changes hue reads as a midday cloud in a hat.
    const before = new THREE.Color().setHex(cloudParams.sunColor);
    resolveCloudPalette(cloudParams, fog.setHex(SUNSET), sun, sky);
    expect(sun.r).toBeGreaterThan(sun.b);
    expect(sky.r).toBeGreaterThan(sky.b);
    expect(srgbLightness(sun)).toBeLessThan(srgbLightness(before) - 0.05);
  });

  it('does NOT turn sunlit faces blue at midday, when the haze is cyan', () => {
    resolveCloudPalette(cloudParams, fog.setHex(MIDDAY), sun, sky);
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
      resolveCloudPalette(cloudParams, fog.setHex(hex), sun, sky);
      const lit = lum(sun) * 0.95 + lum(sky) * cloudParams.skyMax;
      const shadow = lum(sky) * cloudParams.skyMin * 0.85;
      expect(shadow / lit, `haze #${hex.toString(16)}`).toBeLessThan(0.35);
    }
  });

  it('and never re-approaches the summed clipping point', () => {
    // the old near-white pair summed to ~1.8 linear on every channel
    for (const hex of HAZES) {
      resolveCloudPalette(cloudParams, fog.setHex(hex), sun, sky);
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
      resolveCloudPalette(cloudParams, fog.setHex(hex), sun, sky);
      expect(Math.abs(srgbLightness(sky) - base), `haze #${hex.toString(16)}`).toBeLessThan(0.08);
    }
  });

  it('the sunlight may only darken, never brighten', () => {
    // one-directional by construction (Math.min on the target lightness);
    // brightening is the direction §B.19 failed in
    const base = srgbLightness(new THREE.Color().setHex(cloudParams.sunColor));
    for (const hex of HAZES) {
      resolveCloudPalette(cloudParams, fog.setHex(hex), sun, sky);
      expect(srgbLightness(sun), `haze #${hex.toString(16)}`).toBeLessThan(base + 0.02);
    }
  });

  it('a storm cluster still lands darker and cooler than a fair one', () => {
    // per-cluster colour comes out of the CHANNEL mix, not a second uniform:
    // stormSunCut removes far more sun than stormSkyCut removes sky, so the
    // storm mass shifts toward skyColor. If these ever invert, storm clouds
    // would read as the BRIGHT ones.
    expect(cloudParams.stormSunCut).toBeGreaterThan(cloudParams.stormSkyCut);
    resolveCloudPalette(cloudParams, fog.setHex(MIDDAY), sun, sky);
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
