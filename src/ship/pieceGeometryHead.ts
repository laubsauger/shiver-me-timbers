/**
 * §T.34 head-works geometry: the beakhead rails, the catheads, the anchors
 * they stow, and the figurehead.
 *
 * The figurehead is the free win from the gap list — `socket-figurehead` was
 * declared and NOTHING was ever mounted on it, so the most-looked-at point of
 * the whole silhouette (docs/ship-full-view.png puts a kraken there) was bare
 * planking.
 */
import * as THREE from 'three';
import type { AABB } from './pieceTypes';
import { hullHalfWidthAt, type HullShape } from './hullMath';
import { aabbSize, barBetween, mergeNonIndexed } from './pieceGeometryShapes';
import { shipDetailParams } from '../params/ship';
import { vjitter } from './variation';

/**
 * Head rails: the pair of curved cheeks that sweep from the forecastle out
 * and up to the bowsprit, with stanchions between them. They are what turns a
 * bare stem into a beakhead.
 *
 * `shape` = bow hull hints + { side, zc, startZ, startY, endZ, endY, flare }.
 * `zc` is the bow piece's own z origin — the rails ride the stem and go with
 * it (§V13).
 */
export function buildHeadrailGeometry(shape: Record<string, number>): THREE.BufferGeometry {
  const s = shape as unknown as HullShape;
  const side = shape.side >= 0 ? 1 : -1;
  const zc = shape.zc ?? 0;
  const startZ = shape.startZ ?? 0;
  const startY = shape.startY ?? 2;
  const endZ = shape.endZ ?? startZ + 3;
  const endY = shape.endY ?? startY + 2;
  const flare = shape.flare ?? 0.45;
  const stations = 9;
  const jitter = Math.max(0, shipDetailParams.irregularity);

  /** one rail's polyline, lifted by `dy` and pulled in by `dx` */
  const railPoints = (dy: number, pull: number): THREE.Vector3[] => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= stations; i++) {
      const t = i / stations;
      const z = startZ + (endZ - startZ) * t;
      // the rail climbs fastest at the forward end, chasing the bowsprit
      const y = startY + (endY - startY) * (t * t * 0.7 + t * 0.3) + dy;
      const hull = hullHalfWidthAt(z, y, s);
      const x = side * (hull + (flare * Math.sin(Math.PI * t) + 0.1) * pull);
      pts.push(new THREE.Vector3(x, y, z - zc));
    }
    return pts;
  };

  const upper = railPoints(0, 1);
  const lower = railPoints(-0.5, 0.62);
  const parts: THREE.BufferGeometry[] = [];
  for (const rail of [upper, lower]) {
    for (let i = 0; i < rail.length - 1; i++) {
      parts.push(barBetween(rail[i], rail[i + 1], 0.075, 5));
    }
  }
  // stanchions, hand-fitted: neither evenly spaced nor exactly vertical
  for (let i = 1; i < stations; i += 2) {
    const jitterZ = vjitter(0.06 * jitter, i, side);
    const a = upper[i].clone();
    const b = lower[i].clone();
    a.z += jitterZ;
    parts.push(barBetween(a, b, 0.04, 4));
  }
  // headboard closing the forward end
  const board = new THREE.BoxGeometry(0.09, 0.5, 0.7);
  const tip = upper[upper.length - 1];
  board.rotateY(side * 0.35);
  board.translate(tip.x - side * 0.1, tip.y - 0.22, tip.z - 0.3);
  parts.push(board);
  return mergeNonIndexed(parts);
}

/**
 * Cathead: the short beam that swings the anchor clear of the topsides.
 * Built along +z (forward) with the piece's own rotation raking it outboard,
 * so the anchor piece can simply hang off its tip.
 */
export function buildCatheadGeometry(aabb: AABB): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const len = s.z;
  const parts: THREE.BufferGeometry[] = [];
  const beam = new THREE.BoxGeometry(s.x, s.y * 0.62, len);
  beam.translate(0, 0, len / 2);
  parts.push(beam);
  // knee bracing it back into the bulwark — a cantilever with no knee reads
  // as a stick glued to the hull
  const knee = new THREE.BoxGeometry(s.x * 0.7, s.y * 0.9, s.y * 0.9);
  knee.rotateX(-0.7);
  knee.translate(0, -s.y * 0.3, s.y * 0.35);
  parts.push(knee);
  // sheave holes at the outer end, and the ring the anchor's stopper takes
  for (const ox of [-0.28, 0, 0.28]) {
    const sheave = new THREE.CylinderGeometry(s.y * 0.14, s.y * 0.14, s.x * 1.1, 7);
    sheave.rotateZ(Math.PI / 2);
    sheave.translate(0, 0, len * (0.86 + ox * 0.06));
    parts.push(sheave);
  }
  const ring = new THREE.TorusGeometry(s.y * 0.2, s.y * 0.05, 5, 10);
  ring.rotateY(Math.PI / 2);
  ring.translate(0, -s.y * 0.38, len * 0.9);
  parts.push(ring);
  return mergeNonIndexed(parts);
}

