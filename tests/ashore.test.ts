/**
 * §T.100 step ashore + terrain walk + back aboard — WHY: §V85 puts the
 * walker in RAFT-LOCAL coordinates aboard and WORLD coordinates ashore, so
 * every frame crossing is a coordinate conversion against the LIVE raft
 * pose (§V71), and the one way to know they all agree is a round trip:
 * deck → gangway → sand → slope → water → sand → deck, with the raft beached
 * at an arbitrary yaw and heel. The island is a synthetic `heightAt` (§V90
 * tests on the heightmap only); limits are read from `playerParams`
 * (§V80); no GPU (§V88).
 *
 * Driven through the REAL player (`createPlayer`): keys on an EventTarget,
 * sockets from the real raft assembly through the pose, the real raft deck
 * field — so the surface-per-frame pick in `index.ts` is under test, not a
 * hand-assembled copy of it.
 */
import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3, type Material } from 'three';
import { createPlayer, type Player } from '../src/player/index';
import { createTerrainSurface, terrainSlopeAt } from '../src/player/ashore';
import { boardingSpotFrom, transitionFrame, type FrameContext } from '../src/player/frames';
import { createPlayerState, type PlayerState, type Vec3 } from '../src/player/playerStep';
import { playerParams } from '../src/params/player';
import { CONTROL_CODES } from '../src/input/controlMap';
import { buildRaftBlueprint } from '../src/ship/raftBlueprint';
import { buildRaftDeckField, raftBoardingPoints, createRaftCeiling } from '../src/ship/raftDeckField';
import { ShipAssembly } from '../src/ship/shipAssembly';
import { createInitialState } from '../src/state/simState';
import type { Quat } from '../src/state/simState';

const DT = 1 / 60;
const P = playerParams;
const stubFactory = () => ({ dispose(): void {} }) as unknown as Material;

const blueprint = buildRaftBlueprint();
const field = buildRaftDeckField(blueprint);
const asm = new ShipAssembly(blueprint, stubFactory);
const boarding = raftBoardingPoints(blueprint);
const ceiling = createRaftCeiling();

function keyEvent(type: string, code: string): Event {
  const e = new Event(type, { cancelable: true }) as Event & Record<string, unknown>;
  e.code = code;
  e.repeat = false;
  e.metaKey = false;
  e.altKey = false;
  e.ctrlKey = false;
  e.shiftKey = false;
  return e;
}

/** the raft's pose: yaw about +y then heel (roll about its own +z), at `position` */
function pose(yaw: number, heelDeg: number, position: Vec3): { position: Vec3; quaternion: Quat } {
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw);
  q.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), (heelDeg * Math.PI) / 180));
  return { position, quaternion: [q.x, q.y, q.z, q.w] };
}

/**
 * A synthetic island laid out in the raft's OWN heading so the same scene
 * works at any yaw: `s` is metres ahead of the raft origin along her
 * forward, `l` metres to her left.
 *   s < bowS + 0.2       : apron, −0.05 m just off the bow, falling away astern at 27% (the beach she beached on)
 *   bowS+0.2 … +25        : gentle 8.5° rise (walkable)
 *   beyond +25            : a 40° bank (NOT walkable)
 *   l > 6                 : the shore shelves down to a lagoon at 26.5° (l ≈ 14 is swimming depth)
 */
function island(yaw: number, origin: Vec3, bowS: number) {
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  const lx = Math.cos(yaw);
  const lz = -Math.sin(yaw);
  const foot = bowS + 0.2;
  return (x: number, z: number): number => {
    const dx = x - origin[0];
    const dz = z - origin[2];
    const s = dx * fx + dz * fz;
    const l = dx * lx + dz * lz;
    const shore = l > 6 ? 4.5 - 0.5 * (l - 6) : Infinity;
    if (s < foot) return Math.min(shore, -0.05 + 0.27 * (s - foot));
    const gentle = -0.05 + Math.tan((8.5 * Math.PI) / 180) * Math.min(25, s - foot);
    if (s - foot <= 25) return Math.min(shore, gentle);
    return Math.min(shore, gentle + Math.tan((40 * Math.PI) / 180) * (s - foot - 25));
  };
}

