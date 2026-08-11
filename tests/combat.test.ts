/**
 * §V.2 lockstep + §V.3 sim purity for cannon combat (T16).
 * WHY these tests: multiplayer-later means same state+inputs must replay to
 * identical trajectories/hashes; physics must be sane (elevation & drag
 * shape range); and segment-vs-OBB must respect ship quaternions — a wrong
 * local-space transform is exactly the bug netcode/destruction (§V.14)
 * would silently suffer from.
 */
import { describe, expect, it } from 'vitest';
import {
  createInitialState,
  hashState,
  type Quat,
  type ShipState,
  type SimState,
  type Vec3,
} from '../src/state/simState';
import { SIM_DT } from '../src/core/loop';
import { fireCannon } from '../src/combat/cannons';
import { stepProjectiles, type ProjectileEvent } from '../src/combat/ballistics';
import { testHits, type HitTarget } from '../src/combat/hitTest';
import { quatFromAxisAngle } from '../src/combat/quatMath';
import { combatParams, type CombatParams } from '../src/params/combat';

const DEG = Math.PI / 180;
const YAW_90: Quat = quatFromAxisAngle([0, 1, 0], 90 * DEG);

function makeShip(position: Vec3 = [0, 0, 0], quaternion: Quat = [0, 0, 0, 1]): ShipState {
  return {
    id: 'player', kind: 'player', position, quaternion,
    velocity: [0, 0, 0], angularVelocity: [0, 0, 0],
    rudder: 0, sailTrim: 0, flood: 0, damage: {},
  };
}

function makeState(seed = 42, ship: ShipState = makeShip()): SimState {
  const state = createInitialState(seed);
  state.ships.push(ship);
  return state;
}

const MOUNT: Vec3[] = [[3.6, 1.3, 0], [3.6, 1.3, 4]];

/** step until the first splash; returns its position */
function flyToSplash(state: SimState, params: CombatParams = combatParams): Vec3 {
  for (let i = 0; i < 2000; i++) {
    state.tick++;
    const splash = stepProjectiles(state, SIM_DT, params).find(
      (e) => e.type === 'splash',
    );
    if (splash) return splash.position;
  }
  throw new Error('no splash within 2000 ticks');
}

describe('determinism (§V.2)', () => {
  it('same seed + same inputs → identical trajectories, events and state hash', () => {
    const run = (): { state: SimState; events: ProjectileEvent[] } => {
      const state = makeState(42);
      // nonzero spread on purpose: exercises the seeded-rng path
      fireCannon(state, 0, 'starboard', 0, { elevation: 20 * DEG, spread: 0.05 }, MOUNT);
      fireCannon(state, 0, 'port', 1, { elevation: 35 * DEG, spread: 0.05 }, MOUNT);
      const events: ProjectileEvent[] = [];
      for (let i = 0; i < 400; i++) {
        state.tick++;
        events.push(...stepProjectiles(state, SIM_DT));
      }
      return { state, events };
    };
    const a = run();
    const b = run();
    expect(hashState(a.state)).toBe(hashState(b.state));
    expect(a.events).toEqual(b.events);
  });

  it('spread differs per projectile id but never uses Math.random', () => {
    const state = makeState(7);
    const p0 = fireCannon(state, 0, 'starboard', 0, { elevation: 0, spread: 0.05 }, MOUNT);
    const p1 = fireCannon(state, 0, 'starboard', 1, { elevation: 0, spread: 0.05 }, MOUNT);
    // different ids seed different jitter — volleys are not laser-identical
    expect(p0.velocity).not.toEqual(p1.velocity);
    // ...but a rebuilt state replays the exact same jitter (id-seeded rng)
    const replay = makeState(7);
    const q0 = fireCannon(replay, 0, 'starboard', 0, { elevation: 0, spread: 0.05 }, MOUNT);
    expect(q0.velocity).toEqual(p0.velocity);
  });

  it('fireCannon mutates only the passed state — no globals (§V.3 store contract)', () => {
    const target = makeState(1);
    const bystander = makeState(2);
    const before = hashState(bystander);
    const p = fireCannon(target, 0, 'port', 0, { elevation: 0, spread: 0 }, MOUNT);
    expect(hashState(bystander)).toBe(before);
    expect(target.projectiles).toContain(p);
    expect(target.nextProjectileId).toBe(1);
  });
});

