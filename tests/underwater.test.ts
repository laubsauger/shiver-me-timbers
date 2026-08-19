/**
 * Underwater submersion logic tests (§V25). WHY these matter: the underwater
 * grade is a fullscreen effect — any discontinuity in mode or blend is an
 * instant whole-screen flash. Wave chop makes the waterline oscillate around
 * the camera every frame, so the hysteresis band and the rate-limited blend
 * are the only things standing between "cinematic crossing" and a strobing
 * screen. These tests pin the pure math down so the GPU side can trust it.
 */
import { describe, expect, it } from 'vitest';
import {
  smooth01,
  submersionState,
  type SubmersionState,
} from '../src/underwater/submersion';
import {
  lightSinkLength,
  submergedPathLength,
  transmittance,
} from '../src/underwater/waterVolume';
import underwaterIndexSource from '../src/underwater/index.ts?raw';
import waterlineBandSource from '../src/underwater/waterlineBand.ts?raw';
import waterVolumeSource from '../src/underwater/waterVolume.ts?raw';
import { underwaterParams } from '../src/params/underwater';
import { causticsParams } from '../src/params/caustics';
import { getParamsEntry } from '../src/params/registry';

const cfg = { hysteresisBand: 0.5, maxBlendStep: 0.1 };

function run(
  ys: number[],
  waterH = 0,
  c = cfg,
): SubmersionState[] {
  const out: SubmersionState[] = [];
  let prev: SubmersionState | undefined;
  for (const y of ys) {
    prev = submersionState(y, waterH, prev, c);
    out.push(prev);
  }
  return out;
}

describe('submersion hysteresis (chop must not strobe the effect)', () => {
  it('camera clearly above → above, clearly below → below', () => {
    expect(submersionState(5, 0, undefined, cfg).mode).toBe('above');
    expect(submersionState(-5, 0, undefined, cfg).mode).toBe('below');
    expect(submersionState(5, 0, undefined, cfg).blend).toBe(0);
    expect(submersionState(-5, 0, undefined, cfg).blend).toBe(1);
  });

  it('chop oscillating INSIDE the band keeps mode stable at crossing — the grade never flips hard above/below', () => {
    // ±0.2m around the waterline, band is 0.5m (half = 0.25)
    const ys = Array.from({ length: 60 }, (_, i) => 0.2 * Math.sin(i * 1.7));
    const states = run(ys);
    for (const s of states) expect(s.mode).toBe('crossing');
  });

  it('swings BEYOND the band do flip the mode (effect must engage)', () => {
    const states = run([1, -1, 1, -1]);
    expect(states.map((s) => s.mode)).toEqual([
      'above',
      'below',
      'above',
      'below',
    ]);
  });

  it('band boundary is exclusive: exactly at ±band/2 still counts as crossing', () => {
    expect(submersionState(0.25, 0, undefined, cfg).mode).toBe('crossing');
    expect(submersionState(-0.25, 0, undefined, cfg).mode).toBe('crossing');
  });

  it('waterHeight shifts the band with the sea — same logic off y=0', () => {
    expect(submersionState(10.4, 10.3, undefined, cfg).mode).toBe('crossing');
    expect(submersionState(11, 10.3, undefined, cfg).mode).toBe('above');
    expect(submersionState(9, 10.3, undefined, cfg).mode).toBe('below');
  });
});

describe('blend continuity (V25: no pop — fullscreen effect must fade)', () => {
  it('never jumps more than maxBlendStep per tick, even on a teleport', () => {
    let prev = submersionState(5, 0, undefined, cfg); // fully above
    // teleport deep underwater and hold
    for (let i = 0; i < 30; i++) {
      const next = submersionState(-20, 0, prev, cfg);
      expect(Math.abs(next.blend - prev.blend)).toBeLessThanOrEqual(
        cfg.maxBlendStep + 1e-12,
      );
      prev = next;
    }
    expect(prev.blend).toBeCloseTo(1, 10); // and it does arrive
  });

  it('blend stays in [0,1] and tracks depth monotonically through the band', () => {
    let prev: SubmersionState | undefined;
    let last = 0;
    // slow descent through the band: blend must only ever increase
    for (let y = 0.4; y >= -0.4; y -= 0.01) {
      prev = submersionState(y, 0, prev, cfg);
      expect(prev.blend).toBeGreaterThanOrEqual(last);
      expect(prev.blend).toBeGreaterThanOrEqual(0);
      expect(prev.blend).toBeLessThanOrEqual(1);
      last = prev.blend;
    }
  });

  it('smooth01 is the hermite ramp the crossing fade relies on', () => {
    expect(smooth01(-1, 1, -1)).toBe(0);
    expect(smooth01(-1, 1, 0)).toBeCloseTo(0.5, 10);
    expect(smooth01(-1, 1, 1)).toBe(1);
  });
});