interface Rig {
  player: Player;
  target: EventTarget;
  state(): PlayerState;
  toWorld(p: Vec3): Vec3;
  ground(x: number, z: number): number;
  yaw: number;
  origin: Vec3;
  bowS: number;
}

function mount(yaw = 0, heelDeg = 0): Rig {
  const origin: Vec3 = [12, 0, -7];
  const sp = pose(yaw, heelDeg, origin);
  const q = new Quaternion(sp.quaternion[0], sp.quaternion[1], sp.quaternion[2], sp.quaternion[3]);
  const toWorld = (p: Vec3): Vec3 => {
    const v = new Vector3(p[0], p[1], p[2]).applyQuaternion(q);
    return [v.x + origin[0], v.y + origin[1], v.z + origin[2]];
  };
  const gangway = asm.socketWorldPosition('station-gangway-bow') as Vec3; // ship-local (assembly at identity)
  const bowS = gangway[2];
  const ground = island(yaw, origin, bowS);
  const sim = createInitialState(1);
  const target = new EventTarget();
  // spawn one stride aft of the bow gangway, on the centre log, facing the bow
  const spawn: Vec3 = [gangway[0], field.deckY, gangway[2] - 0.6];
  const player = createPlayer({
    sim,
    shipPose: () => sp,
    deckField: field,
    boardingPoints: boarding,
    ceilingAt: ceiling,
    keyTarget: target,
    spawn,
    socketWorld: (id) => {
      try {
        return toWorld(asm.socketWorldPosition(id) as Vec3);
      } catch {
        return null;
      }
    },
    groundAt: ground,
  });
  player.setActive(true);
  return { player, target, state: () => sim.player as PlayerState, toWorld, ground, yaw, origin, bowS };
}

/** hold `codes` for `seconds`, with the walker's yaw set to `faceYaw` (frame-relative) */
function walk(r: Rig, codes: string[], seconds: number, faceYaw?: number, each?: (s: PlayerState) => void): void {
  for (const c of codes) r.target.dispatchEvent(keyEvent('keydown', c));
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    if (faceYaw !== undefined) (r.state() as { yaw: number }).yaw = faceYaw;
    r.player.step(DT);
    each?.(r.state());
  }
  for (const c of codes) r.target.dispatchEvent(keyEvent('keyup', c));
}

function settle(r: Rig): void {
  for (let i = 0; i < 10; i++) r.player.step(DT);
}

/** world yaw that faces `forwardOffset` metres along the raft's forward (+) or astern (−) */
const faceAlong = (r: Rig, sign: 1 | -1): number => (sign > 0 ? r.yaw : r.yaw + Math.PI);
/** world yaw facing the raft's left (+) or right (−) — yaw + turns toward +x, i.e. left */
const faceLeft = (r: Rig, sign: 1 | -1): number => r.yaw + (sign * Math.PI) / 2;

/** crouch and look down at the gangway socket, press E */
function stepOff(r: Rig): void {
  const s = r.state();
  (s as { pitch: number }).pitch = -1.2;
  (s as { yaw: number }).yaw = 0;
  r.target.dispatchEvent(keyEvent('keydown', CONTROL_CODES.walkCrouch));
  for (let i = 0; i < 5; i++) r.player.step(DT);
  expect(r.player.interact.focus()).toBe('gangway-bow');
  r.target.dispatchEvent(keyEvent('keydown', CONTROL_CODES.interact));
  r.player.step(DT);
  r.target.dispatchEvent(keyEvent('keyup', CONTROL_CODES.walkCrouch));
  r.target.dispatchEvent(keyEvent('keyup', CONTROL_CODES.interact));
}

