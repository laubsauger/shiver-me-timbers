/**
 * §T.94 first-person walker. WHY each block exists:
 *
 * - §V73/§V85: the deck MOVES. Every ground-contact assumption of a static
 *   controller breaks on it, so the properties are asserted on a surface that
 *   heaves under the walker's feet, and speed is measured against the DECK.
 * - §V80: these pin PROPERTIES (gate(x) blocks ⟺ x beyond the limit, with the
 *   limit read from the same params object the code reads), never the numbers.
 * - §V62: a key that is bound and drives nothing is this project's signature
 *   defect; the keyboard path is exercised through a real EventTarget and the
 *   assertion is that SimState moved.
 * - §V2: the core is pure and deterministic; the same input log twice must
 *   produce identical state, and no input may produce NaN.
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import {
  createPlayerState,
  neutralPlayerInput,
  stepPlayer,
  type PlayerInput,
  type PlayerState,
  type Vec3,
  type WalkSurface,
} from '../src/player/playerStep';
import { lookFromMouse, LookAccumulator } from '../src/player/pointerLock';
import { PlayerKeys, attachPlayerKeys } from '../src/player/playerInput';
import { createDeckSurface } from '../src/player/deckSurface';
import { createPlayer } from '../src/player/index';
import { playerParams } from '../src/params/player';
import { CONTROL_CODES } from '../src/input/controlMap';
import { buildGalleonBlueprint } from '../src/ship/shipBlueprint';
import { buildDeckHeightfield, sampleDeckField } from '../src/ship/deckHeightfield';
import { createInitialState } from '../src/state/simState';
import { FollowCam } from '../src/camera/followCam';

const DT = 1 / 60;
const P = playerParams;

function flat(h: (x: number, z: number) => number | null, extra: Partial<WalkSurface> = {}): WalkSurface {
  return { heightAt: h, solidAt: () => false, ...extra };
}

function walkInput(over: Partial<PlayerInput> = {}): PlayerInput {
  return { ...neutralPlayerInput(), forward: 1, ...over };
}

/** stand the walker on the surface before the scenario begins */
function settled(surface: WalkSurface, pos: Vec3 = [0, 0, 0], yaw = 0): PlayerState {
  let s = createPlayerState(pos, yaw);
  for (let i = 0; i < 5; i++) s = stepPlayer(s, neutralPlayerInput(), surface, DT);
  return s;
}

function run(s: PlayerState, surface: WalkSurface, input: PlayerInput, seconds: number, each?: (s: PlayerState) => void): PlayerState {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    s = stepPlayer(s, input, surface, DT);
    each?.(s);
  }
  return s;
}

describe('§V85 speed is measured against the deck, and the feet stay on it', () => {
  it('walking 10 s across a heaving, rolling surface keeps deck-relative speed within ±5% of walkSpeed', () => {
    // height = A·sin(ωt + kx): a 0.5 m swell rolling under the walker at
    // 1 rad/s, slopes up to 21°. The walker heads along +x so it climbs and
    // descends the moving slope; speed is the HORIZONTAL displacement in the
    // deck's own frame, which is what §V85 says "standing still" is about.
    let t = 0;
    const A = 0.5;
    const k = (2 * Math.PI) / 8;
    const surface = flat((x) => A * Math.sin(t + k * x));
    let s = settled(surface, [0, 0, 0], Math.PI / 2); // +yaw turns toward +x
    const x0 = s.pos[0];
    let worstGap = 0;
    const steps = Math.round(10 / DT);
    for (let i = 0; i < steps; i++) {
      t += DT;
      s = stepPlayer(s, walkInput(), surface, DT);
      worstGap = Math.max(worstGap, Math.abs(s.pos[1] - (surface.heightAt(s.pos[0], s.pos[2]) as number)));
    }
    const speed = Math.hypot(s.pos[0] - x0, s.pos[2]) / 10;
    expect(speed).toBeGreaterThan(P.walkSpeed * 0.95);
    expect(speed).toBeLessThan(P.walkSpeed * 1.05);
    expect(s.grounded).toBe(true);
    // never sinking through nor floating above the moving planks (§V73c)
    expect(worstGap).toBeLessThan(0.01);
  });

  it('standing still on the same surface is zero deck-relative velocity', () => {
    let t = 0;
    const surface = flat((x) => 0.5 * Math.sin(t + x));
    let s = settled(surface);
    for (let i = 0; i < 120; i++) {
      t += DT;
      s = stepPlayer(s, neutralPlayerInput(), surface, DT);
    }
    expect(Math.hypot(s.vel[0], s.vel[2])).toBe(0);
    expect(s.pos[0]).toBe(0);
    expect(s.pos[2]).toBe(0);
  });
});

