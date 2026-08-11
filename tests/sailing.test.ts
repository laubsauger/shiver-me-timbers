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
import { quatFromAxisAngle, rotateVec } from '../src/combat/quatMath';
import { stepShipSailing, type Wind } from '../src/sailing/shipKinematics';
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

  it('sailing never touches the vertical channel (buoyancy contract)', () => {
    const ship = makeShip(Math.PI / 2);
    ship.position[1] = 1.23;
    ship.velocity[1] = -0.5;
    for (let i = 0; i < 200; i++) stepShipSailing(ship, neutralInput(), WIND, SIM_DT);
    expect(ship.position[1]).toBe(1.23);
    expect(ship.velocity[1]).toBe(-0.5);
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
