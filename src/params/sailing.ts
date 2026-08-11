/**
 * Sailing tunables (§V.16): every value registers with the params registry
 * so the debug panel auto-binds it. Sim reads the live object; the panel
 * mutates it in place. Angles in radians, speeds m/s, rates per second.
 */
import { registerParams } from './registry';

export interface SailingParams {
  /** m/s² of thrust per (m/s)² of wind at full trim & best angle */
  thrustScale: number;
  /** quadratic hull drag coefficient, 1/m */
  dragCoef: number;
  /** fraction of lateral (leeway) velocity killed per second */
  keelGrip: number;
  /** brake (S held): linear decel coefficient on forward speed, 1/s */
  brakeDrag: number;
  /** max yaw rate at/above reference speed, rad/s */
  rudderRate: number;
  /** forward speed at which the rudder reaches full authority, m/s */
  rudderRefSpeed: number;
  /** rudder authority floor once the ship has steerage way (0..1) */
  minSteerFactor: number;
  /** below this forward speed the rudder does nothing, m/s */
  steerageSpeed: number;
  /** half-angle around head-to-wind producing zero thrust, rad */
  deadZone: number;
  /** blend width from dead zone to the efficiency curve, rad */
  deadZoneRamp: number;
  /** efficiency floor when running dead downwind (0..1) */
  downwindEff: number;
  /** sailTrim units per second from trim keys */
  trimSpeed: number;
  /** rad of target heel per (m/s)² of lateral wind force */
  heelGain: number;
  /** heel bound, rad */
  maxHeel: number;
  /** exp approach rate toward target heel, 1/s */
  heelResponse: number;
  /** input feel: rudder units/s toward the held direction */
  rudderRampRate: number;
  /** input feel: rudder units/s springing back to center */
  rudderSpringRate: number;
}

export const sailingParams: SailingParams = registerParams(
  'sailing',
  {
    thrustScale: 0.03,
    dragCoef: 0.02,
    keelGrip: 3,
    brakeDrag: 0.8,
    rudderRate: 0.5,
    rudderRefSpeed: 4,
    minSteerFactor: 0.25,
    steerageSpeed: 0.05,
    deadZone: Math.PI / 6,
    deadZoneRamp: 0.35,
    downwindEff: 0.55,
    trimSpeed: 0.5,
    heelGain: 0.004,
    maxHeel: 0.35,
    heelResponse: 1.5,
    rudderRampRate: 2.5,
    rudderSpringRate: 3,
  },
  {
    thrustScale: { min: 0, max: 0.2, step: 0.001 },
    dragCoef: { min: 0.001, max: 0.2, step: 0.001 },
    keelGrip: { min: 0, max: 10, step: 0.1 },
    brakeDrag: { min: 0, max: 5, step: 0.05 },
    rudderRate: { min: 0, max: 2, step: 0.01 },
    rudderRefSpeed: { min: 0.5, max: 15, step: 0.1 },
    minSteerFactor: { min: 0, max: 1, step: 0.01 },
    steerageSpeed: { min: 0, max: 1, step: 0.01 },
    deadZone: { min: 0, max: 1.2, step: 0.01 },
    deadZoneRamp: { min: 0.01, max: 1, step: 0.01 },
    downwindEff: { min: 0, max: 1, step: 0.01 },
    trimSpeed: { min: 0.1, max: 3, step: 0.05 },
    heelGain: { min: 0, max: 0.02, step: 0.0005 },
    maxHeel: { min: 0, max: 0.8, step: 0.01 },
    heelResponse: { min: 0.1, max: 8, step: 0.1 },
    rudderRampRate: { min: 0.5, max: 10, step: 0.1 },
    rudderSpringRate: { min: 0.5, max: 10, step: 0.1 },
  },
);
