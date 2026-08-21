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
import {
  resolveWaterEntry,
  stepProjectiles,
  type ProjectileEvent,
} from '../src/combat/ballistics';
import { testHits, type HitTarget } from '../src/combat/hitTest';
import { quatFromAxisAngle } from '../src/core/quat';
import {
  ageFraction,
  brightnessAt,
  burstDirection,
  sizeAt,
  stepVelocity,
  type FxProfile,
} from '../src/combat/fxMath';
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
    stepProjectiles(state, SIM_DT, params);
    const splash = resolveWaterEntry(state, SIM_DT).find((e) => e.type === 'splash');
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
        events.push(...resolveWaterEntry(state, SIM_DT));
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
    // the ball leaves the MUZZLE, not the carriage: the spawn walks
    // muzzleForward out along the barrel, which for a port gun on a ship
    // yawed 90° means +z in world space
    expect(p.position[0]).toBeCloseTo(13, 6);
    expect(p.position[1]).toBeCloseTo(1, 6);
    expect(p.position[2]).toBeCloseTo(3 + combatParams.muzzleForward, 6);
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
    state.projectiles.push({
      id: 0, position: [0, 2, 0], velocity: [10, -20, 0], age: 0, owner: 0,
    });
    state.nextProjectileId = 1;
    const events: ProjectileEvent[] = [];
    for (let i = 0; i < 60; i++) {
      events.push(...stepProjectiles(state, SIM_DT));
      events.push(...resolveWaterEntry(state, SIM_DT));
    }
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
    state.projectiles.push({
      id: state.nextProjectileId++, position: curr, velocity, age: 0.1, owner: 0,
    });
  };

  it('direct broadside hit registers with entry point + removes the projectile', () => {
    const state = makeState(9);
    ball(state, [2, 0.5, 0], [720, 0, 0]); // segment [-10,0.5,0]→[2,0.5,0]
    const hits = testHits(state, [hull()], SIM_DT, 0);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ shipIndex: 1, pieceId: 'hull-mid', projectileId: 0 });
    expect(hits[0].point[0]).toBeCloseTo(-1, 6); // entry face, not box center
    expect(state.projectiles).toHaveLength(0);
  });

  it('shot over the deck misses and the ball flies on', () => {
    const state = makeState(9);
    ball(state, [2, 3, 0], [720, 0, 0]); // y=3 clears max.y=1
    expect(testHits(state, [hull()], SIM_DT, 0)).toHaveLength(0);
    expect(state.projectiles).toHaveLength(1);
  });

  it('hit on a yawed ship still registers — quat transform correctness', () => {
    // Box is long on local z. Yawed 90°, its length lies along world x, so a
    // shot down world z at x=3 hits it — but would MISS the unrotated box.
    const control = makeState(9);
    ball(control, [3, 0, 10], [0, 0, 1200]); // segment [3,0,-10]→[3,0,10]
    expect(testHits(control, [hull()], SIM_DT, 0)).toHaveLength(0); // unrotated: miss
    const state = makeState(9);
    ball(state, [3, 0, 10], [0, 0, 1200]);
    const hits = testHits(state, [hull(YAW_90)], SIM_DT, 0);
    expect(hits).toHaveLength(1);
    expect(state.projectiles).toHaveLength(0);
  });
});

describe('tick order: water entry resolves AFTER the hit test', () => {
  /**
   * WHY: the integrator used to delete any ball that ended a tick under y=0,
   * and it ran before testHits. A shot arriving at the waterline — exactly
   * the geometry §V14's flood clause is about — was therefore removed before
   * anything could be hit, so below-water strikes were not rare, they were
   * IMPOSSIBLE. It failed by scoring zero hits, silently, while every unit
   * test that fired into open air still passed.
   */
  const waterlinePiece = (): HitTarget => ({
    shipIndex: 1,
    pieceId: 'hull-port-mid',
    aabb: { min: [-1, -2, -5], max: [1, 0.2, 5] }, // straddles the surface
    worldTransform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
  });

  it('a ball crossing the surface this tick still strikes the hull below it', () => {
    const state = makeState(11);
    // descending shot that ends the tick underwater, inside the hull box
    state.projectiles.push({
      id: 0, position: [0, -0.3, 0], velocity: [60, -30, 0], age: 0.5, owner: 0,
    });
    const hits = testHits(state, [waterlinePiece()], SIM_DT, 0);
    expect(hits).toHaveLength(1);
    expect(hits[0].pieceId).toBe('hull-port-mid');
  });

  it('stepProjectiles no longer retires water-crossers itself', () => {
    const state = makeState(11);
    state.projectiles.push({
      id: 0, position: [0, 0.05, 0], velocity: [0, -30, 0], age: 0.5, owner: 0,
    });
    stepProjectiles(state, SIM_DT);
    expect(state.projectiles[0].position[1]).toBeLessThan(0);
    expect(state.projectiles).toHaveLength(1); // survives for the hit test
    // ...and only then does water entry claim it, exactly once
    const events = resolveWaterEntry(state, SIM_DT);
    expect(events.filter((e) => e.type === 'splash')).toHaveLength(1);
    expect(state.projectiles).toHaveLength(0);
  });

  it('splashes land on the LIVE sea surface, not a flat plane (§V.8)', () => {
    const state = makeState(11);
    // segment for the tick is prev [0,2.4,0] → curr [0,1.9,0]: it crosses a
    // 2 m crest partway, so the splash must land ON the crest
    state.projectiles.push({
      id: 0, position: [0, 1.9, 0], velocity: [0, -30, 0], age: 0.5, owner: 0,
    });
    const crest = 2;
    const events = resolveWaterEntry(state, SIM_DT, () => crest);
    expect(events).toHaveLength(1);
    expect(events[0].position[1]).toBeCloseTo(crest, 6);
  });

  it('a non-finite sea height cannot send a splash to NaN (§V.28)', () => {
    const state = makeState(11);
    state.projectiles.push({
      id: 0, position: [0, -1, 0], velocity: [0, -30, 0], age: 0.5, owner: 0,
    });
    const events = resolveWaterEntry(state, SIM_DT, () => Number.NaN);
    expect(events).toHaveLength(1);
    for (const c of events[0].position) expect(Number.isFinite(c)).toBe(true);
  });
});

