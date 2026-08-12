/**
 * The combat WIRING (T16/T17/T18/T19), as opposed to the combat chain.
 *
 * WHY this file exists: every module under src/combat had green unit tests
 * and a green end-to-end chain test (combatChain.test.ts) while the game
 * shipped with none of it connected — main.ts imported exactly one helper
 * out of eleven modules, and the user's report was "the NPC ship isn't
 * trying to shoot at us, there's no smoke, no cannonballs, no impacts".
 * A test that only proves the chain CAN work does not catch that; these
 * tests pin the things that were actually missing:
 *
 *   - the enemy opens fire from the position main.ts really spawns her at,
 *   - Space fires the battery that BEARS rather than a hard-coded side,
 *   - what the renderer draws follows what the sim holds,
 *   - every gun and impact is a PLACED sound, not a stereo blat,
 *   - and none of the render-side sinks can perturb the sim (§V.2/§V.3).
 */
import { describe, expect, it } from 'vitest';
import {
  Matrix4,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  Vector3,
  type Material,
} from 'three';
import { SIM_DT } from '../src/core/loop';
import {
  createInitialState,
  hashState,
  type ShipState,
  type SimState,
  type Vec3,
} from '../src/state/simState';
import { buildGalleonBlueprint } from '../src/ship/shipBlueprint';
import { ShipAssembly } from '../src/ship/shipAssembly';
import { resolvePieceFrames } from '../src/combat/pieceFrame';
import { sideForBearing } from '../src/combat/battery';
import { createCombatRuntime, viewBearing, type CombatAudioSink } from '../src/combat/combatRuntime';
import type { CombatEvent } from '../src/audio/events';
import { stepFlooding } from '../src/sea-physics/flooding';
import { createAiShip, stepAiShip } from '../src/ai/aiShip';
import { stepShipSailing } from '../src/sailing/shipKinematics';
import {
  arenaTargets,
  combatSceneRequested,
  createCombatArena,
  type ArenaCamera,
  type CombatArena,
} from '../src/combat/combatArena';
import { jitterScale } from '../src/combat/fxMath';
import { combatArenaParams, combatParams, combatFxParams } from '../src/params/combat';
import { aiParams } from '../src/params/ai';
import { elevationForRange, shotRange } from '../src/combat/ballistics';
import { isSunk } from '../src/combat/sinking';

/** the spawn main.ts really uses — the test is worthless against a different one */
const ENEMY_SPAWN: [number, number] = [190, -150];

const stub = (): Material => ({ dispose(): void {} }) as unknown as Material;

function makeShip(id: string, x: number, z: number, kind: ShipState['kind']): ShipState {
  return {
    id,
    kind,
    position: [x, 0, z],
    quaternion: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    rudder: 0,
    sailTrim: 0.7,
    flood: 0,
    damage: {},
  };
}

interface Rig {
  state: SimState;
  runtime: ReturnType<typeof createCombatRuntime>;
  events: CombatEvent[];
  assemblies: ShipAssembly[];
}

/** two galleons, a flat sea, and a recording audio sink */
function rig(playerAt: [number, number], enemyAt: [number, number], audio = true): Rig {
  const state = createInitialState(1337);
  state.ships.push(makeShip('player', playerAt[0], playerAt[1], 'player'));
  state.ships.push(makeShip('enemy-1', enemyAt[0], enemyAt[1], 'enemy'));
  const events: CombatEvent[] = [];
  const sink: CombatAudioSink = {
    event: (e) => {
      events.push(e);
    },
  };
  const assemblies = state.ships.map(() => new ShipAssembly(buildGalleonBlueprint(), stub));
  // main.ts poses each assembly from ShipState every frame; do the same here
  // so matrixWorld means what the runtime assumes it means
  assemblies.forEach((a, i) => {
    a.group.position.fromArray(state.ships[i].position);
    a.group.updateMatrixWorld(true);
  });
  const runtime = createCombatRuntime({
    ships: assemblies.map((assembly, shipIndex) => ({
      shipIndex,
      blueprint: buildGalleonBlueprint(),
      assembly,
    })),
    waterHeightAt: () => 0,
    audio: audio ? sink : null,
  });
  return { state, runtime, events, assemblies };
}

