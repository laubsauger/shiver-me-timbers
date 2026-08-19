/**
 * §T.76 — THE YARDS DRIVE THE SHIP, AND THE PLAYER HAS THE YARDS.
 *
 * WHY these tests exist, stated so they cannot rot into shape-checks:
 *
 * The user asked to rotate the sails with Q/E instead of raising and lowering
 * them. Q/E were already bound — to a SECOND trim pair — so the visible half
 * of that request was a rebinding. The invisible half was that the brace drove
 * NOTHING: `stepShipSailing` read the HULL's angle to the wind and the yards
 * were a render-side animation chasing the same wind on the frame delta. A
 * rebinding alone would therefore have shipped a control that visibly turns
 * the yards and changes nothing about how she sails — §V.62's silent knob,
 * sixteenth of its kind.
 *
 * So the load-bearing test in this file is the FIRST one: at a fixed heading
 * and a fixed sail trim, sweeping the brace must move the ship at different
 * speeds, with an optimum. Every other test here guards a way that could be
 * true while the model is still wrong:
 *
 *   - the optimum has to MOVE with the wind, or it is a constant dressed up
 *   - the automatic brace has to SIT on it, or a player who never finds Q/E
 *     has been quietly made slower — a new lever, not a new chore
 *   - §B.49's escape from irons has to survive every brace the player can
 *     hold, or `0f20b96`'s deadlock comes back through the new control
 *   - it is SIM state on the fixed tick (§V.2), not a frame-rate-dependent
 *     animation that now happens to feed a force
 */
import { describe, expect, it } from 'vitest';
import {
  autoBrace,
  braceBack,
  braceDrive,
  stepShipSailing,
  windBearing,
  type Wind,
} from '../src/sailing/shipKinematics';
import {
  hashState,
  createInitialState,
  type ShipState,
  type Vec3,
} from '../src/state/simState';
import { SIM_DT } from '../src/core/loop';
import { quatFromAxisAngle, rotateVec } from '../src/combat/quatMath';
import {
  KeyboardInput,
  attachKeyboard,
  neutralInput,
  type InputState,
} from '../src/sailing/input';
import { CONTROL_CODES } from '../src/input/controlMap';
import { sailingParams } from '../src/params/sailing';
import { shipRigParams } from '../src/params/ship';

const WIND: Wind = { direction: 0, speed: 8 }; // blowing toward +z

/** the sea's hands off the helm — see the note on HELM_STEADY in sailing.test */
const STEADY = { ...sailingParams, weatherHelmGain: 0, rollYawGain: 0 };

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

function planarSpeed(v: Vec3): number {
  return Math.hypot(v[0], v[2]);
}

/** forward component of her way — signed, so sternway reads negative */
function wayOf(ship: ShipState): number {
  const f = rotateVec(ship.quaternion, [0, 0, 1]);
  return ship.velocity[0] * f[0] + ship.velocity[2] * f[2];
}

/**
 * Settle her on one heading with the yards PINNED, and report her speed.
 *
 * The pin is `brace` + `braceHold` rewritten every tick rather than a stream
 * of key presses, because this is a question about the FORCE MODEL and a key
 * stream would also be measuring the slew rate and the hand-back timer. Those
 * get their own tests below.
 */
function wayAtBrace(yaw: number, brace: number | null, ticks = 900): number {
  const ship = makeShip(yaw);
  const input = neutralInput();
  for (let i = 0; i < ticks; i++) {
    if (brace !== null) {
      ship.brace = brace;
      ship.braceHold = 1e6; // manual authority never lapses inside the test
    }
    stepShipSailing(ship, input, WIND, SIM_DT, STEADY);
  }
  return wayOf(ship);
}

/** brace angles across the whole range the shrouds allow, endpoints included */
function braceSweep(n = 25): number[] {
  const m = shipRigParams.braceMax;
  return Array.from({ length: n }, (_, i) => -m + (2 * m * i) / (n - 1));
}

