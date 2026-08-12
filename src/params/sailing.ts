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
  /**
   * how fast the actual yaw rate converges on the rudder's target, 1/s
   * (time constant 1/x). Low = heavy: the turn builds over seconds and
   * keeps swinging after the helm centres. High = arcade snap-to-rudder.
   */
  yawResponse: number;
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
  /**
   * Leeway: fraction of the sail's geometric side force (drive × cot(θ/2))
   * that actually pushes the hull sideways after the keel and deadwood have
   * had their say. 0 = the ship travels exactly where she points, which is
   * a car, not a square-rigger.
   */
  leewayRatio: number;
  /** cap on cot(θ/2) — the ratio diverges head to wind, where the sails
   * are shaking anyway and the number means nothing */
  maxSideForceRatio: number;
  /**
   * Yaw rate (rad/s) added per radian of WIND heel at full rudder authority:
   * weather helm, the steady gripe up into the wind. Small on purpose — it
   * is a nuisance to be corrected, not a spin. 0 = perfectly balanced helm.
   */
  weatherHelmGain: number;
  /**
   * Yaw rate added per rad/s of ROLL RATE: how much the swell makes her hunt
   * about her course. Reads the rate, not the angle, so a steady heel adds
   * nothing (see shipKinematics). 0 = a ship on rails.
   */
  rollYawGain: number;
  /** hard bound (rad/s) on the sea's total contribution to the yaw target —
   * the helm must stay the player's, whatever a storm is doing */
  maxSeaHelmRate: number;
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
    // the keel bites, but not instantly: 1.5/s leaves ~0.7 s of sideways
    // carry so the hull skids a little through a hard turn instead of the
    // velocity vector snapping to the new heading
    keelGrip: 1.5,
    brakeDrag: 0.8,
    rudderRate: 0.5,
    // τ = 2 s to spin up or wind down a turn — the ship leans into the
    // circle rather than stepping onto it
    yawResponse: 0.5,
    rudderRefSpeed: 4,
    minSteerFactor: 0.25,
    steerageSpeed: 0.05,
    deadZone: Math.PI / 6,
    deadZoneRamp: 0.35,
    downwindEff: 0.55,
    trimSpeed: 0.5,
    // measured leeway at the shipped wind: ~1° running, ~3° on a beam
    // reach, ~7° close-hauled — the classic square-rigger shape, and enough
    // that the wake trails visibly off the quarter instead of dead astern
    leewayRatio: 0.4,
    maxSideForceRatio: 3,
    // 15° of wind heel gripes her up at 0.22°/s — 13° a minute hands off,
    // enough that the helm is a live thing, far short of rounding up
    weatherHelmGain: 0.015,
    // at the swell's roll rates (±0.2 rad/s) this swings the heading a
    // couple of degrees either side of her course, at the roll period
    rollYawGain: 0.35,
    // 20% of full rudder: a storm can make her wander, never steer her
    maxSeaHelmRate: 0.1,
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
    yawResponse: { min: 0.05, max: 5, step: 0.05 },
    rudderRefSpeed: { min: 0.5, max: 15, step: 0.1 },
    minSteerFactor: { min: 0, max: 1, step: 0.01 },
    steerageSpeed: { min: 0, max: 1, step: 0.01 },
    deadZone: { min: 0, max: 1.2, step: 0.01 },
    deadZoneRamp: { min: 0.01, max: 1, step: 0.01 },
    downwindEff: { min: 0, max: 1, step: 0.01 },
    trimSpeed: { min: 0.1, max: 3, step: 0.05 },
    leewayRatio: { min: 0, max: 2, step: 0.01 },
    maxSideForceRatio: { min: 1, max: 10, step: 0.1 },
    weatherHelmGain: { min: 0, max: 0.2, step: 0.001 },
    rollYawGain: { min: 0, max: 2, step: 0.01 },
    maxSeaHelmRate: { min: 0, max: 0.5, step: 0.005 },
    heelGain: { min: 0, max: 0.02, step: 0.0005 },
    maxHeel: { min: 0, max: 0.8, step: 0.01 },
    heelResponse: { min: 0.1, max: 8, step: 0.1 },
    rudderRampRate: { min: 0.5, max: 10, step: 0.1 },
    rudderSpringRate: { min: 0.5, max: 10, step: 0.1 },
  },
);
