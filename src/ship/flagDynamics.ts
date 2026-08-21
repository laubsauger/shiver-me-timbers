/**
 * Flag / pennant wind response — pure, testable, no three.js (§V3: reads the
 * wind params the sim reads and the ship's own render transform; writes
 * nothing back).
 *
 * WHY A FLAG IS NOT AN ORNAMENT. A masthead pennant is the oldest wind
 * instrument there is: it points where the APPARENT wind goes, so a glance at
 * the truck tells you the wind angle relative to your heading — the single
 * number a sailing game is built on and the one this game showed nowhere.
 * Apparent, not true, is the whole point: true wind alone gives a flag that
 * ignores the helm, and the request was for something that "gives more
 * dynamic feeling to the wind and the motion direction that we're going in
 * relative to the wind". Run downwind at speed and the apparent wind dies and
 * the flag droops; come about and it swings across, and the tip lags the root
 * so the cloth whips instead of rotating like a signpost.
 *
 * Convention matches sailDynamics.ts and src/sailing: `windDirection` is the
 * direction the wind blows TOWARD, +z is ship forward.
 *
 * §V28: every output is finite-guarded — these feed shader uniforms directly.
 */
import type { ShipFlagParams } from '../params/ship';

const TAU = Math.PI * 2;

function finite(x: number, fallback = 0): number {
  return Number.isFinite(x) ? x : fallback;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export interface ApparentWindInput {
  /** direction the TRUE wind blows toward (rad) and its speed (m/s) */
  windDirection: number;
  windSpeed: number;
  /** the ship's own world velocity (m/s) */
  shipVelX: number;
  shipVelZ: number;
}

export interface ApparentWind {
  /** unit-ish direction the apparent wind blows toward */
  x: number;
  z: number;
  speed: number;
}

/**
 * Apparent wind = true wind minus the ship's own velocity. The vector a flag
 * on deck actually feels: a ship running dead downwind at 6 m/s in a 7 m/s
 * breeze feels 1 m/s and its pennant falls slack, which is exactly the cue a
 * helmsman uses to know he is sailing by the lee.
 */
export function apparentWind(input: ApparentWindInput): ApparentWind {
  const dir = finite(input.windDirection);
  const speed = Math.max(0, finite(input.windSpeed));
  const x = Math.sin(dir) * speed - finite(input.shipVelX);
  const z = Math.cos(dir) * speed - finite(input.shipVelZ);
  const mag = Math.hypot(x, z);
  if (mag < 1e-4) return { x: 0, z: 1, speed: 0 }; // §V28 floored divisor
  return { x: x / mag, z: z / mag, speed: mag };
}

/** fold an angle into (−π, π] — keeps the value a shader trig call sees small */
export function wrapAngle(a: number): number {
  let x = finite(a) % TAU;
  if (x > Math.PI) x -= TAU;
  else if (x <= -Math.PI) x += TAU;
  return x;
}

/** signed shortest difference a → b, in (−π, π] */
export function angleDelta(a: number, b: number): number {
  let d = (finite(b) - finite(a)) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d < -Math.PI) d += TAU;
  return d;
}

export interface FlagState {
  /** angle the cloth leaves the staff at (rad, in the flag's local frame) */
  root: number;
  /** angle the FLY TIP is trailing at — lags the root, which is the whip */
  tip: number;
  /** 0..1 how hard it is streaming */
  strength: number;
  /** this flag's own gust phase — see gustModulation */
  phase: number;
  /** ∫ waveRate dt, wrapped — see the note on advanceFlag */
  wavePhase: number;
  /** ∫ waveRate·CRACK_RATIO dt, wrapped independently */
  crackPhase: number;
}

/**
 * The crack rides at a deliberately IRRATIONAL-ish multiple of the main
 * ripple so the two never lock into one obvious period (§B.4). Exported
 * because flagMaterial.ts needs the same number for the crack's SPATIAL
 * frequency — the constant is shared, never copied.
 */
export const FLAG_CRACK_RATIO = 2.3;

/**
 * CPU mirror of the cloth ripple's phase in flagMaterial.ts `clothAt`:
 * ωt − k·u, with k = waveCount·2π along the fly. The MINUS is the direction
 * of travel (§B76): ∂φ/∂t > 0 and ∂φ/∂u < 0 put the crest velocity
 * −(∂φ/∂t)/(∂φ/∂u) > 0, i.e. from the hoist (u = 0) to the fly (u = 1).
 */
export function flagRipplePhase(u: number, wavePhase: number, waveCount: number): number {
  return finite(wavePhase) - clamp(finite(u), 0, 1) * Math.max(0, finite(waveCount)) * TAU;
}

/** the ripple's amplitude envelope along the fly — 0 at the hoist, 1 at the fly */
export function flagRippleGrow(u: number): number {
  const x = clamp(finite(u), 0, 1);
  return x * 0.4 + x * x * 0.6;
}

/** ripple rate (rad/s) at a given stream strength — bounded by construction */
export function flagWaveRate(strength: number, p: ShipFlagParams): number {
  return Math.max(0, finite(p.flagWaveFreq)) * (0.35 + clamp(finite(strength), 0, 1));
}

