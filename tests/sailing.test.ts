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
import { oceanParams } from '../src/params/ocean';

const WIND: Wind = { direction: 0, speed: 8 }; // blowing toward +z

/**
 * Sailing params with the SEA's hands off the helm: weather helm and
 * roll-driven hunting both write the yaw target (§B.23), which is the point
 * of them, but a test that pins an equilibrium speed or a heel angle is
 * asking "what does the force model settle at on THIS heading" and must
 * hold the heading still to mean anything. Anything asserting the wander
 * itself uses the shipped params instead.
 */
const HELM_STEADY = { ...sailingParams, weatherHelmGain: 0, rollYawGain: 0 };

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
    const p = HELM_STEADY;
    const vMax = Math.sqrt((WIND.speed * WIND.speed * p.thrustScale) / p.dragCoef);
    const ship = makeShip(Math.PI / 2);
    let prevSpeed = 0;
    for (let i = 0; i < 4000; i++) {
      stepShipSailing(ship, neutralInput(), WIND, SIM_DT, p);
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
    const p = HELM_STEADY;
    const waveRoll = 0.2;
    const ship = makeShip(Math.PI / 2); // beam wind, full trim
    ship.quaternion = quatMul(ship.quaternion, quatFromAxisAngle([0, 0, 1], waveRoll));
    for (let i = 0; i < 900; i++) stepShipSailing(ship, neutralInput(), WIND, SIM_DT, p);
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
    let sum2 = 0;
    let n = 0;
    for (let i = 0; i < 1800; i++) {
      const t = (i + 1) * SIM_DT;
      ocean.update(t);
      stepShipSailing(ship, input, WIND, SIM_DT);
      stepShipBuoyancy(ship, ocean, SIM_DT);
      if (i >= 600) {
        const pitch = pitchOf(ship.quaternion);
        maxPitch = Math.max(maxPitch, Math.abs(pitch));
        sum2 += pitch * pitch;
        n++;
      }
      if (!ship.quaternion.every(Number.isFinite)) {
        throw new Error(`quaternion went non-finite at tick ${i}`);
      }
    }
    const maxPitchDeg = (maxPitch * 180) / Math.PI;
    const rmsPitchDeg = (Math.sqrt(sum2 / n) * 180) / Math.PI;
    // The RMS is the feel number and the one worth pinning: a 35 m hull in
    // a 3.5 m sea works, visibly, without hobby-horsing. The MAX is only a
    // runaway guard — it is a ~4σ outlier of the same signal, so bounding
    // it tightly (it was 15°) says nothing about feel and everything about
    // how strongly the hull is allowed to answer at all. Pinned loosely on
    // purpose, with the RMS carrying the real assertion.
    expect(rmsPitchDeg).toBeGreaterThan(1.5); // she works in a seaway
    expect(rmsPitchDeg).toBeLessThan(7); // and does not hobby-horse
    expect(maxPitchDeg).toBeLessThan(25); // nothing double-adds/runs away
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

/**
 * §B.23 — "it goes always way too straight constantly." Measured before
 * this existed: leeway 0.00° at every point of sail, and 0.14° of heading
 * change over two minutes of open-water sailing at swell. A ship that
 * travels exactly where she points and holds a heading to a tenth of a
 * degree is a vehicle on rails; these tests hold the model to the two
 * things that make a square-rigger not one.
 */
describe('§B.23: she crabs and she hunts — a ship, not a rail vehicle', () => {
  /** steady-state leeway angle (deg, magnitude) at a given angle off the wind */
  function leewayAt(theta: number): { deg: number; fwd: number } {
    const ship = makeShip(theta);
    for (let i = 0; i < 4000; i++) {
      stepShipSailing(ship, neutralInput(), WIND, SIM_DT, HELM_STEADY);
    }
    const yaw = yawOf(ship.quaternion);
    const f = ship.velocity[0] * Math.sin(yaw) + ship.velocity[2] * Math.cos(yaw);
    const l = ship.velocity[0] * Math.cos(yaw) - ship.velocity[2] * Math.sin(yaw);
    return { deg: Math.abs((Math.atan2(l, f) * 180) / Math.PI), fwd: f };
  }

  it('she makes leeway, and MORE of it the closer she points', () => {
    // The sail force is perpendicular to the canvas: only part of it is
    // drive. Close-hauled most of it is side force, which is why a
    // square-rigger crabs to leeward and why she cannot work upwind well.
    // Running dead downwind there is nothing sideways left to give.
    const close = leewayAt(Math.PI / 2 + Math.PI / 4); // 45° off the eye… but
    const beam = leewayAt(Math.PI / 2); // 90° off the eye
    const running = leewayAt(Math.PI / 12); // nearly dead downwind
    expect(beam.deg).toBeGreaterThan(1); // she does not go where she points
    expect(beam.deg).toBeLessThan(12); // …but she is not sliding sideways
    expect(close.deg).toBeGreaterThan(beam.deg * 1.3); // pointing up costs
    expect(running.deg).toBeLessThan(beam.deg * 0.6); // running costs nothing
    // and she is still SAILING at each of them — leeway that only exists
    // because she stopped would be a stall, not leeway
    expect(beam.fwd).toBeGreaterThan(3);
    expect(close.fwd).toBeGreaterThan(3);
  });

  it('a heeled ship gripes up into the wind (weather helm)', () => {
    // Heel makes the hull asymmetric and she carries weather helm: the
    // heading must NOT be a fixed point of an unattended tick. Small,
    // though — a nuisance for the helmsman, not a spin.
    const ship = makeShip(Math.PI / 2);
    const start = yawOf(ship.quaternion);
    for (let i = 0; i < 3600; i++) {
      stepShipSailing(ship, neutralInput(), WIND, SIM_DT);
    }
    const turned = Math.abs(wrapPi(yawOf(ship.quaternion) - start));
    const deg = (turned * 180) / Math.PI;
    expect(deg).toBeGreaterThan(2); // in 60 s hands off, she has moved
    expect(deg).toBeLessThan(45); // …but has not rounded up into irons
    // she is still drawing: rounding up must not have stalled her
    expect(planarSpeed(ship.velocity)).toBeGreaterThan(5);
  });

  it('the SWELL makes her hunt — flat water does not', () => {
    // The hunting reads roll RATE, so it is the SEA doing it, not a bias:
    // in flat water the same ship on the same heading must be quiet, or
    // what we built is a drift, not a response. (It was: driving the helm
    // from the roll ANGLE picked up the few degrees by which sailing's heel
    // offset and buoyancy's righting moment disagree, and turned her 58° in
    // 120 s of dead calm.)
    const wander = (amplitude: number): number => {
      const ocean = new CpuOcean(5, { ...oceanParams, resolution: 128, amplitude });
      const ship = makeShip(Math.PI / 2);
      const yaws: number[] = [];
      for (let i = 0; i < 7200; i++) {
        const t = (i + 1) * SIM_DT;
        ocean.update(t);
        stepShipSailing(ship, neutralInput(), WIND, SIM_DT, {
          ...sailingParams,
          weatherHelmGain: 0, // isolate the SEA's contribution from the wind's
        });
        stepShipBuoyancy(ship, ocean, SIM_DT);
        if (i >= 1800) yaws.push(yawOf(ship.quaternion));
      }
      // RMS about the straight-line trend: pure wander, not net drift
      const n = yaws.length;
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let sxy = 0;
      for (let i = 0; i < n; i++) {
        sx += i;
        sy += yaws[i];
        sxx += i * i;
        sxy += i * yaws[i];
      }
      const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
      const inter = (sy - slope * sx) / n;
      let s2 = 0;
      for (let i = 0; i < n; i++) {
        const r = yaws[i] - (inter + slope * i);
        s2 += r * r;
      }
      return (Math.sqrt(s2 / n) * 180) / Math.PI;
    };
    const flat = wander(0);
    const seaway = wander(oceanParams.amplitude);
    expect(flat).toBeLessThan(0.05); // glass: she tracks
    expect(seaway).toBeGreaterThan(0.5); // swell: she hunts, visibly
    expect(seaway).toBeLessThan(15); // …but she is not broaching
  });
});

describe('§B.22: the planar channel has ONE owner', () => {
  it('buoyancy never moves her horizontally — sailing integrates position', () => {
    // Both systems ran `position += velocity·dt` on the same tick, so every
    // ship travelled EXACTLY TWICE her own velocity over the ground: she
    // outran her own wake, her own drag equilibrium and the sea's encounter
    // frequency, at 26 knots of "13 m/s". This is the same shape as the
    // grounding bug (two owners of one channel) and it is worth a standing
    // guard: buoyancy may add horizontal FORCE, it may not integrate.
    const ocean = new CpuOcean(3);
    const ship = makeShip(0.7);
    ship.velocity[0] = 3;
    ship.velocity[2] = 4;
    ocean.update(SIM_DT);
    const before: Vec3 = [...ship.position];
    stepShipBuoyancy(ship, ocean, SIM_DT);
    expect(ship.position[0]).toBe(before[0]);
    expect(ship.position[2]).toBe(before[2]);
    expect(ship.position[1]).not.toBe(before[1]); // it DOES own the vertical
  });

  it('a full tick advances the ground track by exactly velocity·dt', () => {
    // the end-to-end version: whatever each module does internally, one
    // sim tick must move her one tick's worth
    const ocean = new CpuOcean(3);
    const ship = makeShip(Math.PI / 2);
    for (let i = 0; i < 600; i++) {
      const t = (i + 1) * SIM_DT;
      stepShipSailing(ship, neutralInput(), WIND, SIM_DT);
      ocean.update(t);
      stepShipBuoyancy(ship, ocean, SIM_DT);
    }
    const before: Vec3 = [...ship.position];
    stepShipSailing(ship, neutralInput(), WIND, SIM_DT);
    const expectX = before[0] + ship.velocity[0] * SIM_DT;
    const expectZ = before[2] + ship.velocity[2] * SIM_DT;
    ocean.update(601 * SIM_DT);
    stepShipBuoyancy(ship, ocean, SIM_DT);
    expect(ship.position[0]).toBeCloseTo(expectX, 12);
    expect(ship.position[2]).toBeCloseTo(expectZ, 12);
  });
});
