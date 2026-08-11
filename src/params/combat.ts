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
  },
  {
    muzzleVelocity: { min: 10, max: 150, step: 1 },
    gravity: { min: 0, max: 20, step: 0.1 },
    drag: { min: 0, max: 0.05, step: 0.001 },
    maxAge: { min: 1, max: 30, step: 0.5 },
    spreadAngle: { min: 0, max: 0.2, step: 0.001 },
    reloadTime: { min: 0.5, max: 10, step: 0.1 },
  },
);
