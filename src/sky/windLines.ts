/**
 * VISIBLE WIND LINES (§T.47) — long, gentle, semi-transparent streaks running
 * across the sky and converging toward the horizon, so a player on deck can
 * read the wind's bearing WITHOUT looking down at the HUD dial.
 *
 * This is diegetic instrumentation first and decoration second. The user's
 * words: "gentle, wavy, semi-transparent white lines... without being
 * overwhelming — it should be subtle, so that it's always clear where the wind
 * is coming from without us having to look down at the wind indicator", and
 * they "should intensify in storms and reflect the wind speed".
 *
 * ── THE OBJECT: A PENCIL OF GREAT CIRCLES THROUGH THE WIND AXIS ────────────
 * Take W, the horizontal unit vector the wind blows TOWARD. Every streak is a
 * MERIDIAN of the sphere whose poles are ±W — the set of directions at constant
 * azimuth `phi` about W. All of them meet at exactly two points, +W and −W,
 * and both of those lie ON THE HORIZON.
 *
 * That is where the convergence comes from, and it is real projective
 * convergence rather than a screen-space fake: parallel horizontal lines in air
 * converge at the horizon point their direction pierces. Worked through:
 *   - looking CROSSWIND, the poles sit left and right on the horizon and the
 *     streaks read as near-horizontal bands stacked in elevation, arcing across
 *     the sky and converging at both horizon points — the reference frame;
 *   - looking DOWNWIND, the pole is dead ahead and the streaks radiate out of
 *     it; looking UPWIND they converge into it;
 *   - looking UP, they run along the wind, over your head.
 * So the vanishing point IS the bearing, from every camera angle. That is the
 * property that lets this replace a glance at the dial.
 *
 * The alternative — a horizontal plane above the camera, intersected by the
 * view ray — was rejected: it divides by `dir.y`, so it breaks at the horizon
 * (which is exactly where the interesting part is) and needs a far-distance
 * clamp whose engagement is a visible seam. The pencil needs neither, and it is
 * a pure function of the view RAY, with no camera position and no plane, which
 * is what makes it portable to another composite site (see the note in
 * skyBackground.ts about moving it in front of the clouds).
 *
 * ── CONVERGENCE AND ANTI-ALIASING ARE THE SAME FACT ────────────────────────
 * Everything is measured in `u` = phi in units of ONE STREAK SPACING, and the
 * streak's width is a constant DUTY CYCLE — a fraction of the spacing, never a
 * fixed angle. That is the honest perspective model: approaching a vanishing
 * point, real streaks get thinner AND closer together by the same factor, so
 * the duty cycle is what stays constant. A constant ANGULAR width instead piles
 * all N streaks into a saturated knot at the pole, which is both wrong and
 * unfilterable.
 *
 * Because the duty cycle is constant, the whole pattern goes sub-pixel
 * TOGETHER, and §V.48b's energy ratio dissolves it precisely at the pinch. The
 * pattern draws its own convergence and then fades it out. Measured at the
 * shipped defaults (49 streaks, duty 0.09, 1080p / 55° fov ⇒ 9.64e-4 rad per
 * pixel): the fade begins 20.6° from the vanishing point, is at half energy by
 * 9.9° and a quarter by 4.9°, and is 3e-6 of peak AT the pole itself. No knot,
 * no hard edge, no separate horizon hack. `tests/windLines.test.ts` solves for
 * those three angles rather than trusting them.
 *
 * ── THE FOOTPRINT IS ANALYTIC, NOT `fwidth(phi)` ───────────────────────────
 * `phi` comes from an atan2 and WRAPS at ±π. Differentiating it reports an
 * enormous filter width along that one meridian and deletes the streaks on it:
 * a slit through the sky that would read as a rendering bug rather than as a
 * filter bug. So the footprint is written down from the geometry instead:
 *
 *     |∇phi| = 1 / sin(theta)          (longitude on a globe: arc = sinθ·dphi)
 *     filter_u = pixelAngle · ( (N/2π)/sinθ + waveSlope )
 *
 * exact, seam-free, and cheaper than differentiating. §V28's corollary is
 * satisfied STRUCTURALLY rather than by clamping the result: the ε floor on
 * sinθ lets the filter pin at a huge value, and a huge filter drives the energy
 * ratio to ZERO — the only thing the divergence can do is delete a feature that
 * is already sub-pixel. The failure direction is safe by construction.
 *
 * ── WAVINESS IS LOAD-BEARING, NOT ORNAMENT ─────────────────────────────────
 * A straight line translating along its own length is INVISIBLE. Without the
 * undulation the drift would not read at all and the streaks would be static
 * scratches. Two detuned sines, each with a per-streak hashed phase offset from
 * its own decorrelated hash stream (§B.4), plus a slow gust envelope along the
 * streak so they fade in and out down their length instead of running as rails.
 *
 * ── ZERO TEXTURES, ZERO SAMPLERS, `colorNode` ONLY ─────────────────────────
 * Same two rules the starfield established and for the same reasons: the ocean
 * fragment stage is at its sampler ceiling (§V40) and `skyDome` is evaluated
 * per WATER pixel, so nothing here may ever migrate into it. Everything below
 * is hash + trig on the view ray, and it runs on background fragments only.
 */