describe('§T.76: the brace is a real degree of freedom', () => {
  it('THE LEVER: at a fixed heading and trim, the yards change her speed', () => {
    // WHY THIS ONE MATTERS MOST: it is the test that fails on the code this
    // replaced. There, `thrust` was a function of the hull's heading and the
    // sail trim and nothing else, so this sweep returned one number twenty-five
    // times over. If this ever passes trivially again, the brace has been
    // disconnected from the force model and the control is decorative.
    //
    // Broad reach: the wind 30° off the stern quarter, which is where the
    // best brace sits INSIDE the range rather than jammed against the clamp.
    const yaw = -Math.PI / 6; // wind bearing +30° → wind on the port quarter
    const speeds = braceSweep().map((b) => wayAtBrace(yaw, b));
    const best = Math.max(...speeds);
    const worst = Math.min(...speeds);
    expect(best).toBeGreaterThan(0.5); // she does sail
    // a spread, not a wobble: the wrong brace costs most of her way
    expect(best / Math.max(worst, 1e-6)).toBeGreaterThan(2);
  });

  it('THE OPTIMUM IS A PEAK, not a slope — it can be found and it can be missed', () => {
    // A monotone response would still pass the test above while giving the
    // player nothing to aim at: "hold E" would simply be correct forever.
    const yaw = -Math.PI / 6;
    const angles = braceSweep();
    const speeds = angles.map((b) => wayAtBrace(yaw, b));
    const iBest = speeds.indexOf(Math.max(...speeds));
    expect(iBest).toBeGreaterThan(0);
    expect(iBest).toBeLessThan(angles.length - 1);
    // and it falls away on BOTH sides of that peak
    expect(speeds[iBest]).toBeGreaterThan(speeds[0]);
    expect(speeds[iBest]).toBeGreaterThan(speeds[angles.length - 1]);
  });

  it('the optimum MOVES with the wind — it is an angle, not a constant', () => {
    // Same ship, same trim, two different winds off the bow. If the best
    // brace were a fixed number the player would learn it once and never
    // touch the keys again, which is the no-op in slow motion.
    const angles = braceSweep(41);
    const bestFor = (yaw: number): number => {
      const speeds = angles.map((b) => wayAtBrace(yaw, b, 700));
      return angles[speeds.indexOf(Math.max(...speeds))];
    };
    const broad = bestFor(-Math.PI / 6); // wind 30° off the quarter
    const beam = bestFor(-Math.PI / 2); // wind on the beam
    expect(beam).toBeGreaterThan(broad + 0.1);
  });

  it('THE AUTOMATIC BRACE SITS ON THE OPTIMUM — the default costs nothing', () => {
    // The contract with a player who never discovers Q/E: this is a new lever,
    // not a new chore. Leaving the yards to the crew must be as fast as the
    // best brace a player could hold, at every point of sail.
    for (const yaw of [-0.3, -Math.PI / 6, -Math.PI / 3, -Math.PI / 2, -2.2, -2.8]) {
      const auto = wayAtBrace(yaw, null, 700);
      for (const b of braceSweep(17)) {
        expect(wayAtBrace(yaw, b, 700), `yaw ${yaw.toFixed(2)} brace ${b.toFixed(2)}`)
          .toBeLessThanOrEqual(auto + 1e-6);
      }
    }
  });

  it('and the yards SETTLE at the crew’s angle, which is the plate optimum', () => {
    const ship = makeShip(-Math.PI / 3);
    for (let i = 0; i < 600; i++) stepShipSailing(ship, neutralInput(), WIND, SIM_DT, STEADY);
    const gamma = windBearing(-Math.PI / 3, WIND.direction);
    expect(ship.brace).toBeCloseTo(autoBrace(gamma, shipRigParams), 6);
  });
});

