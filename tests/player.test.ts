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
  jumpSpeed,
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
import { createInteract } from '../src/player/interact';
import { RAFT_STATIONS } from '../src/player/stations';
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

  it('a jump leaves the deck and lands back on it with no residual velocity', () => {
    const surface = flat(() => 0);
    let s = stepPlayer(settled(surface), walkInput({ forward: 0, jump: true }), surface, DT);
    expect(s.grounded).toBe(false);
    let peak = 0;
    for (let i = 0; i < 120; i++) {
      s = stepPlayer(s, neutralPlayerInput(), surface, DT);
      peak = Math.max(peak, s.pos[1]);
    }
    // §V80 — the PROPERTY is "the feet reach the authored apex", read from the
    // same knob the code reads. The assertion this replaces was `peak < 0.2`
    // "a hop, not a leap", which pinned the DECISION: it passed for the entire
    // life of the 7 cm twitch §T.135 was filed about, and would have failed on
    // any legitimate move of the height.
    expect(peak).toBeGreaterThan(P.jumpHeight * 0.9);
    expect(peak).toBeLessThan(P.jumpHeight * 1.1);
    expect(s.grounded).toBe(true);
    expect(s.pos[1]).toBe(0);
    expect(s.vel[1]).toBe(0);
  });
});

/**
 * §T.135 JUMP, AND CLIMBING BACK ABOARD WITH IT. USER: "we need to be able to
 * jump on spacebar, right? And also that's probably how we get back on the
 * boat when we fell off."
 *
 * The keydown blocks below go through the REAL `KeyboardInput` on a REAL
 * EventTarget and assert `SimState.player` moved, because §V62's whole point
 * is that Space WAS bound before this task and drove a 7 cm hop nobody could
 * see — a control that looks wired and is not is this project's signature
 * defect, and "the height is in the params" is not evidence that pressing the
 * key does anything.
 */
describe('§T.135 the jump', () => {
  const deck = buildDeckHeightfield(buildGalleonBlueprint());
  if (deck === null) throw new Error('galleon has no deck field');

  it('a real Space KeyboardEvent raises SimState.player by jumpHeight ±10%', () => {
    const sim = createInitialState(1);
    const target = new EventTarget();
    const player = createPlayer({
      sim,
      shipPose: () => ({ position: [0, 0, 0], quaternion: [0, 0, 0, 1] }),
      deckField: deck,
      keyTarget: target,
      spawn: [0, 0, 0],
    });
    player.setActive(true);
    for (let i = 0; i < 5; i++) player.step(DT);
    const floor = (sim.player as PlayerState).pos[1];
    target.dispatchEvent(keyEvent('keydown', CONTROL_CODES.walkJump));
    target.dispatchEvent(keyEvent('keyup', CONTROL_CODES.walkJump));
    let peak = floor;
    for (let i = 0; i < 120; i++) {
      player.step(DT);
      peak = Math.max(peak, (sim.player as PlayerState).pos[1]);
    }
    const risen = peak - floor;
    expect(risen).toBeGreaterThan(P.jumpHeight * 0.9);
    expect(risen).toBeLessThan(P.jumpHeight * 1.1);
    // …and back down: a jump that leaves the walker hovering is not a jump
    expect((sim.player as PlayerState).pos[1]).toBeCloseTo(floor, 6);
    player.dispose();
  });

  it('the launch speed follows gravity, so the apex is the knob and not a coincidence', () => {
    // §V80/§V62: `jumpHeight` is the authored number and √(2gh) is arithmetic.
    // Halving gravity must NOT double the jump — that is exactly the drift a
    // stored `jumpSpeed` had, and it is invisible until someone tunes gravity.
    const moon = { ...playerParams, gravity: playerParams.gravity / 4 };
    expect(jumpSpeed(moon)).toBeCloseTo(jumpSpeed(playerParams) / 2, 9);
    const surface = flat(() => 0);
    let s = stepPlayer(settled(surface), walkInput({ forward: 0, jump: true }), surface, DT, moon);
    let peak = 0;
    for (let i = 0; i < 400; i++) {
      s = stepPlayer(s, neutralPlayerInput(), surface, DT, moon);
      peak = Math.max(peak, s.pos[1]);
    }
    expect(peak).toBeGreaterThan(moon.jumpHeight * 0.9);
    expect(peak).toBeLessThan(moon.jumpHeight * 1.1);
    // a zero height is a disabled jump, not a NaN launch
    const off = { ...playerParams, jumpHeight: 0 };
    expect(jumpSpeed(off)).toBe(0);
    expect(stepPlayer(settled(surface), walkInput({ forward: 0, jump: true }), surface, DT, off).grounded).toBe(true);
  });

  it('does nothing mid-air: hammering the key through the flight is still one arc', () => {
    const surface = flat(() => 0);
    let s = stepPlayer(settled(surface), walkInput({ forward: 0, jump: true }), surface, DT);
    const vy: number[] = [];
    // an edge on EVERY tick of the flight — the strongest form of the input a
    // stuck key or a mashed spacebar can produce
    for (let i = 0; i < 200 && !s.grounded; i++) {
      s = stepPlayer(s, walkInput({ forward: 0, jump: true }), surface, DT);
      vy.push(s.vel[1]);
    }
    expect(s.grounded).toBe(true); // he came down: no hovering on a held key
    // one arc = the vertical velocity only ever falls, from launch to landing
    for (let i = 1; i < vy.length - 1; i++) expect(vy[i]).toBeLessThan(vy[i - 1] + 1e-9);
    expect(Math.max(...vy)).toBeLessThan(jumpSpeed(P));
  });

  it('§V62 holding Space down is ONE jump — the collector reports edges, not the key state', () => {
    // the mid-air gate above is `grounded`; this is the other half of it, and
    // it is the half that lives in the keyboard collector. A `jump` that meant
    // "the key is down" would re-launch the walker every time he touched the
    // deck, which is a pogo stick and not a jump.
    const keys = new PlayerKeys();
    keys.keyDown(CONTROL_CODES.walkJump);
    expect(keys.sample().jump).toBe(true);
    for (let i = 0; i < 10; i++) expect(keys.sample().jump).toBe(false);
    keys.keyDown(CONTROL_CODES.walkJump); // a repeat while already held
    expect(keys.sample().jump).toBe(false);
    keys.keyUp(CONTROL_CODES.walkJump);
    keys.keyDown(CONTROL_CODES.walkJump);
    expect(keys.sample().jump).toBe(true);
  });

  it('does nothing while crouched — the roof is 0.9 m over the mattress', () => {
    // the auto-crouch of §V85 is the walker telling us there is a ceiling
    // under head height; launching there puts the head through the thatch
    const low = flat(() => 0, { ceilingAt: () => P.standHeight - 0.2 });
    let s = settled(low);
    expect(s.crouch).toBe(true);
    s = stepPlayer(s, walkInput({ forward: 0, jump: true }), low, DT);
    expect(s.grounded).toBe(true);
    expect(s.pos[1]).toBe(0);
    // and the same key in the open, standing, DOES jump — so the gate is the
    // crouch and not a broken binding
    const open = flat(() => 0);
    expect(stepPlayer(settled(open), walkInput({ forward: 0, jump: true }), open, DT).grounded).toBe(false);
  });

  it('does nothing while a station is held: the hands are on the tiller', () => {
    const host = {
      st: { ...createPlayerState([0, 0, 0], 0), grounded: true } as PlayerState,
      get state() {
        return host.st;
      },
      setState(n: PlayerState): void {
        host.st = n;
      },
      applyAction: () => true,
    };
    const socket: Vec3 = [0, P.standHeight - P.eyeDrop, 1];
    const interact = createInteract(host, { socketWorld: (id) => (id === RAFT_STATIONS.tiller.socket ? socket : null) });
    expect(interact.focus()).toBe('tiller');
    interact.begin();
    expect(interact.held()).toBe('tiller');
    const surface = flat(() => 0);
    const shaped = interact.shapeInput(walkInput({ forward: 0, jump: true }));
    expect(shaped.jump).toBe(false);
    expect(stepPlayer(host.st, shaped, surface, DT).grounded).toBe(true);
  });
});