import { Fn, atan, float, mix, smoothstep, uniform, vec2, vec3 } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { bandLimitAmplitude, bandLimitEnergy, bandLimitWidth } from '../ship/bandLimit';
import { hash3 } from '../terrain/noise';
import { hash3Cpu } from '../terrain/noiseCpu';
import type { SkyParams } from '../params/sky';
import type { KeyLight } from './moonCycle';

/** any TSL node — this math is structural, not typed */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any;

/** floor for every divisor here (§V28) */
const EPS = 1e-6;

const TAU = Math.PI * 2;

/**
 * Detuning of the second undulation against the first. Deliberately not a
 * small-integer ratio, so the two never lock into one obvious period — §B.4,
 * and the same number and the same reason as `FLAG_CRACK_RATIO`.
 */
export const WAVE_RATIO = 2.3;

/** second undulation's amplitude, as a fraction of the first */
export const WAVE_SECOND = 0.5;

/**
 * The most a streak may wander from its own meridian, in spacings, INCLUDING
 * its drawn half-width.
 *
 * This is `starfield.ts`'s JITTER argument in one dimension. Only the pixel's
 * OWN streak — the nearest base index — is evaluated, no neighbourhood, which
 * is legal only while a streak cannot reach the wall of its own cell at 0.5.
 * Past that its wave would be cut off against a straight line down the sky.
 * `tests/windLines.test.ts` pins the shipped wave amplitudes and duty cycle
 * against this, so raising one without the other cannot silently start
 * clipping.
 */
export const WIND_LINE_CLEARANCE = 0.4;

/** decorrelated hash streams — one per per-streak property (§B.4) */
const SEED_WAVE_A = [13.19, 2.71, 51.03] as const;
const SEED_WAVE_B = [7.77, 63.41, 19.87] as const;
const SEED_GUST = [37.13, 11.29, 5.51] as const;
const SEED_DENSITY = [23.57, 44.02, 71.91] as const;

/** smooth 0..1 ramp — spelled out rather than imported, as bandLimit.ts does */
function smoothstep01(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / Math.max(edge1 - edge0, EPS)));
  return t * t * (3 - 2 * t);
}

function finite(x: number, fallback = 0): number {
  return Number.isFinite(x) ? x : fallback;
}

/** fold into [0, 2π) — keeps an accumulator's float precision constant forever */
function wrapTau(x: number): number {
  const v = finite(x) % TAU;
  return v < 0 ? v + TAU : v;
}

