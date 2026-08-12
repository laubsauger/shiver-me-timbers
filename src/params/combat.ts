/**
 * Cannon combat tunables (§V.16): every value registers with the params
 * registry so the debug panel auto-binds it. Sim code reads these live
 * objects; the panel mutates them in place.
 */
import { registerParams } from './registry';

export interface CombatParams {
  muzzleVelocity: number; // m/s at the muzzle
  gravity: number; // m/s², applied downward (positive value)
  drag: number; // quadratic drag coefficient, 1/m
  maxAge: number; // s before an airborne projectile expires
  spreadAngle: number; // radians, default aim jitter half-angle
  reloadTime: number; // s between shots per cannon (consumed by input/AI)
  /**
   * m — cannonball collision radius. Hit targets are the piece AABB grown
   * by this (Minkowski sum of the ball with the box), so a ball that grazes
   * a mast still strikes it. Without it a 0.3 m mast is a needle that a
   * spread-limited broadside effectively never hits, and §V14's mast break
   * becomes unreachable in play while every unit test still passes.
   */
  ballRadius: number;
  /** m — cannon-mount socket → muzzle along the barrel, so the ball leaves
   *  the gun's mouth instead of appearing inside the bulwark */
  muzzleForward: number;
  /** rad — barrel elevation used when the caller supplies no aim pitch */
  defaultElevation: number;
  /** rad — aim pitch clamp (guns cannot depress below/elevate above these) */
  minElevation: number;
  maxElevation: number;
  /** s between neighbouring guns of one broadside — the rolling ripple */
  rippleDelay: number;
}

export const combatParams: CombatParams = registerParams(
  'combat',
  {
    muzzleVelocity: 60,
    gravity: 9.81,
    drag: 0.008,
    maxAge: 12,
    spreadAngle: 0.015,
    reloadTime: 3,
    ballRadius: 0.4,
    muzzleForward: 1.4,
    defaultElevation: 0.06,
    minElevation: -0.12,
    maxElevation: 0.6,
    rippleDelay: 0.08,
  },
  {
    muzzleVelocity: { min: 10, max: 150, step: 1 },
    gravity: { min: 0, max: 20, step: 0.1 },
    drag: { min: 0, max: 0.05, step: 0.001 },
    maxAge: { min: 1, max: 30, step: 0.5 },
    spreadAngle: { min: 0, max: 0.2, step: 0.001 },
    reloadTime: { min: 0.5, max: 10, step: 0.1 },
    ballRadius: { min: 0, max: 2, step: 0.05 },
    muzzleForward: { min: 0, max: 4, step: 0.1 },
    defaultElevation: { min: -0.2, max: 0.8, step: 0.01 },
    minElevation: { min: -0.5, max: 0, step: 0.01 },
    maxElevation: { min: 0.1, max: 1.2, step: 0.01 },
    rippleDelay: { min: 0, max: 0.5, step: 0.01 },
  },
);

/**
 * Combat fx tunables (§V.16) — the visible half of §T.16/§V.14: muzzle
 * flash and smoke, splinter bursts at a breach, the pillar where a ball
 * pitches into the sea, and the balls themselves.
 *
 * Registered as its own panel group because these are look knobs, tuned
 * against footage, while the group above is ballistics that changes how the
 * game plays.
 */
export interface CombatFxParams {
  /** sprite pool size — sanitized to an int at construction (§V.28) */
  particleCount: number;
  /** cannonballs drawn at once; SimState may hold fewer */
  ballCount: number;
  /** m — rendered radius of a ball (its collision radius is ballRadius) */
  ballDrawRadius: number;
  flashLife: number;
  flashSize: number;
  smokeLife: number;
  smokeSize: number;
  smokeGrowth: number; // × sizeStart at death
  smokeSpeed: number;
  splinterLife: number;
  splinterSize: number;
  splinterSpeed: number;
  splashLife: number;
  splashSize: number;
  splashSpeed: number;
  /** particles per muzzle / breach / water-entry event */
  smokePerShot: number;
  splintersPerBreach: number;
  splashPerHit: number;
  /** overall additive brightness */
  intensity: number;
  /** rad/s — tumble of a detached mast on the way down (§V.14) */
  wreckTumble: number;
  /** m/s — settle rate once the spar is in the water (it stops falling) */
  wreckSinkSpeed: number;
  /** m below the LIVE surface at which wreckage is removed from the scene */
  wreckSinkDepth: number;
}

export const combatFxParams: CombatFxParams = registerParams(
  'combatFx',
  {
    particleCount: 768,
    ballCount: 64,
    ballDrawRadius: 0.16,
    flashLife: 0.09,
    flashSize: 2.2,
    smokeLife: 2.4,
    smokeSize: 1.1,
    smokeGrowth: 4.5,
    smokeSpeed: 7,
    splinterLife: 1.1,
    splinterSize: 0.28,
    splinterSpeed: 9,
    splashLife: 1.0,
    splashSize: 1.4,
    splashSpeed: 6,
    smokePerShot: 14,
    splintersPerBreach: 18,
    splashPerHit: 10,
    intensity: 1,
    wreckTumble: 0.7,
    wreckSinkSpeed: 1.2,
    wreckSinkDepth: 12,
  },
  {
    particleCount: { min: 64, max: 4096, step: 64 },
    ballCount: { min: 8, max: 256, step: 8 },
    ballDrawRadius: { min: 0.05, max: 0.6, step: 0.01 },
    flashLife: { min: 0.02, max: 0.4, step: 0.01 },
    flashSize: { min: 0.2, max: 6, step: 0.1 },
    smokeLife: { min: 0.2, max: 8, step: 0.1 },
    smokeSize: { min: 0.1, max: 4, step: 0.05 },
    smokeGrowth: { min: 1, max: 12, step: 0.1 },
    smokeSpeed: { min: 0, max: 30, step: 0.5 },
    splinterLife: { min: 0.1, max: 4, step: 0.05 },
    splinterSize: { min: 0.05, max: 1, step: 0.01 },
    splinterSpeed: { min: 0, max: 30, step: 0.5 },
    splashLife: { min: 0.1, max: 4, step: 0.05 },
    splashSize: { min: 0.1, max: 5, step: 0.1 },
    splashSpeed: { min: 0, max: 30, step: 0.5 },
    smokePerShot: { min: 0, max: 64, step: 1 },
    splintersPerBreach: { min: 0, max: 64, step: 1 },
    splashPerHit: { min: 0, max: 64, step: 1 },
    intensity: { min: 0, max: 3, step: 0.05 },
    wreckTumble: { min: 0, max: 4, step: 0.05 },
    wreckSinkSpeed: { min: 0.1, max: 10, step: 0.1 },
    wreckSinkDepth: { min: 2, max: 40, step: 1 },
  },
);
