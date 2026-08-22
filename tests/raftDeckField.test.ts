/**
 * §T92 raft deck field — §V83 properties, §V80 style: every assertion names
 * the surface / member it belongs to and derives its numbers from the layout
 * and the blueprint, never from a knob that is free to move.
 */
import { describe, expect, it } from 'vitest';
import { buildRaftBlueprint, raftLayout } from '../src/ship/raftBlueprint';
import {
  buildRaftDeckField,
  createRaftCeiling,
  raftBoardingPoints,
  raftCeilingAt,
  RAFT_FOOT_RADIUS,
} from '../src/ship/raftDeckField';
import { DECK_FIELD_BEAM, DECK_FIELD_LENGTH, sampleDeckField } from '../src/ship/deckHeightfield';
import { raftParams } from '../src/params/raft';
import { playerParams } from '../src/params/player';
import { createDeckSurface } from '../src/player/deckSurface';
import {
  createPlayerState,
  neutralPlayerInput,
  stepPlayer,
  type PlayerState,
  type WalkSurface,
} from '../src/player/playerStep';
import type { PieceDef } from '../src/ship/pieceTypes';
import type { Material } from 'three';
import { ShipAssembly } from '../src/ship/shipAssembly';
import { RAFT_ACTIONS, RAFT_STATIONS } from '../src/player/stations';

const p = raftParams;
const L = raftLayout(p);
const blueprint = buildRaftBlueprint(p);
const field = buildRaftDeckField(blueprint, p);
const surface = createDeckSurface(field, {
  ceilingAt: createRaftCeiling(p),
  boardingPoints: raftBoardingPoints(blueprint, p),
});
const DT = 1 / 60;
const hw = p.cabinWidth / 2;

const piece = (id: string): PieceDef => {
  const pc = blueprint.find((q) => q.id === id);
  if (pc === undefined) throw new Error(`no piece ${id}`);
  return pc;
};
/** ship-space position of a socket (raft sockets sit on un-parented pieces) */
function socketPos(id: string): [number, number, number] {
  for (const pc of blueprint) {
    const s = pc.sockets.find((q) => q.id === id);
    if (s === undefined) continue;
    if (pc.parent !== undefined) throw new Error(`${id} is parented; resolve via assembly`);
    const b = pc.transform.position;
    return [b[0] + s.position[0], b[1] + s.position[1], b[2] + s.position[2]];
  }
  throw new Error(`no socket ${id}`);
}
const h = (x: number, z: number): number => {
  const v = surface.heightAt(x, z);
  if (v === null) throw new Error(`no deck at ${x},${z}`);
  return v;
};
const solidAt = (x: number, z: number): boolean => sampleDeckField(field, field.solid, x, z) >= 0.5;
/** a socket's SHIP-space position through the live assembly (§V71: parented
 *  pieces — the ladder rides a leaning bipod leg — resolve through it) */
const assembly = new ShipAssembly(blueprint, () => ({ dispose(): void {} }) as unknown as Material);
const asmSocket = (id: string): [number, number, number] => assembly.socketWorldPosition(id) as [number, number, number];

const logs = L.logs;
const centre = logs.find((l) => l.i === 0)!;
const log4 = logs[4];
const log5 = logs[5];
/** the doorway in the starboard wall, from the two wall pieces that flank it */
const doorZ0 = piece('cabin-wall-starboard-aft').transform.position[2] + piece('cabin-wall-starboard-aft').aabb.max[2];
const doorZ1 = piece('cabin-wall-starboard-fwd').transform.position[2] + piece('cabin-wall-starboard-fwd').aabb.min[2];
const doorZ = (doorZ0 + doorZ1) / 2;
const foreMatZ = (L.cabinFrontZ + L.mastZ) / 2 + 1.2; // fore deck, clear of the mast legs
const cabinZ = (L.cabinAftZ + L.cabinFrontZ) / 2;
// bare logs: aft of the cabin and its drum, forward of the mizzen/flag poles
const bareZ = L.cabinAftZ - 0.8;