/**
 * THE WIND VECTOR, AND WHICH CAMP THIS FILE JOINED.
 *
 * `windDirection` is the direction the wind blows TOWARD, and the project reads
 * that angle through TWO MIRRORED CONVENTIONS — see the "KNOWN DIVERGENCE"
 * block in `tests/ui.test.ts`:
 *
 *   (cos θ, sin θ)  the ocean spectrum, spray, palm sway, foam, rain slant
 *   (sin θ, cos θ)  the sails, the flags, AI steering, audio panning, HUD dial
 *
 * They are a reflection of each other: they agree at the shipped default of
 * exactly π/4 and are 180° apart at 135°.
 *
 * THIS FILE JOINS THE SECOND CAMP — sails, flags, HUD dial — deliberately,
 * because the whole point of the feature is that the sky agrees with the RIG
 * THE PLAYER IS LOOKING AT and replaces a glance at the dial. Wind lines that
 * disagreed with the masthead pennant would be worse than no wind lines.
 *
 * Cost of the choice, stated plainly: off the 45° fixed point the streaks will
 * visibly disagree with the WAVE train, up to running dead against it at 135°.
 * That divergence is not created here — it is what the sky now makes visible,
 * because until now nothing drew the wind at all. When the conventions are
 * reconciled, this function is the one line in this file that changes.
 */
export function windAxis(direction: number): {
  /** unit vector the wind blows TOWARD — the downwind vanishing point */
  axis: [number, number, number];
  /** the horizontal vector perpendicular to it: cross(axis, up) */
  side: [number, number, number];
} {
  const d = finite(direction);
  const wx = Math.sin(d);
  const wz = Math.cos(d);
  return { axis: [wx, 0, wz], side: [-wz, 0, wx] };
}

/** where the streaks converge — the direction the wind blows toward */
export function vanishingPoint(direction: number): [number, number, number] {
  return windAxis(direction).axis;
}

/**
 * How much of the field is present at a given TRUE wind speed, 0..1.
 *
 * The onset is BEAUFORT 3 (3.4 m/s), which is not an arbitrary threshold: it is
 * where the scale first mentions whitecaps and within 0.1 m/s of Callaghan
 * 2008's fitted whitecap onset, i.e. the speed at which the SEA itself first
 * shows the wind (see the ladder in `src/ui/settingsStore.ts`). Below it the
 * gate is exactly 0, which collapses every streak weight to ~1e-9 of peak — a
 * calm sky is bare, with no branch and no special case.
 *
 * The top is the ladder's top rung, so the shipped default (11 m/s, F6) sits
 * near half and a storm has real room left to fill the sky in.
 */
export function windLineGate(speed: number, onset: number, full: number): number {
  return smoothstep01(onset, Math.max(full, onset + EPS), Math.max(0, finite(speed)));
}

/**
 * A streak's weight, 0..1, from one uniform hash — brightness AND presence in
 * the same number, exactly as `starMagnitude` does for stars.
 *
 * Written as `1 − h/gate` rather than `h/gate` for the same reason it is there:
 * the streaks nearest the cut are the FAINTEST, so a rising wind fades new
 * streaks in from the bottom of the brightness distribution instead of popping
 * them in at full strength, and a falling wind takes them out the same way.
 *
 * At `gate` 0 the base collapses to EPS and the weight with it — ~1e-9 at the
 * shipped power, which is what makes a calm bare. Not literally zero, because
 * the base is floored rather than clamped: `pow(0, k)` is NaN on some drivers
 * (§V28), and the starfield floors its own magnitude for the same reason.
 */
export function windLineWeight(h: number, gate: number, power: number): number {
  const base = Math.max(EPS, 1 - (Math.max(0, finite(h)) + EPS) / Math.max(gate, EPS));
  return Math.pow(base, Math.max(EPS, power));
}

/** the two undulation wavenumbers, radians⁻¹ along the streak */
export function waveNumbers(waveFreq: number): [number, number] {
  const k = TAU * Math.max(0, finite(waveFreq));
  return [k, k * WAVE_RATIO];
}

/**
 * Worst-case |∂u/∂theta| contributed by the undulation, in spacings per radian.
 *
 * Bounded by the amplitudes rather than evaluated, because it is a CORRECTION:
 * at the shipped defaults it is 1.22 against the meridian term's 7.80 at the
 * equator — 16%, and that is its WORST case, since the meridian term diverges
 * toward the poles while this stays put. Two saved cosines, and the bound errs
 * toward fading, which is the safe direction for a filter width.
 */