function roundTrip(yaw: number, heel: number): void {
  const r = mount(yaw, heel);
  settle(r);
  expect(r.state().frame).toBe('ship');

  // 1. gangway: the feet land on the GROUND, in WORLD coordinates, ahead of the bow
  stepOff(r);
  const s1 = r.state();
  expect(s1.frame).toBe('world');
  expect(s1.pos[1]).toBeCloseTo(r.ground(s1.pos[0], s1.pos[2]), 9);
  const bowW = r.toWorld([0, 0, r.bowS]);
  const ahead = (s1.pos[0] - bowW[0]) * Math.sin(yaw) + (s1.pos[2] - bowW[2]) * Math.cos(yaw);
  expect(ahead).toBeCloseTo(P.stepOffDistance, 6);
  // the world yaw is the ship yaw the walker faced plus the raft's heading
  expect(Math.cos(s1.yaw - yaw)).toBeCloseTo(1, 6);

  // 2. 20 m up the gentle slope: y tracks the ground the whole way, the frame stays 'world'
  settle(r);
  expect(r.state().frame).toBe('world'); // standing beside the raft does NOT bounce back aboard
  let maxGap = 0;
  walk(r, [CONTROL_CODES.walkForward], 20 / P.walkSpeed + 2, faceAlong(r, 1), (s) => {
    expect(s.frame).toBe('world');
    maxGap = Math.max(maxGap, Math.abs(s.pos[1] - r.ground(s.pos[0], s.pos[2])));
  });
  const s2 = r.state();
  const climbed = (s2.pos[0] - s1.pos[0]) * Math.sin(yaw) + (s2.pos[2] - s1.pos[2]) * Math.cos(yaw);
  expect(climbed).toBeGreaterThan(20);
  expect(maxGap).toBeLessThan(P.stepUp);
  expect(s2.pos[1]).toBeGreaterThan(s1.pos[1] + 2); // it IS a slope

  // 3. the 40° bank stops the walk: another 20 s of forward gains < 2 m past the bank foot
  walk(r, [CONTROL_CODES.walkForward], 20, faceAlong(r, 1));
  const s3 = r.state();
  const bankFoot = r.bowS + 0.2 + 25;
  const along = (s3.pos[0] - r.origin[0]) * Math.sin(yaw) + (s3.pos[2] - r.origin[2]) * Math.cos(yaw);
  expect(along).toBeLessThan(bankFoot + 1.0);
  expect(along).toBeGreaterThan(bankFoot - 2.0); // but she got TO the bank
  expect(s3.frame).toBe('world');

  // 4. into the lagoon (left, > 10 m): the frame flips to 'swim' when the ground is below water − swimDepth
  let swamAt: PlayerState | null = null;
  walk(r, [CONTROL_CODES.walkForward], 16 / P.walkSpeed + 4, faceLeft(r, 1), (s) => {
    if (s.frame === 'swim' && swamAt === null) swamAt = s;
  });
  expect(swamAt).not.toBeNull();
  expect(r.ground(swamAt!.pos[0], swamAt!.pos[2])).toBeLessThan(-P.swimDepth);
  expect(r.state().frame).toBe('swim');

  // 5. swim back toward the sand: ground rises → 'world' again, feet on the ground
  walk(r, [CONTROL_CODES.walkForward], 8 / P.swimSpeed + 4, faceLeft(r, -1));
  const s5 = r.state();
  expect(s5.frame).toBe('world');
  expect(s5.pos[1]).toBeCloseTo(r.ground(s5.pos[0], s5.pos[2]), 9);

  // 6. walk back down to the raft and aboard at its edge: 'ship', feet ship-local ON the deck
  // (head for the bow from wherever she is)
  let aboard: PlayerState | null = null;
  walk(r, [CONTROL_CODES.walkForward], 60, undefined, (s) => {
    if (s.frame === 'ship') {
      if (aboard === null) aboard = s;
      return;
    }
    // steer: world yaw toward a point just ahead of the bow
    const gw = r.toWorld([0, 0, r.bowS - 0.5]);
    (s as { yaw: number }).yaw = Math.atan2(gw[0] - s.pos[0], gw[2] - s.pos[2]);
  });
  expect(aboard).not.toBeNull();
  const a = aboard as unknown as PlayerState;
  const deckH = field.deckY;
  // ship-local: within the deck field and on a walkable cell, at that cell's height
  expect(a.pos[0]).toBeGreaterThanOrEqual(field.minX);
  expect(a.pos[0]).toBeLessThanOrEqual(field.maxX);
  expect(a.pos[2]).toBeGreaterThanOrEqual(field.minZ);
  expect(a.pos[2]).toBeLessThanOrEqual(field.maxZ);
  expect(Math.abs(a.pos[1] - deckH)).toBeLessThan(0.6);
  expect(a.grounded).toBe(true);
  // and the walker keeps walking on the deck afterwards without falling through
  walk(r, [], 1);
  expect(r.state().frame).toBe('ship');
}

