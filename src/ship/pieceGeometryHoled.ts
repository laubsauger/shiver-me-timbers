/**
 * Holed damage-state variant (§V.14): base greybox shape + readable jagged
 * breach — torn edge ring (wood) around a dark hole disc. Two geometry
 * groups: [0] wood material, [1] hole material. Greybox until T22 polish.
 */
import * as THREE from 'three';
import type { AABB, PieceKind } from './pieceTypes';
import { buildPieceGeometry } from './pieceGeometry';
import { aabbCenter, aabbSize, mergeNonIndexed } from './pieceGeometryShapes';

const SPIKES = 9;

/** deterministic jagged star ring (outer torn edge, inner circular hole) */
function tornRingShape(outerR: number, innerR: number): THREE.Shape {
  const shape = new THREE.Shape();
  for (let i = 0; i < SPIKES * 2; i++) {
    const angle = (i / (SPIKES * 2)) * Math.PI * 2;
    // alternate long/short spikes, with a fixed 3-cycle wobble for asymmetry
    const wobble = 1 + 0.12 * Math.sin(i * 2.1);
    const r = (i % 2 === 0 ? outerR : outerR * 0.62) * wobble;
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, innerR, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  return shape;
}

/**
 * Same silhouette as the intact piece with a jagged breach overlay on the
 * outboard face. `faceSign` picks +x or −x face (starboard/port sections).
 */
export function buildHoledVariant(
  kind: PieceKind,
  aabb: AABB,
  faceSign: 1 | -1 = 1,
): THREE.BufferGeometry {
  const base = buildPieceGeometry(kind, aabb);
  const s = aabbSize(aabb);
  const c = aabbCenter(aabb);
  const outerR = Math.max(0.3, Math.min(s.y, s.z) * 0.35);
  const innerR = outerR * 0.55;

  const ring = new THREE.ShapeGeometry(tornRingShape(outerR, innerR), 12);
  const disc = new THREE.CircleGeometry(innerR * 1.05, 16);
  for (const overlay of [ring, disc]) {
    overlay.rotateY((faceSign * Math.PI) / 2); // face normal → ±x (outboard)
  }
  const halfX = s.x / 2;
  ring.translate(c.x + faceSign * (halfX + 0.02), c.y, c.z);
  disc.translate(c.x + faceSign * (halfX - 0.03), c.y, c.z);

  // groups: [0] = base + torn edge (wood), [1] = dark hole disc
  const wood = mergeNonIndexed([base, ring]);
  return mergeNonIndexed([wood, disc], true);
}