describe('muzzle transform', () => {
  it('muzzle position/velocity follow ship position + quaternion + mount offset', () => {
    // yawed 90° about Y: local x→world -z, local z→world +x
    const state = makeState(1, makeShip([10, 0, 5], YAW_90));
    const p = fireCannon(state, 0, 'port', 0, { elevation: 0, spread: 0 }, [[2, 1, 3]]);
    expect(p.position[0]).toBeCloseTo(13, 6);
    expect(p.position[1]).toBeCloseTo(1, 6);
    expect(p.position[2]).toBeCloseTo(3, 6);
    // port fires local -x → world +z
    expect(p.velocity[0]).toBeCloseTo(0, 6);
    expect(p.velocity[2]).toBeCloseTo(combatParams.muzzleVelocity, 6);
  });
});

describe('ballistics sanity', () => {
  it('45° shot travels farther than 10° (arc physics holds)', () => {
    const range = (elevation: number): number => {
      const state = makeState(3);
      fireCannon(state, 0, 'starboard', 0, { elevation, spread: 0 }, MOUNT);
      const splash = flyToSplash(state);
      return splash[0] - MOUNT[0][0];
    };
    expect(range(45 * DEG)).toBeGreaterThan(range(10 * DEG));
  });

  it('drag reduces range vs no-drag', () => {
    const range = (params: CombatParams): number => {
      const state = makeState(3);
      fireCannon(state, 0, 'starboard', 0, { elevation: 30 * DEG, spread: 0 }, MOUNT, params);
      return flyToSplash(state, params)[0];
    };
    const noDrag = { ...combatParams, drag: 0 };
    expect(combatParams.drag).toBeGreaterThan(0); // guard: default must exercise drag
    expect(range(combatParams)).toBeLessThan(range(noDrag));
  });

  it('splash fires exactly once per water entry, at y≈0, and removes the ball', () => {
    const state = makeState(5);
    state.projectiles.push({ id: 0, position: [0, 2, 0], velocity: [10, -20, 0], age: 0 });
    state.nextProjectileId = 1;
    const events: ProjectileEvent[] = [];
    for (let i = 0; i < 60; i++) events.push(...stepProjectiles(state, SIM_DT));
    const splashes = events.filter((e) => e.type === 'splash' && e.projectileId === 0);
    expect(splashes).toHaveLength(1);
    expect(splashes[0].position[1]).toBeCloseTo(0, 6);
    expect(state.projectiles).toHaveLength(0);
  });
});

describe('segment-vs-OBB hits (§V.14 input)', () => {
  const hull = (quaternion: Quat = [0, 0, 0, 1]): HitTarget => ({
    shipIndex: 1,
    pieceId: 'hull-mid',
    aabb: { min: [-1, -2, -5], max: [1, 1, 5] },
    worldTransform: { position: [0, 0, 0], quaternion },
  });

  /** projectile whose reconstructed segment is curr - v*SIM_DT → curr */
  const ball = (state: SimState, curr: Vec3, velocity: Vec3): void => {
    state.projectiles.push({ id: state.nextProjectileId++, position: curr, velocity, age: 0.1 });
  };

  it('direct broadside hit registers with entry point + removes the projectile', () => {
    const state = makeState(9);
    ball(state, [2, 0.5, 0], [720, 0, 0]); // segment [-10,0.5,0]→[2,0.5,0]
    const hits = testHits(state, [hull()]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ shipIndex: 1, pieceId: 'hull-mid', projectileId: 0 });
    expect(hits[0].point[0]).toBeCloseTo(-1, 6); // entry face, not box center
    expect(state.projectiles).toHaveLength(0);
  });

  it('shot over the deck misses and the ball flies on', () => {
    const state = makeState(9);
    ball(state, [2, 3, 0], [720, 0, 0]); // y=3 clears max.y=1
    expect(testHits(state, [hull()])).toHaveLength(0);
    expect(state.projectiles).toHaveLength(1);
  });

  it('hit on a yawed ship still registers — quat transform correctness', () => {
    // Box is long on local z. Yawed 90°, its length lies along world x, so a
    // shot down world z at x=3 hits it — but would MISS the unrotated box.
    const control = makeState(9);
    ball(control, [3, 0, 10], [0, 0, 1200]); // segment [3,0,-10]→[3,0,10]
    expect(testHits(control, [hull()])).toHaveLength(0); // unrotated box: miss
    const state = makeState(9);
    ball(state, [3, 0, 10], [0, 0, 1200]);
    const hits = testHits(state, [hull(YAW_90)]);
    expect(hits).toHaveLength(1);
    expect(state.projectiles).toHaveLength(0);
  });
});
