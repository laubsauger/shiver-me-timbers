/**
 * PROCEDURAL STARFIELD (§T.46) — the largest single gap to the SoT night
 * references in docs/inspo/night/, every one of which is a dense field of
 * small stars over a deep blue sky. We had zero.
 *
 * ── THE THREE HARD CONSTRAINTS, AND WHY NONE IS NEGOTIABLE ───────────────
 *
 * 1. `colorNode` ONLY — NEVER `skyDome`. `skyBackground.ts`'s `skyDome` is the
 *    ocean's reflected-sky term and is therefore evaluated PER WATER PIXEL, in
 *    the fragment stage that is the frame's dominant cost (§V.17, §V.40). The
 *    background, by contrast, is at most one screen of pixels and shrinks
 *    toward nothing as the sea fills the frame. Everything here is cheap only
 *    because of where it runs. The references show no star reflections on the
 *    water either, so there is nothing to gain by moving it.
 *
 * 2. ZERO TEXTURES, ZERO SAMPLERS. `skyBackground.ts` is fully procedural and
 *    must stay that way: the ocean fragment stage sits at 15 samplers against
 *    a hard Metal cap of 16 (§V.40 — measured from the adapter, asking for
 *    more buys nothing), and the one spare is already earmarked. A star
 *    TEXTURE is the obvious implementation and it is the one thing we cannot
 *    afford. Hence hash-cells on the view ray.
 *
 * 3. §V.48, BOTH HALVES. A star is a sub-pixel dot — the worst case the
 *    band-limit invariant exists for. Widening alone leaves a fat smear;
 *    fading alone leaves a crawling step. Both are applied through
 *    `src/ship/bandLimit`, which is the single owner of the 2-px floor and the
 *    energy ratio: this is the project's TENTH band-limited procedural
 *    feature, not a new idea, and it does not get a private variant.
 *
 * ── WHY A CUBE-FACE GRID, AND WHY THE JACOBIAN IS NOT OPTIONAL ────────────
 * The field is one candidate star per cell of a grid laid over the six faces
 * of a cube, addressed by the view ray. Exactly ONE cell is examined per pixel
 * — no 3x3 neighbourhood — which is only legal because a star's drawn radius
 * is a few percent of a cell, so a star can never reach the wall of the cell
 * it was born in. {@link JITTER} is what guarantees that.
 *
 * A cube face is a GNOMONIC projection: a cell of fixed (u,v) area subtends
 * (1+u²+v²)^-3/2 of the solid angle it does at the face centre, so a naive
 * one-star-per-cell field is 5.2x denser at the eight cube corners than at the
 * six face centres — eight fixed knots of stars in the sky, which is exactly
 * the kind of lattice §B.33 is about. {@link starDensityWeight} cancels it as
 * the probability that a cell holds a star at all, and it is FREE: it is a
 * power of the reciprocal length the star direction needs for its normalize.
 */
import { Fn, float, mix, smoothstep, step, time, uniform, vec2, vec3 } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { bandLimitAmplitude, bandLimitEnergy, bandLimitWidth } from '../ship/bandLimit';
import { hash3 } from '../terrain/noise';
import { hash3Cpu } from '../terrain/noiseCpu';
import type { SkyParams } from '../params/sky';
import { hexToRgb } from './sunCycle';
import type { KeyLight } from './moonCycle';

/** any TSL node — this math is structural, not typed */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any;

/** floor for every divisor here (§V28) */
const EPS = 1e-6;

/**
 * How far a star may wander from its cell centre, as a fraction of the cell.
 *
 * NOT 0.5. Only the pixel's OWN cell is evaluated, so a star whose drawn disc
 * crossed a cell wall would be cut off at that wall — a hard straight edge
 * through a good fraction of the sky's stars. 0.38 leaves 12% of a cell of
 * clearance on every side, which at the shipped density is 0.191°: 1.7x the
 * drawn radius at 1080p and still clear at 720p (0.166°).
 *
 * It trades against `starDensity` — a denser grid is a smaller cell and less
 * clearance in degrees — so the two are chosen together, and a test pins the
 * margin so raising one without the other cannot silently start clipping.
 *
 * Past that the guarantee lapses rather than being clamped, and it lapses
 * SAFELY: the drawn radius only grows because the pixel footprint grew, and by
 * then §V.48b's energy ratio has faded the star to a few percent of its peak.
 * A clipped invisible star is invisible.
 */
const JITTER = 0.38;

/** how much of a cell a star is guaranteed NOT to reach, in cells — the
 *  quantity the clipping test measures the drawn radius against */
export const CELL_CLEARANCE = 0.5 - JITTER;

