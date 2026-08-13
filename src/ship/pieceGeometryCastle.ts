/**
 * Castle & rail structure (T8 visual pass, §V22): forecastle/quarterdeck
 * slabs that FOLLOW the hull plan taper (no slab overhang), bulkhead +
 * support posts beneath, hull-integrated trapezoid cabin, and rails that
 * curve with both the deck outline (XZ) and the sheer line (Y).
 * All sampled from the same hull shape hints the hull loft uses (§V18).
 */
import * as THREE from 'three';
import type { AABB } from './pieceTypes';
import { hullHalfWidthAt, hullSheer, hullTopY, type HullShape } from './pieceGeometryHull';
import { mergeNonIndexed } from './pieceGeometryShapes';
import {
  buildRailRun,
  railProfile,
  railSeed,
  readRailGaps,
  type RailPoint,
} from './pieceGeometryRail';

/**
 * Deck half-width at ship-space z, inset from the shell AT THE RAIL LINE.
 * Using the plan envelope alone ignored tumblehome, so castle slabs and the
 * cabin were wider than the topsides they sat on and their corners broke out
 * through the hull as flat panels (§V22 stern critique).
 */
function halfWidthAt(z: number, s: HullShape, inset = 0.97): number {
  return hullHalfWidthAt(z, hullTopY(z, s), s) * inset;
}

/** plan-taper-following slab between s.z0..s.z1, top at local y=0 */
function taperedSlab(s: HullShape, thickness: number, inset: number): THREE.BufferGeometry {
  const slices = 10;
  const shape = new THREE.Shape();
  const w0 = halfWidthAt(s.z0, s, inset);
  shape.moveTo(-w0, s.z0);
  shape.lineTo(w0, s.z0);
  for (let i = 1; i <= slices; i++) {
    const z = s.z0 + ((s.z1 - s.z0) * i) / slices;
    shape.lineTo(halfWidthAt(z, s, inset), z);
  }
  for (let i = slices; i >= 0; i--) {
    const z = s.z0 + ((s.z1 - s.z0) * i) / slices;
    shape.lineTo(-halfWidthAt(z, s, inset), z);
  }
  const geo = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  geo.rotateX(Math.PI / 2); // shapeY→worldZ, extrusion → downward, top y=0
  return geo;
}

/**
 * Raised castle deck: tapered slab + bulkhead closing the open end +
 * two support posts — reads built-in, not floating (§V22 critique).
 * `bulkheadAtAft` true → wall at z0 (forecastle); false → at z1 (quarterdeck).
 * `rise` is the height down to the main deck. Piece-local origin: slab top
 * center at y=0, ship z = (z0+z1)/2.
 */
export function buildCastleDeck(
  s: HullShape,
  rise: number,
  thickness: number,
  bulkheadAtAft: boolean,
): THREE.BufferGeometry {
  const zc = (s.z0 + s.z1) / 2;
  const parts: THREE.BufferGeometry[] = [taperedSlab(s, thickness, 0.97)];

  const wallZ = bulkheadAtAft ? s.z0 : s.z1;
  const wallW = halfWidthAt(wallZ, s, 0.94);
  const wall = new THREE.BoxGeometry(wallW * 2, rise, 0.14);
  wall.translate(0, -rise / 2, wallZ);
  parts.push(wall);

  // support posts under the open span
  const postZ = bulkheadAtAft ? s.z1 - (s.z1 - s.z0) * 0.25 : s.z0 + (s.z1 - s.z0) * 0.25;
  const postX = halfWidthAt(postZ, s, 0.7);
  for (const sx of [-1, 1]) {
    const post = new THREE.BoxGeometry(0.16, rise, 0.16);
    post.translate(sx * postX, -rise / 2, postZ);
    parts.push(post);
  }
  const geo = mergeNonIndexed(parts);
  geo.translate(0, 0, -zc);
  return geo;
}

/** cabin block whose plan follows the stern envelope — integrated in the
 *  hull silhouette instead of a stacked box */
export function buildCabinGeometry(s: HullShape, height: number): THREE.BufferGeometry {
  const zc = (s.z0 + s.z1) / 2;
  const geo = taperedSlab(s, height, 0.92);
  geo.translate(0, height, -zc); // slab top y=0 → lift so base sits at y=0
  return geo;
}

/**
 * Rail run following deck taper (XZ) and sheer (Y): stanchion posts at
 * stations along the outline, cap + mid boxes angled per segment.
 * Piece origin: centreline at deck level; `railInset`/`railHeight` from aabb.
 */
export function buildCurvedRail(
  s: HullShape,
  aabb: AABB,
  railInset: number,
  shape?: Record<string, number>,
): THREE.BufferGeometry {
  /**
   * Stations sample the CURVE, and are no longer the balusters — those come
   * from `balusterSpacing` inside buildRailRun. 24 is enough to resolve the
   * hull's taper over any run on either ship class; the old 13 was doing both
   * jobs and could not be right for either (§T.45).
   */
  const stations = 24;
  // POST HEIGHT ABOVE THE DECK, not the piece's total extent. The aabb top is
  // railHeight + the sheer at the ENDS OF THE HULL, but each post already
  // starts at its own station's sheer — so subtracting only the sheer over the
  // rail RUN (which is 80% of the hull, well short of stem and transom) left
  // every post 0.6 m too tall. That is the "midship rail is visibly too tall"
  // report: a bug in what the number meant, not a tuning miss.
  const sheerEnd = Math.max(hullSheer(s.z0, s), hullSheer(s.z1, s));
  const height = Math.max(0.5, shape?.railHeight ?? aabb.max[1] - sheerEnd);
  const t = 0.09;
  const pts: RailPoint[] = [];
  for (let i = 0; i <= stations; i++) {
    const z = s.z0 + ((s.z1 - s.z0) * i) / stations;
    // rail stands inboard of the SHELL at the rail line (tumblehome-aware),
    // not of the plan envelope — otherwise the run floats outboard of the hull
    const x = s.side * Math.max(0.1, hullHalfWidthAt(z, hullTopY(z, s), s) - railInset);
    pts.push([x, hullSheer(z, s), z]);
  }
  /**
   * The WAIST carries solid bulwark boarding; a castle rail does not.
   *
   * A castle deck is something you look over and shoot past, and the reference
   * has open turned balusters there. The waist is the other case entirely: it
   * is the top of the ship's SIDE, and leaving it open is what made the ship
   * read as a raft with a fence. The blueprint says which this is rather than
   * the geometry guessing, because only the blueprint knows whether there is
   * hull below this run or a castle deck.
   */
  const panelHeight = shape?.panelHeight ?? 0;
  return buildRailRun(
    pts,
    railProfile(height, t, { panelHeight, seed: railSeed(s.side, s.z0, s.z1) }),
    readRailGaps(shape),
  );
}