describe('raft deck field — §V83 three surfaces + round logs', () => {
  it('is the same grid and type the ships publish', () => {
    expect(field.width).toBe(DECK_FIELD_BEAM);
    expect(field.height).toBe(DECK_FIELD_LENGTH);
    expect(field.data.length).toBe(field.width * field.height);
    expect(field.plank.length).toBe(field.data.length);
    expect(field.mask.length).toBe(field.data.length);
    expect(field.solid.length).toBe(field.data.length);
    // the rectangle covers the whole log field with a margin
    expect(field.minZ).toBeLessThan(Math.min(...logs.map((l) => l.zStern)));
    expect(field.maxZ).toBeGreaterThan(L.bowZ);
    expect(field.maxX).toBeGreaterThan(L.halfBeam + logs[logs.length - 1].r);
    for (const v of field.data) expect(Number.isFinite(v)).toBe(true);
  });

  it('(1) bare stern log < fore mat < cabin floor, each proud by the member it rests on', () => {
    const stern = h(centre.x, L.sternZ + 0.4);
    const mat = h(0, foreMatZ);
    const cabin = h(0, cabinZ);
    expect(stern).toBeLessThan(mat);
    expect(mat).toBeLessThan(cabin);
    // mats stand on the crossbeams (one diameter + mat), the cabin floor on the box layer
    expect(mat - stern).toBeCloseTo(p.crossbeamDiameter + p.matThickness, 1);
    expect(cabin - mat).toBeCloseTo(p.cabinBoxHeight, 1);
    // the stern log itself is at the log crown, not the waterline
    expect(stern).toBeGreaterThan(p.logAxisY + centre.r * 0.8);
  });

  it('(2) a chink between log-4 and log-5 dips but never reads as sea or no-ground', () => {
    const gap = L.chinks[4];
    const x0 = log4.x;
    const x1 = log5.x;
    const top = Math.max(h(x0, bareZ), h(x1, bareZ));
    let min = Infinity;
    for (let x = x0; x <= x1; x += 0.005) {
      const v = surface.heightAt(x, bareZ);
      expect(v).not.toBeNull();
      expect(Number.isFinite(v)).toBe(true);
      min = Math.min(min, v as number);
    }
    expect(min).toBeLessThan(top); // it IS a dip — water pools along the seam
    expect(min).toBeGreaterThanOrEqual(top - 0.5 * Math.max(log4.r, log5.r));
    expect(min).toBeGreaterThan(p.logAxisY + 0.1); // nowhere near the waterline
    // a foot wider than the chink is carried by the logs either side
    expect(RAFT_FOOT_RADIUS * 2).toBeGreaterThan(gap);
    const xc = log4.x + log4.r + gap / 2;
    let footMax = -Infinity;
    for (let dx = -playerParams.capsuleRadius; dx <= playerParams.capsuleRadius; dx += 0.01) {
      footMax = Math.max(footMax, h(xc + dx, bareZ));
    }
    expect(top - footMax).toBeLessThan(0.15);
  });

  it('(3) solid at the cabin walls, open at the doorway, open on the fore mat', () => {
    expect(solidAt(-hw + p.cabinWallThickness / 2, cabinZ)).toBe(true); // port wall
    expect(solidAt(hw - p.cabinWallThickness / 2, doorZ0 - 0.3)).toBe(true); // stbd wall aft of the door
    expect(solidAt(hw - p.cabinWallThickness / 2, doorZ1 + 0.3)).toBe(true); // and forward of it
    expect(solidAt(hw - p.cabinWallThickness / 2, doorZ)).toBe(false); // the doorway
    expect(solidAt(0, foreMatZ)).toBe(false);
    expect(solidAt(0, cabinZ)).toBe(false); // the cabin floor is walkable
    // crossbeams and foot-rails are stepped over, not walls
    expect(solidAt(-hw - 1.0, L.cabinAftZ + 0.2)).toBe(false);
    expect(solidAt(-L.halfBeam, L.cabinAftZ + 2)).toBe(false);
    // the stern block and the crates are
    expect(solidAt(0, L.sternZ - p.sternProjection / 2)).toBe(true);
    // §B87: the crates alongside the port wall are seeded in size, yaw and
    // spacing now, so the probe reads WHERE THE CRATE IS off the graph rather
    // than re-deriving an authored station that is free to move (§V80).
    const crate = piece('crate-1');
    expect(solidAt(crate.transform.position[0], crate.transform.position[2])).toBe(true);
  });

  it('(4) a log is round: crown higher than its shoulder, falling toward the chink', () => {
    for (const log of logs) {
      const z = bareZ;
      const crown = h(log.x, z);
      const shoulder = h(log.x + log.r * 0.6, z);
      const edge = h(log.x + log.r * 0.9, z);
      expect(crown).toBeGreaterThan(shoulder);
      expect(shoulder).toBeGreaterThan(edge);
    }
  });

  it('(5) ceiling: cabin gable between eave and ridge inside, sky outside', () => {
    const ceil = createRaftCeiling(p);
    const eave = ceil(hw - 0.01, cabinZ);
    const ridge = ceil(0, cabinZ);
    expect(eave).not.toBeNull();
    expect(ridge).not.toBeNull();
    expect((eave as number) - L.cabinFloorY).toBeGreaterThanOrEqual(p.cabinEave - 0.02);
    expect((ridge as number) - L.cabinFloorY).toBeLessThanOrEqual(p.cabinRidge + 1e-6);
    expect(eave as number).toBeLessThan(ridge as number);
    expect(ceil(hw + 0.5, cabinZ)).toBeNull();
    expect(ceil(0, L.cabinFrontZ + 0.5)).toBeNull();
    expect(ceil(0, L.cabinAftZ - 0.5)).toBeNull();
    expect(raftCeilingAt(0, cabinZ)).toBe(ridge);
    // the player must be able to crouch through but never stand
    expect((ridge as number) - h(0, cabinZ)).toBeLessThan(playerParams.standHeight);
    expect((eave as number) - h(hw - 0.1, cabinZ)).toBeGreaterThan(playerParams.crouchHeight);
  });

  it('(6) boarding points lie on the foot-rails or the stern logs, a metre apart', () => {
    const pts = raftBoardingPoints(blueprint, p);
    expect(pts.length).toBeGreaterThanOrEqual(6);
    const rail = piece('foot-rail-port');
    const railZ0 = rail.transform.position[2] + rail.aabb.min[2];
    const railZ1 = rail.transform.position[2] + rail.aabb.max[2];
    for (const [x, y, z] of pts) {
      const ground = surface.heightAt(x, z);
      expect(ground).not.toBeNull();
      expect(Math.abs(y - (ground as number))).toBeLessThan(0.4);
      const onRail = Math.abs(Math.abs(x) - L.halfBeam) < 0.4 && z >= railZ0 - 0.4 && z <= railZ1 + 0.4;
      const onStern = Math.abs(z - L.sternZ) < 0.6;
      expect(onRail || onStern).toBe(true);
      expect(solidAt(x, z)).toBe(false);
    }
  });

  it('(8) determinism: two builds are bit-identical', () => {
    const again = buildRaftDeckField(buildRaftBlueprint(p), p);
    expect(again.data).toEqual(field.data);
    expect(again.mask).toEqual(field.mask);
    expect(again.solid).toEqual(field.solid);
    expect(again.deckY).toBe(field.deckY);
  });

  it('(9) the grid covers the whole raft: every log and chink reads as deck; the lookout does not', () => {
    for (const log of logs) {
      for (let z = log.zStern + 0.1; z < log.zBow - log.length * 0 - p.logBowChamfer; z += 0.25) {
        expect(surface.heightAt(log.x, z)).not.toBeNull();
      }
    }
    for (let k = 0; k < L.chinks.length; k++) {
      const a = logs[k];
      const b = logs[k + 1];
      const xc = a.x + a.r + L.chinks[k] / 2;
      const z0 = Math.max(a.zStern, b.zStern) + 0.1;
      const z1 = Math.min(a.zBow, b.zBow) - p.logBowChamfer;
      for (let z = z0; z < z1; z += 0.25) expect(surface.heightAt(xc, z)).not.toBeNull();
    }
    // outboard of the outer logs there is no deck at all
    expect(surface.heightAt(L.halfBeam + logs[logs.length - 1].r + 0.2, 0)).toBeNull();
    expect(surface.heightAt(0, L.bowZ + 0.05)).toBeNull();
    // the lookout platform is another level, not part of this field
    expect(h(0, L.mastZ) - L.logTopY).toBeLessThan(1.5);
  });
});