/** decorrelated hash streams — one per per-star property (§B.4) */
const SEED_JITTER_U = [17.31, 5.77, 2.19] as const;
const SEED_JITTER_V = [3.11, 41.09, 7.53] as const;
const SEED_COLOR = [61.7, 13.37, 29.03] as const;
const SEED_PHASE = [8.91, 71.23, 44.61] as const;

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

/**
 * Fraction of a cell's solid angle relative to a face-centre cell, 0.192..1.
 *
 * `invLen` is 1/|(±1, u, v)| = 1/sqrt(1+u²+v²). See the header: this is the
 * gnomonic Jacobian and it is what keeps star density flat per steradian
 * instead of knotting at the cube corners.
 */
export function starDensityWeight(invLen: number): number {
  return invLen * invLen * invLen;
}

/**
 * Per-star magnitude, 0..1, from one uniform hash.
 *
 * Doubles as the DENSITY gate, which is why there is no separate threshold
 * test: a cell whose hash lands above `threshold` yields exactly 0 and simply
 * is not a star. Written as `1 - h/threshold` rather than `h/threshold` on
 * purpose — that way the stars nearest the cut are the FAINTEST, so lowering
 * the density (or moving toward a cube corner, where the threshold falls)
 * removes stars from the bottom of the brightness distribution instead of
 * blinking the brightest ones in and out.
 *
 * `power` shapes the distribution: at 3 the median star sits at 1/8 of peak,
 * which is what makes a field read as "a few bright, very many faint" rather
 * than as evenly spaced confetti.
 */
export function starMagnitude(h: number, threshold: number, power: number): number {
  const t = Math.max(threshold, EPS);
  return Math.pow(Math.max(0, 1 - h / t), power);
}

/**
 * Which cube face a direction falls on, and its (u, v) in [-1, 1] there.
 *
 * Faces 0/1/2 are +x/+y/+z, 3/4/5 the negatives. The permutation is chosen so
 * a face and its opposite read the SAME two source components (u,v = y,z on
 * both ±x), which is what lets the inverse be three swizzles instead of six
 * branches. Cell walls land exactly on |u| = 1, so the six grids tile the
 * sphere with no cell straddling a seam and no star counted twice.
 */
export function cubeFace(d: readonly [number, number, number]): {
  face: number;
  u: number;
  v: number;
} {
  const ax = Math.abs(d[0]);
  const ay = Math.abs(d[1]);
  const az = Math.abs(d[2]);
  const isX = ax >= ay && ax >= az;
  const isY = !isX && ay >= az;
  const major = isX ? d[0] : isY ? d[1] : d[2];
  const inv = 1 / Math.max(Math.abs(major), EPS);
  const u = (isX ? d[1] : isY ? d[2] : d[0]) * inv;
  const v = (isX ? d[2] : isY ? d[0] : d[1]) * inv;
  return { face: (isX ? 0 : isY ? 1 : 2) + (major < 0 ? 3 : 0), u, v };
}

/**
 * Inverse of {@link cubeFace}: the unit direction of a point on a face, plus
 * the `invLen` {@link starDensityWeight} wants — the normalize computed it
 * anyway, which is the whole reason the density correction is free.
 */
export function faceDirection(
  face: number,
  u: number,
  v: number,
): { dir: [number, number, number]; invLen: number } {
  const sgn = face >= 3 ? -1 : 1;
  const axis = face % 3;
  const l: [number, number, number] =
    axis === 0 ? [sgn, u, v] : axis === 1 ? [v, sgn, u] : [u, v, sgn];
  const invLen = 1 / Math.max(Math.hypot(l[0], l[1], l[2]), EPS);
  return { dir: [l[0] * invLen, l[1] * invLen, l[2] * invLen], invLen };
}

/**
 * Stars per steradian the grid actually produces.
 *
 * A cell spans (2/N)² of face area and (2/N)²·J of solid angle, and holds a
 * star with probability J — so J cancels EXACTLY and this is a constant over
 * the whole sky. A test pins the flatness: drop the Jacobian and it stops
 * being constant, which is the corner-knot artefact in numbers.
 */
export function starsPerSteradian(cellsPerEdge: number): number {
  const cell = 2 / Math.max(cellsPerEdge, 1);
  return 1 / (cell * cell);
}

/**
 * §V.48b's amplitude ratio in its 2D (disc) form.
 *
 * The exponent is 2 and not 1 because a star is a DISC: its integrated flux
 * goes as r², so this is the factor that holds flux constant while half (a)
 * widens the disc to the sample grid — i.e. the mean the pixel should have
 * seen. `bandLimitEnergy` is the 1D owner and is squared here rather than
 * re-derived, so the 2-px floor stays in one place.
 */
