/**
 * The opt-in worn geometry (src/ship/pieceGeometryWear.ts) — the film raft's close-camera twin of the game's
 * greybox slabs. What has to hold for it to be safe to swap onto a piece:
 *
 *   - it stays where the piece is: inside the piece's aabb but for the warp's few centimetres (the deck field,
 *     the sockets and the neighbours were all placed against the aabb);
 *   - the subdivision is crack-free (a split edge split alike from both sides): a closed box stays closed, every
 *     edge shared by exactly two triangles — or the warp tears it open and the sky shows through a wall;
 *   - it is opt-in: the pieces the film does not wear (the logs the user likes as they are) come back null, and
 *     the game's own builders are not touched by importing it.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ropeRailParts, softBox, subdivideToEdge, wornPieceGeometry } from '../src/ship/pieceGeometryWear';
import { buildPieceGeometry } from '../src/ship/pieceGeometry';
import { buildRaftBlueprint } from '../src/ship/raftBlueprint';

function bounds(g: THREE.BufferGeometry): THREE.Box3 {
  g.computeBoundingBox();
  return g.boundingBox!;
}

/** every undirected edge (by quantised endpoints) → how many triangles use it */
function edgeUses(g: THREE.BufferGeometry): Map<string, number> {
  const p = g.attributes.position;
  const idx = g.index;
  const n = idx ? idx.count : p.count;
  const key = (i: number): string => [p.getX(i), p.getY(i), p.getZ(i)].map((v) => Math.round(v * 1e5)).join(',');
  const uses = new Map<string, number>();
  for (let t = 0; t < n; t += 3) {
    const v = [0, 1, 2].map((k) => key(idx ? idx.getX(t + k) : t + k));
    for (let k = 0; k < 3; k++) {
      const e = [v[k], v[(k + 1) % 3]].sort().join('|');
      uses.set(e, (uses.get(e) ?? 0) + 1);
    }
  }
  return uses;
}

describe('pieceGeometryWear', () => {
  it('softBox fills its box exactly, edges rounded inside it', () => {
    const b = bounds(softBox(-1, 2, 0, 0.5, -0.3, 0.3, 0.02, 0.1));
    expect(b.min.x).toBeCloseTo(-1, 5);
    expect(b.max.x).toBeCloseTo(2, 5);
    expect(b.min.y).toBeCloseTo(0, 5);
    expect(b.max.y).toBeCloseTo(0.5, 5);
    expect(b.max.z).toBeCloseTo(0.3, 5);
  });

  it('subdivision splits every long edge and leaves a closed box closed (no T-junction to tear)', () => {
    const box = new THREE.BoxGeometry(4, 1.5, 0.05);
    const g = subdivideToEdge(box, 0.1);
    const p = g.attributes.position;
    for (let t = 0; t < p.count; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = new THREE.Vector3().fromBufferAttribute(p, t + k);
        const b = new THREE.Vector3().fromBufferAttribute(p, t + ((k + 1) % 3));
        expect(a.distanceTo(b)).toBeLessThanOrEqual(0.1 + 1e-9);
      }
    }
    for (const n of edgeUses(g).values()) expect(n).toBe(2);
  });

  it('every worn raft piece stays within its aabb but for the warp (a few cm; the thatch fringe hangs further)', () => {
    let worn = 0;
    for (const def of buildRaftBlueprint()) {
      const base = buildPieceGeometry(def.kind, def.aabb, def.shape);
      const g = wornPieceGeometry(def, base);
      if (g === null) continue;
      worn++;
      // (the reed fringe hangs up to ~22 cm off the eave and the gable ends, by design)
      // (a log's bow end is cut at its own length, up to 14 cm off the blueprint's)
      const SLACK = def.kind === 'thatch-roof' ? 0.3 : def.kind === 'log' ? 0.2 : 0.08;
      const b = bounds(g);
      for (let k = 0; k < 3; k++) {
        expect(b.min.getComponent(k), `${def.id} min ${k}`).toBeGreaterThanOrEqual(Math.min(def.aabb.min[k], bounds(base).min.getComponent(k)) - SLACK);
        expect(b.max.getComponent(k), `${def.id} max ${k}`).toBeLessThanOrEqual(Math.max(def.aabb.max[k], bounds(base).max.getComponent(k)) + SLACK);
      }
    }
    // the walls, the thatch and its laths, the mats and the boards: all of them came back worn
    expect(worn).toBeGreaterThanOrEqual(20);
  });

  it('wears only what a close camera reads as cut: the stores, the masts and the sails come back null (as built)', () => {
    for (const def of buildRaftBlueprint()) {
      if (!['crate', 'bipod-mast', 'mast', 'yard', 'sail'].includes(def.kind)) continue;
      expect(wornPieceGeometry(def, buildPieceGeometry(def.kind, def.aabb, def.shape)), def.id).toBeNull();
    }
  });

  it('a worn wall is closed: welded across its rounded edges, no open seam for the light to show through', () => {
    const wall = buildRaftBlueprint().find((d) => d.id === 'cabin-wall-port')!;
    const g = wornPieceGeometry(wall, buildPieceGeometry(wall.kind, wall.aabb, wall.shape))!;
    for (const n of edgeUses(g).values()) expect(n).toBe(2);
  });

  it('the railing rope is made fast at every post head (it ran at a fixed height over posts cut ±9% long)', () => {
    for (const def of buildRaftBlueprint().filter((d) => d.id === 'rail-port' || d.id === 'rail-starboard')) {
      const parts = ropeRailParts(def)!;
      const p = parts.rope.attributes.position;
      for (const post of parts.posts) {
        let near = Infinity;
        const v = new THREE.Vector3();
        for (let i = 0; i < p.count; i++) near = Math.min(near, v.fromBufferAttribute(p, i).distanceTo(post.head));
        // its turns sit just under the head, round the post
        expect(near, def.id).toBeLessThan(post.r + 0.05);
      }
    }
  });
});