describe('the enemy actually shoots at us (§V.15 broadside → §T.16 gun)', () => {
  it('opens fire from the spawn main.ts uses, and the balls reach SimState', () => {
    const { state, runtime } = rig([0, 0], ENEMY_SPAWN, false);
    const ai = createAiShip(1, ENEMY_SPAWN);
    let firstMuzzleTick = -1;
    let ballsSeen = 0;

    // three minutes of sim: she has to close ~240 m under sail first
    for (let i = 0; i < 60 * 180; i++) {
      state.tick++;
      state.time += SIM_DT;
      const commands = stepAiShip(ai, state, 0);
      stepShipSailing(state.ships[1], commands.input, state.wind, SIM_DT);
      // main.ts integrates planar position inside buoyancy (§V.51 single
      // owner); this test has no buoyancy, so it moves her the same way
      state.ships[1].position[0] += state.ships[1].velocity[0] * SIM_DT;
      state.ships[1].position[2] += state.ships[1].velocity[2] * SIM_DT;
      const frame = runtime.tick(state, SIM_DT, [{ shipIndex: 0, fire: false }, commands.order]);
      if (frame.muzzles.length > 0 && firstMuzzleTick < 0) firstMuzzleTick = i;
      ballsSeen = Math.max(ballsSeen, state.projectiles.length);
    }

    expect(firstMuzzleTick).toBeGreaterThanOrEqual(0);
    // a fire ORDER that never reaches a gun is the exact failure this file
    // exists for, so assert the projectile, not just the intent
    expect(ballsSeen).toBeGreaterThan(0);
    // ...and the shots have to arrive. Guns that fire and always miss look
    // identical to guns that work, and leave §V.14 unreachable in play.
    expect(Object.values(state.ships[0].damage).some((hp) => hp < 1)).toBe(true);
  });

  it('holds her fire while she is still hull-down — a broadside at 240 m is theatre', () => {
    const { state, runtime } = rig([0, 0], ENEMY_SPAWN, false);
    const ai = createAiShip(1, ENEMY_SPAWN);
    for (let i = 0; i < 60 * 3; i++) {
      state.tick++;
      const commands = stepAiShip(ai, state, 0);
      const frame = runtime.tick(state, SIM_DT, [{ shipIndex: 0, fire: false }, commands.order]);
      expect(frame.muzzles).toHaveLength(0);
    }
  });
});