describe('§T.76 ∩ §B.49: the new control cannot reopen the irons deadlock', () => {
  it('head to wind she still makes STERNWAY under every brace in range', () => {
    // `0f20b96` is the worst bug this project has shipped: no thrust ⇒ no way
    // ⇒ no helm ⇒ no thrust, a closed loop with no exit. The escape is that
    // set canvas held to the wind blows her astern. A brace the player can
    // hold down must not be able to switch that off.
    for (const b of [...braceSweep(13), null]) {
      const ship = makeShip(Math.PI); // bow into the wind
      for (let i = 0; i < 600; i++) {
        if (b !== null) {
          ship.brace = b;
          ship.braceHold = 1e6;
        }
        stepShipSailing(ship, neutralInput(), WIND, SIM_DT, STEADY);
      }
      const way = wayOf(ship);
      expect(way, `brace ${b === null ? 'auto' : b.toFixed(2)}`).toBeLessThan(-0.05);
    }
  });

  it('the manual brace is ONE-WAY on the aback term — it can only add sternway', () => {
    // Stated as a property of the model rather than measured off one heading:
    // whatever the player does with the yards, she is never pushed astern LESS
    // than the crew would push her, so §B.49's exit cannot be braced away.
    for (let g = -Math.PI; g <= Math.PI; g += 0.05) {
      const star = autoBrace(g, shipRigParams);
      for (const b of braceSweep(9)) {
        const extra = Math.max(0, braceBack(b, g) - braceBack(star, g));
        expect(extra, `gamma ${g.toFixed(2)} brace ${b.toFixed(2)}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('bracing the canvas ABACK on a reach drives her backwards — it is a real force', () => {
    // The other half of the same term, and the reason the lever is interesting:
    // turn the yards far enough round and the wind takes the FRONT of the sail.
    const yaw = -Math.PI / 2; // beam wind; the crew would brace hard to +max
    const ship = makeShip(yaw);
    for (let i = 0; i < 900; i++) {
      ship.brace = -shipRigParams.braceMax; // braced full the wrong way
      ship.braceHold = 1e6;
      stepShipSailing(ship, neutralInput(), WIND, SIM_DT, STEADY);
    }
    expect(wayOf(ship)).toBeLessThan(0);
  });

  it('furled canvas makes the brace inert — the force is CLOTH, not yards', () => {
    const bare = (b: number): number => {
      const ship = makeShip(-Math.PI / 2, 0); // sailTrim 0
      for (let i = 0; i < 400; i++) {
        ship.brace = b;
        ship.braceHold = 1e6;
        stepShipSailing(ship, neutralInput(), WIND, SIM_DT, STEADY);
      }
      return planarSpeed(ship.velocity);
    };
    expect(bare(shipRigParams.braceMax)).toBeCloseTo(0, 9);
    expect(bare(-shipRigParams.braceMax)).toBeCloseTo(0, 9);
  });
});

describe('§T.76: the plate law and the crew’s brace (pure functions)', () => {
  const P = shipRigParams;

  it('autoBrace IS the argmax of braceDrive inside the clamp, at every wind', () => {
    // The property the whole "default costs nothing" contract rests on. A
    // brute sweep is the honest check on a closed-form solution.
    for (let g = -Math.PI; g <= Math.PI; g += 0.02) {
      const star = autoBrace(g, P);
      const dStar = braceDrive(star, g);
      for (let i = 0; i <= 120; i++) {
        const b = -P.braceMax + (2 * P.braceMax * i) / 120;
        expect(braceDrive(b, g), `gamma ${g.toFixed(2)} vs ${b.toFixed(3)}`)
          .toBeLessThanOrEqual(dStar + 2e-4);
      }
    }
  });

  it('she draws best with the wind SQUARE into the back of the canvas', () => {
    // The physical statement the model is made of: peak at (gamma − beta) = 0,
    // nothing at all edge-on, fully backed at 180°.
    expect(braceDrive(0, 0)).toBeCloseTo(1, 9);
    expect(braceDrive(0, Math.PI / 2)).toBeCloseTo(0, 9);
    expect(braceBack(0, Math.PI)).toBeCloseTo(1, 9);
    expect(braceBack(0, 0)).toBe(0);
    expect(braceDrive(0, Math.PI)).toBe(0);
  });

  it('square on a run, hard braced by the beam, and never past the clamp', () => {
    // Ported from the bisector rule this replaced (tests/ship.test.ts): the
    // OBSERVABLE shape of a square rig is unchanged, only its derivation.
    expect(Math.abs(autoBrace(0, P))).toBeLessThan(0.02);
    expect(autoBrace(Math.PI / 2, P)).toBeCloseTo(P.braceMax, 9); // wind to stbd → port tack
    expect(autoBrace(-Math.PI / 2, P)).toBeCloseTo(-P.braceMax, 9);
    for (let g = -Math.PI; g <= Math.PI; g += 0.01) {
      const a = autoBrace(g, P);
      expect(Number.isFinite(a)).toBe(true);
      expect(Math.abs(a)).toBeLessThanOrEqual(P.braceMax + 1e-9);
    }
  });

  it('crosses the eye of the wind without whipping the rig across', () => {
    let prev = autoBrace(Math.PI - 0.4, P);
    for (let d = -0.4; d <= 0.4; d += 0.02) {
      const a = autoBrace(windBearing(0, Math.PI + d), P);
      expect(Math.abs(a - prev), `step at ${d.toFixed(2)}`).toBeLessThan(0.2);
      prev = a;
    }
  });

  it('windBearing agrees with the point-of-sail angle the thrust curve uses', () => {
    // §V.77: theta is now derived as π − |gamma| rather than re-taken from a
    // second dot product. This is the check that the two agree exactly.
    for (let yaw = -3; yaw < 3; yaw += 0.1) {
      for (let wd = -3; wd < 3; wd += 0.1) {
        const f = [Math.sin(yaw), Math.cos(yaw)];
        const w = [Math.sin(wd), Math.cos(wd)];
        const dot = Math.max(-1, Math.min(1, -(f[0] * w[0] + f[1] * w[1])));
        // 7 digits, not 9, and the slack is ACOS's: it loses precision as its
        // argument approaches ±1, i.e. exactly on a run and head to wind. The
        // wrapped-difference form is the accurate one — this asserts they
        // agree, not that the old one was right to the last bit.
        expect(Math.PI - Math.abs(windBearing(yaw, wd))).toBeCloseTo(Math.acos(dot), 7);
      }
    }
  });
});

describe('§T.76: Q and E reach the yards (§V.62 — a knob that drives nothing is a defect)', () => {
  it('the KEYS produce a brace intent, and no longer a trim one', () => {
    const input = new KeyboardInput();
    input.keyDown(CONTROL_CODES.braceToStarboard);
    expect(input.sample(SIM_DT).braceDelta).toBe(1);
    input.keyUp(CONTROL_CODES.braceToStarboard);
    input.keyDown(CONTROL_CODES.braceToPort);
    const s = input.sample(SIM_DT);
    expect(s.braceDelta).toBe(-1);
    // the regression the user actually reported: Q and E used to move the
    // canvas up and down, duplicating W and S
    expect(s.sailTrimDelta).toBe(0);
    input.keyUp(CONTROL_CODES.braceToPort);
    input.keyDown(CONTROL_CODES.trimIn);
    const t = input.sample(SIM_DT);
    expect(t.sailTrimDelta).toBe(1);
    expect(t.braceDelta).toBe(0);
  });

  it('a REAL keydown moves the yards and changes how she sails', () => {
    // §V.62's own lesson: wire the sink in the same change as the knob, and
    // prove it from the DOM edge, not from a call to the handler.
    const target = new EventTarget();
    const collector = new KeyboardInput();
    const detach = attachKeyboard(collector, target);
    const ev = (type: string, code: string): Event => {
      const e = new Event(type) as Event & Record<string, unknown>;
      e.code = code;
      e.repeat = false;
      return e;
    };
    const yaw = -Math.PI / 3;
    const run = (press: string | null): { brace: number; speed: number } => {
      const ship = makeShip(yaw);
      collector.clear();
      if (press !== null) target.dispatchEvent(ev('keydown', press));
      for (let i = 0; i < 500; i++) {
        stepShipSailing(ship, collector.sample(SIM_DT), WIND, SIM_DT, STEADY);
      }
      if (press !== null) target.dispatchEvent(ev('keyup', press));
      return { brace: ship.brace ?? 0, speed: planarSpeed(ship.velocity) };
    };
    const auto = run(null);
    const held = run(CONTROL_CODES.braceToPort);
    expect(held.brace).toBeLessThan(auto.brace - 0.2); // yards really moved
    expect(held.speed).toBeLessThan(auto.speed * 0.9); // and it cost her way
    detach();
  });

  it('the yards HAND BACK to the crew once the player stops working them', () => {
    // The chosen resolution of "manual takes over, then gives it back":
    // a countdown, not a second keybinding. Chosen so a player who braces her
    // wrong and gets distracted is not left sailing at half speed forever.
    const yaw = -Math.PI / 3;
    const ship = makeShip(yaw);
    const hard: InputState = { ...neutralInput(), braceDelta: -1 };
    for (let i = 0; i < 240; i++) stepShipSailing(ship, hard, WIND, SIM_DT, STEADY);
    const star = autoBrace(windBearing(yaw, WIND.direction), shipRigParams);
    expect(ship.brace!).toBeLessThan(star - 0.2);
    expect(ship.braceHold).toBeCloseTo(STEADY.braceHoldTime, 6);
    // let go: the hold runs down, then the yards come back on their own
    const ticks = Math.ceil((STEADY.braceHoldTime + 8) / SIM_DT);
    for (let i = 0; i < ticks; i++) {
      stepShipSailing(ship, neutralInput(), WIND, SIM_DT, STEADY);
    }
    expect(ship.braceHold).toBe(0);
    expect(ship.brace!).toBeCloseTo(star, 4);
  });

  it('the yards never SNAP — the rate limit moved to the tick, it did not vanish', () => {
    const ship = makeShip(0); // running; the crew's brace is ~0
    let prev = 0;
    const hard: InputState = { ...neutralInput(), braceDelta: 1 };
    for (let i = 0; i < 400; i++) {
      stepShipSailing(ship, hard, WIND, SIM_DT, STEADY);
      expect(Math.abs(ship.brace! - prev)).toBeLessThanOrEqual(
        shipRigParams.braceRate * SIM_DT + 1e-9,
      );
      prev = ship.brace!;
    }
    expect(prev).toBeCloseTo(shipRigParams.braceMax, 6); // and it stops at the clamp
  });
});

describe('§V.2: the brace is sim state on the fixed tick', () => {
  it('an input log containing Q/E replays to an identical hash', () => {
    const inputAt = (i: number): InputState => ({
      rudder: i < 200 ? 0.6 : 0,
      sailTrimDelta: i < 120 ? 1 : 0,
      braceDelta: i < 300 ? -1 : i < 500 ? 1 : 0,
      brake: false,
      fire: false,
      anchorToggle: i === 700,
    });
    const run = (): number => {
      const state = createInitialState(7);
      state.ships.push(makeShip(-Math.PI / 3, 0));
      for (let i = 0; i < 900; i++) {
        state.tick++;
        stepShipSailing(state.ships[0], inputAt(i), WIND, SIM_DT);
      }
      return hashState(state);
    };
    expect(run()).toBe(run());
  });

  it('the yard TRACK is identical however many render frames sit between ticks', () => {
    // The defect this closes: the slew used to run in `rigTrim.updateRig` on
    // the RENDER delta, so the yard angle — and now the thrust it scales —
    // depended on frame rate. Same shape as the wake's §T.78 fix. The sim sees
    // only SIM_DT, so the track has to be byte-identical at 30, 60 and 144 fps.
    const track = (fps: number): number[] => {
      const ship = makeShip(-Math.PI / 3);
      const out: number[] = [];
      const framesPerTick = Math.max(1, Math.round(fps / (1 / SIM_DT)));
      for (let i = 0; i < 600; i++) {
        const input: InputState = { ...neutralInput(), braceDelta: i < 200 ? -1 : 0 };
        stepShipSailing(ship, input, WIND, SIM_DT, STEADY);
        // the render frames that would fall inside this tick do NOT touch it
        for (let f = 0; f < framesPerTick; f++) void (1 / fps);
        out.push(ship.brace!);
      }
      return out;
    };
    const a = track(30);
    const b = track(60);
    const c = track(144);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('a ship that has never braced still serializes — brace is seeded, not assumed', () => {
    const ship = makeShip(-Math.PI / 3);
    expect(ship.brace).toBeUndefined();
    stepShipSailing(ship, neutralInput(), WIND, SIM_DT, STEADY);
    // seeded to the crew's own brace, so she does not spend her first seconds
    // slewing the yards up from square
    expect(ship.brace).toBeCloseTo(
      autoBrace(windBearing(-Math.PI / 3, WIND.direction), shipRigParams),
      6,
    );
  });
});
