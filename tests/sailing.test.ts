/**
 * T9 sailing kinematics — WHY these tests:
 * §V.2 lockstep: multiplayer-later means the same ship + input log must
 * replay to an identical state hash; input snapshots must survive JSON so
 * the log IS the netcode/replay format (§V.3 plain data).
 * Force model intent: the no-go zone is what makes sailing a game (you
 * must tack, not motor upwind); rudder-needs-way is what makes it feel
 * like a ship (no turning on the spot); drag equilibrium is the anti-
 * runaway guarantee that keeps every tunable combination stable.
 */
import { describe, expect, it } from 'vitest';
import {
  createInitialState,
  hashState,
  type Quat,
  type ShipState,
  type Vec3,
} from '../src/state/simState';
import { SIM_DT } from '../src/core/loop';
import { quatFromAxisAngle, quatMul, rotateVec } from '../src/combat/quatMath';
import { stepShipSailing, type Wind } from '../src/sailing/shipKinematics';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import { stepShipBuoyancy } from '../src/sea-physics/buoyancy';
import { KeyboardInput, neutralInput, type InputState } from '../src/sailing/input';
import { sailingParams } from '../src/params/sailing';

const WIND: Wind = { direction: 0, speed: 8 }; // blowing toward +z

function makeShip(yaw: number, sailTrim = 1): ShipState {
  return {
    id: 'player',
    kind: 'player',
    position: [0, 0, 0],
    quaternion: quatFromAxisAngle([0, 1, 0], yaw),
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    rudder: 0,
    sailTrim,
    flood: 0,
    damage: {},
  };
}

function yawOf(q: Quat): number {
  const f = rotateVec(q, [0, 0, 1]);
  return Math.atan2(f[0], f[2]);
}

function planarSpeed(v: Vec3): number {
  return Math.hypot(v[0], v[2]);
}

/** bow elevation, rad — matches buoyancy's stored-pitch convention */
function pitchOf(q: Quat): number {
  const y = rotateVec(q, [0, 0, 1])[1];
  return Math.asin(y < -1 ? -1 : y > 1 ? 1 : y);
}

/** roll, rad, starboard-up positive — exact while pitch is 0 */
function rollOf(q: Quat): number {
  const y = rotateVec(q, [1, 0, 0])[1];
  return Math.asin(y < -1 ? -1 : y > 1 ? 1 : y);
}

function wrapPi(a: number): number {
  let x = a % (Math.PI * 2);
  if (x <= -Math.PI) x += Math.PI * 2;
  else if (x > Math.PI) x -= Math.PI * 2;
  return x;
}

describe('sailing determinism (V2)', () => {
  it('same ship + input log replays to an identical SimState hash', () => {
    const inputAt = (i: number): InputState => ({
      rudder: i < 300 ? 1 : i < 600 ? -0.5 : 0,
      sailTrimDelta: i < 120 ? 1 : 0,
      brake: i >= 800,
      fire: false,
    });
    const run = (): number => {
      const state = createInitialState(42);
      state.ships.push(makeShip(Math.PI / 2, 0));
      for (let i = 0; i < 1000; i++) {
        state.tick++;
        stepShipSailing(state.ships[0], inputAt(i), WIND, SIM_DT);
      }
      return hashState(state);
    };
    expect(run()).toBe(run());
  });
});