describe('ball radius (§V.14 mast break reachability)', () => {
  /**
   * WHY: a galleon mast is ~0.6 m across. With a point-sized ball, a
   * broadside at any real range essentially never touches one, so "mast hit
   * → mast detaches" is dead content that no unit test notices, because a
   * test that aims dead-centre always connects.
   */
  const mast = (): HitTarget => ({
    shipIndex: 1,
    pieceId: 'mast-main',
    aabb: { min: [-0.3, 0, -0.3], max: [0.3, 30, 0.3] },
    worldTransform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
  });

  const grazing = (state: SimState): void => {
    // passes 0.55 m to one side of the mast centreline: clear of the 0.3 m
    // half-width, inside 0.3 + 0.4 once the ball has a radius
    state.projectiles.push({
      id: 0, position: [2, 10, 0.55], velocity: [720, 0, 0], age: 0.1, owner: 0,
    });
  };

  it('a graze misses a point ball and connects for a real one', () => {
    const pointBall = makeState(13);
    grazing(pointBall);
    expect(testHits(pointBall, [mast()], SIM_DT, 0)).toHaveLength(0);

    const realBall = makeState(13);
    grazing(realBall);
    expect(testHits(realBall, [mast()], SIM_DT, 0.4)).toHaveLength(1);
  });

  it('radius is clamped non-negative — a bad param cannot shrink hitboxes', () => {
    const state = makeState(13);
    state.projectiles.push({
      id: 0, position: [2, 10, 0], velocity: [720, 0, 0], age: 0.1, owner: 0,
    });
    expect(testHits(state, [mast()], SIM_DT, Number.NaN)).toHaveLength(1);
  });
});

describe('combat fx math (§V.28 — the §B.5 class of failure)', () => {
  /**
   * WHY: §B.5 was a particle life of 0 producing a 0/0 NaN age, which became
   * a NaN-sized additive quad, ×4096 of them, and read as a browser hang
   * rather than an error. Dead particles were also still being rasterized at
   * full size with zero opacity. Both are guarded here, at the boundary,
   * because neither shows up as anything but a frozen tab.
   */
  const profile: FxProfile = {
    life: 1, sizeStart: 2, sizeEnd: 4, gravity: 9.81, drag: 0.5,
    color: [1, 1, 1], speed: 8, spread: 0.6, boost: 1,
    riseSpeed: 0, windCoupling: 0, growthExp: 1, alpha: 0,
  };

  it('a zero or non-finite life can never yield a NaN age fraction', () => {
    for (const life of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const t = ageFraction(0.5, life);
      expect(Number.isFinite(t)).toBe(true);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(1);
    }
    expect(Number.isFinite(ageFraction(Number.NaN, 1))).toBe(true);
  });

  it('a dead particle is EXACTLY zero size, not merely transparent', () => {
    expect(sizeAt(profile, 1)).toBe(0);
    expect(sizeAt(profile, 1.5)).toBe(0);
    expect(brightnessAt(1)).toBe(0);
    // ...and alive ones are strictly positive, so nothing vanishes early
    expect(sizeAt(profile, 0.5)).toBeGreaterThan(0);
    expect(brightnessAt(0.5)).toBeGreaterThan(0);
  });

  it('a degenerate size profile still returns a finite non-negative size', () => {
    const bad: FxProfile = { ...profile, sizeStart: Number.NaN, sizeEnd: -5 };
    for (const t of [0, 0.25, 0.5, 0.99]) {
      const s = sizeAt(bad, t);
      expect(Number.isFinite(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
    }
  });

  it('a zero-length burst axis cannot divide to NaN', () => {
    const d = burstDirection([0, 0, 0], 3, 0.7);
    for (const c of d) expect(Number.isFinite(c)).toBe(true);
    expect(Math.hypot(...d)).toBeGreaterThan(0.5);
  });

  it('burst directions stay unit-length and deterministic', () => {
    for (let i = 0; i < 40; i++) {
      const d = burstDirection([1, 0, 0], i, 0.8);
      expect(Math.hypot(...d)).toBeCloseTo(1, 6);
    }
    // same event, same debris — replayable for a netcode spectator
    expect(burstDirection([0, 1, 0], 7, 0.5)).toEqual(burstDirection([0, 1, 0], 7, 0.5));
  });

  it('zero spread keeps the burst on its axis', () => {
    expect(burstDirection([0, 1, 0], 9, 0)).toEqual([0, 1, 0]);
  });

  it('velocity stays finite under a hostile dt and a negative drag param', () => {
    const hostile: FxProfile = { ...profile, drag: -10 };
    const v = stepVelocity(1, 2, 3, hostile, 1 / 60);
    for (const c of v) expect(Number.isFinite(c)).toBe(true);
    // negative drag must not become exponential GROWTH (positions → Infinity)
    expect(Math.hypot(...v)).toBeLessThanOrEqual(Math.hypot(1, 2, 3) + 1);
  });
});
