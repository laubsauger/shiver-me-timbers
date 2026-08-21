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
    expect(solidAt(-hw - 0.03 - p.crateWidth / 2, L.cabinFrontZ - 0.35)).toBe(true);
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