describe('the player fires the battery that bears (§I: Space, one key)', () => {
  it('viewBearing reads a camera matrix in the SAME convention as ship yaw', () => {
    // ship yaw is atan2(fwd.x, fwd.z) of the hull's local +Z; a camera looks
    // down its local -Z, so the two would silently disagree by π if the sign
    // were dropped, and every shot would go out of the wrong side
    const camera = new PerspectiveCamera();
    for (const target of [
      new Vector3(0, 0, 10),
      new Vector3(10, 0, 0),
      new Vector3(0, 0, -10),
      new Vector3(-10, 0, 0),
      new Vector3(7, 3, -4),
    ]) {
      camera.position.set(0, 0, 0);
      camera.lookAt(target);
      camera.updateMatrixWorld(true);
      const delta = Math.atan2(
        Math.sin(viewBearing(camera.matrixWorld.elements) - Math.atan2(target.x, target.z)),
        Math.cos(viewBearing(camera.matrixWorld.elements) - Math.atan2(target.x, target.z)),
      );
      expect(delta).toBeCloseTo(0, 5); // wrapped: ±π is the same bearing
    }
  });

  it('never divides by a degenerate matrix', () => {
    expect(Number.isFinite(viewBearing(new Matrix4().elements))).toBe(true);
    expect(Number.isFinite(viewBearing([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(
      true,
    );
  });

  it('looking to port fires the PORT guns and looking to starboard the starboard ones', () => {
    // the whole point of aiming: a fixed side would fire into empty sea half
    // the time, which reads exactly like "the guns do not work"
    const { state, runtime } = rig([0, 0], [60, 0], false);
    const camera = new PerspectiveCamera();

    const fireToward = (x: number, z: number): number[] => {
      camera.position.set(0, 0, 0);
      camera.lookAt(new Vector3(x, 0, z));
      camera.updateMatrixWorld(true);
      state.tick++;
      const frame = runtime.tick(state, SIM_DT, [
        { shipIndex: 0, fire: true, aimBearing: viewBearing(camera.matrixWorld.elements) },
      ]);
      // guns speak on the tick they come due; drain the ripple
      const sides: number[] = frame.muzzles.map((m) => m.position[0]);
      for (let i = 0; i < 60; i++) {
        state.tick++;
        for (const m of runtime.tick(state, SIM_DT, []).muzzles) sides.push(m.position[0]);
      }
      return sides;
    };

    // ship at the origin heading +Z: starboard is +x, port is -x
    const starboard = fireToward(60, 0);
    expect(starboard.length).toBeGreaterThan(0);
    expect(starboard.every((x) => x > 0)).toBe(true);
    expect(sideForBearing(0, Math.atan2(60, 0))).toBe('starboard');

    // wait out the reload, then aim the other way
    for (let i = 0; i < Math.ceil(combatParams.reloadTime / SIM_DT) + 5; i++) {
      state.tick++;
      runtime.tick(state, SIM_DT, []);
    }
    const port = fireToward(-60, 0);
    expect(port.length).toBeGreaterThan(0);
    expect(port.every((x) => x < 0)).toBe(true);
  });
});

describe('the guns are LAID for the range (§T.16 firing solution)', () => {
  const GUN_HEIGHT = 2.65; // galleon cannon-mount socket, blueprintParts.ts

  it('the fixed default elevation cannot reach the range §V.15 fights at', () => {
    // pinned as the reason elevationForRange exists: leave the elevation
    // constant and every enemy broadside lands half the range short, which
    // looks like working guns and produces no hits, ever
    expect(shotRange(combatParams.defaultElevation, GUN_HEIGHT)).toBeLessThan(
      aiParams.broadsideRange,
    );
  });

  it('lays the ball on the mark across the whole engagement band', () => {
    for (const range of [40, 60, 90, 110, 125]) {
      const elevation = elevationForRange(range, GUN_HEIGHT);
      expect(Math.abs(shotRange(elevation, GUN_HEIGHT) - range)).toBeLessThan(1);
    }
  });

  it('never asks for more elevation than the guns have, and eats a bad range', () => {
    expect(elevationForRange(5000, GUN_HEIGHT)).toBe(combatParams.maxElevation);
    expect(elevationForRange(-5, GUN_HEIGHT)).toBe(combatParams.minElevation);
    expect(Number.isFinite(elevationForRange(Number.NaN, GUN_HEIGHT))).toBe(true);
    expect(Number.isFinite(elevationForRange(90, Number.NaN))).toBe(true);
  });

  it('a broadside at 90 m connects, where the old fixed elevation never could', () => {
    const hitsAt = (elevation?: number): number => {
      const { state, runtime } = rig([0, 0], [90, 0], false);
      let hits = 0;
      for (let i = 0; i < 60 * 60; i++) {
        state.tick++;
        hits += runtime.tick(state, SIM_DT, [
          { shipIndex: 0, fire: true, aimBearing: Math.PI / 2, elevation },
        ]).hits.length;
      }
      return hits;
    };
    expect(hitsAt(combatParams.defaultElevation)).toBe(0); // the defect
    expect(hitsAt(undefined)).toBeGreaterThan(0); // the fix
  });
});

describe('hits do damage, and damage floods her (§V.14 through the runtime)', () => {
  it('a sustained broadside holes the target and the hull takes water', () => {
    // the user-facing claim: keep shooting and something happens. Two ships
    // alongside; the player holds the trigger; her opponent must end up
    // breached, taking water and eventually gone.
    const { state, runtime } = rig([0, 0], [26, 0], false);
    const enemy = state.ships[1];
    let floodAfterFirstBreach = -1;

    for (let i = 0; i < 60 * 240 && !isSunk(enemy); i++) {
      state.tick++;
      runtime.tick(state, SIM_DT, [{ shipIndex: 0, fire: true, aimBearing: Math.PI / 2 }]);
      const holes = runtime.floodHoles(state, 1);
      stepFlooding(enemy, holes, SIM_DT);
      if (holes.length > 0 && floodAfterFirstBreach < 0) floodAfterFirstBreach = enemy.flood;
    }

    expect(Object.values(enemy.damage).some((hp) => hp < 1)).toBe(true);
    expect(floodAfterFirstBreach).toBeGreaterThanOrEqual(0);
    expect(enemy.flood).toBeGreaterThan(floodAfterFirstBreach);
    expect(isSunk(enemy)).toBe(true);
  });

  it('an undamaged ship has no holes, so she never leaks by accident', () => {
    const { state, runtime } = rig([0, 0], [26, 0], false);
    state.tick++;
    runtime.tick(state, SIM_DT, []);
    expect(runtime.floodHoles(state, 1)).toHaveLength(0);
    expect(runtime.floodHoles(state, 0)).toHaveLength(0);
  });
});

describe('every gun and impact is a PLACED sound', () => {
  it('muzzle, splash and breach events all carry a finite world position', () => {
    // the user asked for localisable audio: an event with no `world` plays
    // dry down the middle, which is the failure being guarded here
    const { state, runtime, events } = rig([0, 0], [26, 0]);
    for (let i = 0; i < 60 * 60; i++) {
      state.tick++;
      runtime.tick(state, SIM_DT, [{ shipIndex: 0, fire: true, aimBearing: Math.PI / 2 }]);
      stepFlooding(state.ships[1], runtime.floodHoles(state, 1), SIM_DT);
    }

    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds.has('cannonFire')).toBe(true);
    expect(kinds.has('ballHit')).toBe(true);
    expect(kinds.has('splinter')).toBe(true);
    for (const e of events) {
      expect(e.world, `${e.kind} played without a position`).toBeDefined();
      const w = e.world as ArrayLike<number>;
      expect(w.length).toBe(3);
      for (let i = 0; i < 3; i++) expect(Number.isFinite(w[i])).toBe(true);
    }
  });

  it('a ball that pitches into the sea splashes where it crossed the surface', () => {
    // aimed at open water, not at a ship: proves water entry is wired at all
    const { state, runtime, events } = rig([0, 0], [4000, 4000]);
    for (let i = 0; i < 60 * 20; i++) {
      state.tick++;
      runtime.tick(state, SIM_DT, [{ shipIndex: 0, fire: true, aimBearing: Math.PI / 2 }]);
    }
    const splashes = events.filter((e) => e.kind === 'ballSplash');
    expect(splashes.length).toBeGreaterThan(0);
    for (const s of splashes) {
      // waterHeightAt is flat 0 here, so the crossing must be at 0
      expect((s.world as ArrayLike<number>)[1]).toBeCloseTo(0, 3);
    }
  });
});

describe('what is drawn follows what the sim holds (§V.3)', () => {
  it('the cannonball instance count tracks SimState.projectiles', () => {
    const { state, runtime } = rig([0, 0], [4000, 4000], false);
    const balls = findInstanced(runtime.group);
    expect(balls).not.toBeNull();
    expect(balls?.count).toBe(0);

    for (let i = 0; i < 40; i++) {
      state.tick++;
      runtime.tick(state, SIM_DT, [{ shipIndex: 0, fire: true, aimBearing: Math.PI / 2 }]);
    }
    runtime.update(1 / 60, state);
    expect(state.projectiles.length).toBeGreaterThan(0);
    expect(balls?.count).toBe(Math.min(state.projectiles.length, combatFxParams.ballCount));

    // and when the sim's projectiles are gone, so are the drawn ones —
    // a stale instance buffer would leave balls hanging in the sky
    state.projectiles = [];
    runtime.update(1 / 60, state);
    expect(balls?.count).toBe(0);
  });

  it('smoke and flash actually reach the sprite buffer on a muzzle event', () => {
    const { state, runtime } = rig([0, 0], [4000, 4000], false);
    const sizes = findSpriteSizes(runtime.group);
    expect(sizes).not.toBeNull();
    expect(maxOf(sizes!)).toBe(0); // §V.28: the whole pool starts at ZERO size

    // every gun including the first draws its own jittered delay, so the
    // trigger tick is not necessarily the tick a gun speaks on
    let muzzles = 0;
    for (let i = 0; i < 30 && muzzles === 0; i++) {
      state.tick++;
      muzzles = runtime.tick(state, SIM_DT, [
        { shipIndex: 0, fire: i === 0, aimBearing: Math.PI / 2 },
      ]).muzzles.length;
    }
    expect(muzzles).toBeGreaterThan(0);
    runtime.update(1 / 60, state);
    expect(maxOf(sizes!)).toBeGreaterThan(0);
  });
});

describe('§V.14 mast break leaves something to look at', () => {
  it('a mast shot away lands in the world at its own transform, not the origin', () => {
    // detachPiece hands back a node whose LOCAL transform is still
    // ship-local; adding that to the scene unedited teleports a 30 m spar to
    // the world origin, which is precisely the kind of silent visual bug
    // this project keeps paying for
    const { state, runtime } = rig([0, 0], [200, 0], false);
    const enemy = state.ships[1];
    const blueprint = buildGalleonBlueprint();
    const frames = resolvePieceFrames(blueprint);
    const mast = blueprint
      .filter((p) => p.kind === 'mast')
      .map((p) => ({ p, f: frames.get(p.id)! }))
      .sort((a, b) => b.f.position[1] + b.p.aabb.max[1] - (a.f.position[1] + a.p.aabb.max[1]))[0];
    // aim at the mast well above the rail so nothing lower intercepts
    const target: Vec3 = [
      enemy.position[0] + mast.f.position[0],
      mast.f.position[1] + mast.p.aabb.max[1] * 0.6,
      enemy.position[2] + mast.f.position[2],
    ];

    for (let shot = 0; shot < 12; shot++) {
      state.tick++;
      // a hand-placed ball: aiming a real broadside at a 0.3 m spar at 200 m
      // is a lottery, and the thing under test is the DETACH, not the gunnery
      state.projectiles.push({
        id: state.nextProjectileId++,
        position: [target[0] - 3, target[1], target[2]],
        velocity: [240, 0, 0],
        age: 0,
        owner: 0,
      });
      runtime.tick(state, SIM_DT, []);
      if ((enemy.damage[mast.p.id] ?? 1) <= 0) break;
    }
    expect(enemy.damage[mast.p.id]).toBe(0);

    const wreckage = runtime.group.getObjectByName('combat-wreckage');
    expect(wreckage).toBeDefined();
    expect(wreckage!.children.length).toBeGreaterThan(0);
    const spar = wreckage!.children[0];
    // it is where the mast was standing, not at (0,0,0)
    expect(Math.hypot(spar.position.x - enemy.position[0], spar.position.z - enemy.position[2]))
      .toBeLessThan(6);
    expect(spar.position.y).toBeGreaterThan(1);

    // ...and it goes into the sea rather than through it, then is retired
    for (let i = 0; i < 60 * 60; i++) runtime.update(1 / 60, state);
    expect(wreckage!.children.length).toBe(0);
  });
});

describe('a broadside is a ROLL, not a chord (user: "the perfect identical same time")', () => {
  /** seconds from the trigger at which each gun of one broadside speaks */
  const volleyTimes = (seed: number): number[] => {
    const { state, runtime } = rig([0, 0], [55, 0], false);
    state.seed = seed;
    const times: number[] = [];
    for (let i = 0; i < 90; i++) {
      state.tick++;
      for (const _ of runtime.tick(state, SIM_DT, [
        { shipIndex: 0, fire: i === 0, aimBearing: Math.PI / 2 },
      ]).muzzles) {
        times.push(i * SIM_DT);
      }
    }
    return times;
  };

  it('the guns of one broadside do not speak at the same instant', () => {
    const times = volleyTimes(1337);
    expect(times.length).toBeGreaterThan(2);
    expect(new Set(times).size).toBeGreaterThan(1);
  });

  it('the spacing is UNEVEN — an even ripple is still a machine', () => {
    // this is the actual complaint: a metronome at 80 ms reads as one
    // mechanism firing, not as gun captains each judging their own roll
    const times = volleyTimes(1337);
    const gaps: number[] = [];
    for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
    expect(gaps.length).toBeGreaterThan(1);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeGreaterThan(SIM_DT);
  });

  it('...but still replays identically from the same seed (§V.2)', () => {
    expect(volleyTimes(1337)).toEqual(volleyTimes(1337));
    expect(volleyTimes(1337)).not.toEqual(volleyTimes(99));
  });

  it('the whole broadside still lands inside a musical window', () => {
    // uneven is the goal; strung out over seconds would stop being a
    // broadside at all, so the jitter has to stay bounded by the ripple
    const times = volleyTimes(1337);
    const span = times[times.length - 1] - times[0];
    expect(span).toBeGreaterThan(combatParams.rippleDelay);
    expect(span).toBeLessThan(
      (times.length + 1) * (combatParams.rippleDelay + combatParams.rippleJitter),
    );
  });
});

describe('no two guns throw the identical puff (user: "identical across all cannons")', () => {
  it('per-shot seeds differ, and zero variation is what made them the same', () => {
    const { state, runtime } = rig([0, 0], [55, 0], false);
    const seeds = new Set<number>();
    for (let i = 0; i < 90; i++) {
      state.tick++;
      for (const m of runtime.tick(state, SIM_DT, [
        { shipIndex: 0, fire: i === 0, aimBearing: Math.PI / 2 },
      ]).muzzles) {
        seeds.add(m.seed);
      }
    }
    expect(seeds.size).toBeGreaterThan(2); // one distinct seed per gun
  });

  it('the same seed gives the same jitter and a different seed does not', () => {
    // §V.2: the variation is a hash, not an rng stream — a replay throws the
    // same smoke, but two guns in one volley do not
    expect(jitterScale(7, 3, 0.5)).toBe(jitterScale(7, 3, 0.5));
    expect(jitterScale(7, 3, 0.5)).not.toBe(jitterScale(8, 3, 0.5));
    expect(jitterScale(7, 3, 0)).toBe(1); // the knob really is a no-op at 0
  });

  it('stays inside its band and never returns a degenerate scale', () => {
    for (let a = 0; a < 200; a++) {
      const v = jitterScale(a * 7919, a, 0.45);
      expect(v).toBeGreaterThan(0.5);
      expect(v).toBeLessThan(1.5);
    }
  });

  it('particles of one burst come out at visibly different sizes', () => {
    const { state, runtime } = rig([0, 0], [4000, 4000], false);
    const sizes = findSpriteSizes(runtime.group);
    for (let i = 0; i < 30; i++) {
      state.tick++;
      runtime.tick(state, SIM_DT, [{ shipIndex: 0, fire: i === 0, aimBearing: Math.PI / 2 }]);
    }
    runtime.update(1 / 60, state);
    const live = [...sizes!].filter((s) => s > 0);
    expect(live.length).toBeGreaterThan(8);
    // uniformity is this project's recurring visual failure; assert spread
    expect(Math.max(...live) / Math.min(...live)).toBeGreaterThan(1.2);
  });
});

describe('the combat TEST SCENE (?scene=combat)', () => {
  const arenaOf = (r: Rig): CombatArena => {
    const arena = createCombatArena(r.state, r.runtime, noCamera(), buildGalleonBlueprint(), {
      enabled: true,
      target: new EventTarget(),
    });
    expect(arena).not.toBeNull();
    return arena!;
  };

  it('is OFF unless the URL asks for it — it may never leak into normal play', () => {
    expect(combatSceneRequested('')).toBe(false);
    expect(combatSceneRequested('?boot=baseline')).toBe(false);
    expect(combatSceneRequested('?scene=combat')).toBe(true);
    const r = rig([0, 0], [190, -150], false);
    expect(
      createCombatArena(r.state, r.runtime, noCamera(), buildGalleonBlueprint(), {
        enabled: false,
      }),
    ).toBeNull();
  });

  it('places both hulls hove to at the preset range and holds them there', () => {
    const r = rig([0, 0], [190, -150], false);
    const arena = arenaOf(r);
    const separation = (): number =>
      Math.hypot(
        r.state.ships[1].position[0] - r.state.ships[0].position[0],
        r.state.ships[1].position[2] - r.state.ships[0].position[2],
      );
    expect(separation()).toBeCloseTo(combatArenaParams.range, 3);

    // shove them hard and step: the harness must put them back, or every
    // A/B comparison it exists to enable is measuring a different scene
    r.state.ships[0].velocity = [12, 0, -9];
    r.state.ships[1].position[0] += 40;
    for (let i = 0; i < 120; i++) {
      r.state.tick++;
      arena.hold(r.state);
      r.runtime.tick(r.state, SIM_DT, [arena.playerOrder(false), arena.enemyOrder()]);
    }
    expect(separation()).toBeCloseTo(combatArenaParams.range, 3);
    expect(r.state.ships[0].sailTrim).toBe(0);
  });

  it('hands the lens back when you press C, and re-parks on P', () => {
    // the vantage is a DEBUG POSE, which outranks every camera mode — so
    // without this the free-fly key would toggle and the camera would not
    // move, in the one scene built for looking at things
    let parks = 0;
    let releases = 0;
    const camera: ArenaCamera = {
      setDebugPose: () => {
        parks++;
      },
      clearDebugPose: () => {
        releases++;
      },
    };
    const target = new EventTarget();
    const r = rig([0, 0], [190, -150], false);
    createCombatArena(r.state, r.runtime, camera, buildGalleonBlueprint(), {
      enabled: true,
      target,
    });
    expect(parks).toBe(1);

    const key = (code: string): KeyboardEvent =>
      new KeyboardEvent('keydown', { code, cancelable: true });
    const c = key('KeyC');
    target.dispatchEvent(c);
    expect(releases).toBe(1);
    // the camera module needs this same keystroke to toggle free-fly
    expect(c.defaultPrevented).toBe(false);

    target.dispatchEvent(key('KeyP'));
    expect(parks).toBe(2);
  });

  it('parks the lens across the line of fire, not down it', () => {
    // a vantage on the firing line sees a ball as a dot that never moves;
    // the arc is only readable from the side
    let parked: readonly [number, number, number] | null = null;
    let aim: readonly [number, number, number] | null = null;
    const camera: ArenaCamera = {
      setDebugPose: (position, target) => {
        parked = position;
        aim = target ?? null;
      },
      clearDebugPose: () => undefined,
    };
    const r = rig([0, 0], [190, -150], false);
    createCombatArena(r.state, r.runtime, camera, buildGalleonBlueprint(), {
      enabled: true,
      target: new EventTarget(),
    });
    expect(parked).not.toBeNull();
    expect(aim).not.toBeNull();
    const p = parked as unknown as readonly [number, number, number];
    const a = aim as unknown as readonly [number, number, number];
    // above the sea, standing off, and looking back at the midpoint
    expect(p[1]).toBeGreaterThan(2);
    expect(Math.hypot(p[0] - a[0], p[2] - a[2])).toBeGreaterThan(
      combatArenaParams.range * 0.4,
    );
  });

  it('B fires the enemy at the player — the side that bears, not a guess', () => {
    const r = rig([0, 0], [190, -150], false);
    const arena = arenaOf(r);
    arena.enemyFire();
    let muzzles = 0;
    for (let i = 0; i < 60; i++) {
      r.state.tick++;
      arena.hold(r.state);
      const frame = r.runtime.tick(r.state, SIM_DT, [
        arena.playerOrder(false),
        arena.enemyOrder(),
      ]);
      muzzles += frame.muzzles.length;
      // the enemy lies at +x of the player, so her guns must fire to PORT
      for (const m of frame.muzzles) {
        expect(m.shipIndex).toBe(1);
        expect(m.position[0]).toBeLessThan(r.state.ships[1].position[0]);
      }
    }
    expect(muzzles).toBeGreaterThan(0);
  });

  it('N fires both, so two smoke banks can be judged in one frame', () => {
    const r = rig([0, 0], [190, -150], false);
    const arena = arenaOf(r);
    arena.bothFire();
    const shooters = new Set<number>();
    for (let i = 0; i < 60; i++) {
      r.state.tick++;
      arena.hold(r.state);
      for (const m of r.runtime.tick(r.state, SIM_DT, [
        arena.playerOrder(false),
        arena.enemyOrder(),
      ]).muzzles) {
        shooters.add(m.shipIndex);
      }
    }
    expect(shooters).toEqual(new Set([0, 1]));
  });

  it('V opens a breach that actually floods, without waiting for a lucky hit', () => {
    const r = rig([0, 0], [190, -150], false);
    const arena = arenaOf(r);
    arena.breachEnemy();
    r.state.tick++;
    arena.hold(r.state);
    const holes = r.runtime.floodHoles(r.state, 1);
    expect(holes.length).toBeGreaterThan(0);
    expect(holes.some((h) => h[1] < 0)).toBe(true); // below the waterline
    const before = r.state.ships[1].flood;
    for (let i = 0; i < 600; i++) {
      stepFlooding(r.state.ships[1], r.runtime.floodHoles(r.state, 1), SIM_DT);
    }
    expect(r.state.ships[1].flood).toBeGreaterThan(before);
  });

  it('M puts the mast over the side, with splinters and a spar in the world', () => {
    const r = rig([0, 0], [190, -150], false);
    const arena = arenaOf(r);
    const { mastId } = arenaTargets(buildGalleonBlueprint());
    arena.dropEnemyMast();
    r.state.tick++;
    arena.hold(r.state);
    expect(r.state.ships[1].damage[mastId]).toBe(0);
    const wreckage = r.runtime.group.getObjectByName('combat-wreckage');
    expect(wreckage!.children.length).toBeGreaterThan(0);
  });

  it('J resets: damage, flooding and the balls in the air all go away', () => {
    const r = rig([0, 0], [190, -150], false);
    const arena = arenaOf(r);
    arena.breachEnemy();
    r.state.tick++;
    arena.hold(r.state);
    r.state.ships[1].flood = 0.4;
    expect(Object.keys(r.state.ships[1].damage).length).toBeGreaterThan(0);

    arena.reset();
    r.state.tick++;
    arena.hold(r.state);
    expect(r.state.ships[1].damage).toEqual({});
    expect(r.state.ships[1].flood).toBe(0);
    expect(r.state.projectiles).toHaveLength(0);
  });

  it('picks its demo pieces off the piece graph, never by a typed-in id', () => {
    // §V.18: a hand-written id rots the first time the blueprint changes,
    // and rots SILENTLY — the harness would just demonstrate nothing
    const blueprint = buildGalleonBlueprint();
    const t = arenaTargets(blueprint);
    expect(t.hullIds.length).toBeGreaterThanOrEqual(combatArenaParams.breachSections);
    for (const id of t.hullIds) {
      const hull = blueprint.find((p) => p.id === id);
      expect(hull?.kind).toBe('hull-section');
      expect(hull?.damageStates.some((s) => s.id === 'holed')).toBe(true);
    }
    expect(blueprint.find((p) => p.id === t.mastId)?.kind).toBe('mast');
    expect(() => arenaTargets([])).toThrow(); // fails loud, §Rule 8
  });
});

describe('the shot has to be followable (a 0.3 m dark sphere at 60 m/s)', () => {
  it('balls stretch along their own velocity, and the stretch is bounded', () => {
    const { state, runtime } = rig([0, 0], [4000, 4000], false);
    const balls = findInstanced(runtime.group) as unknown as {
      count: number;
      getMatrixAt(i: number, m: Matrix4): void;
    };
    for (let i = 0; i < 20; i++) {
      state.tick++;
      runtime.tick(state, SIM_DT, [{ shipIndex: 0, fire: i === 0, aimBearing: Math.PI / 2 }]);
    }
    runtime.update(1 / 60, state);
    expect(balls.count).toBeGreaterThan(0);

    const m = new Matrix4();
    balls.getMatrixAt(0, m);
    // decompose, NOT setFromRotationMatrix: the matrix carries a non-uniform
    // scale, and setFromRotationMatrix assumes it does not
    const scale = new Vector3();
    const rot = new Quaternion();
    m.decompose(new Vector3(), rot, scale);
    // long axis is the ball's own +Y, so y must exceed the cross-section
    expect(scale.y).toBeGreaterThan(scale.x * 1.5);
    expect(scale.y / scale.x).toBeLessThanOrEqual(combatFxParams.ballStretchMax + 1e-6);

    // ...and the long axis really does point along the velocity
    const dir = new Vector3(0, 1, 0).applyQuaternion(rot);
    const v = state.projectiles[0].velocity;
    const vel = new Vector3(v[0], v[1], v[2]).normalize();
    expect(dir.dot(vel)).toBeGreaterThan(0.99);
  });

  it('a ball at rest is drawn round, not degenerate', () => {
    const { state, runtime } = rig([0, 0], [4000, 4000], false);
    state.projectiles.push({
      id: 0,
      position: [0, 5, 0],
      velocity: [0, 0, 0],
      age: 0,
      owner: 0,
    });
    runtime.update(1 / 60, state);
    const balls = findInstanced(runtime.group) as unknown as {
      count: number;
      getMatrixAt(i: number, m: Matrix4): void;
    };
    const m = new Matrix4();
    balls.getMatrixAt(0, m);
    const scale = new Vector3().setFromMatrixScale(m);
    expect(scale.x).toBeCloseTo(scale.y, 6);
    expect(scale.x).toBeGreaterThan(0);
  });

  it('a ball in flight lays a ribbon behind it — with no gun having fired', () => {
    // isolated on purpose: a lone projectile and NO muzzle event, so any
    // live sprite can only be the ball's own trail
    const { state, runtime } = rig([0, 0], [4000, 4000], false);
    const sizes = findSpriteSizes(runtime.group)!;
    state.projectiles.push({
      id: 5,
      position: [0, 40, 0],
      velocity: [45, 12, 0],
      age: 0,
      owner: 0,
    });
    expect([...sizes].filter((s) => s > 0)).toHaveLength(0);
    for (let i = 0; i < 12; i++) {
      state.tick++;
      runtime.tick(state, SIM_DT, []);
    }
    runtime.update(1 / 60, state);
    expect([...sizes].filter((s) => s > 0).length).toBeGreaterThan(0);
  });
});

describe('render sinks can never move the sim (§V.2 determinism)', () => {
  it('the same seed and the same orders replay identically with fx and audio attached', () => {
    const run = (audio: boolean): number => {
      const { state, runtime } = rig([0, 0], [26, 0], audio);
      for (let i = 0; i < 60 * 30; i++) {
        state.tick++;
        state.time += SIM_DT;
        runtime.tick(state, SIM_DT, [
          { shipIndex: 0, fire: i % 120 < 4, aimBearing: Math.PI / 2 },
          { shipIndex: 1, fire: i % 180 < 4, aimBearing: -Math.PI / 2 },
        ]);
        stepFlooding(state.ships[0], runtime.floodHoles(state, 0), SIM_DT);
        stepFlooding(state.ships[1], runtime.floodHoles(state, 1), SIM_DT);
        runtime.settle(state, SIM_DT);
        // render clock deliberately differs between the two runs
        runtime.update(audio ? 1 / 144 : 1 / 30, state);
      }
      return hashState(state);
    };
    expect(run(true)).toBe(run(false));
  });
});

/** a camera stand-in for the arena tests that records nothing */
function noCamera(): ArenaCamera {
  return { setDebugPose: () => undefined, clearDebugPose: () => undefined };
}

/** first InstancedMesh under `root` — the cannonballs */
function findInstanced(root: Object3D): (Object3D & { count: number }) | null {
  let found: (Object3D & { count: number }) | null = null;
  root.traverse((o) => {
    if (found === null && (o as unknown as { isInstancedMesh?: boolean }).isInstancedMesh === true) {
      found = o as Object3D & { count: number };
    }
  });
  return found;
}

/** the sprite pool's per-instance size attribute (0 = dead, §V.28) */
function findSpriteSizes(root: Object3D): Float32Array | null {
  let found: Float32Array | null = null;
  root.traverse((o) => {
    const material = (o as unknown as { material?: { scaleNode?: { value?: { array?: unknown } } } })
      .material;
    const array = material?.scaleNode?.value?.array;
    if (found === null && array instanceof Float32Array) found = array;
  });
  return found;
}

function maxOf(a: Float32Array): number {
  let m = 0;
  for (const v of a) m = Math.max(m, v);
  return m;
}