/** fold into [0, 2π) — keeps an accumulator's float precision constant forever */
function wrapTau(x: number): number {
  const v = finite(x) % TAU;
  return v < 0 ? v + TAU : v;
}

/**
 * Lull-and-gust breathing, 0.7 … 1.3 ish. Two detuned sines, never a single
 * period, so the cloth never settles into an obvious loop.
 *
 * `phase` MUST differ per flag. §B.4 is the standing lesson here: the ocean's
 * sparkle shared one time phase across every cell and the whole sea flashed in
 * unison on a 3 s cycle. Three flags on one ship breathing in step would read
 * the same way — as one animation playing, rather than as three pieces of
 * cloth in the same air.
 */
export function gustModulation(time: number, phase: number): number {
  const t = finite(time);
  const p = finite(phase);
  const g = 0.5 * Math.sin(t * 0.9 + p) + 0.5 * Math.sin(t * 1.47 + p * 1.7 + 1.3);
  return 1 + 0.3 * g;
}

/**
 * Damp a flag toward the live apparent wind. The root chases at the full
 * response rate and the tip at a third of it, so a course change travels out
 * along the cloth as a visible crack rather than rotating the whole flag at
 * once. Wrap-safe: stepping through the ±π branch by shortest angle is what
 * stops a flag spinning the long way round when the ship crosses due south.
 *
 * IT ALSO INTEGRATES THE RIPPLE PHASE, and that is the whole of the user's
 * "super super twitchy, super ultra high frequency… like they're in 1000
 * kilometre an hour wind".
 *
 * The shader used to compute its carrier as `time × rate`, with `rate` a
 * function of the live stream strength. That is only the phase of a sine if
 * the rate is CONSTANT. When it varies, the instantaneous frequency of
 * sin(t·ω(t)) is ω + t·dω/dt — and the second term grows without bound as the
 * app runs, because the elapsed time multiplies every wobble in ω. Measured on
 * the default 11 m/s wind, against an intended 0.93 Hz flap:
 *
 *     t = 15 s → 2.2 Hz    t = 60 s → 5.8 Hz
 *     t = 120 s → 13.4 Hz  t = 600 s → 59.5 Hz  (crack term: 137 Hz)
 *
 * It also goes NEGATIVE, so the ripple reverses direction at random. Nothing
 * about it is bounded, and it gets worse the longer you play — which is why a
 * quick look after a reload would never show it.
 *
 * The frequency was never the problem; the missing integral was. A phase is
 * ∫ω dt, so it is accumulated here, per flag, and wrapped so the accumulator
 * keeps full float precision forever (the same reasoning that already wraps
 * `root` — see FlagWindUniforms.lagAngle).
 */
export function advanceFlag(
  state: FlagState,
  targetAngle: number,
  targetStrength: number,
  dt: number,
  p: ShipFlagParams,
): FlagState {
  const step = clamp(finite(dt), 1 / 1000, 0.25); // §V28
  const rate = Math.max(0.2, p.flagResponse);
  const kRoot = 1 - Math.exp(-rate * step);
  const kTip = 1 - Math.exp(-rate * 0.34 * step);
  const kStrength = 1 - Math.exp(-rate * 0.6 * step);
  const root = finite(state.root) + angleDelta(state.root, targetAngle) * kRoot;
  const strength = clamp(
    finite(state.strength) + (clamp(finite(targetStrength), 0, 1) - finite(state.strength)) * kStrength,
    0,
    1,
  );
  // integrated at the rate the cloth is ACTUALLY flapping this instant, so a
  // flag that stiffens ripples faster from here on rather than retroactively
  const wave = flagWaveRate(strength, p);
  return {
    root,
    // the tip chases the ROOT, not the wind: that is what makes the lag
    // travel outward along the cloth instead of both ends turning together
    tip: finite(state.tip) + angleDelta(state.tip, root) * kTip,
    strength,
    phase: finite(state.phase),
    wavePhase: wrapTau(finite(state.wavePhase) + wave * step),
    // its own accumulator rather than 2.3 × the other one: multiplying a value
    // that has been wrapped at 2π by a non-integer breaks continuity at every
    // wrap, and the detune is the point (§B.4)
    crackPhase: wrapTau(finite(state.crackPhase) + wave * FLAG_CRACK_RATIO * step),
  };
}

/**
 * 0..1 stream factor from apparent wind speed — 1 = board stiff.
 *
 * MEASURED BUG (user: "the flags don't seem to be modulated by the movement
 * speed, wind speed, or the accumulation of both ... even when we're
 * stationary, very much flying hard"): `flagStreamRef` was 7 m/s while the
 * default wind is 11 m/s, so this clamped to 1 in every normal condition and
 * the telltale carried no information at all. The reference must sit ABOVE the
 * usual wind, not below it — the same class of mistake §V36 is about, a
 * threshold whose meaning drifted away from the range it gates.
 */
export function streamStrength(speed: number, p: ShipFlagParams): number {
  return clamp(finite(speed) / Math.max(0.5, p.flagStreamRef), 0, 1);
}