export function windLineWaveSlope(waveAmount: number, waveFreq: number): number {
  const [k1, k2] = waveNumbers(waveFreq);
  const a1 = Math.max(0, finite(waveAmount));
  return a1 * k1 + a1 * WAVE_SECOND * k2;
}

/**
 * Screen-space footprint of `u`, in spacings — the CPU mirror of the analytic
 * filter the node builds. See the header for why this is not `fwidth(phi)`.
 *
 * @param count      streaks around the wind axis (odd — see `createWindLines`)
 * @param sinTheta   sine of the angle from the vanishing point, 0 at the pole
 * @param pixelAngle angular size of one pixel, radians
 * @param waveSlope  {@link windLineWaveSlope}
 */
export function windLineFilter(
  count: number,
  sinTheta: number,
  pixelAngle: number,
  waveSlope: number,
): number {
  const meridian = count / TAU / Math.max(Math.abs(sinTheta), EPS);
  return Math.max(0, pixelAngle) * (meridian + Math.max(0, waveSlope));
}

/**
 * Peak linear radiance a streak is actually DRAWN at — the CPU mirror of the
 * amplitude the node builds, and what the tests use to prove that the pattern
 * converges on the sky instead of aliasing into it as it pinches.
 *
 * The feature whose width is band-limited is the streak's HALF-width, because
 * that is the distance from its centre to its edge — the sharpest thing in the
 * pattern (§V.48: measure the FEATURE, never the repeat).
 */
export function windLinePeakRadiance(
  brightness: number,
  weight: number,
  duty: number,
  filter: number,
): number {
  return brightness * weight * bandLimitEnergy(Math.max(0, duty) / 2, filter);
}

/** angular size of one pixel, radians — the filter width every limit here uses */
export function pixelAngleFor(fovYDegrees: number, heightPx: number): number {
  return (2 * Math.tan(((fovYDegrees * Math.PI) / 180) / 2)) / Math.max(heightPx, 1);
}

/**
 * The streak count actually used — the authored one, forced ODD.
 *
 * `phi` comes from an atan2 and wraps at ±π, which is `u = ±N/2`. With N ODD
 * that is a half-integer, i.e. exactly a CELL WALL: the two sides of the seam
 * are two different legitimate streaks and the pattern is zero at the boundary
 * between them, so nothing straddles the discontinuity. With N EVEN it is an
 * integer — a streak's own CENTRE — and the two sides of the wrap hash to
 * different streams and tear it lengthwise down the sky.
 *
 * Same cure as the starfield's cube seams, which put a cell wall exactly on
 * |u| = 1 for the same reason: tile so nothing crosses the discontinuity,
 * rather than patching the crossing afterwards.
 */
export function oddStreakCount(count: number): number {
  const wanted = Math.max(3, Math.round(finite(count, 49)));
  return wanted % 2 === 0 ? wanted + 1 : wanted;
}

/**
 * Arc between two adjacent streaks at a given distance from the vanishing
 * point. Goes to zero AT the pole — which is the whole claim: the meridians
 * really do converge, rather than being drawn converging.
 */
export function streakArcSpacing(count: number, sinTheta: number): number {
  return (TAU / Math.max(1, count)) * Math.abs(sinTheta);
}

/**
 * §V.55 PHASE ACCUMULATOR. `phi += rate·dt`, wrapped.
 *
 * NOT `time × rate`, and this is the case the invariant is actually about
 * rather than a formality: the drift rate is `windSpeed × driftRate`, and the
 * wind speed is a LIVE value that weather transitions lerp every tick. `t·ω(t)`
 * is a valid phase only while ω is constant; elapsed time multiplies every
 * wobble in the rate, unbounded. §B.30 measured that on the flags — 0.93 Hz
 * intended, 59.5 Hz ten minutes in — and it looks fine on a fresh reload, which
 * is exactly why it survived three passes there.
 *
 * `dt` is clamped as well as finite-guarded: a tab-hidden stall would otherwise
 * teleport the pattern by an arbitrary angle on the first frame back.
 */
export function advanceWindPhase(phase: number, rate: number, dt: number): number {
  const step = Math.max(0, Math.min(0.25, finite(dt))) * finite(rate);
  return wrapTau(finite(phase) + step);
}

