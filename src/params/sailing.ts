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
  /**
   * yaw rate at `rudderRefSpeed` with the helm hard over, rad/s. With the
   * rate ∝ speed below that, `rudderRefSpeed / rudderRate` IS her turning
   * radius in metres (§T.83) — tune the pair as a radius, not as a rate.
   */
  rudderRate: number;
  /**
   * §T.83 — hull side-drag in a turn: forward deceleration per (rad/s)² of
   * yaw rate, per m/s of way, i.e. `turnDrag · r² · f`. This is what makes
   * a hard turn COST her speed — a real hull loses about a third of her way
   * round a hard turn — and it is quadratic in the rate so the swell's yaw
   * hunting barely taxes her. 0 = a turn is free, a rail car.
   */
  turnDrag: number;
  /**
   * how fast the actual yaw rate converges on the rudder's target, 1/s
   * (time constant 1/x). Low = heavy: the turn builds over seconds and
   * keeps swinging after the helm centres. High = arcade snap-to-rudder.
   */
  yawResponse: number;
  /**
   * §T.83 — floor on the speed scaling of `yawResponse` (0..1). The yaw
   * damping is ∝ way like the rudder is, so a ship losing her way keeps her
   * swing (that is what carries her through a tack); this is the share that
   * stays when she has stopped, so a swing on a stopped ship still dies.
   */
  yawDampFloor: number;
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
  /**
   * §B.49 — THE WAY OUT OF IRONS, and the reason this param exists at all.
   *
   * Inside the dead zone `trimEfficiency` is exactly 0, so thrust is 0, so
   * she never gathers way; and the rudder does nothing below `steerageSpeed`,
   * so she can never turn out of it either. Head to wind was therefore a
   * PERMANENT DEADLOCK — measured at the shipped boot: 120 s of full canvas
   * and full helm produced 0.000 kt and 0.6° of heading.
   *
   * The missing force is the one a real square-rigger cannot avoid: canvas
   * set and presented flat to the wind is a barn door, and it blows her
   * bodily ASTERN. Sternway gives the rudder something to bite on, she falls
   * off onto a tack, the gate opens and she sails. So this is not a rescue
   * hack bolted onto the model — it is the term whose absence made the model
   * one-way.
   *
   * Fraction of the head-on wind force that pushes her astern, scaled by
   * trim (bare poles barely blow astern at all). Small: it must be enough to
   * beat `steerageSpeed`, never enough to feel like reverse gear.
   */
  abackRatio: number;
  /**
   * Fraction of planar velocity the cable kills per second while she rides to
   * her anchor. High — an anchor that let her sail away slowly would be
   * exactly the ambiguity the anchor exists to remove.
   */
  anchorHold: number;
  /** sailTrim units per second from trim keys */
  trimSpeed: number;
  /**
   * §T.76 — how long the player keeps the yards after the last Q/E press, in
   * seconds, before they slew back to the automatic brace.
   *
   * The brace HAD to default to automatic: it is a new lever, not a new chore,
   * and a player who never discovers Q/E must sail exactly as well as before.
   * Handing back on a timer rather than on a second keybinding is the cheaper
   * of the two, and it is forgiving in the direction that matters — brace her
   * wrong, get distracted, and she comes right on her own instead of quietly
   * sailing at half speed for the rest of the voyage.
   *
   * 0 means the yards are handed back on the very next tick, i.e. it disables
   * MANUAL bracing rather than the hand-back — stated because the opposite
   * reading is the natural one. A long hold is a large value, not zero, and it
   * has to stay finite: `Infinity` does not survive `JSON.stringify` and this
   * value reaches sim state through `ShipState.braceHold` (§V.2).
   */
  braceHoldTime: number;
  /**
   * §T.76 — the plate drive at which the yards get FULL say over her speed.
   *
   * The brace scales the drive by how far it is from the best angle the
   * shrouds allow, but only in proportion to how much drive that best angle
   * can actually make: `smoothstep(driveStar / this)`. Close-hauled the clamp
   * leaves a square yard nothing to collect (drive 0.005 at θ = 50°, 0 at
   * 45°), and letting a ratio of two near-zero numbers govern there put a
   * knife edge across five degrees of yard. Above this value the plate law
   * governs outright; below it the point-of-sail curve does.
   *
   * 0.05 sits just under the drive available on a close reach (0.047 at
   * θ = 60°), so the lever is essentially fully live everywhere she really
   * sails and fades out only where the RIG, not the model, has run out.
   */
  braceAuthorityRef: number;
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
    // 12 / 0.126 = 95 m turning radius ≈ 2.5 LWL, tactical diameter ~5
    // lengths — a sailing ship of her size, not a launch. Measured before:
    // 28.6°/s from 4 m/s up, 180° in 8.4 s, the circle ONE ship length
    // across. After: 4–6°/s at speed, 180° in ~50 s, ~5 lengths, and she
    // comes out of it with a third of her way gone (§T.83).
    rudderRate: 0.126,
    // τ = 4 s at 10 m/s to spin up or wind down a turn — the ship leans
    // into the circle rather than stepping onto it — and longer as she
    // slows (∝ 1/way, floored by yawDampFloor)
    yawResponse: 0.3,
    yawDampFloor: 0.4,
    // above her top speed on purpose: the rate never saturates under sail
    rudderRefSpeed: 12,
    minSteerFactor: 0.4,
    turnDrag: 26,
    steerageSpeed: 0.05,
    deadZone: Math.PI / 6,
    deadZoneRamp: 0.35,
    downwindEff: 0.55,
    // measured: from dead head-to-wind under full canvas with the helm over,
    // she gathers sternway in ~4 s and has fallen off far enough for the
    // sails to fill at ~13 s. Below ~0.03 she never beats steerageSpeed and
    // the deadlock comes back; above ~0.15 she backs out like a car.
    abackRatio: 0.07,
    anchorHold: 3,
    trimSpeed: 0.5,
    // ~5 s of yard travel at braceRate = 0.35 rad/s, i.e. long enough to
    // brace her round, look at what she is doing and correct it
    braceHoldTime: 15,
    braceAuthorityRef: 0.05,
    // measured leeway at the shipped wind: ~1° running, ~3° on a beam
    // reach, ~7° close-hauled — the classic square-rigger shape, and enough
    // that the wake trails visibly off the quarter instead of dead astern
    leewayRatio: 0.4,
    maxSideForceRatio: 3,
    // 15° of wind heel gripes her up at 0.22°/s — 13° a minute hands off,
    // enough that the helm is a live thing, far short of rounding up
    weatherHelmGain: 0.015,
    // at the swell's roll rates (±0.2 rad/s) this swings the heading a
    // couple of degrees either side of her course, at the roll period.
    // Re-sized with §T.83: the yaw lag is 4 s at speed now, not 2, so the
    // hull follows less of each roll — 0.35 measured 0.80° RMS of wander
    // under the old lag and 0.38° under the new; 0.8 puts it back near 0.7°
    rollYawGain: 0.8,
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
    rudderRate: { min: 0, max: 2, step: 0.001 },
    turnDrag: { min: 0, max: 100, step: 0.5 },
    yawResponse: { min: 0.05, max: 5, step: 0.05 },
    yawDampFloor: { min: 0.01, max: 1, step: 0.01 },
    rudderRefSpeed: { min: 0.5, max: 15, step: 0.1 },
    minSteerFactor: { min: 0, max: 1, step: 0.01 },
    steerageSpeed: { min: 0, max: 1, step: 0.01 },
    deadZone: { min: 0, max: 1.2, step: 0.01 },
    deadZoneRamp: { min: 0.01, max: 1, step: 0.01 },
    downwindEff: { min: 0, max: 1, step: 0.01 },
    abackRatio: { min: 0, max: 0.5, step: 0.005 },
    anchorHold: { min: 0.1, max: 10, step: 0.1 },
    trimSpeed: { min: 0.1, max: 3, step: 0.05 },
    braceHoldTime: { min: 0, max: 60, step: 1 },
    braceAuthorityRef: { min: 0.001, max: 0.5, step: 0.001 },
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