/**
 * Admiralty-pattern anchor: shank, stock athwart the head, two curved arms
 * with flukes, and the ring. Hangs from its own piece transform at a cathead.
 */
export function buildAnchorGeometry(aabb: AABB): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const size = Math.max(0.4, Math.max(s.y, shipDetailParams.anchorSize));
  const shankR = size * 0.045;
  const parts: THREE.BufferGeometry[] = [];

  const shank = new THREE.CylinderGeometry(shankR, shankR * 1.25, size, 7);
  shank.translate(0, -size / 2, 0);
  parts.push(shank);

  const stock = new THREE.BoxGeometry(size * 0.78, shankR * 1.7, shankR * 1.7);
  stock.rotateY(0.12); // a wooden stock is never dead square to the shank
  stock.translate(0, -size * 0.12, 0);
  parts.push(stock);

  const ring = new THREE.TorusGeometry(size * 0.09, shankR * 0.55, 5, 10);
  ring.rotateY(Math.PI / 2);
  ring.translate(0, size * 0.06, 0);
  parts.push(ring);

  // arms sweep down and out from the crown, each ending in a triangular fluke
  for (const sx of [-1, 1]) {
    const crown = new THREE.Vector3(0, -size, 0);
    const mid = new THREE.Vector3(sx * size * 0.2, -size * 1.02, 0);
    const tipEnd = new THREE.Vector3(sx * size * 0.36, -size * 0.78, 0);
    parts.push(
      barBetween(crown, mid, shankR * 0.95, 5),
      barBetween(mid, tipEnd, shankR * 0.8, 5),
    );
    const fluke = new THREE.BoxGeometry(size * 0.19, size * 0.12, shankR * 1.2);
    fluke.rotateZ(sx * -0.85);
    fluke.translate(sx * size * 0.34, -size * 0.75, 0);
    parts.push(fluke);
  }
  return mergeNonIndexed(parts);
}

/**
 * Figurehead: a rearing sea-serpent on the stem, built as an S-curve of
 * tapering segments with a head, jaw and two swept fins, plus the carved
 * volute of the trailboard behind it. Deliberately stylised — the reference
 * silhouette is a dark curled mass under the bowsprit, and at any range the
 * game shows it that is what has to read.
 *
 * `shape` = { size, lean }. Local +z is forward, +y up, origin at the stem head.
 */
export function buildFigureheadGeometry(aabb: AABB): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const size = Math.max(0.4, Math.max(s.y, s.z));
  const parts: THREE.BufferGeometry[] = [];
  const seg = 9;

  // body: an S from the stem, dipping forward and down, then rearing
  const path: THREE.Vector3[] = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    path.push(
      new THREE.Vector3(
        vjitter(0.02 * size, i, 3),
        size * (0.16 - 0.72 * t + 0.34 * t * t) + Math.sin(t * 2.6) * size * 0.09,
        size * (0.12 + 1.05 * t),
      ),
    );
  }
  for (let i = 0; i < seg; i++) {
    const r = size * (0.15 - 0.07 * (i / seg));
    parts.push(barBetween(path[i], path[i + 1], r, 7));
  }

  // head and jaw at the forward end
  const head = path[seg];
  const skull = new THREE.SphereGeometry(size * 0.16, 8, 6);
  skull.scale(0.85, 1, 1.25);
  skull.translate(head.x, head.y, head.z);
  parts.push(skull);
  const jaw = new THREE.BoxGeometry(size * 0.17, size * 0.09, size * 0.3);
  jaw.rotateX(0.3);
  jaw.translate(head.x, head.y - size * 0.1, head.z + size * 0.16);
  parts.push(jaw);
  for (const sx of [-1, 1]) {
    const horn = new THREE.ConeGeometry(size * 0.045, size * 0.28, 6);
    horn.rotateX(-0.9);
    horn.translate(sx * size * 0.07, head.y + size * 0.15, head.z - size * 0.06);
    parts.push(horn);
  }

  // swept fins, one a touch larger than the other — carved by hand
  for (const sx of [-1, 1]) {
    const scale = 1 + vjitter(0.09, sx, 11);
    const fin = new THREE.ConeGeometry(size * 0.2 * scale, size * 0.55 * scale, 4);
    fin.rotateZ(sx * 1.15);
    fin.rotateY(sx * 0.5);
    fin.translate(sx * size * 0.2, path[4].y + size * 0.1, path[4].z);
    parts.push(fin);
  }

  // trailboard volute: a carved spiral scrolling back onto the planking
  for (const sx of [-1, 1]) {
    const turns = 1.6;
    const steps = 12;
    let prev: THREE.Vector3 | null = null;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const a = t * turns * Math.PI * 2;
      const r = size * 0.24 * (1 - t * 0.78);
      const p = new THREE.Vector3(
        sx * size * 0.16,
        size * 0.1 + Math.sin(a) * r,
        size * 0.06 + Math.cos(a) * r,
      );
      if (prev !== null) parts.push(barBetween(prev, p, size * 0.035, 5));
      prev = p;
    }
  }
  return mergeNonIndexed(parts);
}