describe('steps and slopes gate exactly at the params', () => {
  const stepOf = (rise: number): WalkSurface => flat((_x, z) => (z > 1 ? rise : 0));
  it('a rise of stepUp is climbed in stride; one past it is a wall', () => {
    const up = run(settled(stepOf(P.stepUp - 0.01)), stepOf(P.stepUp - 0.01), walkInput(), 2);
    expect(up.pos[2]).toBeGreaterThan(1.5);
    expect(up.pos[1]).toBeCloseTo(P.stepUp - 0.01, 6);
    const wall = run(settled(stepOf(P.stepUp + 0.1)), stepOf(P.stepUp + 0.1), walkInput(), 2);
    expect(wall.pos[2]).toBeLessThanOrEqual(1);
    expect(wall.pos[1]).toBe(0);
  });

  it('a 0.4 step climbs, 0.5 blocks (the spec’s own numbers, at the default stepUp)', () => {
    expect(P.stepUp).toBeCloseTo(0.4, 9);
    expect(run(settled(stepOf(0.4)), stepOf(0.4), walkInput(), 2).pos[1]).toBeCloseTo(0.4, 6);
    expect(run(settled(stepOf(0.5)), stepOf(0.5), walkInput(), 2).pos[1]).toBe(0);
  });

  const rampOf = (deg: number): WalkSurface => flat((_x, z) => (z > 0 ? Math.tan((deg * Math.PI) / 180) * z : 0));
  it('a ramp 1° under maxSlope is walked up; 1° over it refuses — gate ⟺ beyond the limit', () => {
    const ok = run(settled(rampOf(P.maxSlopeDeg - 1), [0, 0, -0.5]), rampOf(P.maxSlopeDeg - 1), walkInput(), 5);
    expect(ok.pos[1]).toBeGreaterThan(2);
    const no = run(settled(rampOf(P.maxSlopeDeg + 1), [0, 0, -0.5]), rampOf(P.maxSlopeDeg + 1), walkInput(), 5);
    // it may get a probe-length onto the foot of the ramp, never up it
    expect(no.pos[1]).toBeLessThan(P.stepUp);
    expect(no.pos[2]).toBeLessThan(P.slopeProbe + 0.05);
  });

  it('going DOWN a steep ramp is a descent, not a wall', () => {
    const down = flat((_x, z) => (z > 0 ? -Math.tan((50 * Math.PI) / 180) * z : 0));
    const s = run(settled(down, [0, 0, -0.5]), down, walkInput(), 4);
    expect(s.pos[2]).toBeGreaterThan(3);
    expect(s.grounded).toBe(true);
  });

  it('a solid cell is a wall the walker slides along, never enters', () => {
    const surface: WalkSurface = { heightAt: () => 0, solidAt: (x, z) => z > 1 && Math.abs(x) < 0.5 };
    // walk diagonally into the post: z is stopped, x keeps going
    const s = run(settled(surface, [0.2, 0, 0], Math.PI / 4), surface, walkInput(), 3);
    expect(surface.solidAt(s.pos[0], s.pos[2])).toBe(false);
    expect(s.pos[0]).toBeGreaterThan(2);
  });
});

describe('auto-crouch by head clearance, with hysteresis', () => {
  const roof = (c: () => number | null): WalkSurface => flat(() => 0, { ceilingAt: () => c() });
  it('1.5 m clearance crouches, 1.8 m stands, and the return needs the hysteresis margin', () => {
    let ceiling: number | null = null;
    const surface = roof(() => ceiling);
    let s = settled(surface);
    expect(s.crouch).toBe(false);
    ceiling = 1.5;
    s = stepPlayer(s, neutralPlayerInput(), surface, DT);
    expect(s.crouch).toBe(true);
    // JUST enough to stand by the plain height, not by the hysteresis: stays down
    ceiling = P.standHeight + P.crouchHysteresis * 0.5;
    s = stepPlayer(s, neutralPlayerInput(), surface, DT);
    expect(s.crouch).toBe(true);
    ceiling = 1.8;
    s = stepPlayer(s, neutralPlayerInput(), surface, DT);
    expect(s.crouch).toBe(false);
    // and from standing, the plain height is the threshold
    ceiling = P.standHeight - 0.01;
    s = stepPlayer(s, neutralPlayerInput(), surface, DT);
    expect(s.crouch).toBe(true);
  });

  it('a gap lower than the crouched capsule is a wall; the crouch key holds the crouch in the open', () => {
    const low = flat(() => 0, { ceilingAt: (_x, z) => (z > 1 ? P.crouchHeight - 0.1 : null) });
    expect(run(settled(low), low, walkInput(), 2).pos[2]).toBeLessThanOrEqual(1);
    const open = flat(() => 0);
    const s = run(settled(open), open, walkInput({ crouch: true }), 1);
    expect(s.crouch).toBe(true);
    expect(s.pos[2]).toBeCloseTo(P.crouchSpeed, 1);
  });
});