describe('§T.135 Space in the water is a haul-out', () => {
  const deck = buildDeckHeightfield(buildGalleonBlueprint());
  if (deck === null) throw new Error('galleon has no deck field');

  /** a rail whose freeboard is `y`, reachable from `reach` metres off */
  const rail = (y: number, deckAt: (x: number, z: number) => number | null): WalkSurface =>
    flat(deckAt, { waterAt: () => 0, boardingPoints: [[0, y, 0]] });

  /** a swimmer floating `d` metres to starboard of the rail at the origin */
  const swimmer = (d: number): PlayerState => ({
    frame: 'swim',
    pos: [d, P.swimEyeAbove - (P.standHeight - P.eyeDrop), 0],
    yaw: 0, pitch: 0, vel: [0, 0, 0], crouch: false, grounded: false,
  });

  it('hauls out from beyond the passive reach, where drifting alone never boards', () => {
    // the property, not the numbers: the lunge is strictly the more generous
    // pair, so there is a band where only the deliberate climb works
    expect(P.boardLungeReach).toBeGreaterThan(P.boardReach);
    expect(P.boardLungeVertical).toBeGreaterThan(P.boardVertical);
    const mid = (P.boardReach + P.boardLungeReach) / 2;
    const surface = rail(0.44, () => 0.44);
    // …drifting there, with no key, stays in the water however long he waits
    let passive = swimmer(mid);
    for (let i = 0; i < 60; i++) passive = stepPlayer(passive, neutralPlayerInput(), surface, DT);
    expect(passive.frame).toBe('swim');
    // …one press of the jump key and he is aboard, in the SHIP frame
    const hauled = stepPlayer(swimmer(mid), { ...neutralPlayerInput(), jump: true }, surface, DT);
    expect(hauled.frame).toBe('ship');
    expect(hauled.grounded).toBe(true);
    expect(surface.heightAt(hauled.pos[0], hauled.pos[2])).not.toBeNull();
  });

  it('hauls over a rail the passive climb cannot: a swell that lifted the freeboard', () => {
    const high = (P.boardVertical + P.boardLungeVertical) / 2;
    const surface = rail(high, () => high);
    let passive = swimmer(0.1);
    for (let i = 0; i < 60; i++) passive = stepPlayer(passive, neutralPlayerInput(), surface, DT);
    expect(passive.frame).toBe('swim');
    expect(stepPlayer(swimmer(0.1), { ...neutralPlayerInput(), jump: true }, surface, DT).frame).toBe('ship');
  });

  it('a rail out of even the lunge is still refused — this is a climb, not a teleport', () => {
    const surface = rail(P.boardLungeVertical + 0.5, () => P.boardLungeVertical + 0.5);
    expect(stepPlayer(swimmer(0.1), { ...neutralPlayerInput(), jump: true }, surface, DT).frame).toBe('swim');
    const far = rail(0.44, () => 0.44);
    expect(stepPlayer(swimmer(P.boardLungeReach + 0.5), { ...neutralPlayerInput(), jump: true }, far, DT).frame).toBe('swim');
  });

  it('lands the lunge INBOARD of the rail, on deck, when there is deck to land on', () => {
    // §T.135: "both paths must land the player at a sane spot on deck". The
    // rail is at x = 2 and the deck runs in from it; a man who throws himself
    // over a rail ends up behind it, not balanced on it.
    const boarding: Vec3 = [2, 0.44, 0];
    const surface = flat(
      (x, z) => (Math.abs(x) <= 2.1 && Math.abs(z) <= 3 ? 0.44 : null),
      { waterAt: () => 0, boardingPoints: [boarding] },
    );
    const s: PlayerState = { ...swimmer(0), pos: [2.4, -1.35, 0] };
    const aboard = stepPlayer(s, { ...neutralPlayerInput(), jump: true }, surface, DT);
    expect(aboard.frame).toBe('ship');
    expect(aboard.pos[0]).toBeCloseTo(boarding[0] - P.boardStepIn, 6);
    expect(aboard.pos[2]).toBeCloseTo(0, 6);
    // …and NOT when the step-in is over the side (a rail with nothing behind
    // it): then the feet go on the rail, exactly where the passive route puts
    // them, rather than into thin air
    const knife = flat((x, z) => (Math.abs(x - 2) < 0.05 && Math.abs(z) < 3 ? 0.44 : null), {
      waterAt: () => 0,
      boardingPoints: [boarding],
    });
    const perched = stepPlayer(s, { ...neutralPlayerInput(), jump: true }, knife, DT);
    expect(perched.frame).toBe('ship');
    expect(perched.pos).toEqual(boarding);
  });

  it('the passive drift-aboard is untouched: no key pressed, still boards at the rail', () => {
    // §B78's fix is the FALLBACK and must not regress — a player who never
    // learns the key still gets back on the raft. Same surface, same spot, no
    // input at all.
    const boarding: Vec3 = [0.5, 0.44, 0];
    const surface = flat((x, z) => (Math.abs(x) <= 1 && Math.abs(z) <= 1 ? 0.44 : null), {
      waterAt: () => 0,
      boardingPoints: [boarding],
    });
    const aboard = stepPlayer(swimmer(0.6), neutralPlayerInput(), surface, DT);
    expect(aboard.frame).toBe('ship');
    expect(aboard.pos).toEqual(boarding); // AT the rail, ship-local
    expect(aboard.grounded).toBe(true);
  });

  it('§V62 a real Space KeyboardEvent takes SimState.player out of the water', () => {
    const sim = createInitialState(1);
    const target = new EventTarget();
    const boarding: Vec3 = [3, 0.44, 0];
    const player = createPlayer({
      sim,
      shipPose: () => ({ position: [0, 0, 0], quaternion: [0, 0, 0, 1] }),
      deckField: deck,
      waterAt: () => 0,
      boardingPoints: [boarding],
      keyTarget: target,
      spawn: [0, 0, 0],
    });
    player.setActive(true);
    // put him in the water a lunge — but more than a drift — off the rail
    sim.player = {
      frame: 'swim',
      pos: [boarding[0] + (P.boardReach + P.boardLungeReach) / 2, -1.35, 0],
      yaw: 0, pitch: 0, vel: [0, 0, 0], crouch: false, grounded: false,
    };
    for (let i = 0; i < 30; i++) player.step(DT);
    expect((sim.player as PlayerState).frame).toBe('swim');
    // …and the prompt is on screen for exactly that reason, at the rail
    const anchor = player.boardingAnchor();
    expect(anchor).not.toBeNull();
    expect(anchor?.[0]).toBeCloseTo(boarding[0], 6);
    target.dispatchEvent(keyEvent('keydown', CONTROL_CODES.walkJump));
    target.dispatchEvent(keyEvent('keyup', CONTROL_CODES.walkJump));
    player.step(DT);
    expect((sim.player as PlayerState).frame).toBe('ship');
    expect(player.boardingAnchor()).toBeNull(); // aboard, nothing left to climb
    player.dispose();
  });
});
