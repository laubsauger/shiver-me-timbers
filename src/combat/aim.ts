/**
 * PLAYER GUN LAY (§T.16 "aim") — the elevation the player's broadside is set
 * to, and the point on the sea that lay puts the shot on.
 *
 * WHY THIS FILE EXISTS AT ALL. `combatRuntime.layGuns` auto-lays every fire
 * order that carries no explicit elevation, for the NEAREST OTHER SHIP. That
 * is right for the AI and wrong for the player: her order never carried an
 * elevation, so her guns were laid for the enemy galleon 1014 m off — past the
 * 133.6 m a 60 m/s ball can reach — and `elevationForRange` returned the
 * `maxElevation` clamp on every shot. MEASURED in the browser, through the
 * real runtime: muzzle direction y = 0.570, i.e. 34.8° above horizontal, apex
 * 36.1 m, splash 137.8 m away, on every gun of the broadside. That is the
 * user's report ("shooting just like super high in the sky") in numbers. The
 * launch math itself is sound — the same path fed 0.06/0.2/0.4 rad puts the
 * ball down at 64/95/127 m with apexes of 3.4/8.9/21.2 m.
 *
 * So the player's order must ALWAYS carry an elevation, and this is where it
 * comes from. Auto-lay keeps the AI.
 *
 * §V.2/§V.3: pure. No DOM, no three.js, no randomness — the aim is a number
 * and a projection of the sim's own integrator, so a test can hold it and the
 * reticle and the shot cannot disagree about where the ball goes.
 */
import type { Quat, Vec3 } from '../state/simState';
import { combatParams, type CombatParams } from '../params/combat';
import { shotRange } from './ballistics';
import type { BroadsideSide } from './battery';
import { add, rotateVec } from '../core/quat';

/** the player's gun lay: one number, clamped to what the carriages allow */
export interface Aim {
  /** rad above horizontal, always inside [minElevation, maxElevation] */
  elevation(): number;
  /** move the lay by `delta` rad (mouse/keys); returns the clamped result */
  adjust(delta: number): number;
  /** set the lay outright; returns the clamped result */
  set(elevation: number): number;
  /** 0 at full depression, 1 at full elevation — for a HUD gauge */
  fraction(): number;
}

export function createAim(params: CombatParams = combatParams): Aim {
  let elevation = clampElevation(params.defaultElevation, params);
  const set = (value: number): number => {
    elevation = clampElevation(value, params);
    return elevation;
  };
  return {
    elevation: () => elevation,
    adjust: (delta) => set(elevation + (Number.isFinite(delta) ? delta : 0)),
    set,
    fraction: () => {
      const lo = Math.min(params.minElevation, params.maxElevation);
      const hi = Math.max(params.minElevation, params.maxElevation);
      return hi - lo < 1e-9 ? 0 : (elevation - lo) / (hi - lo);
    },
  };
}

/** the carriages' own limits — a lay outside them is not a lay the guns have */
export function clampElevation(value: number, params: CombatParams = combatParams): number {
  const lo = Math.min(params.minElevation, params.maxElevation);
  const hi = Math.max(params.minElevation, params.maxElevation);
  if (!Number.isFinite(value)) return lo;
  return Math.min(hi, Math.max(lo, value));
}

/** where one gun's muzzle is and which way it points, in WORLD space */
export interface MuzzleLay {
  position: Vec3;
  /** unit vector; its y is the elevation the ball actually leaves at */
  direction: Vec3;
}

/**
 * The muzzle station and firing direction for `side` at `elevation`, built the
 * SAME way `fireCannon` builds it (ship-local outboard ±x, pitched up, then
 * rotated by the hull's live quaternion) minus the per-shot spread.
 *
 * The hull's attitude is read LIVE, not captured: she heels and pitches under
 * the guns, so the direction's y is the barrel's lay PLUS her heel at that
 * instant — which is exactly why the reticle has to be recomputed every frame
 * rather than once at setup (§V.62's shape, and the defect a sibling agent is
 * chasing in the sailing code).
 */
export function muzzleLay(
  position: Vec3,
  quaternion: Quat,
  mountOffset: Vec3,
  side: BroadsideSide,
  elevation: number,
  params: CombatParams = combatParams,
): MuzzleLay {
  const sign = side === 'starboard' ? 1 : -1;
  const ce = Math.cos(elevation);
  const dirLocal: Vec3 = [sign * ce, Math.sin(elevation), 0];
  const muzzleLocal: Vec3 = [
    mountOffset[0] + dirLocal[0] * params.muzzleForward,
    mountOffset[1] + dirLocal[1] * params.muzzleForward,
    mountOffset[2] + dirLocal[2] * params.muzzleForward,
  ];
  return {
    position: add(position, rotateVec(quaternion, muzzleLocal)),
    direction: rotateVec(quaternion, dirLocal),
  };
}

export interface AimPrediction {
  /** world point on the sea the shot falls on */
  point: Vec3;
  /** horizontal metres from the muzzle to that point */
  range: number;
}

/**
 * Where a ball leaving `lay` comes down, on a sea at `seaHeight`.
 *
 * Runs `ballistics.shotRange`, which is the sim's OWN integrator at the sim
 * step including quadratic drag — not a textbook parabola, which disagrees by
 * 40% at these numbers. The reticle therefore cannot drift from the shot: if
 * one is wrong they are wrong together, and the splash proves it either way.
 *
 * Returns null when the muzzle points at or above the horizon with no way
 * down (it cannot, inside the clamp) or when the direction is degenerate —
 * a null is drawn as "no solution" rather than as a crosshair on the horizon.
 */
export function predictImpact(
  lay: MuzzleLay,
  seaHeight = 0,
  params: CombatParams = combatParams,
): AimPrediction | null {
  const [dx, dy, dz] = lay.direction;
  const horiz = Math.hypot(dx, dz);
  if (!(horiz > 1e-6) || !Number.isFinite(dy)) return null;
  const elevation = Math.atan2(dy, horiz);
  const height = lay.position[1] - (Number.isFinite(seaHeight) ? seaHeight : 0);
  const range = shotRange(elevation, Math.max(0, height), params);
  if (!Number.isFinite(range) || range <= 0) return null;
  return {
    point: [
      lay.position[0] + (dx / horiz) * range,
      Number.isFinite(seaHeight) ? seaHeight : 0,
      lay.position[2] + (dz / horiz) * range,
    ],
    range,
  };
}