describe('overboard and back (§V85: drift ≤ swim × 0.5 is always catchable)', () => {
  it('walking off the edge of the deck puts the walker in the water, in world coordinates', () => {
    const offset: Vec3 = [100, 0, 0];
    const surface = flat((_x, z) => (z < 2 ? 0 : null), {
      waterAt: () => -1,
      shipToWorld: (p) => [p[0] + offset[0], p[1], p[2]],
    });
    const s = run(settled(surface), surface, walkInput(), 3);
    expect(s.frame).toBe('swim');
    expect(s.pos[0]).toBeGreaterThan(99); // world, not ship-local
    // bobbing at the surface: eye rides swimEyeAbove over the water
    expect(s.pos[1] + P.standHeight - P.eyeDrop).toBeCloseTo(-1 + P.swimEyeAbove, 1);
  });

  it('from 20 m behind a raft drifting away at 0.5 m/s, the boarding point is reached in < 60 s', () => {
    let raftX = 0;
    const boarding: Vec3 = [2, 0, 0];
    const surface = flat((x, z) => (Math.abs(x) < 2 && Math.abs(z) < 2 ? 0 : null), {
      waterAt: () => 0,
      boardingPoints: [boarding],
      shipToWorld: (p) => [p[0] + raftX, p[1], p[2]],
    });
    let s: PlayerState = { frame: 'swim', pos: [raftX + 2 + 20, -1.35, 0], yaw: 0, pitch: 0, vel: [0, 0, 0], crouch: false, grounded: false };
    let t = 0;
    while (t < 60 && s.frame === 'swim') {
      raftX += 0.5 * DT; // away from the swimmer, at swimSpeed × 0.5
      const bx = boarding[0] + raftX;
      const yaw = Math.atan2(bx - s.pos[0], boarding[2] - s.pos[2]);
      s = stepPlayer({ ...s, yaw }, walkInput(), surface, DT);
      t += DT;
    }
    expect(s.frame).toBe('ship');
    expect(t).toBeLessThan(60);
    expect(s.pos).toEqual(boarding); // back aboard AT the rail, ship-local
    expect(s.grounded).toBe(true);
  });

  it('a boarding point out of vertical reach (a deck 3 m up) does not teleport the swimmer aboard', () => {
    const surface = flat(() => 3, { waterAt: () => 0, boardingPoints: [[0, 3, 0]] });
    let s: PlayerState = { frame: 'swim', pos: [0, -1.35, 0], yaw: 0, pitch: 0, vel: [0, 0, 0], crouch: false, grounded: false };
    s = run(s, surface, neutralPlayerInput(), 2);
    expect(s.frame).toBe('swim');
  });
});

