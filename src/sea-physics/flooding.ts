/**
 * Flooding + sink sequence (T18, §V14): holes below the waterline flood
 * the ship — deeper holes flood faster (hydrostatic head) — while crew
 * pumps drain at a constant rate, so single early hits are recoverable
 * and a riddled hull is doomed. Past sinkThreshold the sequence is
 * one-way: buoyancy support fades 1→0 as flood climbs to 1 (derived from
 * ship.flood alone — ShipState untouched structurally, §V2 plain data).
 * Pure sim math, no three.js (§V3); consumes destruction.floodingHoles.
 *
 * Hole frame: ship-origin-relative, world-rotated positions (what
 * `floodingHoles(blueprint, damageStates, ship.quaternion, 0).positions`
 * yields with waterlineY = 0) — the same ship-local waterline plane y=0
 * the buoyancy probe layout uses (§V8). y < 0 ⇒ submerged, depth = −y.
 *
 * Integration hooks (one line each, NOT applied here):
 * - main.ts sim tick, before stepShipBuoyancy:
 *     stepFlooding(playerShip, floodingHoles(blueprint, zoneStates, playerShip.quaternion, 0).positions, dt);
 * - buoyancy.ts stepShipBuoyancy — flooded ship is heavier (rides lower):
 *     use `const m = p.mass * floodMassFactor(ship.flood);` in place of
 *     p.mass (gravity force line 86, velocity integration lines 111–113);
 * - buoyancy.ts probe spring — sinking support fade (line 102):
 *     const f = (p.buoyancySpring * depth - p.buoyancyDamping * vy) * buoyancyScale(ship);
 * - buoyancy.ts (or main.ts) — list/trim toward the flooded side: add
 *     floodListTorque(ship, holes, ship.flood) into the world-space torque
 *     accumulator after the probe loop (before the inertia step).
 */
import type { ShipState, Vec3 } from '../state/simState';
import { floodingParams, type FloodingParams } from '../params/flooding';

/**
 * One hole position from destruction.FloodingHoles.positions (structurally
 * identical Vec3 tuple, ship-oriented space — see frame note in header).
 */
export type FloodingHole = Vec3;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Σ per-submerged-hole ingress, deeper holes flooding faster (§V14). */
function ingressRate(holes: readonly FloodingHole[], p: FloodingParams): number {
  let rate = 0;
  for (const hole of holes) {
    const depth = -hole[1]; // waterline plane is y=0 in the hole frame
    if (depth <= 0) continue; // hole above waterline takes no water
    rate += p.ingressRatePerHole * (1 + p.depthFactor * depth);
  }
  return rate;
}

/**
 * One fixed-dt flooding step, mutating ship.flood in place (sim-owned,
 * §V3). Below sinkThreshold pumps fight ingress and flood clamps to
 * [0,1]; at/past it the ship is sinking and flood only rises — at least
 * fast enough to reach 1 within sinkDuration (§V14 sink sequence).
 */
export function stepFlooding(
  ship: ShipState,
  holes: readonly FloodingHole[],
  dt: number,
  p: FloodingParams = floodingParams,
): void {
  const net = ingressRate(holes, p) - p.pumpRate;
  if (ship.flood >= p.sinkThreshold) {
    // pumps overwhelmed: one-way ramp completing in ≤ sinkDuration
    const sinkRate = (1 - p.sinkThreshold) / p.sinkDuration;
    ship.flood = Math.min(1, ship.flood + Math.max(net, sinkRate) * dt);
  } else {
    ship.flood = clamp01(ship.flood + net * dt);
  }
}

/**
 * Effective-mass multiplier for buoyancy (§V8 hook, see header): shipped
 * water adds up to `massGain` of the dry mass, so a flooded hull rides
 * lower and answers the helm sluggishly without touching buoyancy params.
 */
export function floodMassFactor(
  flood: number,
  p: FloodingParams = floodingParams,
): number {
  return 1 + p.massGain * clamp01(flood);
}

/**
 * List/trim torque (world frame, N·m): flood water pools at the flooded
 * holes' mean offset, shifting the center of mass there; gravity acting on
 * that offset yields the couple r̄ × (−ŷ) scaled by flood × listStrength.
 * Fades with buoyancyScale — once support is gone the couple is spent.
 */
export function floodListTorque(
  ship: ShipState,
  holes: readonly FloodingHole[],
  flood: number,
  p: FloodingParams = floodingParams,
): Vec3 {
  let mx = 0;
  let mz = 0;
  let n = 0;
  for (const hole of holes) {
    if (hole[1] >= 0) continue; // dry holes hold no water
    mx += hole[0];
    mz += hole[2];
    n++;
  }
  if (n === 0 || flood <= 0) return [0, 0, 0];
  const s = (p.listStrength * clamp01(flood) * buoyancyScale(ship, p)) / n;
  // mean offset × down [0,−1,0] = [z̄, 0, −x̄]: flooded side rolls under
  return [mz * s, 0, -mx * s];
}

/** flood past the point of no return — the sink sequence has begun */
export function isSinking(
  ship: ShipState,
  p: FloodingParams = floodingParams,
): boolean {
  return ship.flood >= p.sinkThreshold;
}

/**
 * Buoyancy support multiplier, derived purely from ship.flood: 1 while
 * recoverable, then a linear 1→0 ramp as flood runs sinkThreshold→1
 * (stepFlooding paces that run over ≤ sinkDuration). Multiply into the
 * probe spring force (hook in header) so the ship settles under the waves
 * instead of popping off the surface.
 */
export function buoyancyScale(
  ship: ShipState,
  p: FloodingParams = floodingParams,
): number {
  if (ship.flood < p.sinkThreshold) return 1;
  const range = Math.max(1e-6, 1 - p.sinkThreshold);
  return clamp01(1 - (ship.flood - p.sinkThreshold) / range);
}
