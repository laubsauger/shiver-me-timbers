/**
 * THE FORE DECK STOPS AT THE BOW BOARDS (the user, 2026-11-02, of the raft at the bow: "Is it possible that there's deck
 * poking out through the sidewall? That should actually be cut: it should follow the shape of the sidewall, this
 * triangular shape … so it doesn't poke through, doesn't z-fight, and is flush with the angle of this wall").
 *
 * The fore slabs (raftPartsHull.ts buildBambooDeck) are rectangles as wide as the logs; the two bow boards run in a V
 * across their outer corners, which stood 0.45–0.5 m out through them. Both the game's slab (pieceGeometry.ts) and the
 * film's slatted mat (pieceGeometryWear.ts) are now cut to the boards' inner faces. Held as properties of the geometry
 * against the boards' own planks, so a re-cut board or a re-laid deck keeps them honest:
 *   - no point of any fore deck mat lies inside or beyond a bow board (the board's plank as built, its own box);
 *   - and the mat reaches the board: its cut edge lies along the board's face within a centimetre (cut flush, not short).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildRaftBlueprint } from '../src/ship/raftBlueprint';
import { buildPieceGeometry } from '../src/ship/pieceGeometry';
import { wornPieceGeometry } from '../src/ship/pieceGeometryWear';
import type { PieceDef } from '../src/ship/pieceTypes';

const bp = buildRaftBlueprint();
const FORE = ['deck-fore', 'deck-fore-taper', 'deck-fore-tip'];
const boards = bp.filter((d) => d.id === 'splashboard-port' || d.id === 'splashboard-starboard');

/** a piece's placement (position, then its yaw: the blueprint's slabs and boards turn about y only) */
const placed = (d: PieceDef): THREE.Matrix4 =>
  new THREE.Matrix4().compose(new THREE.Vector3(...d.transform.position), new THREE.Quaternion().setFromEuler(new THREE.Euler(...(d.transform.rotation ?? [0, 0, 0]))), new THREE.Vector3(1, 1, 1));

/** m a raft-frame point lies into a board's plank toward its outside (the plank's inner face at 0; > 0 into it or past) */
function intoBoard(p: THREE.Vector3, board: PieceDef): number {
  const inv = placed(board).invert();
  const q = p.clone().applyMatrix4(inv);
  const { min, max } = board.aabb;
  // (only along the plank's length: past its ends the board is not there)
  if (q.x < min[0] || q.x > max[0]) return -Infinity;
  // the plank's inner face is the one toward the deck (−z or +z in its frame: the side the raft's middle is on)
  const mid = new THREE.Vector3(0, 0, 0).applyMatrix4(inv);
  return mid.z < 0 ? q.z - min[2] < 0 ? -(min[2] - q.z) : q.z - min[2] : max[2] - q.z;
}

const pointsOf = (d: PieceDef, g: THREE.BufferGeometry): THREE.Vector3[] => {
  const m = placed(d);
  const pos = g.getAttribute('position');
  return Array.from({ length: pos.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m));
};

describe('the fore deck is cut to the bow boards', () => {
  for (const [label, build] of [
    ['the game slab', (d: PieceDef) => buildPieceGeometry(d.kind, d.aabb, d.shape)],
    ['the film mat', (d: PieceDef) => wornPieceGeometry(d, buildPieceGeometry(d.kind, d.aabb, d.shape))!],
  ] as const) {
    it(`${label}: no point of it lies in or beyond either board, and it reaches each one it meets`, () => {
      const reach = new Map<string, number>();
      for (const id of FORE) {
        const d = bp.find((x) => x.id === id)!;
        for (const p of pointsOf(d, build(d))) {
          // (the top of the mat: a point under the board's foot is under the logs' tips, not through the board)
          for (const b of boards) {
            const into = intoBoard(p, b);
            expect(into, `${id} at ${p.toArray().map((v) => v.toFixed(2))} into ${b.id}`).toBeLessThan(1e-3);
            reach.set(b.id, Math.max(reach.get(b.id) ?? -Infinity, into));
          }
        }
      }
      // (flush: the closest any point of the deck comes to each board's inner face)
      for (const b of boards) expect(reach.get(b.id)!, `${b.id}: the deck stops short of it`).toBeGreaterThan(-0.01);
    });
  }
});