describe('pointer-lock look math', () => {
  it('mouse right turns the view right (clockwise seen from above) and mouse down looks down', () => {
    const d = lookFromMouse(10, 0);
    const surface = flat(() => 0);
    const before = settled(surface);
    const after = stepPlayer(before, { ...neutralPlayerInput(), yawDelta: d.yawDelta }, surface, DT);
    // the walker's RIGHT is forward × up = (-cos yaw, 0, sin yaw) in a y-up
    // right-handed frame; after a mouse-right the new forward leans that way
    const right0 = [-Math.cos(before.yaw), Math.sin(before.yaw)];
    const f1 = [Math.sin(after.yaw), Math.cos(after.yaw)];
    expect(right0[0] * f1[0] + right0[1] * f1[1]).toBeGreaterThan(0);
    // which is a rotation about -y: cross(f0, f1).y < 0
    const f0 = [Math.sin(before.yaw), Math.cos(before.yaw)];
    expect(f0[1] * f1[0] - f0[0] * f1[1]).toBeLessThan(0);
    expect(lookFromMouse(0, 10).pitchDelta).toBeLessThan(0);
    expect(lookFromMouse(Number.NaN, Number.NaN).yawDelta).toBe(0);
  });

  it('pitch is clamped to ±pitchLimitDeg however far the mouse travels', () => {
    const surface = flat(() => 0);
    const limit = (P.pitchLimitDeg * Math.PI) / 180;
    const up = stepPlayer(settled(surface), { ...neutralPlayerInput(), pitchDelta: 50 }, surface, DT);
    const down = stepPlayer(settled(surface), { ...neutralPlayerInput(), pitchDelta: -50 }, surface, DT);
    expect(up.pitch).toBeCloseTo(limit, 9);
    expect(down.pitch).toBeCloseTo(-limit, 9);
    expect(Math.abs(up.pitch)).toBeLessThanOrEqual((89 * Math.PI) / 180 + 1e-9);
  });

  it('the accumulator hands over one delta per tick and drains', () => {
    const acc = new LookAccumulator();
    acc.move(5, 0);
    acc.move(5, 0);
    expect(acc.take().yawDelta).toBeCloseTo(lookFromMouse(10, 0).yawDelta, 12);
    expect(acc.take().yawDelta).toBe(0);
  });
});

function keyEvent(type: string, code: string): Event {
  const e = new Event(type, { cancelable: true }) as Event & Record<string, unknown>;
  e.code = code;
  e.repeat = false;
  e.metaKey = false;
  e.altKey = false;
  return e;
}

describe('§V62: the keyboard path moves SimState', () => {
  const galleon = buildGalleonBlueprint();
  const field = buildDeckHeightfield(galleon);
  if (field === null) throw new Error('galleon has no deck field');

  it('a real keydown KeyW on a real EventTarget advances SimState.player along the deck', () => {
    const sim = createInitialState(1);
    const target = new EventTarget();
    const player = createPlayer({
      sim,
      shipPose: () => ({ position: [0, 0, 0], quaternion: [0, 0, 0, 1] }),
      deckField: field,
      keyTarget: target,
      spawn: [1.5, field.deckY, 0],
    });
    const z0 = sim.player!.pos[2];
    // not on the lens: the key must do nothing, or walking would trim sails
    target.dispatchEvent(keyEvent('keydown', CONTROL_CODES.walkForward));
    for (let i = 0; i < 30; i++) player.step(DT);
    expect(sim.player!.pos[2]).toBe(z0);
    player.setActive(true);
    target.dispatchEvent(keyEvent('keydown', CONTROL_CODES.walkForward));
    for (let i = 0; i < 60; i++) player.step(DT);
    expect(sim.player!.pos[2] - z0).toBeCloseTo(P.walkSpeed, 1);
    target.dispatchEvent(keyEvent('keyup', CONTROL_CODES.walkForward));
    const z1 = sim.player!.pos[2];
    for (let i = 0; i < 30; i++) player.step(DT);
    expect(sim.player!.pos[2]).toBe(z1);
    // the camera pose is the eye, in the world, through the ship transform
    const pose = player.cameraPose();
    expect(pose.position.y).toBeCloseTo(sim.player!.pos[1] + P.standHeight - P.eyeDrop, 6);
    player.dispose();
  });

  it('the walker swallows WASD only while active; the toggle key is always heard', () => {
    const keys = new PlayerKeys();
    const target = new EventTarget();
    let active = false;
    attachPlayerKeys(keys, target, () => active);
    // Node's EventTarget has no tree, so "swallowed before the sailing
    // collector's bubble listener" is observed on the event's own
    // stop-propagation flag (`cancelBubble`), the same mechanism freeCam's
    // fly keys rely on in camInput.ts.
    let e = keyEvent('keydown', 'KeyW');
    target.dispatchEvent(e);
    expect(e.cancelBubble).toBe(false);
    expect(keys.sample().forward).toBe(0);
    active = true;
    e = keyEvent('keydown', 'KeyW');
    target.dispatchEvent(e);
    expect(e.cancelBubble).toBe(true);
    expect(keys.sample().forward).toBe(1);
    active = false;
    target.dispatchEvent(keyEvent('keydown', CONTROL_CODES.toggleFirstPerson));
    expect(keys.takeToggle()).toBe(true);
    expect(keys.takeToggle()).toBe(false);
  });

  it('applyAction is a hook: unknown names report false instead of silently doing nothing', () => {
    const sim = createInitialState(1);
    const player = createPlayer({
      sim,
      shipPose: () => ({ position: [0, 0, 0], quaternion: [0, 0, 0, 1] }),
      deckField: field,
      keyTarget: new EventTarget(),
    });
    expect(player.applyAction('oar', 0.5)).toBe(false);
    let got: unknown = null;
    const off = player.onAction('oar', (v) => (got = v));
    expect(player.applyAction('oar', 0.5)).toBe(true);
    expect(got).toBe(0.5);
    off();
    expect(player.applyAction('oar', 1)).toBe(false);
    player.dispose();
  });

  it("followCam 'fp' puts the lens exactly at the walker's eye, no smoothing, and drops back without a source", () => {
    const fakeWindow = new EventTarget();
    const prev = (globalThis as Record<string, unknown>).window;
    (globalThis as Record<string, unknown>).window = fakeWindow;
    try {
      const camera = new PerspectiveCamera(55, 1, 0.1, 5000);
      const cam = new FollowCam(camera, new EventTarget() as unknown as HTMLElement);
      const ship = { id: 'p', kind: 'player' as const, position: [0, 0, 0] as Vec3, quaternion: [0, 0, 0, 1] as [number, number, number, number], velocity: [0, 0, 0] as Vec3, angularVelocity: [0, 0, 0] as Vec3, rudder: 0, sailTrim: 0, flood: 0, damage: {} };
      cam.update(ship, DT);
      const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.7);
      cam.setPoseSource(() => ({ position: new Vector3(12, 3.4, -5), quaternion: q }));
      cam.setMode('fp');
      cam.update(ship, DT);
      expect(camera.position.toArray()).toEqual([12, 3.4, -5]);
      expect(camera.quaternion.angleTo(q)).toBeLessThan(1e-9);
      cam.setPoseSource(null);
      cam.update(ship, DT);
      expect(cam.getMode()).toBe('follow');
      cam.dispose();
    } finally {
      (globalThis as Record<string, unknown>).window = prev;
    }
  });
});