/**
 * The submerged FRACTION is what makes the waterline split a split rather than
 * a full-screen filter: at the crossing the camera sits on the surface and the
 * same frame contains rays that are entirely in air and rays that are entirely
 * in water. A single submersion scalar cannot say that; this can.
 */
describe('submerged path length (the meridian, mirrors waterVolume.ts)', () => {
  const RAY = 3000; // a distant clipmap fragment, well inside horizonRadius

  it('ABOVE the surface there is no water on ANY ray, at any elevation', () => {
    // THE REGRESSION. The old two-ended fraction read the FAR endpoint's
    // height against a plane sampled at the camera's XZ, so a distant sea
    // fragment sitting in a trough reported ~88% of a 3 km ray as submerged
    // while the camera was in open air. That is the user's "it shouldn't be
    // blue while we're already back out of the ocean", and it is why this
    // mirror takes the camera's depth and the ray direction ONLY.
    for (const rayUp of [-1, -0.5, -0.01, 0, 0.01, 0.5, 1]) {
      expect(submergedPathLength(-0.2, rayUp, RAY)).toBe(0);
      expect(submergedPathLength(0, rayUp, RAY)).toBe(0);
    }
  });

  it('above water, the far end CANNOT put water on the ray however deep it is', () => {
    // the same statement as a contract rather than a sweep: depth is the only
    // input that can switch the volume on. No wave, trough, seabed or hull at
    // the far end has a vote, because none of them is on this plane.
    expect(submergedPathLength(-0.2, -1, 1e6)).toBe(0);
    expect(submergedPathLength(-1e-9, -1, 1e6)).toBe(0);
  });

  it('DOWNWARD and LEVEL rays never break the surface — the whole ray is water', () => {
    // resolves THROUGH the §V.28 floor, not in spite of it: the floored
    // divisor sends the quotient past any reachable rayLen so min() takes the
    // ray. This fires across the whole lower half of a submerged frame, so
    // getting it wrong is a full-screen artifact, not an edge case.
    expect(submergedPathLength(1, -1, RAY)).toBe(RAY);
    expect(submergedPathLength(1, -0.5, RAY)).toBe(RAY);
    expect(submergedPathLength(1, 0, RAY)).toBe(RAY);
    expect(submergedPathLength(0.001, -1, RAY)).toBe(RAY);
  });

  it("Snell's window falls out of the geometry: path grows as 1/sin(elevation)", () => {
    // nothing draws the window. Straight up from 1 m down is 1 m of water;
    // the same eye looking 30° above horizontal swims through 2 m; at 5.7° it
    // is 10 m and closing. This IS the window, and it is one division.
    expect(submergedPathLength(1, 1, RAY)).toBeCloseTo(1, 12);
    expect(submergedPathLength(1, 0.5, RAY)).toBeCloseTo(2, 12);
    expect(submergedPathLength(1, 0.1, RAY)).toBeCloseTo(10, 12);
    // twice as deep is twice the path at every elevation
    expect(submergedPathLength(2, 0.5, RAY)).toBeCloseTo(4, 12);
  });

  it('never exceeds the ray it is measured along (§V.44: bounded at source)', () => {
    // an upward exit further away than the fragment must clamp to the
    // fragment, or the water would extinguish light that never reached it.
    expect(submergedPathLength(100, 0.001, 50)).toBe(50);
    for (const [d, up, len] of [
      [1e9, 1e-9, 10],
      [1e9, -1, 10],
      [1, 1, 0],
      [1, 1, -5],
    ]) {
      const l = submergedPathLength(d, up, len);
      expect(l).toBeGreaterThanOrEqual(0);
      expect(l).toBeLessThanOrEqual(Math.max(0, len));
    }
  });

  it('is continuous across the surface for an UPWARD ray — no pop at the meridian', () => {
    // §V.25. Approaching the surface from below, an upward ray's water path
    // must go to zero smoothly rather than stepping, because this is the half
    // of the frame the eye is moving into.
    const near = submergedPathLength(1e-6, 0.5, RAY);
    expect(near).toBeCloseTo(0, 5);
    expect(submergedPathLength(0, 0.5, RAY)).toBe(0);
  });
});

