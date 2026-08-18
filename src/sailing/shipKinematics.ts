/**
 * stepShipSailing — arcade sailing kinematics on the water plane (T9).
 * §V.2: pure deterministic fixed-tick math, no randomness, no wall clock.
 * §V.3: sim-side — no three.js; mutates only ShipState plain data.
 *
 * SPLIT CONTRACT with buoyancy (src/sea-physics, §B.6 fix):
 * sailing owns yaw — the angle AND the rate in angularVelocity[1], which
 * buoyancy leaves strictly alone — plus a wind-heel OFFSET on roll and
 * PLANAR velocity/position only. It never writes position[1]/velocity[1],
 * PRESERVES the pitch buoyancy integrated (recompose is yaw∘pitch∘roll,
 * never yaw∘heel),
 * and never relaxes total roll: wind heel is tracked separately and added
 * on top of the wave-roll component, so buoyancy's roll dynamics pass
 * through untouched. Buoyancy's pitch-memory workaround detects surviving
 * pitch (forward.y ≠ 0) and self-deactivates — no double-pitch.
 *
 * Also the single owner of `ship.anchored` (§V.62): the X key, the HUD's
 * anchor button and a replayed input log all arrive as `input.anchorToggle`
 * and are consumed here, so there is one place where the anchor can change.
 *
 * Conventions: ship forward = local +z; yaw about +y, yaw 0 → world +z,
 * heading = [sin yaw, 0, cos yaw]; starboard = [cos yaw, 0, -sin yaw].
 * wind.direction is the direction the wind blows TOWARD (same convention
 * as yaw). Positive rudder turns to starboard (yaw increases); keyboard keys
 * are mapped separately at the input boundary.
 */
import type { Quat, ShipState } from '../state/simState';
import type { InputState } from './input';
import { quatFromAxisAngle, quatMul, rotateVec } from '../combat/quatMath';
import { groundGrip } from '../sea-physics/grounding';
import { sailingParams, type SailingParams } from '../params/sailing';

export interface Wind {
  direction: number; // radians, blowing toward
  speed: number; // m/s
}

/**
 * Wind-heel memory keyed by ShipState identity (plain-data state stays
 * untouched, §V.3 — same pattern as buoyancy's seaMemory). Derived cache
 * only: windHeel re-converges from ship+wind within ~1/heelResponse s, so
 * losing it (reload) costs a brief heel blend restart, nothing
 * sim-hash-relevant accumulates here. Deterministic under §V.2: its value
 * is a pure function of the tick-ordered ship+wind history.
 */