/**
 * What the sky needs from the wind each frame.
 *
 * `direction` and `speed` are `SimState.wind` — the LIVE wind that weather
 * transitions write every tick, NOT `oceanParams`' ambient default. `dt` is the
 * frame's own delta, because the drift is a §V.55 phase accumulator and an
 * accumulator needs an increment, not a clock.
 */
export interface WindFrame {
  /** direction the wind blows TOWARD, radians */
  direction: number;
  /** true wind speed, m/s */
  speed: number;
  /** seconds since the last update */
  dt: number;
}

/** everything the node derives for one streak — the CPU half of the pair */
export interface StreakSample {
  /** nearest streak index; its meridian is at phi = index·2π/count */
  index: number;
  /** 0..1 presence-and-brightness, exactly 0 in a calm */
  weight: number;
  /** lateral offset from its own meridian, in spacings */
  offset: number;
  /** 0..1 gust envelope along the streak */
  gust: number;
}

/**
 * CPU transliteration of the node below — the same hashes, the same seeds, the
 * same two detuned waves, the same envelope.
 *
 * DOCUMENTED TRANSLITERATION PAIR, the convention `bandLimit.ts`,
 * `sailShape.ts` and `starfield.ts` already use: a TSL graph cannot be
 * evaluated headless, so the properties that matter (a streak never leaves its
 * own cell, a calm is bare, the pattern dissolves at the pinch, the phases are
 * independent) are proven against this and the two sides move together. f64
 * here against f32 on the GPU, so the values are structurally identical rather
 * than bit-exact.
 */
export function streakForIndex(
  index: number,
  theta: number,
  phases: { wave: number; waveB: number; gust: number },
  p: {
    windLineWaveAmount: number;
    windLineWaveFreq: number;
    windLineGustFreq: number;
    windLineGustDepth: number;
    windLineDensityPower: number;
  },
  gate: number,
): StreakSample {
  const [k1, k2] = waveNumbers(p.windLineWaveFreq);
  const a1 = Math.max(0, finite(p.windLineWaveAmount));
  const a2 = a1 * WAVE_SECOND;
  const hA = hash3Cpu(index + SEED_WAVE_A[0], SEED_WAVE_A[1], SEED_WAVE_A[2]);
  const hB = hash3Cpu(index + SEED_WAVE_B[0], SEED_WAVE_B[1], SEED_WAVE_B[2]);
  const hG = hash3Cpu(index + SEED_GUST[0], SEED_GUST[1], SEED_GUST[2]);
  const hD = hash3Cpu(index + SEED_DENSITY[0], SEED_DENSITY[1], SEED_DENSITY[2]);
  const offset =
    a1 * Math.sin(k1 * theta + phases.wave + hA * TAU) +
    a2 * Math.sin(k2 * theta + phases.waveB + hB * TAU);
  const kg = TAU * Math.max(0, finite(p.windLineGustFreq));
  const s = 0.5 + 0.5 * Math.sin(kg * theta + phases.gust + hG * TAU);
  const depth = Math.min(1, Math.max(0, p.windLineGustDepth));
  return {
    index,
    weight: windLineWeight(hD, gate, p.windLineDensityPower),
    offset,
    gust: 1 - depth + depth * s * s,
  };
}

/** the tint's white end — a plain linear white, no colour-space transfer */
const WHITE = /*@__PURE__*/ new THREE.Color(1, 1, 1);