/**
 * §V.71 — the exit is a point on a DISPLACED wave, and a term that resolves it
 * against the rest pose draws a straight line through a sea that has none.
 *
 * The user shot this from just under the surface: "the underwater tint is a
 * straight line instead of following the shape of the water surface... part of
 * the wave above it revealing an untinted view". WHY it matters, i.e. what
 * these tests are protecting: the clamp that produced it is a function of
 * screen ELEVATION only, so it is constant along every horizontal line of the
 * frame — the artifact is not a soft error in a wave, it is a hard edge across
 * the whole picture with unfogged geometry above it.
 */
describe('the exit rides the swell, not the plane through the eye (§V.71)', () => {
  it('a CREST at the far end is fogged over the whole ray, not to the plane', () => {
    // eye 1 m down; a crest 2 m proud of the local sea level, 30 m out. Its
    // elevation is (1+2)/30, so the plane says the ray left the water after
    // 10 m and 20 m of water goes undrawn — that missing 20 m IS the untinted
    // wave in the screenshot. With the surface's real height at the far end
    // the exit lands exactly on the fragment.
    const rayUp = 3 / 30;
    expect(submergedPathLength(1, rayUp, 30)).toBeCloseTo(10, 9); // the bug
    expect(submergedPathLength(1, rayUp, 30, 2)).toBeCloseTo(30, 9); // the fix
  });

  it('the exit lands ON any fragment that is on the surface, at any depth', () => {
    // The identity the fix rests on: for a surface fragment, rayUp·rayLen is
    // camDepth + rise by construction, so (camDepth + rise)/rayUp == rayLen
    // and min() stops clipping. If this ever stops holding, crests clip again.
    for (const [depth, rise, len] of [
      [3, 1.5, 40],
      [0.2, 0.9, 12],
      [15, 4, 300],
    ]) {
      const rayUp = (depth + rise) / len;
      expect(submergedPathLength(depth, rayUp, len, rise)).toBeCloseTo(len, 6);
    }
  });

  it('a TROUGH at the far end is unchanged — the fragment was already nearer', () => {
    // rise is one-sided on purpose. Over a trough the fragment sits inside the
    // plane crossing, min() already took it, and a negative rise would pull the
    // exit in twice.
    const rayUp = 0.2;
    expect(submergedPathLength(1, rayUp, 3, -5)).toBe(3);
    expect(submergedPathLength(1, rayUp, 3, 0)).toBe(3);
  });

  it('ABOVE the surface, no crest anywhere can put water on the ray', () => {
    // THE REGRESSION GUARD. `rise` sits in the numerator that used to be
    // camDepth alone, so the above-water identity (§V.24 owns that case) is no
    // longer implied by the arithmetic — it is stated. Losing it is the solid
    // green-blue frame at every waterline crossing, all over again.
    for (const rayUp of [-1, -0.5, 0, 0.01, 0.5, 1]) {
      expect(submergedPathLength(0, rayUp, 3000, 5)).toBe(0);
      expect(submergedPathLength(-0.5, rayUp, 3000, 5)).toBe(0);
    }
  });

  it('is still bounded by the ray it is measured along (§V.44)', () => {
    // the cap on `rise` bounds how far the exit can be pushed, but the min()
    // against the fragment is what makes it impossible to extinguish light
    // that never reached the eye. Both halves, on absurd input.
    expect(submergedPathLength(1, 0.001, 50, 30)).toBe(50);
    expect(submergedPathLength(1, 1e-9, 10, 1e9)).toBe(10);
    expect(submergedPathLength(1, 1, -5, 30)).toBe(0);
  });
});