export function bandLimitEnergy2D(trueRadius: number, pixelAngle: number): number {
  const r = bandLimitEnergy(trueRadius, pixelAngle);
  return r * r;
}

/**
 * Peak linear radiance a star is actually DRAWN at — the CPU mirror of the
 * amplitude built in the node below, and what the tests use to prove that a
 * sub-pixel star converges on the sky instead of flickering.
 *
 * @param brightness authored peak for a magnitude-1 star at full resolution
 * @param magnitude  0..1 from {@link starMagnitude}
 * @param trueRadius the star's authored angular radius, radians
 * @param pixelAngle angular size of one pixel, radians
 */
export function starPeakRadiance(
  brightness: number,
  magnitude: number,
  trueRadius: number,
  pixelAngle: number,
): number {
  return brightness * magnitude * bandLimitEnergy2D(trueRadius, pixelAngle);
}

/** angular size of one pixel, radians — the filter width every limit here uses */
export function pixelAngleFor(fovYDegrees: number, heightPx: number): number {
  return (2 * Math.tan((fovYDegrees * DEG) / 2)) / Math.max(heightPx, 1);
}

/** everything the node derives for one cell — the CPU half of the pair */
export interface StarSample {
  /** unit direction of the star */
  dir: [number, number, number];
  /** 1/|(±1, u, v)| — feeds {@link starDensityWeight} */
  invLen: number;
  /** probability this cell holds a star at all = the gnomonic Jacobian */
  threshold: number;
  /** 0..1; exactly 0 when the cell holds no star */
  magnitude: number;
  /** twinkle phase OFFSET, radians — its own hash stream (§B.4) */
  phase: number;
  /** 0..1 cool→warm mix factor */
  colorMix: number;
  /** displacement from the cell centre, in cells */
  offsetU: number;
  offsetV: number;
}

/**
 * CPU transliteration of steps 2 and 3 of the node below — the same hash, the
 * same seeds, the same face inverse, the same Jacobian.
 *
 * DOCUMENTED TRANSLITERATION PAIR, the convention `bandLimit.ts` and
 * `sailShape.ts` already use: a TSL graph cannot be evaluated headless, so the
 * properties that matter (density is flat per steradian, stars never reach
 * their own cell wall, phases are decorrelated) are proven against this and
 * the two sides are changed together. f64 here vs f32 on the GPU, so the
 * values are structurally identical, not bit-exact.
 */
export function starForCell(
  face: number,
  cellU: number,
  cellV: number,
  cellsPerEdge: number,
  magnitudePower: number,
): StarSample {
  const n = Math.max(1, cellsPerEdge);
  const hMag = hash3Cpu(cellU, cellV, face);
  const jU = (hash3Cpu(cellU + SEED_JITTER_U[0], cellV + SEED_JITTER_U[1], face + SEED_JITTER_U[2]) - 0.5) * 2 * JITTER;
  const jV = (hash3Cpu(cellU + SEED_JITTER_V[0], cellV + SEED_JITTER_V[1], face + SEED_JITTER_V[2]) - 0.5) * 2 * JITTER;
  const hColor = hash3Cpu(cellU + SEED_COLOR[0], cellV + SEED_COLOR[1], face + SEED_COLOR[2]);
  const hPhase = hash3Cpu(cellU + SEED_PHASE[0], cellV + SEED_PHASE[1], face + SEED_PHASE[2]);
  const u = ((cellU + 0.5 + jU) / n) * 2 - 1;
  const v = ((cellV + 0.5 + jV) / n) * 2 - 1;
  const { dir, invLen } = faceDirection(face, u, v);
  const threshold = starDensityWeight(invLen);
  return {
    dir,
    invLen,
    threshold,
    magnitude: starMagnitude(hMag, threshold, magnitudePower),
    phase: hPhase * TAU,
    colorMix: hColor * hColor,
    offsetU: jU,
    offsetV: jV,
  };
}

