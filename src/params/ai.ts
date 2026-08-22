/**
 * Enemy AI tunables (§V.16): ranges, arcs, dwell times, rudder gains,
 * point-of-sail cones and flee thresholds for the T19 state machine
 * (§V.15). Registered so the debug panel auto-binds; sim reads live.
 */
import { registerParams } from './registry';

export interface AiParams {
  /** m — player inside this → patrol→engage */
  engageRange: number;
  /** m — player inside this → engage→broadside (hold abeam + fire) */
  broadsideRange: number;
  /** m — max distance at which a broadside fire intent is emitted */
  fireRange: number;
  /** m — extra distance before dropping back a mode (no boundary flap) */
  rangeHysteresis: number;
  /** rad — half-angle tolerance around abeam for a fire intent */
  fireArc: number;
  /** s — minimum time in a mode before any transition (no flicker) */
  minDwell: number;
  /** rudder per rad of heading error, clamped to ±1 */
  rudderGain: number;
  /** rad — heading errors below this produce zero rudder */
  rudderDeadband: number;
  /** rad — half-angle of the no-sail cone around dead upwind */
  ironsCone: number;
  /** rad — tack heading offset from dead upwind (≈45°) */
  tackAngle: number;
  /** rad — yaw must cross the wind line by this before the tack flips */
  tackHysteresis: number;
  /** m — min patrol leg length */
  patrolLegMin: number;
  /** m — max patrol leg length */
  patrolLegMax: number;
  /** m — waypoint counts as reached inside this radius */
  waypointRadius: number;
  /** flood fraction above which the ship flees */
  fleeFloodThreshold: number;
  /** mean damage-zone hp below which the ship flees */
  fleeDamageThreshold: number;
  /** rad — flee heading offset from dead upwind (broad reach ≈135°) */
  broadReachAngle: number;
}

export const aiParams: AiParams = registerParams(
  'ai',
  {
    engageRange: 220,
    broadsideRange: 90,
    fireRange: 130,
    rangeHysteresis: 20,
    fireArc: 0.2,
    minDwell: 2,
    rudderGain: 1.5,
    rudderDeadband: 0.02,
    ironsCone: Math.PI / 4,
    tackAngle: Math.PI / 4,
    tackHysteresis: 0.15,
    // §T.83: her turning radius is ~95 m now (was 20 m), so a patrol leg has
    // to be a few radii long and the arrival circle wider than her own track
    // error, or she orbits a waypoint she can never get inside. Measured with
    // 80–220 m legs / 15 m radius under the new hull: median heading error 51°
    // (circling), 12% of the time stalled in stays. With 250–500 / 40: 3.3°,
    // 4%, and she still makes a waypoint every ~100 s.
    patrolLegMin: 250,
    patrolLegMax: 500,
    waypointRadius: 40,
    fleeFloodThreshold: 0.5,
    fleeDamageThreshold: 0.35,
    broadReachAngle: (Math.PI * 3) / 4,
  },
  {
    engageRange: { min: 50, max: 600, step: 5 },
    broadsideRange: { min: 20, max: 300, step: 5 },
    fireRange: { min: 20, max: 400, step: 5 },
    rangeHysteresis: { min: 0, max: 100, step: 1 },
    fireArc: { min: 0.02, max: 0.8, step: 0.01 },
    minDwell: { min: 0, max: 10, step: 0.1 },
    rudderGain: { min: 0.1, max: 5, step: 0.05 },
    rudderDeadband: { min: 0, max: 0.2, step: 0.005 },
    ironsCone: { min: 0.1, max: 1.4, step: 0.01 },
    tackAngle: { min: 0.3, max: 1.5, step: 0.01 },
    tackHysteresis: { min: 0, max: 0.8, step: 0.01 },
    patrolLegMin: { min: 20, max: 500, step: 5 },
    patrolLegMax: { min: 50, max: 1000, step: 5 },
    waypointRadius: { min: 2, max: 60, step: 1 },
    fleeFloodThreshold: { min: 0.05, max: 1, step: 0.05 },
    fleeDamageThreshold: { min: 0, max: 1, step: 0.05 },
    broadReachAngle: { min: 1.6, max: 3, step: 0.01 },
  },
);