describe('§T.100 round trip: deck → gangway → slope → bank → lagoon → sand → deck', () => {
  it('raft at yaw 0, level', () => roundTrip(0, 0));
  it('raft yawed 90° and heeled 5°: the same trip, through the live pose', () => roundTrip(Math.PI / 2, 5));
  it('raft yawed −137° and heeled −5°', () => roundTrip((-137 * Math.PI) / 180, -5));
});

describe('§T.100 gangway refinements', () => {
  /** the raft at identity over FLAT ground at `g`, walker crouched at the bow gangway looking down at it */
  function atGangway(g: number): Player {
    const origin: Vec3 = [0, 0, 0];
    const sp = pose(0, 0, origin);
    const bowS = (asm.socketWorldPosition('station-gangway-bow') as Vec3)[2];
    const player = createPlayer({
      sim: createInitialState(1),
      shipPose: () => sp,
      deckField: field,
      keyTarget: new EventTarget(),
      spawn: [0, field.deckY, bowS - 0.6],
      socketWorld: (id) => {
        try {
          return asm.socketWorldPosition(id) as Vec3;
        } catch {
          return null;
        }
      },
      groundAt: () => g,
    });
    player.setActive(true);
    for (let i = 0; i < 5; i++) player.step(DT);
    const st = player.state as { pitch: number; yaw: number; crouch: boolean };
    st.pitch = -1.2;
    st.yaw = 0;
    st.crouch = true;
    return player;
  }

  it('no step-off onto ground deeper than swimDepth, nor onto ground more than ashoreVertical from the feet; ground in range works', () => {
    const feetY = field.deckY;
    const cases: Array<[string, number, 'ship' | 'world']> = [
      ['too deep', -P.swimDepth - 0.2, 'ship'],
      ['too far down', feetY - P.ashoreVertical - 0.3, 'ship'],
      ['too far up', feetY + P.ashoreVertical + 0.3, 'ship'],
      ['just below the edge', feetY - P.ashoreVertical + 0.1, 'world'],
      ['awash but wadeable', -P.swimDepth + 0.05, 'world'],
    ];
    for (const [label, g, frame] of cases) {
      const player = atGangway(g);
      // §T.145a — the prompt IS the action's precondition: a landing the
      // step-off would refuse is not offered either. This used to assert
      // `'gangway-bow'` for all five, which is how "step ashore" came to be
      // offered in the middle of the ocean.
      expect(player.interact.focus(), label).toBe(frame === 'world' ? 'gangway-bow' : null);
      player.interact.begin();
      expect(player.state.frame, label).toBe(frame);
      if (frame === 'world') expect(player.state.pos[1], label).toBe(g);
      player.dispose();
    }
  });
});