describe('the real galleon deck', () => {
  const galleon = buildGalleonBlueprint();
  const field = buildDeckHeightfield(galleon);
  if (field === null) throw new Error('galleon has no deck field');
  const surface = createDeckSurface(field);
  const enteredSolid = (x: number, z: number): boolean => sampleDeckField(field, field.solid, x, z) >= 0.5;

  /** follow waypoints, asserting the two walk properties every tick */
  function walkRoute(route: Array<[number, number]>, params = P): { s: PlayerState; reached: number } {
    const [sx, sz] = route[0];
    let s = createPlayerState([sx, field!.deckY, sz]);
    s.pos[1] = surface.heightAt(sx, sz) as number;
    s.grounded = true;
    let next = 1;
    let ticks = 0;
    while (next < route.length && ticks < 120 * 60) {
      const [tx, tz] = route[next];
      const dx = tx - s.pos[0];
      const dz = tz - s.pos[2];
      if (Math.hypot(dx, dz) < 0.12) {
        next++;
        continue;
      }
      const prevY = s.pos[1];
      s = stepPlayer({ ...s, yaw: Math.atan2(dx, dz) }, walkInput(), surface, DT, params);
      expect(s.frame).toBe('ship');
      expect(enteredSolid(s.pos[0], s.pos[2])).toBe(false);
      expect(Math.abs(s.pos[1] - prevY)).toBeLessThanOrEqual(0.4);
      ticks++;
    }
    return { s, reached: next };
  }

  // forecastle → fore ladder → main deck alongside the centreline fittings
  // (mast partners, grating coaming and capstan pad are all SOLID on x = 0,
  // so the lane runs at x = 1.5) → the foot of the aft ladder
  const BOW_TO_MAIN_AFT: Array<[number, number]> = [[0, 16], [1.77, 13.2], [1.77, 10], [1.5, 9], [1.5, -6], [2.2, -6]];
  const UP_AFT_LADDER: Array<[number, number]> = [[2.2, -9.2], [0, -14]];

  it('walks from the bow down the fore ladder and aft along the main deck without clipping a fitting or the bulwark', () => {
    const { s, reached } = walkRoute(BOW_TO_MAIN_AFT);
    expect(reached).toBe(BOW_TO_MAIN_AFT.length);
    expect(s.pos[1]).toBeLessThan(field.deckY + 0.1); // down on the main deck
  });

  it('MEASURED: the aft companionway ladders are steeper than the 40° walk limit', () => {
    // 2.2 m rise over the ladder’s 2.32 m run = 43.5°. Recorded as a fact so
    // the next test’s param override is a documented decision, not a hack.
    const foot = surface.heightAt(2.2, -6.4) as number;
    const top = surface.heightAt(2.2, -8.4) as number;
    const gradeDeg = (Math.atan((top - foot) / 2) * 180) / Math.PI;
    expect(gradeDeg).toBeGreaterThan(P.maxSlopeDeg);
    expect(gradeDeg).toBeLessThan(46);
    // and at the default limit the walker is refused at its foot, not clipped through it
    const { reached } = walkRoute([[2.2, -6], ...UP_AFT_LADDER]);
    expect(reached).toBe(1);
  });

  it('with maxSlope raised past the ladder’s grade, the same walk continues up to the quarterdeck and the stern', () => {
    const { s, reached } = walkRoute([[2.2, -6], ...UP_AFT_LADDER], { ...P, maxSlopeDeg: 46 });
    expect(reached).toBe(UP_AFT_LADDER.length + 1);
    expect(s.pos[1]).toBeGreaterThan(field.deckY + 2);
  });

  it('the bulwark is a wall: walking abeam stops inboard of it, never overboard', () => {
    // from clear planking abaft the mainmast partner, heading to port (-x)
    let s = createPlayerState([0, field.deckY, -5], -Math.PI / 2);
    s.pos[1] = surface.heightAt(0, -5) as number;
    s.grounded = true;
    s = run(s, surface, walkInput(), 6);
    expect(s.frame).toBe('ship');
    expect(Math.abs(s.pos[0])).toBeGreaterThan(2.5);
    expect(Math.abs(s.pos[0])).toBeLessThan(field.maxX);
  });
});