/**
 * The other half of `submergedPathScale`, and why it had to be split.
 *
 * 1.4 exists because a RECEIVER only knows its own depth — the seabed is lit
 * by light that already sank to it. Charged as a flat multiplier it also bills
 * Snell's window 40% extra, where the eye→surface path is the ENTIRE path
 * because the light was in air a metre earlier. One scalar, two different
 * questions.
 */
describe("the light's own leg is the FRAGMENT's depth, not a multiplier", () => {
  const SCALE = causticsParams.submergedPathScale;

  it('a SURFACE fragment pays nothing — this is the window brightening', () => {
    expect(lightSinkLength(0, SCALE)).toBe(0);
    expect(lightSinkLength(-2, SCALE)).toBe(0); // a crest, above the plane
  });

  it('agrees with the old flat multiplier in its canonical case', () => {
    // looking straight down at a seabed 40 m under: eye leg 40 m, sink leg
    // 0.4·40 = 16 m, total 56 m — exactly 1.4·40. The split is a refinement of
    // this model, not a replacement, so the seabed must not move.
    const d = 40;
    expect(submergedPathLength(d, -1, d) + lightSinkLength(d, SCALE)).toBeCloseTo(
      d * SCALE,
      9,
    );
  });

  it('scales with the fragment, so a deep seabed still darkens', () => {
    expect(lightSinkLength(80, SCALE)).toBeCloseTo(2 * lightSinkLength(40, SCALE), 9);
    expect(lightSinkLength(40, 1)).toBe(0); // scale 1 = no extra leg at all
    expect(lightSinkLength(40, 0.2)).toBe(0); // and never negative
  });

  it('buys the window back its RED, which is where the sunset is', () => {
    // K_r = 0.36/m. At 10 m of water the flat 1.4 multiplier left 0.006 of the
    // red through the window; the split leaves 0.027 — 4.7×, and red is the
    // channel a 17.6 sky is made of.
    const kR = causticsParams.submergedAbsorptionR;
    const before = transmittance(kR, 10, 1, SCALE);
    const after = transmittance(kR, 10 + lightSinkLength(0, SCALE));
    expect(after).toBeGreaterThan(before * 4);
  });
});

describe('aquatic perspective (Beer–Lambert on the SHARED Jerlov coefficients)', () => {
  const { submergedAbsorptionR: KR, submergedAbsorptionG: KG, submergedAbsorptionB: KB } =
    causticsParams;

  it('red dies first — the defining fact of looking through water', () => {
    // At 10 m the ordering must be strict, not merely "tinted": this is the
    // reason a submerged hull reads blue-green instead of grey.
    const r = transmittance(KR, 10);
    const g = transmittance(KG, 10);
    const b = transmittance(KB, 10);
    expect(r).toBeLessThan(g);
    expect(g).toBeLessThan(b);
    // and red must be substantially GONE, not just reduced
    expect(r).toBeLessThan(0.05);
    expect(b).toBeGreaterThan(0.5);
  });

  it('closes the horizon on its own — §V.30 stops applying under the surface', () => {
    // The visibility limit is not a separate far-clip or fog wall; it is the
    // same exponential. Nothing survives 4 km of water in ANY channel.
    expect(transmittance(KB, 4000)).toBeLessThan(1e-6);
    // and the useful range is tens of metres, not kilometres
    expect(transmittance(KB, 150)).toBeLessThan(0.02);
  });

  it('murkiness scales all three channels together (a water TYPE, not a new set)', () => {
    // The whole point of the scalar: it may not re-order the channels, or it
    // would be authoring a second absorption vector by the back door.
    const murk = 3;
    expect(transmittance(KR, 5, murk)).toBeLessThan(transmittance(KR, 5, 1));
    expect(transmittance(KR, 5, murk)).toBeLessThan(transmittance(KG, 5, murk));
    expect(transmittance(KG, 5, murk)).toBeLessThan(transmittance(KB, 5, murk));
  });

  it('is the identity at zero path length — above water costs nothing', () => {
    expect(transmittance(KR, 0)).toBe(1);
    expect(transmittance(KG, 0)).toBe(1);
    expect(transmittance(KB, 0)).toBe(1);
  });

  it('clamps negative inputs instead of exploding (bad heightFn / camera data)', () => {
    // a negative length through exp() would AMPLIFY, i.e. an unbounded
    // additive-looking term in a multiply slot (§V.44).
    expect(transmittance(KR, -50)).toBe(1);
    expect(transmittance(-1, 50)).toBe(1);
    expect(transmittance(KR, 50, -2)).toBe(1);
  });
});

