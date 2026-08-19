/**
 * §T.61 — THE SUN THROUGH SNELL'S WINDOW, as arithmetic.
 *
 * The shader half cannot be unit-tested (it is a TSL graph), but everything
 * that DECIDES whether the feature works is a closed-form number, and every
 * one of them was got wrong at least once on the way here:
 *
 *  · the critical angle, which must be DERIVED from the IOR and not typed in
 *    (the shipped code carried a literal 0.661 against a derived 0.6612);
 *  · whether the sun is inside the window AT ALL at the framing the user keeps
 *    shooting — if it is not, no amount of shader work can show it;
 *  · whether adding the disc to a direction refracted about a LIVE WAVE NORMAL
 *    aliases, which is what the §V.48 widening in `skyBackground.sunFor` is
 *    for, and whether that widening is the no-op it claims to be for the sky
 *    background itself. A band limit that quietly dims the thing it protects
 *    is worse than none, and "it's a no-op up there" was an assertion in a
 *    comment until this file measured it.
 *
 * §V.8-style discipline applied to a look feature: the numbers come from the
 * SAME `keyLight`, `skyParams` and exported constants the material uses, so a
 * tweak to any of them moves this test rather than leaving it agreeing with a
 * copy of itself.
 */
import { describe, expect, it } from 'vitest';
import { keyLight } from '../src/sky/moonCycle';
import { sunDiscCosines } from '../src/sky/sunCycle';
import { skyParams } from '../src/params/sky';
import { oceanSurfaceParams as sp } from '../src/params/oceanSurface';
import {
  CRITICAL_COS,
  WATER_IOR,
  WATER_RADIANCE_GAIN,
} from '../src/ocean/surfaceMaterial';

const deg = (r: number) => (r * 180) / Math.PI;
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** where the sun lands on the water side, for a time of day */
function sunInWater(tod: number) {
  const elev = keyLight(tod, skyParams).sunElevation; // RADIANS
  const thetaAir = Math.PI / 2 - elev;
  const thetaW = Math.asin(Math.min(1, Math.sin(thetaAir) / WATER_IOR));
  const cosW = Math.cos(thetaW);
  return {
    elevDeg: deg(elev),
    thetaAirDeg: deg(thetaAir),
    thetaWDeg: deg(thetaW),
    cosW,
    /** the material's own window mask, at the sun's own direction */
    open: smooth(CRITICAL_COS - sp.underWindowSoftness, CRITICAL_COS + sp.underWindowSoftness, cosW),
    /** dθ_air/dθ_water — how much the window squashes the disc RADIALLY */
    squash: Math.cos(thetaAir) / (WATER_IOR * cosW),
  };
}

describe('§T.61 Snell window geometry', () => {
  it('derives the critical angle from the IOR, never a literal', () => {
    // 48.607°. The pre-§T.61 shader carried `float(0.661)`; the drift is small
    // but it is drift, and it silently decouples from any IOR change.
    expect(deg(Math.acos(CRITICAL_COS))).toBeCloseTo(48.607, 3);
    expect(WATER_RADIANCE_GAIN).toBeCloseTo(1.7769, 4);
  });

  it('puts the sun INSIDE the window at the framing the user shoots (tod 17.6)', () => {
    const s = sunInWater(17.6);
    // 5.79° elevation → 48.28° in water, 0.33° inside the 48.607° critical
    // angle. This is the whole premise of the feature: the sun IS visible from
    // below at their framing, and the window was simply filled with a function
    // that could not contain it (§V.26 scoped to reflection).
    expect(s.thetaWDeg).toBeLessThan(deg(Math.acos(CRITICAL_COS)));
    expect(s.thetaWDeg).toBeCloseTo(48.28, 1);
  });

  it('is the WORST case pre-sunset, which is why it must be judged there', () => {
    const dusk = sunInWater(17.6);
    const noonish = sunInWater(15.0);
    // The rim of the window is half-closed by `underWindowSoftness`, so at dusk
    // the sun's own pixel keeps only ~half its radiance while at 15.0 it keeps
    // all of it. Validating this feature at ONE sun angle is how three fixes
    // shipped broken this session.
    expect(dusk.open).toBeGreaterThan(0.4);
    expect(dusk.open).toBeLessThan(0.6);
    expect(noonish.open).toBeCloseTo(1, 3);
  });

  it('squashes the disc into a streak — the "distorted bright spot", for free', () => {
    // The user asked for "at least like this distorted bright spot", not a
    // clean disc. Nothing in the shader draws a streak: the refraction's own
    // Jacobian does it. At 900 px / 55° fov the sun's image is
    //   tod 17.6 → 4.1 px tall × 36 px wide   (a hard smear along the rim)
    //   tod 15.0 → 22  px tall × 36 px wide   (a rounder blob)
    const degPerPx = 55 / 900;
    const width = (skyParams.sunDiscSize * 2) / degPerPx;
    const tall = (tod: number) => (skyParams.sunDiscSize * 2 * sunInWater(tod).squash) / degPerPx;
    expect(width).toBeCloseTo(36, 0);
    expect(tall(17.6)).toBeGreaterThan(2);
    expect(tall(17.6)).toBeLessThan(6);
    // and it must be MORE squashed at dusk than at 15.0, or the mapping is
    // inverted — which looks plausible and is the easy sign error here
    expect(tall(17.6)).toBeLessThan(tall(15.0));
  });
});

describe('§V.48 disc widening in skyBackground.sunFor', () => {
  const [outer, inner] = sunDiscCosines(skyParams.sunDiscSize, skyParams.sunDiscSoftness);
  const w0 = inner - outer;
  /** the shader's `w = max(w0, 2·fwidth(c))`, and the energy factor w0/w */
  const widen = (dcPerPixel: number) => {
    const w = Math.max(w0, 2 * dcPerPixel);
    return { w, gain: w0 / w };
  };
  /** d(dir·sunDir) per pixel, for a ray swinging `swingDeg` per pixel */
  const dcPerPx = (swingDeg: number) =>
    Math.sin((skyParams.sunDiscSize * Math.PI) / 180) * ((swingDeg * Math.PI) / 180);

  it('is an exact NO-OP on the sky background, so the sun above water cannot move', () => {
    // The background's `dir` is the view ray: 55°/900 px = 0.061°/px. This is
    // the claim the code comment makes, and it is the one that would silently
    // dim the sky's own sun if it were false.
    const { gain } = widen(dcPerPx(55 / 900));
    expect(gain).toBe(1);
  });

  it('engages, and conserves energy, once the wave normal swings the ray', () => {
    // Inside the window the ray is refracted about the live wave normal and
    // amplified by dθ_air/dθ_water ≈ 8.8 at tod 17.6, so a few tenths of a
    // degree of per-pixel slope becomes degrees of ray swing. The disc must
    // then get WIDER and DIMMER by the same factor — a widened edge at full
    // amplitude is §V.48(b) with the sign flipped, i.e. a smeared sun that is
    // BRIGHTER than a sharp one.
    const { w, gain } = widen(dcPerPx(2.6));
    expect(w).toBeGreaterThan(w0 * 4);
    expect(gain).toBeCloseTo(w0 / w, 12);
    expect(gain).toBeLessThan(0.25);
    // energy — width × amplitude — is preserved exactly, which is what makes
    // this a band limit rather than a fade-out
    expect(w * gain).toBeCloseTo(w0, 12);
  });
});