export function createWindLines(p: SkyParams) {
  /** the direction the wind blows TOWARD — see `windAxis` for which camp */
  const uAxis = uniform(new THREE.Vector3(0, 0, 1));
  /** cross(axis, up): the horizontal vector phi is measured from */
  const uSide = uniform(new THREE.Vector3(1, 0, 0));
  const uCount = uniform(49);
  const uHalfDuty = uniform(p.windLineWidth / 2);
  const uWaveA = uniform(p.windLineWaveAmount);
  const uWaveB = uniform(p.windLineWaveAmount * WAVE_SECOND);
  const uWaveK1 = uniform(TAU * p.windLineWaveFreq);
  const uWaveK2 = uniform(TAU * p.windLineWaveFreq * WAVE_RATIO);
  const uGustK = uniform(TAU * p.windLineGustFreq);
  const uGustDepth = uniform(p.windLineGustDepth);
  const uWaveSlope = uniform(0);
  const uGate = uniform(0);
  const uDensityPower = uniform(p.windLineDensityPower);
  const uHorizonFade = uniform(p.windLineHorizonFade);
  const uTint = uniform(new THREE.Color(1, 1, 1));
  /** authored brightness × the night dim — one factor, bounded at source */
  const uAmp = uniform(0);
  /** §V.55: three independent accumulators, never one scaled three ways */
  const uPhaseWave = uniform(0);
  const uPhaseWaveB = uniform(0);
  const uPhaseGust = uniform(0);

  const phases = { wave: 0, waveB: 0, gust: 0 };

  /**
   * Additive wind-line radiance toward `dir` (a normalized world-space view
   * ray). Exactly 0 at and below the horizon, and ~1e-9 of peak in a calm.
   *
   * NOTE §B1/§V23: functional `mix(a, b, t)` / `smoothstep(lo, hi, x)` ONLY —
   * the chained forms read the RECEIVER as the factor and silently invert.
   */
  const node = Fn(([dir]: [AnyNode]) => {
    // ── 1. the wind frame ───────────────────────────────────────────────
    // theta: angle from the DOWNWIND vanishing point, 0..π, uniform in arc.
    // phi:   azimuth about the wind axis — the streaks' own coordinate.
    // atan(y, x) is three's two-argument form; `atan2` is deprecated (r172).
    const cosT = dir.dot(uAxis).toVar();
    const px = dir.dot(uSide).toVar();
    const py = dir.y.toVar();
    // |d − (d·W)W|, i.e. sin(theta), and never negative
    const sinT = vec2(px, py).length().toVar();
    const theta = atan(sinT, cosT).toVar();
    // §V28: atan2(0, 0) is indeterminate in WGSL, and (px, py) is exactly
    // (0, 0) on the two vanishing points themselves. Nudging both components
    // off the origin makes the call total; the bias it introduces is EPS/sinT
    // in phi, which is unmeasurable everywhere except at the pole, where the
    // energy ratio below is already zero. Belt and braces: a NaN here would
    // survive the multiply by zero and poison the pixel.
    const phi = atan(py.add(EPS), px.add(EPS)).toVar();

    // ── 2. which streak, and where it has wandered to ───────────────────
    // `u` is phi in units of ONE SPACING, so the whole pattern below is
    // scale-free and the duty cycle is what stays constant (see the header).
    const n = uCount.max(1).toVar();
    const u = phi.mul(n).div(TAU).toVar(); // (−N/2, N/2]
    // ONE streak is examined, never a neighbourhood — legal because
    // WIND_LINE_CLEARANCE keeps a streak inside its own cell.
    const idx = u.add(0.5).floor().toVar();
    // THE COUNT IS ODD (see update()), so the ±π seam of `phi` lands exactly on
    // a CELL WALL rather than on a streak: the two sides of the seam are two
    // different, legitimate streaks and the pattern is zero at the boundary
    // between them. Same argument as the starfield's cube seams — tile so that
    // nothing straddles the discontinuity, rather than patching it afterwards.
    const hA = hash3(vec3(idx, 0, 0).add(vec3(...SEED_WAVE_A))).toVar();
    const hB = hash3(vec3(idx, 0, 0).add(vec3(...SEED_WAVE_B))).toVar();
    const hG = hash3(vec3(idx, 0, 0).add(vec3(...SEED_GUST))).toVar();
    const hD = hash3(vec3(idx, 0, 0).add(vec3(...SEED_DENSITY))).toVar();

    // ── 3. the undulation (§B.4, §V.55) ─────────────────────────────────
    // Two detuned waves, each with its OWN accumulated phase and its OWN
    // per-streak hashed offset. The offsets are what stop the whole sky
    // rippling on one beat, which is §B.4 exactly; the separate accumulators
    // are §V.55's clause about detuned harmonics — a wrapped phase multiplied
    // by a non-integer ratio breaks continuity at every wrap.
    //
    // A crest sits where k·theta + phase is constant, so an INCREASING phase
    // moves it toward theta = 0: the features travel to the downwind
    // vanishing point, which is the way the air is going.
    const wave = uWaveA
      .mul(theta.mul(uWaveK1).add(uPhaseWave).add(hA.mul(TAU)).sin())
      .add(uWaveB.mul(theta.mul(uWaveK2).add(uPhaseWaveB).add(hB.mul(TAU)).sin()))
      .toVar();

    // ── 4. the drawn band (§V.48, both halves) ──────────────────────────
    // Distance to THIS streak's wavy centre line, in spacings.
    const dist = u.sub(idx).sub(wave).abs().toVar();
    // The analytic footprint — see the header for why this is not fwidth(phi).
    // The pixel angle is max-of-two-lengths rather than |∂x|+|∂y| for the
    // reason starfield.ts records: the view ray's derivative IS the angular
    // size of a pixel, and that is a LENGTH, so summing the two axes
    // over-estimates it by ~2x.
    const pixelAngle = dir.dFdx().length().max(dir.dFdy().length()).max(EPS).toVar();
    const filter = pixelAngle
      .mul(n.div(TAU).div(sinT.max(EPS)).add(uWaveSlope))
      .toVar();
    // (a) widen to the sample grid, (b) fade to the feature's own mean. The
    // mean of a streak over a pixel that can no longer resolve it IS the sky
    // behind it, so fading the amplitude to zero is fading to the mean —
    // the same argument the sail's antisymmetric seam ridge makes.
    const drawn = bandLimitWidth(uHalfDuty, dir, filter).toVar();
    const energy = bandLimitAmplitude(uHalfDuty, dir, filter).toVar();
    const profile = smoothstep(0, drawn, dist).oneMinus();

    // ── 5. gusts along the streak ───────────────────────────────────────
    // Squared so the lulls are broad and the bright runs narrow, which is what
    // makes a streak read as a gust of air rather than as a painted rail. A
    // smooth per-period term with no edge in it, so §V.48 wants no gate here
    // beyond the one the band above already applies to the whole feature.
    const g = uGustK.mul(theta).add(uPhaseGust).add(hG.mul(TAU)).sin().mul(0.5).add(0.5).toVar();
    const gust = mix(uGustDepth.oneMinus(), float(1), g.mul(g));

    // ── 6. presence, horizon, and the additive result ───────────────────
    // The density gate: ~1e-9 of peak below the onset wind, so a calm is bare.
    // `hD + EPS` rather than `hD`, and it is load-bearing: at gate 0 the
    // divisor is floored to EPS, and a streak whose hash came out EXACTLY 0
    // would then read 1 − 0/EPS = 1 and burn at full brightness in a dead
    // calm. Flooring a divisor bounds the division, not the quotient (§V44's
    // corollary); nudging the NUMERATOR is what actually closes the hole.
    const weight = hD
      .add(EPS)
      .div(uGate.max(EPS))
      .oneMinus()
      .max(EPS) // §V28: pow(0, k) is NaN on some drivers; EPS^k underflows to 0
      .pow(uDensityPower.max(EPS))
      .toVar();

    // A ramp `windLineHorizonFade` tall, deliberately much shallower than the
    // starfield's: the vanishing point sits ON the horizon and is the most
    // legible part of the bearing read, so it must not be faded away. The
    // §V.48b dissolve above is what softens the pinch instead.
    // @band-limited-elsewhere: 1.7° at the shipped value — ~31 px at 1080p and
    // ~21 px at 720p. It cannot go sub-pixel at any resolution we run at.
    const horizon = smoothstep(0, uHorizonFade.max(EPS), dir.y);

    // §V44 bounded at source: profile, gust, horizon and weight are all 0..1 by
    // construction, energy is a clamped ratio, and the only unbounded factor is
    // the authored brightness itself.
    const amp = uAmp
      .mul(weight)
      .mul(energy)
      .mul(profile)
      .mul(gust)
      .mul(horizon);
    return vec3(uTint).mul(amp);
  });

  return {
    node: (dir: AnyNode): AnyNode => node(dir),
    /**
     * @param key   the resolved key light — `nightFactor` is read for the night
     *              dim, because it is THE single "how dark is it" clock (§V.33)
     *              and a second dusk derived here would drift from it.
     * @param wind  the LIVE wind — `state.wind`, which weather transitions
     *              write every tick, NOT `oceanParams`' ambient default. The
     *              sails, flags, AI, palms, spray and cannon smoke all read the
     *              live one; reading the default would drift the sky against
     *              the flags the player is looking at, which is precisely the
     *              tell this feature exists to provide.
     * @param haze  this frame's resolved horizon haze colour, so the streaks
     *              sit in the day's grade instead of staying chalk-white at
     *              sunset (§T.39 — one weight moves everything). Passed in
     *              rather than re-resolved: a second palette lookup here would
     *              drift from the sky's the moment either is tuned.
     */
    update(key: KeyLight, wind: WindFrame, haze: THREE.Color): void {
      const { axis, side } = windAxis(wind.direction);
      uAxis.value.set(axis[0], axis[1], axis[2]);
      uSide.value.set(side[0], side[1], side[2]);

      // THE COUNT MUST BE ODD — see `oddStreakCount`. Forced here rather than
      // in the panel so a drag through the even values simply steps.
      uCount.value = oddStreakCount(p.windLineCount);

      const duty = Math.max(0, finite(p.windLineWidth));
      uHalfDuty.value = duty / 2;
      const waveAmount = Math.max(0, finite(p.windLineWaveAmount));
      const [k1, k2] = waveNumbers(p.windLineWaveFreq);
      uWaveA.value = waveAmount;
      uWaveB.value = waveAmount * WAVE_SECOND;
      uWaveK1.value = k1;
      uWaveK2.value = k2;
      uWaveSlope.value = windLineWaveSlope(waveAmount, p.windLineWaveFreq);
      uGustK.value = TAU * Math.max(0, finite(p.windLineGustFreq));
      uGustDepth.value = Math.min(1, Math.max(0, finite(p.windLineGustDepth)));
      uDensityPower.value = Math.max(EPS, finite(p.windLineDensityPower, 1));
      uHorizonFade.value = Math.max(EPS, finite(p.windLineHorizonFade, 0.03));

      const speed = Math.max(0, finite(wind.speed));
      uGate.value = windLineGate(speed, p.windLineOnset, p.windLineFull);

      // §V.55: three accumulators, each advanced at its OWN wavenumber so all
      // three families of feature travel down the streak at the same ANGULAR
      // speed — `windSpeed × windLineDriftRate` radians of theta per second.
      // Deriving the second and third by scaling the first would break
      // continuity at every wrap, which is the clause of the invariant that
      // exists because we already shipped that bug once.
      const drift = speed * Math.max(0, finite(p.windLineDriftRate));
      phases.wave = advanceWindPhase(phases.wave, k1 * drift, wind.dt);
      phases.waveB = advanceWindPhase(phases.waveB, k2 * drift, wind.dt);
      phases.gust = advanceWindPhase(phases.gust, uGustK.value * drift, wind.dt);
      uPhaseWave.value = phases.wave;
      uPhaseWaveB.value = phases.waveB;
      uPhaseGust.value = phases.gust;

      // Tint: the live haze colour lifted toward white. Both are already in the
      // linear working space, so this is a straight lerp — feeding sRGB numbers
      // into it is §B9, the white wash.
      const white = Math.min(1, Math.max(0, finite(p.windLineWhiteness)));
      uTint.value.copy(haze).lerp(WHITE, white);

      // Wind lines are LIT AIR. After dark there is almost nothing lighting
      // them, so they fall away to a trace rather than glowing on as white
      // scratches over a night sky.
      const night = Math.min(1, Math.max(0, finite(key.nightFactor)));
      const dim = Math.min(1, Math.max(0, finite(p.windLineNightDim)));
      uAmp.value = Math.max(0, finite(p.windLineBrightness)) * (1 - night * (1 - dim));
    },
  };
}

export type WindLines = ReturnType<typeof createWindLines>;