describe('underwater params (V16: registered, clamped, sane)', () => {
  it('registers under "underwater" so Tweakpane auto-binds it', () => {
    const entry = getParamsEntry('underwater');
    expect(entry).toBeDefined();
    expect(entry!.params).toBe(underwaterParams);
  });

  it('every numeric default sits inside its own declared meta clamp', () => {
    const entry = getParamsEntry('underwater')!;
    for (const [key, meta] of Object.entries(entry.meta)) {
      const v = entry.params[key] as number;
      if (meta.min !== undefined) expect(v).toBeGreaterThanOrEqual(meta.min);
      if (meta.max !== undefined) expect(v).toBeLessThanOrEqual(meta.max);
    }
  });

  it('hysteresis band and blend step are positive — zero would freeze the fade', () => {
    expect(underwaterParams.hysteresisBand).toBeGreaterThan(0);
    expect(underwaterParams.maxBlendStep).toBeGreaterThan(0);
  });

  it('shader-build-time params are usable integer counts', () => {
    expect(Number.isInteger(underwaterParams.rayTaps)).toBe(true);
    expect(Number.isInteger(underwaterParams.waterlineSamples)).toBe(true);
    expect(underwaterParams.waterlineSamples).toBeGreaterThanOrEqual(2);
  });

  /**
   * THE Y-FLIP, ONCE, FOR EVERY MODULE THAT CROSSES NDC ↔ SCREEN UV.
   *
   * NDC y is +1 at the TOP of the frame. Screen UV — `screenUV` and `uv()`
   * alike — is 0 at the top on both backends: `QuadGeometry` gives the NDC-top
   * vertex v = 0, and `ScreenNode` reads WGSL's already-top-left `fragCoord`
   * while the GLSL path flips `gl_FragCoord` to match. So every conversion in
   * either direction must INVERT y. Three states this explicitly in
   * `getViewPosition()` / `getScreenPosition()` (PostProcessingUtils.js); the
   * plain `ndc*0.5 + 0.5` everyone writes from memory is the WebGL-era form and
   * is silently mirrored here.
   *
   * Three sites in this directory got it wrong the same way, and the fourth —
   * the above-water god rays in core/postGodRays.ts — is what the user actually
   * shot: the march converged on the sun's mirror image below the horizon, so
   * the effect smeared SEA into "blue god rays from below water". The failure
   * is invisible in any test of the surrounding maths (all of it is correct)
   * and invisible on screen whenever the frame happens to be near-symmetric,
   * which is why it is pinned lexically and in one place.
   *
   * These are source assertions because the expressions live inside TSL graphs
   * or a per-frame update that needs a live camera; the arithmetic itself is
   * pinned in tests/postGodRays.test.ts, which fails on the un-flipped form.
   */
  it('inverts y on every NDC ↔ screen-UV conversion (§V.23-adjacent)', () => {
    // sun projection for the submerged shafts
    expect(underwaterIndexSource).toContain('0.5 - sunWorld.y * 0.5');
    // waterline column projection for the meniscus band
    expect(waterlineBandSource).toContain('0.5 - waterPoint.y * 0.5');
    // ...and the band's shader compares it y-DOWN, so "above" is the smaller v
    expect(waterlineBandSource).toContain('const d = waterY.sub(screenUV.y)');
    // depth→world reconstruction for the volume: an unflipped ndc.y sign-flips
    // rayUp, which opens Snell's window downward
    expect(waterVolumeSource).toContain(
      'vec2(screenUV.x, screenUV.y.oneMinus()).mul(2).sub(1)',
    );

    // and the WebGL-era form must not come back anywhere in the directory
    for (const src of [underwaterIndexSource, waterlineBandSource, waterVolumeSource]) {
      expect(src).not.toMatch(/\.y\s*\*\s*0\.5\s*\+\s*0\.5/);
      expect(src).not.toMatch(/screenUV\.mul\(2\)\.sub\(1\)/);
    }
  });
});
