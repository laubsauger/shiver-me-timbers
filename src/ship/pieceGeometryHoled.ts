/**
 * Holed damage-state variant (§V.14): base greybox shape + readable jagged
 * breach — torn edge ring (wood) around a dark hole disc. Two geometry
 * groups: [0] wood material, [1] hole material. Greybox until T22 polish.
 */
import * as THREE from 'three';
import type { AABB, PieceKind } from './pieceTypes';
import { buildPieceGeometry } from './pieceGeometry';
import { aabbCenter, aabbSize, mergeNonIndexed } from './pieceGeometryShapes';
import { asHullShape, hullHalfWidthAt } from './pieceGeometryHull';

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
  shape?: Record<string, number>,
): THREE.BufferGeometry {
  const base = buildPieceGeometry(kind, aabb, shape);
  const s = aabbSize(aabb);
  const c = aabbCenter(aabb);
  const outerR = Math.max(0.3, Math.min(s.y, s.z) * 0.3);
  const innerR = outerR * 0.55;

  const ring = new THREE.ShapeGeometry(tornRingShape(outerR, innerR), 12);
  const disc = new THREE.CircleGeometry(innerR * 1.05, 16);
  for (const overlay of [ring, disc]) {
    overlay.rotateY((faceSign * Math.PI) / 2); // face normal → ±x (outboard)
  }
  // ── SEAT THE BREACH ON THE SHELL, VIA THE ONE FUNCTION THAT OWNS IT ────
  // This used to be `beamHalf · hullEnvelope(zMid) · 0.93`. `hullEnvelope` is
  // the PLAN-VIEW half-breadth — the hull's width at whatever height it is
  // widest — and the shell is not a cylinder: `sectionHalf` pinches it in
  // toward the keel, and the breach sits LOW, a quarter of the draft below the
  // waterline, exactly where that pinch bites hardest. The 0.93 was a fudge
  // standing in for a pinch that varies from section to section, so it could
  // not have been right at more than one of them.
  //
  // Measured on the shipped galleon: the overlay stood proud of the planking
  // by 0.457 m at the bow section, 0.497 m amidships and 0.568 m at the stern.
  // Half a metre of daylight between the wound and the ship — so it read as a
  // plate hovering alongside rather than as a hole in her side, and it
  // parallaxed against the hull from any oblique angle.
  //
  // `hullHalfWidthAt(z, y)` is the single owner of "half-width of the SHELL at
  // this station and this height", and every other part that has to mate with
  // the planking already goes through it (decks, castle slabs, cabin, gallery,
  // balustrade, and the beakhead plate twenty lines away in pieceGeometryHull).
  // This was the one place still re-deriving it from a fraction of the beam.
  //
  // THE STATION IS `zMid`, NOT `c.z`, and the difference is not cosmetic.
  // `buildLoftedHullSection` lofts the shell in SHIP space and then recentres
  // it by `-(z0+z1)/2`, so piece-local z = 0 IS ship station `zMid`. The aabb
  // centre is 0 for every section, bow and stern included; sampling the hull
  // there would ask for the width amidships and put the bow's breach on a
  // station 11.7 m from the piece it belongs to.
  const hull = asHullShape(shape);
  const holeY = hull !== null ? -hull.draft * 0.25 : c.y;
  const surfaceX =
    hull !== null
      ? hullHalfWidthAt((hull.z0 + hull.z1) / 2, holeY, hull)
      : Math.abs(c.x) + s.x / 2;
  ring.translate(faceSign * (surfaceX + 0.02), holeY, c.z);
  disc.translate(faceSign * (surfaceX - 0.03), holeY, c.z);

  // groups: [0] = base + torn edge (wood), [1] = dark hole disc
  const wood = mergeNonIndexed([base, ring]);
  return mergeNonIndexed([wood, disc], true);
}