describe('§V2 determinism and NaN safety', () => {
  it('the same input log twice yields identical state', () => {
    const script = (): PlayerState => {
      let t = 0;
      const surface = flat((x, z) => 0.3 * Math.sin(t + x) + (z > 3 ? 0.2 : 0), { ceilingAt: (_x, z) => (z > 5 ? 1.4 : null) });
      let s = settled(surface);
      for (let i = 0; i < 600; i++) {
        t += DT;
        s = stepPlayer(s, { forward: i % 50 < 40 ? 1 : -1, strafe: i % 7 === 0 ? 1 : 0, jump: i % 120 === 0, crouch: false, yawDelta: 0.003, pitchDelta: 0.001 }, surface, DT);
      }
      return s;
    };
    expect(JSON.stringify(script())).toBe(JSON.stringify(script()));
  });

  it('NaN in any input, dt, or state leaves every field finite', () => {
    const surface = flat(() => 0);
    const bad: PlayerInput = { forward: Number.NaN, strafe: Number.POSITIVE_INFINITY, jump: true, crouch: false, yawDelta: Number.NaN, pitchDelta: Number.NaN };
    let s = stepPlayer(settled(surface), bad, surface, DT);
    s = stepPlayer({ ...s, pos: [Number.NaN, 0, 0], yaw: Number.NaN }, walkInput(), surface, Number.NaN);
    s = stepPlayer(s, walkInput(), surface, DT);
    for (const v of [...s.pos, ...s.vel, s.yaw, s.pitch]) expect(Number.isFinite(v)).toBe(true);
  });

  it('a hop leaves the deck and lands back on it with no residual velocity', () => {
    const surface = flat(() => 0);
    let s = stepPlayer(settled(surface), walkInput({ forward: 0, jump: true }), surface, DT);
    expect(s.grounded).toBe(false);
    let peak = 0;
    for (let i = 0; i < 120; i++) {
      s = stepPlayer(s, neutralPlayerInput(), surface, DT);
      peak = Math.max(peak, s.pos[1]);
    }
    expect(peak).toBeGreaterThan(0.03);
    expect(peak).toBeLessThan(0.2); // small — a hop, not a leap
    expect(s.grounded).toBe(true);
    expect(s.pos[1]).toBe(0);
    expect(s.vel[1]).toBe(0);
  });
});