describe('force model', () => {
  it('head-to-wind dead zone produces zero thrust — tacking is mandatory', () => {
    const ship = makeShip(Math.PI); // bow straight into the wind eye
    for (let i = 0; i < 600; i++) stepShipSailing(ship, neutralInput(), WIND, SIM_DT);
    expect(planarSpeed(ship.velocity)).toBeLessThan(1e-12);
    expect(Math.hypot(ship.position[0], ship.position[2])).toBeLessThan(1e-12);
  });

  it('beam reach outruns close-hauled — points of sail matter', () => {
    const beam = makeShip(Math.PI / 2); // 90° off the wind eye
    const closeHauled = makeShip((3 * Math.PI) / 4); // 45° off the eye
    for (let i = 0; i < 1200; i++) {
      stepShipSailing(beam, neutralInput(), WIND, SIM_DT);
      stepShipSailing(closeHauled, neutralInput(), WIND, SIM_DT);
    }
    const vBeam = planarSpeed(beam.velocity);
    const vClose = planarSpeed(closeHauled.velocity);
    expect(vClose).toBeGreaterThan(0); // close-hauled still sails, outside dead zone
    expect(vBeam).toBeGreaterThan(vClose * 1.1);
  });

  it('rudder without way does nothing — ships cannot turn on the spot', () => {
    const ship = makeShip(0.3, 0); // sails furled → no thrust, no heel target
    const input = { ...neutralInput(), rudder: 1 };
    const before = [...ship.quaternion] as Quat;
    for (let i = 0; i < 300; i++) stepShipSailing(ship, input, WIND, SIM_DT);
    for (let k = 0; k < 4; k++) {
      expect(ship.quaternion[k]).toBeCloseTo(before[k], 9);
    }
    expect(planarSpeed(ship.velocity)).toBe(0);
  });

  it('sustained rudder circles the ship — heading wraps a full 2π', () => {
    const ship = makeShip(Math.PI / 2);
    const input = { ...neutralInput(), rudder: 1 };
    let prev = yawOf(ship.quaternion);
    let turned = 0;
    for (let i = 0; i < 6000; i++) {
      stepShipSailing(ship, input, WIND, SIM_DT);
      const yaw = yawOf(ship.quaternion);
      turned += wrapPi(yaw - prev);
      prev = yaw;
      // heading stays a wrapped angle, never accumulates unbounded
      expect(Math.abs(yaw)).toBeLessThanOrEqual(Math.PI);
    }
    expect(turned).toBeGreaterThan(2 * Math.PI);
  });

  it('speed reaches drag equilibrium below the analytic cap — no runaway', () => {
    const p = sailingParams;
    const vMax = Math.sqrt((WIND.speed * WIND.speed * p.thrustScale) / p.dragCoef);
    const ship = makeShip(Math.PI / 2);
    let prevSpeed = 0;
    for (let i = 0; i < 4000; i++) {
      stepShipSailing(ship, neutralInput(), WIND, SIM_DT);
      if (i === 3899) prevSpeed = planarSpeed(ship.velocity);
    }
    const speed = planarSpeed(ship.velocity);
    expect(Number.isFinite(speed)).toBe(true);
    expect(speed).toBeLessThanOrEqual(vMax * 1.01);
    expect(speed).toBeGreaterThan(vMax * 0.5); // actually sails, not stalled
    expect(Math.abs(speed - prevSpeed)).toBeLessThan(1e-6); // settled
  });

  it('yaw rate BUILDS over seconds under sustained rudder — no snap', () => {
    // WHY (user, sailing live): "the movements are a little bit too quick —
    // we're not really respecting the inertia we've built". A yaw rate
    // assigned straight from the rudder makes a 200-ton hull pivot like a
    // cursor. It must spin up against its own rotational inertia.
    const ship = makeShip(Math.PI / 2);
    for (let i = 0; i < 1200; i++) stepShipSailing(ship, neutralInput(), WIND, SIM_DT);
    const helm = { ...neutralInput(), rudder: 1 };
    const rateAfter = (seconds: number): number => {
      for (let i = 0; i < Math.round(seconds / SIM_DT); i++) {
        stepShipSailing(ship, helm, WIND, SIM_DT);
      }
      return ship.angularVelocity[1];
    };
    const quarterSec = rateAfter(0.25);
    const oneSec = rateAfter(0.75);
    const settled = rateAfter(11);
    // a snap-to-rudder helm would already be at the steady rate in 1 tick
    expect(quarterSec).toBeLessThan(settled * 0.25);
    expect(oneSec).toBeGreaterThan(quarterSec * 2); // still climbing
    expect(oneSec).toBeLessThan(settled * 0.65);
    expect(settled).toBeGreaterThan(0); // and it does get there
  });

  it('a centred helm keeps swinging — the turn carries its momentum', () => {
    // WHY: the flip side of the build-up. Releasing the wheel mid-turn must
    // not stop the swing dead, or every course correction reads weightless.
    const ship = makeShip(Math.PI / 2);
    const helm = { ...neutralInput(), rudder: 1 };
    for (let i = 0; i < 1200; i++) stepShipSailing(ship, neutralInput(), WIND, SIM_DT);
    for (let i = 0; i < 600; i++) stepShipSailing(ship, helm, WIND, SIM_DT);
    const rateAtRelease = ship.angularVelocity[1];
    const yawAtRelease = yawOf(ship.quaternion);
    let carried = 0;
    let prev = yawAtRelease;
    for (let i = 0; i < 300; i++) {
      stepShipSailing(ship, neutralInput(), WIND, SIM_DT);
      const y = yawOf(ship.quaternion);
      carried += wrapPi(y - prev);
      prev = y;
    }
    expect(rateAtRelease).toBeGreaterThan(0.3);
    // keeps turning tens of degrees after the helm is centred...
    expect(carried).toBeGreaterThan(0.5);
    // ...but the swing does wind down, it is a lag and not a flywheel
    expect(ship.angularVelocity[1]).toBeLessThan(rateAtRelease * 0.2);
  });

  it('sailing never touches the vertical channel (buoyancy contract)', () => {
    const ship = makeShip(Math.PI / 2);
    ship.position[1] = 1.23;
    ship.velocity[1] = -0.5;
    for (let i = 0; i < 200; i++) stepShipSailing(ship, neutralInput(), WIND, SIM_DT);
    expect(ship.position[1]).toBe(1.23);
    expect(ship.velocity[1]).toBe(-0.5);
  });
});