describe('§T.100 terrain surface and frame rules in isolation', () => {
  const flatGround = (h: number) => (): number => h;

  it('ground under more than swimDepth of water is no ground; above it, it is', () => {
    const wet = createTerrainSurface({ groundAt: flatGround(-P.swimDepth - 0.01) });
    const damp = createTerrainSurface({ groundAt: flatGround(-P.swimDepth + 0.01) });
    expect(wet.heightAt(0, 0)).toBeNull();
    expect(damp.heightAt(0, 0)).toBeCloseTo(-P.swimDepth + 0.01, 12);
    // the rule follows the sea, not y = 0
    const high = createTerrainSurface({ groundAt: flatGround(0.5), waterAt: () => 1.0 });
    expect(high.heightAt(0, 0)).toBeNull();
  });

  it('slope just under terrainSlopeDeg is open, just over is solid, in every direction; an obstacle is solid', () => {
    const lim = (P.terrainSlopeDeg * Math.PI) / 180;
    const under = Math.tan(lim - 0.03);
    const over = Math.tan(lim + 0.03);
    for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1], [Math.SQRT1_2, Math.SQRT1_2]]) {
      const ok = createTerrainSurface({ groundAt: (x, z) => under * (x * ax + z * az) });
      const wall = createTerrainSurface({ groundAt: (x, z) => over * (x * ax + z * az) });
      expect(ok.solidAt(3, 3), `${ax},${az}`).toBe(false);
      expect(wall.solidAt(3, 3), `${ax},${az}`).toBe(true);
      expect(terrainSlopeAt((x, z) => under * (x * ax + z * az), 3, 3, 0.25)).toBeCloseTo(under, 6);
    }
    const prop = createTerrainSurface({ groundAt: flatGround(0), obstacleAt: (x) => x > 5 });
    expect(prop.solidAt(4, 0)).toBe(false);
    expect(prop.solidAt(5.2, 0)).toBe(true); // the capsule footprint reaches it
  });

  it('walking speed eases from 1 on the flat to slopeSlowdown at the limit', () => {
    const flat = createTerrainSurface({ groundAt: flatGround(0) });
    expect(flat.speedAt!(0, 0)).toBe(1);
    const lim = Math.tan((P.terrainSlopeDeg * Math.PI) / 180);
    const steep = createTerrainSurface({ groundAt: (x) => lim * x });
    expect(steep.speedAt!(0, 0)).toBeCloseTo(P.slopeSlowdown, 6);
    const half = createTerrainSurface({ groundAt: (x) => 0.5 * lim * x });
    const v = half.speedAt!(0, 0);
    expect(v).toBeGreaterThan(P.slopeSlowdown);
    expect(v).toBeLessThan(1);
  });

  it('world → ship only while MOVING TOWARD the deck: standing beside it, or walking away, stays ashore', () => {
    // a 4 m square deck at y = 0.5, raft at identity
    const ctx: FrameContext = {
      shipToWorld: (p) => [p[0], p[1], p[2]],
      worldToShip: (p) => [p[0], p[1], p[2]],
      groundAt: () => 0.3,
      waterAt: () => 0,
      deckHeightAt: (x, z) => (Math.abs(x) <= 2 && Math.abs(z) <= 2 ? 0.5 : null),
    };
    const beside: Vec3 = [2.6, 0.3, 0];
    expect(boardingSpotFrom(beside, [0, 0, 0], ctx)).toBeNull();
    expect(boardingSpotFrom(beside, [1, 0, 0], ctx)).toBeNull(); // away
    const spot = boardingSpotFrom(beside, [-1, 0, 0], ctx); // toward
    expect(spot).not.toBeNull();
    expect(spot![1]).toBe(0.5);
    expect(Math.abs(spot![0])).toBeLessThanOrEqual(2);
    // too high a deck edge is not boardable from the ground
    const tall: FrameContext = { ...ctx, deckHeightAt: (x, z) => (Math.abs(x) <= 2 && Math.abs(z) <= 2 ? 0.3 + P.ashoreVertical + 0.1 : null) };
    expect(boardingSpotFrom(beside, [-1, 0, 0], tall)).toBeNull();
    // through transitionFrame the yaw becomes ship-relative: with the raft yawed 90° a world-north walker faces ship −x
    const yawed: FrameContext = {
      ...ctx,
      shipToWorld: (p) => [p[2], p[1], -p[0]],
      worldToShip: (p) => [-p[2], p[1], p[0]],
    };
    const w: PlayerState = { ...createPlayerState([0, 0.3, -2.6], 0), frame: 'world', vel: [0, 0, 1], grounded: true };
    const s = transitionFrame(w, yawed);
    expect(s.frame).toBe('ship');
    expect(Math.cos(s.yaw + Math.PI / 2)).toBeCloseTo(1, 9);
  });

  it('transitions are deterministic and never produce NaN from a NaN ground sample', () => {
    const ctx: FrameContext = {
      shipToWorld: (p) => p,
      worldToShip: (p) => p,
      groundAt: () => NaN,
      waterAt: () => 0,
      deckHeightAt: () => null,
    };
    const w: PlayerState = { ...createPlayerState([1, 0, 1]), frame: 'world' };
    const a = transitionFrame(w, ctx);
    const b = transitionFrame(w, ctx);
    expect(a).toEqual(b);
    expect(a.frame).toBe('swim'); // no ground is water
    for (const v of a.pos) expect(Number.isFinite(v)).toBe(true);
  });
});