describe('(7) the real player walks the raft', () => {
  function walkInput() {
    return { ...neutralPlayerInput(), forward: 1 };
  }
  function standAt(x: number, z: number): PlayerState {
    const s = createPlayerState([x, h(x, z), z]);
    s.grounded = true;
    return s;
  }
  function walkRoute(
    start: PlayerState,
    route: Array<[number, number]>,
    surf: WalkSurface,
    each?: (s: PlayerState) => void,
    maxTicks = 60 * 60,
  ): { s: PlayerState; reached: number; ticks: number } {
    let s = start;
    let next = 0;
    let ticks = 0;
    while (next < route.length && ticks < maxTicks) {
      const [tx, tz] = route[next];
      const dx = tx - s.pos[0];
      const dz = tz - s.pos[2];
      if (Math.hypot(dx, dz) < 0.1) {
        next++;
        continue;
      }
      s = stepPlayer({ ...s, yaw: Math.atan2(dx, dz) }, walkInput(), surf, DT);
      each?.(s);
      ticks++;
    }
    return { s, reached: next, ticks };
  }

  // the lane along the starboard strip: outboard of the kitchen box + the
  // capsule, inboard of the outer log's edge
  const kitchen = piece('kitchen-box');
  const laneX = Math.max(
    kitchen.transform.position[0] + kitchen.aabb.max[0] + playerParams.capsuleRadius + 0.05,
    L.halfBeam - 0.15,
  );
  const tiller = socketPos('station-tiller');

  it('helmsman → starboard strip → through the doorway into the cabin: crouches inside, stands out again', () => {
    const crouchLog: boolean[] = [];
    const route: Array<[number, number]> = [[laneX, tiller[2]], [laneX, doorZ], [hw - 0.6, doorZ], [0, doorZ]];
    const { s, reached } = walkRoute(standAt(tiller[0], tiller[2]), route, surface, (q) => {
      expect(q.frame).toBe('ship');
      expect(solidAt(q.pos[0], q.pos[2])).toBe(false);
      crouchLog.push(q.crouch);
    });
    expect(reached).toBe(route.length);
    expect(s.crouch).toBe(true); // under the roof
    expect(crouchLog[0]).toBe(false); // upright on the stern logs
    // standing on the cabin floor, not on the mats
    expect(s.pos[1]).toBeCloseTo(L.cabinFloorY, 1);

    // back out: upright again once past the wall line
    const out = walkRoute(s, [[hw - 0.6, doorZ], [laneX, doorZ]], surface);
    expect(out.reached).toBe(2);
    expect(out.s.crouch).toBe(false);
    expect(out.s.pos[1]).toBeCloseTo(L.deckY, 1);
  });

  it('the port cabin wall stops the walker; the doorway does not', () => {
    const inside = standAt(0, doorZ);
    const { s, reached } = walkRoute(inside, [[-hw - 1.0, doorZ]], surface, undefined, 10 * 60);
    expect(reached).toBe(0);
    expect(s.frame).toBe('ship');
    expect(s.pos[0]).toBeGreaterThan(-hw + p.cabinWallThickness);
    expect(s.pos[0]).toBeLessThan(-hw + playerParams.capsuleRadius + 0.1);
  });

  it('walking off the starboard edge goes overboard', () => {
    let s = standAt(laneX, doorZ);
    for (let i = 0; i < 4 * 60 && s.frame === 'ship'; i++) {
      s = stepPlayer({ ...s, yaw: Math.PI / 2 }, walkInput(), surface, DT); // +yaw faces +x
    }
    expect(s.frame).toBe('swim');
  });

  it('crossing the bare stern logs athwartships never wedges in a chink', () => {
    const z = L.sternZ + 0.4; // the helmsman's line, clear of the block and the poles
    const x0 = logs[1].x;
    const x1 = logs[logs.length - 2].x;
    const { s, reached } = walkRoute(standAt(x0, z), [[x1, z]], surface, (q) => {
      expect(q.frame).toBe('ship');
    });
    expect(reached).toBe(1);
    expect(Math.abs(s.pos[1] - L.logTopY)).toBeLessThan(0.2);
  });
});