const heelMemory = new WeakMap<ShipState, { windHeel: number }>();

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function smoothstep01(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function wrapPi(a: number): number {
  let x = a % (Math.PI * 2);
  if (x <= -Math.PI) x += Math.PI * 2;
  else if (x > Math.PI) x -= Math.PI * 2;
  return x;
}

/**
 * Arcade sail efficiency vs angle off the eye of the wind (theta: 0 = head
 * to wind, π/2 = beam reach, π = running). Dead zone in irons, best at
 * beam/broad reach (sin peak), decent floor dead downwind.
 */
export function trimEfficiency(theta: number, params: SailingParams = sailingParams): number {
  const shape = params.downwindEff + (1 - params.downwindEff) * Math.sin(theta);
  return noGoGate(theta, params) * shape;
}

/**
 * 0 inside the no-go zone, ramping to 1 where the sails begin to draw. Split
 * out of `trimEfficiency` because the ABACK term needs its COMPLEMENT, and
 * `1 − trimEfficiency` is not it: efficiency is also below 1 dead downwind,
 * where she is sailing perfectly well and nothing is aback (§B.49).
 */
export function noGoGate(theta: number, params: SailingParams = sailingParams): number {
  return smoothstep01((theta - params.deadZone) / params.deadZoneRamp);
}

export function stepShipSailing(
  ship: ShipState,
  input: InputState,
  wind: Wind,
  dt: number,
  params: SailingParams = sailingParams,
): void {
  // --- decompose q = yaw(Y) ∘ pitch(X) ∘ roll(Z), Tait-Bryan y-x'-z''.
  // forward = [cos p·sin y, sin p, cos p·cos y] gives yaw+pitch directly
  // (|pitch| < π/2 for any floating hull, so cos p > 0 and atan2 is safe);
  // roll = residual rotation about local z after removing yaw∘pitch.
  const fwd3 = rotateVec(ship.quaternion, [0, 0, 1]);
  const pitch = Math.asin(clamp(fwd3[1], -1, 1));
  const yaw = Math.atan2(fwd3[0], fwd3[2]);
  // R_x(−pitch) maps forward [0,0,1] → [0, sin pitch, cos pitch] — same
  // sign convention as buoyancy's stored pitch (asin of forward.y)
  const qPitch = quatFromAxisAngle([1, 0, 0], -pitch);
  const qYP = quatMul(quatFromAxisAngle([0, 1, 0], yaw), qPitch);
  const qRes: Quat = quatMul([-qYP[0], -qYP[1], -qYP[2], qYP[3]], ship.quaternion);
  const roll = wrapPi(2 * Math.atan2(qRes[2], qRes[3]));

  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  const rx = fz; // starboard, planar
  const rz = -fx;

  // --- controls ---
  ship.rudder = clamp(input.rudder, -1, 1);
  ship.sailTrim = clamp(ship.sailTrim + input.sailTrimDelta * params.trimSpeed * dt, 0, 1);
  // the anchor is SIM state and this is its single owner (§V.62: the key, the
  // HUD button and a replayed input log all arrive here and nowhere else)
  if (input.anchorToggle) ship.anchored = !ship.anchored;

  // --- sail thrust: windSpeed² · trimEfficiency(angle off wind) · trim ---
  const wx = Math.sin(wind.direction);
  const wz = Math.cos(wind.direction);
  const theta = Math.acos(clamp(-(fx * wx + fz * wz), -1, 1));
  const windForce = wind.speed * wind.speed * ship.sailTrim * params.thrustScale;
  // ABACK (§B.49). `trimEfficiency` is exactly 0 inside the dead zone, and the
  // rudder is exactly 0 below steerageSpeed, so head to wind used to be a
  // closed loop with no exit: no thrust ⇒ no way ⇒ no helm ⇒ no thrust. What
  // was missing is that set canvas held flat to the wind BLOWS HER ASTERN.
  // Sternway is what gives the rudder something to bite on, and falling off
  // is what opens the gate again — the same escape a real ship makes.
  // Complement of the GATE, so the two never overlap: full aback dead head to
  // wind, gone by the time the sails draw, and nothing aback dead downwind.
  const gate = noGoGate(theta, params);
  const thrust =
    windForce * trimEfficiency(theta, params) - windForce * params.abackRatio * (1 - gate);

  // --- aground: the bank eats the drive before it ever reaches the water.
  // OWNERSHIP (§B.6, stated because this contract has been broken here
  // before): sea-physics/grounding owns the seabed reaction and writes only
  // the vertical channel, pitch/roll and a friction bleed on velocity — it
  // never touches thrust, yaw or the quaternion. Sailing owns the driving
  // force, so the force balance closes HERE and nowhere else. Grounding
  // publishes what the seabed can resist (μ·N/m, a deceleration) and this
  // subtracts it: a keel carrying the ship's weight simply cannot be pushed
  // along by canvas, however she is trimmed. It reads one tick behind
  // (main.ts runs sailing first), which at 60 Hz is invisible.
  // The bank resists motion whichever way the canvas is pushing, so the gate
  // is on the MAGNITUDE. Signing it was not optional once thrust could go
  // negative: `thrust > grip` is false for every negative thrust, so a plain
  // subtraction would have silently swallowed the whole aback term and put
  // §B.49's deadlock straight back for any ship that had ever touched sand.
  const grip = groundGrip(ship, dt);
  const thrustMag = Math.abs(thrust);
  let drive = thrustMag > grip ? Math.sign(thrust) * (thrustMag - grip) : 0;

  // --- riding to her anchor: the cable holds her, whatever the sails do.
  // Gated HERE, on drive, for the same reason grounding is (§B.6): the force
  // balance closes in one place. The bleed below is the cable snubbing her up.
  const anchored = ship.anchored === true;
  if (anchored) drive = 0;

  // --- planar velocity in ship frame: forward + lateral (leeway) ---
  const vx = ship.velocity[0];
  const vz = ship.velocity[2];
  let f = vx * fx + vz * fz;
  let l = vx * rx + vz * rz;
  const speed = Math.hypot(f, l);

  // LEEWAY (§B.23). A square-rigger does not go where she points: the sail
  // force is perpendicular to the canvas, so only part of it is drive and
  // the rest shoves her bodily to leeward. The ratio is geometric — the
  // sail is braced to roughly bisect the wind and the centreline, so
  // side/drive ≈ cot(θ/2): ~0 dead downwind, 1 on a beam reach, and it
  // climbs steeply as she points up, which is exactly why a square-rigger
  // makes so much leeway close-hauled and why nobody sails one to windward
  // if they can help it. Measured before this existed: leeway 0.00° at
  // every point of sail — the user's "she goes always way too straight".
  const halfTheta = Math.max(1e-3, theta / 2);
  const sideOverDrive = Math.min(
    params.maxSideForceRatio,
    Math.cos(halfTheta) / Math.sin(halfTheta),
  );
  // to leeward = the side the wind is blowing toward, i.e. the sign of the
  // wind's own starboard projection
  const leeSign = wx * rx + wz * rz;
  // off `drive`, NOT `thrust`: a hull the bank is holding cannot be pushed
  // sideways by canvas either. Gating the forward channel and leaving the
  // lateral one ungated is the §B.6 "sails magically continue to propulse
  // us" bug in the other axis — measured, she crabbed off a bank at 0.35 m/s
  // with her drive fully gated.
  // Positive part only. Aback canvas drives her ASTERN but still shoves her
  // to leeward, so a signed `drive` here would swing the leeway to WINDWARD —
  // a ship in irons crabbing up into the wind she cannot sail into.
  const sideForce =
    Math.max(0, drive) * sideOverDrive * params.leewayRatio * Math.sign(leeSign);

  // semi-implicit Euler: quadratic hull drag opposes each component,
  // brake adds linear decel on forward way only
  f += (drive - params.dragCoef * speed * f - (input.brake ? params.brakeDrag * f : 0)) * dt;
  l += (sideForce - params.dragCoef * speed * l) * dt;
  // keel grip: kill a frame-rate-scaled fraction of sideways velocity
  l *= Math.max(0, 1 - params.keelGrip * dt);
  // the cable: an exponential snub on BOTH channels, so she rounds up to her
  // anchor and stays there instead of sailing off at a knot nobody asked for
  if (anchored) {
    const hold = Math.max(0, 1 - params.anchorHold * dt);
    f *= hold;
    l *= hold;
  }

  ship.velocity[0] = f * fx + l * rx;
  ship.velocity[2] = f * fz + l * rz;
  ship.position[0] += ship.velocity[0] * dt;
  ship.position[2] += ship.velocity[2] * dt;

  // --- wind heel: bounded target ∝ lateral wind force on the set sail.
  // Applied as an OFFSET on top of the wave roll (roll − previous heel):
  // only sailing's own contribution is relaxed, buoyancy's roll survives.
  let mem = heelMemory.get(ship);
  if (mem === undefined) {
    mem = { windHeel: 0 };
    heelMemory.set(ship, mem);
  }
  const waveRoll = roll - mem.windHeel;
  const latWindForce = wind.speed * wind.speed * ship.sailTrim * (wx * rx + wz * rz);
  const targetHeel = clamp(-params.heelGain * latWindForce, -params.maxHeel, params.maxHeel);
  mem.windHeel += (targetHeel - mem.windHeel) * (1 - Math.exp(-params.heelResponse * dt));
  const totalRoll = waveRoll + mem.windHeel;

  // --- rudder: yaw rate ∝ forward speed, min steerage once under way.
  // The rudder sets a TARGET rate; the actual rate lags it with time
  // constant 1/yawResponse, because a few hundred tons of ship take
  // seconds to spin up about its own mast and seconds to stop. Momentum
  // lives in ship.angularVelocity[1] — sailing is its sole owner (§B.6,
  // buoyancy never writes it), so it is real sim state: centre the helm
  // mid-turn and the ship keeps swinging round before it settles.
  // |f|, so STERNWAY steers too — that is what makes §B.49's aback term an
  // exit from irons rather than just a slow slide backwards. The sign is NOT
  // reversed the way a real rudder reverses going astern: she is backing out
  // of a corner the player did not choose to be in, and a helm that answers
  // backwards for those few seconds reads as the controls breaking. Called
  // out because it is a deliberate departure from the physics, not an
  // oversight.
  const way = Math.abs(f);
  const steer =
    way < params.steerageSpeed
      ? 0
      : clamp(way / params.rudderRefSpeed, params.minSteerFactor, 1);
  // WEATHER HELM AND YAW HUNTING (§B.23). Both come from the hull being
  // asymmetric while she is over on one side — the immersed lee bow pushes
  // her head round — but they are read off DIFFERENT signals, on purpose.
  //
  // Weather helm is the STEADY gripe up into the wind, so it reads the wind
  // heel and its gain is tiny: it should be a nuisance the helmsman answers,
  // not a spin. One gain for both, sized for the wander, rounds her up into
  // irons inside a minute hands off (measured 9.8 → 3.0 m/s over 66 s).
  //
  // Hunting reads the ROLL RATE, not the roll angle, and that choice is
  // load-bearing: `waveRoll` carries a DC offset, because sailing re-imposes
  // the heel as an offset every tick while buoyancy's righting moment pulls
  // the total roll back toward upright, and the two settle a few degrees
  // apart. Feeding that to the helm turned a "wander" into a steady 0.48°/s
  // turn (measured: 58° of unasked-for heading change in 120 s of calm). A
  // rate signal cannot have a DC offset — a ship lying at a steady angle is
  // not rolling — so the hunt is zero-mean by construction.
  //
  // Bounded (§V.44): in a storm the sea drives roll rates that would
  // otherwise hand the helm more authority than the rudder has.
  const rollRate = ship.angularVelocity[0] * fx + ship.angularVelocity[2] * fz;
  const seaHelm = clamp(
    params.weatherHelmGain * mem.windHeel + params.rollYawGain * rollRate,
    -params.maxSeaHelmRate,
    params.maxSeaHelmRate,
  );
  const targetYawRate = (ship.rudder * params.rudderRate + seaHelm) * steer;
  const yawRate =
    ship.angularVelocity[1] +
    (targetYawRate - ship.angularVelocity[1]) * (1 - Math.exp(-params.yawResponse * dt));
  const newYaw = yaw + yawRate * dt;
  ship.angularVelocity[1] = yawRate;

  ship.quaternion = quatMul(
    quatFromAxisAngle([0, 1, 0], newYaw),
    quatMul(qPitch, quatFromAxisAngle([0, 0, 1], totalRoll)),
  );
}
