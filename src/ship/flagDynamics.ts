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
}

/**
 * Damp a flag toward the live apparent wind. The root chases at the full
 * response rate and the tip at a third of it, so a course change travels out
 * along the cloth as a visible crack rather than rotating the whole flag at
 * once. Wrap-safe: stepping through the ±π branch by shortest angle is what
 * stops a flag spinning the long way round when the ship crosses due south.
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
  return {
    root,
    // the tip chases the ROOT, not the wind: that is what makes the lag
    // travel outward along the cloth instead of both ends turning together
    tip: finite(state.tip) + angleDelta(state.tip, root) * kTip,
    strength: clamp(
      finite(state.strength) + (clamp(finite(targetStrength), 0, 1) - finite(state.strength)) * kStrength,
      0,
      1,
    ),
  };
}

/** 0..1 stream factor from apparent wind speed — 1 = board stiff */
export function streamStrength(speed: number, p: ShipFlagParams): number {
  return clamp(finite(speed) / Math.max(0.5, p.flagStreamRef), 0, 1);
}