/**
 * §T115 / §B78 — THE RAFT AS A PLACE TO WALK, not as a set of surfaces that
 * happen to be there. The R2 walk review spawned at the tiller and could not
 * leave it, dead-ended on the starboard strip at the bipod, never found the
 * ladder, and never got back aboard after going overboard. Every assertion
 * below is a PROPERTY of the walkable field (§V80) measured with the walker's
 * OWN consumer numbers (§V83: capsule 0.3, step 0.4), not with a route that
 * happened to work.
 */
describe('§T115 the raft is connected: spawn → door → bow → back aboard', () => {
  /** the walker's own admissibility, at one point: deck, no wall, headroom */
  function free(x: number, z: number): number | null {
    const h = surface.heightAt(x, z);
    if (h === null) return null;
    if (surface.solidAt(x, z)) return null;
    const c = surface.ceilingAt?.(x, z) ?? null;
    if (c !== null && c - h < playerParams.crouchHeight) return null;
    return h;
  }

  // half a capsule radius: fine enough that no gap a shoulder fits through is
  // missed, coarse enough to sweep the whole raft in a few ms
  const CELL = playerParams.capsuleRadius / 2;
  const cell = (x: number, z: number): string => `${Math.round(x / CELL)},${Math.round(z / CELL)}`;

  /** 8-neighbour flood over the walkable field; an edge exists iff a stride
   *  could take it, i.e. the rise is within the walker's own `stepUp` */
  function flood(from: readonly [number, number]): Map<string, number> {
    const seen = new Map<string, number>();
    const i0 = Math.round(from[0] / CELL);
    const j0 = Math.round(from[1] / CELL);
    const h0 = free(i0 * CELL, j0 * CELL);
    if (h0 === null) return seen;
    seen.set(`${i0},${j0}`, h0);
    const queue: Array<[number, number]> = [[i0, j0]];
    const iMax = Math.ceil(Math.max(-field.minX, field.maxX) / CELL);
    const jMax = Math.ceil(Math.max(-field.minZ, field.maxZ) / CELL);
    for (let head = 0; head < queue.length; head++) {
      const [i, j] = queue[head];
      const h = seen.get(`${i},${j}`) as number;
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          if (di === 0 && dj === 0) continue;
          const ni = i + di;
          const nj = j + dj;
          if (Math.abs(ni) > iMax || Math.abs(nj) > jMax) continue;
          const k = `${ni},${nj}`;
          if (seen.has(k)) continue;
          const nh = free(ni * CELL, nj * CELL);
          if (nh === null || Math.abs(nh - h) > playerParams.stepUp) continue;
          seen.set(k, nh);
          queue.push([ni, nj]);
        }
      }
    }
    return seen;
  }

  const reached = flood([socketPos('station-tiller')[0], socketPos('station-tiller')[2]]);
  const canReach = (x: number, z: number): boolean => reached.has(cell(x, z));

  it('(T115-2) the tiller spawn is not an island: a free 8-neighbour path runs from it to the doorway', () => {
    // §B78-2: "the stern is an island — a tiller spawn cannot reach the rest
    // of the raft". The spawn cell itself must be standable, and the doorway,
    // the cabin floor, the fore deck and the bow tip must all be in its
    // component — no jumping (`jumpSpeed` is a hop, and the review found
    // Space does nothing aboard).
    expect(reached.size).toBeGreaterThan(0);
    const laneOutside = L.halfBeam - 0.15; // the strip, outboard of the stores
    expect(canReach(laneOutside, doorZ), 'the strip abeam the doorway').toBe(true);
    expect(canReach(hw - 0.6, doorZ), 'the sill').toBe(true);
    expect(canReach(0, cabinZ), 'the cabin floor').toBe(true);
    expect(canReach(0, foreMatZ), 'the fore deck').toBe(true);
    expect(canReach(0, L.bowZ - 1.0), 'the bow').toBe(true);
  });

  it('(T115-3) the starboard road runs stern → doorway → bow, a full capsule wide the whole way', () => {
    // §B78-3: the strip dead-ended at the bipod leg. The property is not
    // "x = 2.3 is walkable" (the leg has to stand somewhere) but that at
    // EVERY station along the raft there is a lane on the starboard side at
    // least one capsule DIAMETER wide — a road, not a slot the width of the
    // man in it. The stores used to leave 0.46 m of it.
    const width = playerParams.capsuleRadius * 2;
    const lane = (z: number): number => {
      let best = 0;
      let run = 0;
      for (let x = 0.2; x <= field.maxX; x += 0.02) {
        run = free(x, z) === null ? 0 : run + 0.02;
        best = Math.max(best, run);
      }
      return best;
    };
    // …over the DECKED length. Forward of the mats the raft is bare tapering
    // logs closing to a point [§1 Bow ends]: it narrows because it is a bow,
    // and the flood above already proves the tip is reachable.
    const tip = piece('deck-fore-tip');
    const deckFwdZ = tip.transform.position[2] + tip.aabb.max[2];
    for (let z = L.sternZ + 0.5; z <= deckFwdZ; z += 0.1) {
      expect(lane(z), `starboard lane at z=${z.toFixed(2)}`).toBeGreaterThanOrEqual(width);
    }
  });

  it('(§T.135) ANYWHERE THE JUMP CAN PUT HIM, THE WALK CAN LEAVE — no roof-trap', () => {
    /**
     * The test §T.135 says is the difference between a jump and a way to get
     * stuck on a roof, run on the REAL raft field rather than on a fixture.
     *
     * The property is the strongest available and it is not "he can get down
     * again": it is that the jump reaches NOTHING OUTSIDE the walk's own
     * component. If every landable cell is already in the flood from the
     * spawn, then leaving any of them is the walk he arrived by, and no
     * argument about falling off or about which ledge faces which is needed.
     *
     * The airborne reachability is a deliberate OVER-approximation, so it can
     * only ever be too strict: the walker is treated as free to travel at his
     * APEX for the whole flight (he is not — the arc is 0.64 s and he is at
     * the top of it for an instant), and to move any distance while up there.
     * Every cell that survives that is a cell no real arc can beat.
     *
     * `admits()` in playerStep is what makes this true of the raft in
     * particular: it refuses a SOLID cell whatever the walker's altitude, and
     * the whole cabin envelope — walls, wall tops, roof — is solid in the
     * field. There is no cabin roof surface to land on at any jump height.
     */
    const apex = playerParams.jumpHeight;
    const airborne = new Map<string, number>();
    const queue: Array<[number, number, number]> = []; // i, j, ceiling of the arc
    for (const [k, h] of reached) {
      const [i, j] = k.split(',').map(Number);
      airborne.set(k, h + apex);
      queue.push([i, j, h + apex]);
    }
    const iMax = Math.ceil(Math.max(-field.minX, field.maxX) / CELL);
    const jMax = Math.ceil(Math.max(-field.minZ, field.maxZ) / CELL);
    for (let head = 0; head < queue.length; head++) {
      const [i, j, ceilY] = queue[head];
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          if (di === 0 && dj === 0) continue;
          const ni = i + di;
          const nj = j + dj;
          if (Math.abs(ni) > iMax || Math.abs(nj) > jMax) continue;
          // `free` IS the walker's own admissibility — deck, not a wall, and
          // headroom for the crouched capsule. A cell it refuses is refused
          // mid-air too (playerStep.admits checks exactly these three).
          const nh = free(ni * CELL, nj * CELL);
          if (nh === null) continue;
          // he can be over this cell if its floor is no more than a stride
          // above the height he is flying at
          if (nh - ceilY > playerParams.stepUp) continue;
          // and once over it he can keep flying at the higher of the two
          const carry = Math.max(ceilY, nh + apex);
          const k = `${ni},${nj}`;
          const seen = airborne.get(k);
          if (seen !== undefined && seen >= carry - 1e-9) continue;
          airborne.set(k, carry);
          queue.push([ni, nj, carry]);
        }
      }
    }
    /**
     * A landing is any cell the flight can be over: he falls onto it. Now the
     * question §T.135 actually asks — CAN HE LEAVE? Three ways out, and they
     * are the three the walker really has:
     *
     *   · a stride to a neighbour no more than `stepUp` above him;
     *   · a DROP off a ledge of any depth — `stepWalk` un-grounds him and he
     *     falls, which is a move he has today with no jump at all;
     *   · over the side. `heightAt` null is the sea, and as of §T.135 the sea
     *     is a place you swim out of: the haul-out and the passive board both
     *     put him back on deck. That is only an escape BECAUSE of this task.
     *
     * A cell with none of the three is a trap, and the failure names it.
     */
    const canLeave = (start: string): boolean => {
      const seen = new Set([start]);
      const q = [start];
      for (let head = 0; head < q.length; head++) {
        const [i, j] = q[head].split(',').map(Number);
        const h = free(i * CELL, j * CELL);
        if (h === null) continue;
        for (let di = -1; di <= 1; di++) {
          for (let dj = -1; dj <= 1; dj++) {
            if (di === 0 && dj === 0) continue;
            const ni = i + di;
            const nj = j + dj;
            if (Math.abs(ni) > iMax || Math.abs(nj) > jMax) return true; // off the field entirely
            if (surface.heightAt(ni * CELL, nj * CELL) === null) return true; // over the side
            const nh = free(ni * CELL, nj * CELL);
            if (nh === null) continue; // a wall, or no headroom
            if (nh - h > playerParams.stepUp) continue; // too high to climb
            const k = `${ni},${nj}`;
            if (reached.has(k)) return true; // back in the walker's own world
            if (seen.has(k)) continue;
            seen.add(k);
            q.push(k);
          }
        }
      }
      return false;
    };
    const trapped = [...airborne.keys()].filter((k) => !reached.has(k) && !canLeave(k));
    expect(
      trapped.slice(0, 8).map((k) => {
        const [i, j] = k.split(',').map(Number);
        return `${(i * CELL).toFixed(2)},${(j * CELL).toFixed(2)} @ ${free(i * CELL, j * CELL)}`;
      }),
      `${trapped.length} cells a jump can land on and the walk cannot leave`,
    ).toEqual([]);

    // …and the reason it holds is worth pinning too, or the next roof gets
    // authored as a walkable slab and this test silently keeps passing on a
    // raft with a ladder onto it. The cabin roof is SOLID over its whole
    // footprint, and its underside is out of reach of apex + a stride.
    const ridgeY = L.cabinFloorY + p.cabinRidge;
    const eaveY = L.cabinFloorY + p.cabinEave;
    const deckTop = Math.max(...[...reached.values()]);
    expect(deckTop + apex + playerParams.stepUp).toBeLessThan(eaveY);
    expect(eaveY).toBeLessThan(ridgeY);
    for (let z = L.cabinAftZ + 0.1; z < L.cabinFrontZ; z += 0.2) {
      for (let x = -hw + 0.1; x < hw; x += 0.2) {
        const y = surface.heightAt(x, z);
        if (y === null) continue;
        // inside the cabin the field reports the FLOOR (walkable, and in the
        // flood); nothing between the floor and the ridge is standable
        expect(y, `cabin surface at ${x.toFixed(2)},${z.toFixed(2)}`).toBeLessThan(eaveY);
      }
    }
  });

  it('(T115-3) every station on the raft stands in the walker\'s own component', () => {
    // §V84 is only true if the stations are REACHABLE ON FOOT. A socket the
    // flood cannot get within arm's length of is a station that does not
    // exist for the player — which is what the ladder was, hung 0.26 m
    // outboard of the deck edge.
    for (const a of RAFT_ACTIONS) {
      const q = asmSocket(RAFT_STATIONS[a].socket);
      let near = false;
      for (let r = 0.4; r <= playerParams.reach && !near; r += 0.1) {
        for (let k = 0; k < 16 && !near; k++) {
          const t = (k / 16) * Math.PI * 2;
          near = canReach(q[0] + Math.cos(t) * r, q[2] + Math.sin(t) * r);
        }
      }
      expect(near, `${a} (${RAFT_STATIONS[a].socket}) has nowhere to stand`).toBe(true);
    }
  });

  it('(T115-1/§V85) every boarding point is within a swimmer\'s climb of the sea', () => {
    // §B78-1: the climb used to be measured from the swimmer's FEET, which
    // hang a body-length under the surface — the rails are 0.44 m of honest
    // freeboard and 1.8 m over his boots, so NOTHING qualified. The property
    // is about the raft: her freeboard is a climb, at every boarding point.
    for (const [x, y, z] of raftBoardingPoints(blueprint, p)) {
      expect(y, `boarding point ${x.toFixed(2)},${z.toFixed(2)} above the sea`).toBeGreaterThan(0);
      expect(y).toBeLessThanOrEqual(playerParams.boardVertical);
    }
  });

  it('(§V85) a swimmer 20 m astern of a drifting raft catches it AND climbs back aboard inside 60 s', () => {
    // The §V85 test that was only ever run against a synthetic rail: on the
    // REAL raft, with the REAL boarding points, drifting at the fastest the
    // invariant allows (swim × 0.5). "Always catchable" includes getting ON.
    let raftX = 0;
    const drifting = createDeckSurface(field, {
      ceilingAt: createRaftCeiling(p),
      boardingPoints: raftBoardingPoints(blueprint, p),
      waterAt: () => 0,
      shipToWorld: (q) => [q[0] + raftX, q[1], q[2]],
    });
    const target = raftBoardingPoints(blueprint, p).find(([, , z]) => Math.abs(z - doorZ) < 0.6) as [number, number, number];
    expect(target).toBeDefined();
    let s: PlayerState = {
      frame: 'swim',
      pos: [target[0] + 20, playerParams.swimEyeAbove - (playerParams.standHeight - playerParams.eyeDrop), target[2]],
      yaw: 0, pitch: 0, vel: [0, 0, 0], crouch: false, grounded: false,
    };
    let t = 0;
    while (t < 60 && s.frame === 'swim') {
      raftX += playerParams.swimSpeed * 0.5 * DT; // away from him, at the §V85 limit
      const bx = target[0] + raftX;
      s = stepPlayer(
        { ...s, yaw: Math.atan2(bx - s.pos[0], target[2] - s.pos[2]) },
        { ...neutralPlayerInput(), forward: 1 },
        drifting,
        DT,
      );
      t += DT;
    }
    expect(s.frame, `still swimming after ${t.toFixed(1)} s`).toBe('ship');
    expect(t).toBeLessThan(60);
    // and he is standing on the raft's own deck, in raft-local coordinates
    expect(surface.heightAt(s.pos[0], s.pos[2])).not.toBeNull();
    expect(Math.abs((surface.heightAt(s.pos[0], s.pos[2]) as number) - s.pos[1])).toBeLessThan(0.4);
  });
});