describe('orientation contract with buoyancy (§B.6)', () => {
  it('preserves buoyancy pitch through the recompose — bow stays up', () => {
    // WHY §B.6a: the old yaw∘heel recompose erased buoyancy's pitch 60×/s
    // (ship never pitched). Recompose must be yaw∘pitch∘roll.
    const ship = makeShip(0, 0);
    ship.quaternion = quatMul(
      quatFromAxisAngle([0, 1, 0], 0.5),
      quatFromAxisAngle([1, 0, 0], -0.1), // pitch +0.1 = bow up
    );
    for (let i = 0; i < 300; i++) stepShipSailing(ship, neutralInput(), WIND, SIM_DT);
    expect(pitchOf(ship.quaternion)).toBeCloseTo(0.1, 6);
    // buoyancy's pitch-memory workaround keys off forward.y ≈ 0; surviving
    // pitch keeps that branch dormant → no double-pitch
    expect(Math.abs(rotateVec(ship.quaternion, [0, 0, 1])[1])).toBeGreaterThan(1e-6);
  });

  it('with sails furled, orientation is a fixed point of the recompose', () => {
    // decompose→recompose roundtrip: no thrust, no way, no heel target →
    // yaw, pitch AND roll must all pass through bit-near-exactly
    const q0 = quatMul(
      quatFromAxisAngle([0, 1, 0], 0.5),
      quatMul(quatFromAxisAngle([1, 0, 0], -0.15), quatFromAxisAngle([0, 0, 1], 0.2)),
    );
    const ship = makeShip(0, 0);
    ship.quaternion = [...q0] as Quat;
    for (let i = 0; i < 300; i++) stepShipSailing(ship, neutralInput(), WIND, SIM_DT);
    for (let k = 0; k < 4; k++) expect(ship.quaternion[k]).toBeCloseTo(q0[k], 6);
  });

  it('wind heel is an OFFSET on wave roll, not a relax of total roll', () => {
    // WHY §B.6b: heelResponse used to pull TOTAL roll toward wind-heel,
    // eating ~half of buoyancy's wave-roll amplitude. A pre-existing roll
    // must survive intact with the wind heel added on top.
    const p = sailingParams;
    const waveRoll = 0.2;
    const ship = makeShip(Math.PI / 2); // beam wind, full trim
    ship.quaternion = quatMul(ship.quaternion, quatFromAxisAngle([0, 0, 1], waveRoll));
    for (let i = 0; i < 900; i++) stepShipSailing(ship, neutralInput(), WIND, SIM_DT);
    // beam wind: latWindForce = -speed², targetHeel = +heelGain·speed²
    const targetHeel = Math.min(p.heelGain * WIND.speed * WIND.speed, p.maxHeel);
    expect(rollOf(ship.quaternion)).toBeCloseTo(waveRoll + targetHeel, 3);
  });

  it('full tick order sailing→buoyancy: pitch alive, bounded, no double-add', () => {
    // WHY: buoyancy re-applies remembered pitch ONLY when the incoming quat
    // is pitch-stripped. If both systems contributed pitch, it would grow
    // tick over tick; if sailing still stripped it, it would stay ~0.
    const ocean = new CpuOcean(7);
    const ship = makeShip(Math.PI / 2);
    const input = neutralInput();
    let maxPitch = 0;
    for (let i = 0; i < 1800; i++) {
      const t = (i + 1) * SIM_DT;
      ocean.update(t);
      stepShipSailing(ship, input, WIND, SIM_DT);
      stepShipBuoyancy(ship, ocean, SIM_DT);
      if (i >= 600) maxPitch = Math.max(maxPitch, Math.abs(pitchOf(ship.quaternion)));
      if (!ship.quaternion.every(Number.isFinite)) {
        throw new Error(`quaternion went non-finite at tick ${i}`);
      }
    }
    const maxPitchDeg = (maxPitch * 180) / Math.PI;
    expect(maxPitchDeg).toBeGreaterThan(0.2); // waves actually pitch the bow
    expect(maxPitchDeg).toBeLessThan(15); // and nothing double-adds/runs away
  });

  it('buoyancy leaves the yaw RATE alone — sailing stores its turn there', () => {
    // WHY §B.6 (extended): the built-up turn rate now lives in
    // angularVelocity[1] across ticks. Buoyancy used to rewrite that slot
    // every tick (angularDamping decay + roll/pitch smearing while heeled),
    // which would quietly bleed the helm's momentum away — a ship that
    // refuses to hold a turn, with nothing in the sailing code to blame.
    const ocean = new CpuOcean(7);
    const ship = makeShip(Math.PI / 2);
    const helm = { ...neutralInput(), rudder: 1 };
    for (let i = 0; i < 900; i++) {
      const t = (i + 1) * SIM_DT;
      ocean.update(t);
      stepShipSailing(ship, helm, WIND, SIM_DT);
      stepShipBuoyancy(ship, ocean, SIM_DT);
    }
    // rolling in a seaway must not change the answer: the rate is whatever
    // sailing set it to on the last tick
    const beforeBuoyancy = ship.angularVelocity[1];
    ocean.update(901 * SIM_DT);
    stepShipBuoyancy(ship, ocean, SIM_DT);
    expect(ship.angularVelocity[1]).toBe(beforeBuoyancy);
    expect(Math.abs(beforeBuoyancy)).toBeGreaterThan(0.3); // a real turn
  });
});

describe('input snapshots (replay contract, V3)', () => {
  it('snapshot survives JSON round-trip unchanged — the log IS the format', () => {
    const kb = new KeyboardInput();
    kb.keyDown('KeyD');
    kb.keyDown('KeyS');
    kb.keyDown('Space');
    let snap: InputState = neutralInput();
    for (let i = 0; i < 10; i++) snap = kb.sample(SIM_DT);
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
    expect(snap.rudder).toBeGreaterThan(0);
    expect(snap.rudder).toBeLessThanOrEqual(1);
    expect(snap.brake).toBe(true); // S brakes...
    expect(snap.sailTrimDelta).toBe(-1); // ...and trims down
    expect(snap.fire).toBe(true);
  });

  it('rudder ramps while held and springs back to exactly 0', () => {
    const kb = new KeyboardInput();
    kb.keyDown('KeyA');
    for (let i = 0; i < 120; i++) kb.sample(SIM_DT);
    expect(kb.sample(SIM_DT).rudder).toBe(-1); // saturates at full port
    kb.keyUp('KeyA');
    let last = -1;
    for (let i = 0; i < 120; i++) last = kb.sample(SIM_DT).rudder;
    expect(last).toBe(0); // exact zero: no residual drift in the log
  });
});