export function createStarfield(p: SkyParams) {
  const uCellsPerEdge = uniform(p.starDensity);
  const uRadius = uniform(p.starSize * DEG);
  const uBrightness = uniform(p.starBrightness);
  const uMagPower = uniform(p.starMagnitudePower);
  const uTwinkleAmount = uniform(p.starTwinkleAmount);
  const uTwinkleRate = uniform(p.starTwinkleRate);
  const uCool = uniform(new THREE.Color());
  const uWarm = uniform(new THREE.Color());
  const uHorizonFade = uniform(p.starHorizonFade);
  /** 0..1 how dark it is — see update() for why this is NOT moonWeight */
  const uNight = uniform(0);

  /**
   * Additive star radiance toward `dir` (a normalized world-space view ray).
   * Exactly 0 in daylight and at or below the horizon.
   *
   * NOTE §B1/§V23: functional `mix(a, b, t)` / `smoothstep(lo, hi, x)` ONLY —
   * the chained forms read the RECEIVER as the factor and silently invert.
   */
  const node = Fn(([dir]: [AnyNode]) => {
    // ── 1. which cube face, and where on it ─────────────────────────────
    // Branch-free: three 0/1 selectors, then one dot each for u and v.
    // These steps choose a FACE; they are not a drawn edge. Both faces meeting
    // at a seam put a cell wall exactly on the seam, so the grid tiles with no
    // feature straddling the discontinuity and there is no transition here for
    // a pixel footprint to be measured against.
    const a = dir.abs().toVar();
    // @band-limited-elsewhere: face select, not an edge — reason just above.
    const isX = step(a.y, a.x).mul(step(a.z, a.x)).toVar();
    const isY = float(1).sub(isX).mul(step(a.z, a.y)).toVar();
    const isZ = float(1).sub(isX).sub(isY).toVar();
    const sel = vec3(isX, isY, isZ).toVar();
    const major = sel.dot(dir).toVar();
    const inv = float(1).div(major.abs().max(EPS));
    const uv = vec2(sel.dot(dir.yzx), sel.dot(dir.zxy)).mul(inv).toVar();
    // §V28: sign() is 0 at 0, which would collapse the face onto a plane
    // through the origin; step is +1 there instead.
    // @band-limited-elsewhere: face select, not an edge — as above.
    const sgn = step(0, major).mul(2).sub(1).toVar();
    const face = isY.add(isZ.mul(2)).add(step(major, 0).mul(3)).toVar();

    // ── 2. the cell, and the star inside it ─────────────────────────────
    const n = uCellsPerEdge.max(1);
    const grid = uv.mul(0.5).add(0.5).mul(n).toVar(); // [0, n) across the face
    const cell = vec3(grid.x.floor(), grid.y.floor(), face).toVar();
    const hMag = hash3(cell).toVar();
    const jitterU = hash3(cell.add(vec3(...SEED_JITTER_U))).sub(0.5).mul(2 * JITTER);
    const jitterV = hash3(cell.add(vec3(...SEED_JITTER_V))).sub(0.5).mul(2 * JITTER);
    const hColor = hash3(cell.add(vec3(...SEED_COLOR))).toVar();
    const hPhase = hash3(cell.add(vec3(...SEED_PHASE))).toVar();
    // cell centre + jitter, back to [-1, 1] face coordinates
    const su = cell.x.add(0.5).add(jitterU).div(n).mul(2).sub(1);
    const sv = cell.y.add(0.5).add(jitterV).div(n).mul(2).sub(1);

    // inverse of the face permutation — three swizzles of one vector
    const local = vec3(sgn, su, sv).toVar();
    const world = local.mul(isX).add(local.zxy.mul(isY)).add(local.yzx.mul(isZ)).toVar();
    const invLen = float(1).div(world.length().max(EPS)).toVar();
    const starDir = world.mul(invLen);

    // ── 3. magnitude — density gate and brightness from one hash ────────
    // threshold = the gnomonic Jacobian, so density per steradian stays flat.
    const threshold = invLen.mul(invLen).mul(invLen);
    const mag = hMag
      .div(threshold.max(EPS))
      .oneMinus()
      .max(EPS) // §V28: pow(0, k) is NaN on some drivers; EPS^k underflows to 0
      .pow(uMagPower.max(EPS))
      .toVar();

    // ── 4. the drawn disc (§V.48, both halves) ──────────────────────────
    // Distance is the CHORD between two unit vectors, equal to the angle to
    // within 0.5% at these sizes, and the footprint below is in exactly the
    // same units: the screen-space derivative of the view ray IS the angular
    // size of a pixel. Deliberately NOT the derivative of the face uv — that
    // is discontinuous at every cube seam and would report a huge footprint
    // along six great circles, deleting the stars on them.
    //
    // max-of-two-lengths rather than `coordFilter`'s |∂x| + |∂y|: this feature
    // is RADIAL, so its footprint is a length, and summing the two axis
    // footprints over-estimates it by ~2x — which would draw every star at
    // twice the radius and a quarter of the peak. Over-estimating is the safe
    // direction for an edge, but "safe" here means "silently deletes the
    // feature", so the override exists (see bandLimit.ts's own note).
    const pixelAngle = dir.dFdx().length().max(dir.dFdy().length()).max(EPS).toVar();
    const dist = dir.sub(starDir).length();
    const ratio = bandLimitAmplitude(uRadius, dir, pixelAngle).toVar();
    const drawn = bandLimitWidth(uRadius, dir, pixelAngle).toVar();
    const profile = smoothstep(0, drawn, dist).oneMinus();
    const energy = ratio.mul(ratio); // a disc's flux goes as r², not as r

    // ── 5. twinkle (§B.4, §V.55) ────────────────────────────────────────
    // §B.4 was one shared time phase making every ocean sparkle cell flip in
    // sync — a 3 s global pulse over the whole sea. Same cure here: the phase
    // OFFSET is per star, hashed from its own cell and from a stream of its
    // own. It deliberately does NOT reuse the colour hash: that would tie
    // phase to hue and put every warm star in the sky on the same beat, which
    // is §B.4 again on the minority that most catches the eye.
    //
    // §V.55 PERMITS `t × rate` here, and this comment exists so a future
    // reader does not "fix" it into an accumulator. The invariant binds
    // oscillators whose RATE CAN VARY, because t·ω(t) is only a valid phase
    // while ω is constant — elapsed time multiplies every wobble in the rate.
    // `starTwinkleRate` is an art constant that nothing in the sim drives, so
    // ω is constant and t·ω is exact. `time` is the RENDERER's own clock
    // (three's NodeFrame), not a second clock invented here. Dragging the rate
    // in Tweakpane re-phases the field in one frame: a discontinuity while a
    // debug slider moves, not the unbounded runaway §V.55 measured on the flags.
    const twinkle = time.mul(uTwinkleRate).add(hPhase.mul(TAU)).sin().mul(uTwinkleAmount).add(1);

    // ── 6. colour, horizon, night ───────────────────────────────────────
    // Squared so the warm tail is a minority: the references are a field of
    // blue-white with a scattering of amber, not an even mix.
    const tint = mix(vec3(uCool), vec3(uWarm), hColor.mul(hColor));
    // Stars sit BEHIND the haze band, so they are gone well before the
    // geometric horizon. A dedicated ramp rather than a second copy of
    // `skyDome`'s haze wedge (§T39: a duplicate drifts the moment either side
    // is tuned) — this is an art knob for where the field ends, not a claim
    // about scattering.
    // @band-limited-elsewhere: a ramp several degrees tall, i.e. hundreds of
    // pixels at every resolution this project runs at. It cannot go sub-pixel.
    const horizon = smoothstep(0, uHorizonFade.max(EPS), dir.y);

    // §V44 bounded at source: profile, horizon and the twinkle factor are all
    // clamped or 0..1 by construction, mag and energy are clamped ratios, and
    // the only unbounded factor is the authored brightness itself.
    const amp = uBrightness
      .mul(mag)
      .mul(energy)
      .mul(profile)
      .mul(twinkle.max(0))
      .mul(horizon)
      .mul(uNight);
    return tint.mul(amp);
  });

  return {
    node: (dir: AnyNode): AnyNode => node(dir),
    /**
     * THE NIGHT GATE IS `nightFactor`, NOT `moonWeight`.
     *
     * `moonCycle.ts` owns both and they are not interchangeable: `moonWeight`
     * is zero on a new-moon night, which is the night with the MOST visible
     * stars, so keying the field off it would delete the starfield exactly
     * when it matters most. `nightFactor` is documented there as THE single
     * clock for "how dark is it" — the one every practical light in the world
     * already reads — and stars belong to that family. One owner (§V.33,
     * §V.51); this reads it, it does not derive a second dusk.
     */
    update(key: KeyLight): void {
      uCellsPerEdge.value = Math.max(1, Math.floor(p.starDensity));
      uRadius.value = Math.max(0, p.starSize) * DEG;
      uBrightness.value = Math.max(0, p.starBrightness);
      uMagPower.value = Math.max(EPS, p.starMagnitudePower);
      uTwinkleAmount.value = Math.min(1, Math.max(0, p.starTwinkleAmount));
      uTwinkleRate.value = Math.max(0, p.starTwinkleRate);
      uHorizonFade.value = Math.max(EPS, p.starHorizonFade);
      const cool = hexToRgb(p.starColorCool);
      const warm = hexToRgb(p.starColorWarm);
      uCool.value.setRGB(cool[0], cool[1], cool[2], THREE.SRGBColorSpace);
      uWarm.value.setRGB(warm[0], warm[1], warm[2], THREE.SRGBColorSpace);
      uNight.value = Math.min(1, Math.max(0, key.nightFactor));
    },
  };
}

export type Starfield = ReturnType<typeof createStarfield>;