/**
 * §T.137 — THE WALK SURFACE USES THE RAFT'S OWN WIDTH.
 *
 * USER: "the deck is not wide enough left and right to really use the width,
 * so we're losing a bunch of space… this should also give us more wiggle room
 * to move on deck because right now it's very squeezy."
 *
 * MEASURED, on the built field, with §T115's own instrument (`free`: deck,
 * no wall, headroom, capsule-radius footprint), BEFORE → AFTER:
 *
 *   starboard road (min over the decked length)   0.67 m → 0.67 m
 *   port walkway  (min alongside the cabin)       0.29 m → 0.29 m
 *   stern         (min abaft the cabin's wall)    1.18 m → 1.18 m
 *   flat mat, starboard strip                     1.20 m → 1.46 m
 *   flat mat, fore deck                           4.86 m → 5.41 m
 *   flat mat, bow-tip slab                        3.68 m → 4.24 m
 *
 * READ THAT HONESTLY: widening the mats did NOT widen one walkable lane, and
 * it could not have. The bare logs outboard of the mats were ALREADY walkable
 * to the very edge — a round log is a 35° ramp in this field, not a wall — so
 * the mats' width never bounded any lane. What bounds them is the STORES: the
 * kitchen box holds the starboard road to 0.67 m and the jerrycan stack holds
 * the port walkway to 0.29 m of standable centre (0.62 m of clear floor for a
 * 0.60 m man). Both are `buildDressing` pieces. The deck widening is a real
 * fix to a real defect — the mats stopped at the outer logs' CENTRELINES — but
 * it is a fix to what the deck LOOKS like and what is flat under foot, not to
 * the squeeze, and saying otherwise would be the fourth mis-diagnosis this
 * week (§B78-2 was a lane width, not a wall).
 */
describe('§T.137 the mats reach the logs\' edges, and the lanes that were roads still are', () => {
  const strip = piece('deck-starboard');
  const outer = { port: L.logs[0], starboard: L.logs[L.logs.length - 1] };
  const face = {
    port: outer.port.x - outer.port.r,
    starboard: outer.starboard.x + outer.starboard.r,
  };

  function free(x: number, z: number): number | null {
    const y = surface.heightAt(x, z);
    if (y === null) return null;
    if (surface.solidAt(x, z)) return null;
    const c = surface.ceilingAt?.(x, z) ?? null;
    if (c !== null && c - y < playerParams.crouchHeight) return null;
    return y;
  }
  /** widest free run of capsule CENTRES in [x0, x1] at station z */
  function lane(z: number, x0: number, x1: number): number {
    let best = 0;
    let run = 0;
    for (let x = x0; x <= x1; x += 0.01) {
      run = free(x, z) === null ? 0 : run + 0.01;
      best = Math.max(best, run);
    }
    return best;
  }

  it('you stand on BAMBOO out to the log faces, not on a rounded log shoulder', () => {
    // §V83: the field is written from the pieces, so this is the deck's own
    // width measured where a foot goes. The bar is the mat's own thickness —
    // "the surface at the edge is the MAT surface" — not a metre value. The
    // station is one FOOT-SOLE in from the log's face: the field is a 192-texel
    // grid, so the last texel straddles the edge and blends the mat into the
    // water; a sole's width in is the outermost place a foot actually rests.
    // Before: a whole sole in from the face the foot was on ROUND LOG,
    // 0.18 m below the mats, on both sides and down the whole decked length.
    const stripZ = [strip.transform.position[2] + strip.aabb.min[2] + 0.2,
      strip.transform.position[2] + strip.aabb.max[2] - 0.2];
    for (let z = stripZ[0]; z <= stripZ[1]; z += 0.2) {
      const y = surface.heightAt(face.starboard - RAFT_FOOT_RADIUS, z);
      expect(y, `starboard strip edge at z=${z.toFixed(2)}`).not.toBeNull();
      expect(Math.abs((y as number) - L.deckY), `mat under foot at z=${z.toFixed(2)}`)
        .toBeLessThanOrEqual(p.matThickness);
    }
    const fore = piece('deck-fore');
    const foreZ = [fore.transform.position[2] + fore.aabb.min[2] + 0.2,
      fore.transform.position[2] + fore.aabb.max[2] - 0.1];
    for (let z = foreZ[0]; z <= foreZ[1]; z += 0.2) {
      for (const side of ['port', 'starboard'] as const) {
        const x = side === 'port' ? face.port + RAFT_FOOT_RADIUS : face.starboard - RAFT_FOOT_RADIUS;
        const y = surface.heightAt(x, z);
        expect(y, `fore deck ${side} edge at z=${z.toFixed(2)}`).not.toBeNull();
        expect(Math.abs((y as number) - L.deckY), `${side} mat under foot at z=${z.toFixed(2)}`)
          .toBeLessThanOrEqual(p.matThickness);
      }
    }
  });

  it('the starboard road and the stern are still roads — a capsule diameter with room to spare', () => {
    // The two lanes §T.137 leaves as roads. Stated margins, measured:
    // starboard 0.67 m (0.07 over one capsule diameter, held by `kitchen-box`)
    // stern 1.18 m (0.58 over, held by the cabin's aft wall + `dinghy`)
    const cap = playerParams.capsuleRadius * 2;
    const tip = piece('deck-fore-tip');
    const deckFwdZ = tip.transform.position[2] + tip.aabb.max[2];
    for (let z = L.sternZ + 0.5; z <= deckFwdZ; z += 0.05) {
      expect(lane(z, 0.2, field.maxX), `starboard road at z=${z.toFixed(2)}`).toBeGreaterThan(cap);
    }
    for (let z = L.sternZ + 0.4; z <= L.cabinAftZ; z += 0.05) {
      expect(lane(z, field.minX, field.maxX), `stern at z=${z.toFixed(2)}`)
        .toBeGreaterThan(cap + playerParams.capsuleRadius);
    }
  });

  /**
   * ROUTED, NOT DONE — the same hand-off as §T.137's railing.
   *
   * The port walkway is 0.29 m of standable centre at its worst (z ≈ −1.05),
   * i.e. 0.62 m of clear floor for a 0.60 m capsule: the man gets past with a
   * shoulder over the water. The reference does call this side "lashed
   * boxes/gear with narrow walkway" [§1 Deck coverage], so it is meant to be
   * the tight one — but not this tight.
   *
   * WHAT HOLDS IT (measured): the two `jerrycan-*` are placed OUTBOARD of the
   * port crate stack, at `crateX1 - crateWidth - 0.05`, so the gear reaches
   * x = −2.06 on a raft whose port face is at −2.72. The crates themselves
   * reach −2.07 at `crateSizeVar`'s widest draw. Both are in
   * `src/ship/raftPartsCabin.ts:buildDressing`, which this task was told not
   * to touch. Stack the cans ON the crates (or move them to the fore deck)
   * and the walkway opens to ≈ 0.6 m of centre without moving one reference
   * dimension. Un-skip this with that change.
   */
  it.skip('(ROUTED) the port walkway past the cargo takes a capsule with room', () => {
    const cap = playerParams.capsuleRadius * 2;
    for (let z = L.cabinAftZ; z <= L.cabinFrontZ; z += 0.05) {
      expect(lane(z, field.minX, -p.cabinWidth / 2), `port walkway at z=${z.toFixed(2)}`)
        .toBeGreaterThanOrEqual(cap);
    }
  });
});
