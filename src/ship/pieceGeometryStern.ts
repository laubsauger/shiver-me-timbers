/**
 * Stern works geometry (§V22 user critique: "the back of the ship is not
 * fully closed, there are ugly panels back there").
 *
 * The transom used to be an axis-aligned BOX: wider than the hull envelope
 * at the stern (so its corners stuck out through the shell as flat panels)
 * and only as tall as the sheer line (so the counter under the quarterdeck
 * stayed open). This builds it as a lofted cap instead: its outline is the
 * hull shell's own aft section — same `sectionHalf`/`hullEnvelope` the shell
 * strips use (src/hullMath.ts) — so the seam is watertight by construction,
 * and it carries on up to the castle deck to close the counter.
 *
 * Geometry only; the piece graph, its id, sockets and damage states are
 * untouched (§V13/§V18 — an AI-generated transom mesh drops into the same
 * piece with the same shape hints).
 */
import * as THREE from 'three';
import type { AABB } from './pieceTypes';
import { hullEnvelope, hullTopY, sectionHalf, type HullShape } from './hullMath';
import { mergeNonIndexed } from './pieceGeometryShapes';

const U_STEPS = 14;
const H_STEPS = 10;

/** extra hints the transom piece carries beyond the shared hull set */
export interface TransomShape extends HullShape {
  /** how far above the shell's sheer line the transom carries on (m) —
   *  closes the counter under a raised quarterdeck; 0 = flush with the rail */
  counterRise?: number;
  /** how far the middle of the plate bulges aft (m) — rounded transom */
  crown?: number;
}

/** half-width of the transom outline at height fraction h (0 = keel line,
 *  1 = sheer line, >1 = the counter carried up under the castle) */
function transomHalf(h: number, s: TransomShape): number {
  const env = hullEnvelope(s.sternZ, s);
  if (h <= 1) return s.beamHalf * sectionHalf(env, h, s);
  // above the rail the section keeps leaning in at the tumblehome rate so
  // the counter stays inside the silhouette (no flat panel sticking out)
  const over = h - 1;
  return s.beamHalf * sectionHalf(env, 1, s) * Math.max(0.5, 1 - s.tumblehome * over);
}

/**
 * Transom cap: an indexed grid whose port/starboard edges sit exactly on the
 * shell's aft section, bottom edge on the keel line, top edge at the castle
 * deck. The interior bulges aft (crown) and every edge crown-tapers to zero,
 * so the plate meets the shell with no gap and no overhang.
 * Piece-local: origin on the centreline at z = sternZ (transform puts it there).
 */
export function buildTransomGeometry(s: TransomShape): THREE.BufferGeometry {
  const topY = hullTopY(s.sternZ, s);
  const rise = Math.max(0, s.counterRise ?? 0);
  const crown = Math.max(0, s.crown ?? 0);
  const span = topY + s.draft; // shell height at the stern
  const hTop = 1 + rise / Math.max(0.1, span); // grid runs 0..hTop
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j <= H_STEPS; j++) {
    const h = (hTop * j) / H_STEPS;
    const half = transomHalf(h, s);
    const y = -s.draft + span * h;
    // crown vanishes at the bottom and top edges (sin) and at both sides
    const hNorm = h / hTop;
    const crownH = Math.sin(Math.PI * hNorm);
    for (let i = 0; i <= U_STEPS; i++) {
      const u = (i / U_STEPS) * 2 - 1; // -1 port … +1 starboard
      positions.push(u * half, y, -crown * crownH * (1 - u * u));
      uvs.push(i / U_STEPS, hNorm);
    }
  }
  const row = U_STEPS + 1;
  for (let j = 0; j < H_STEPS; j++) {
    for (let i = 0; i < U_STEPS; i++) {
      const a = j * row + i;
      const b = (j + 1) * row + i;
      // wound so the face normal points aft (−z), i.e. outboard
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Stern gallery: the window band on the cabin's aft face. Sized from the
 * piece AABB (which the blueprint now derives from the hull envelope, so it
 * can no longer be wider than the stern) — a recessed panel, mullions
 * between the lights, and a sill ledge under it.
 */
export function buildGalleryGeometry(aabb: AABB): THREE.BufferGeometry {
  const w = aabb.max[0] - aabb.min[0];
  const h = aabb.max[1] - aabb.min[1];
  const d = aabb.max[2] - aabb.min[2];
  const cy = (aabb.min[1] + aabb.max[1]) / 2;
  const cz = (aabb.min[2] + aabb.max[2]) / 2;
  const parts: THREE.BufferGeometry[] = [];

  const panel = new THREE.BoxGeometry(w, h, d * 0.5);
  panel.translate(0, cy, cz);
  parts.push(panel);

  const lights = 5; // window lights between mullions
  for (let i = 0; i <= lights; i++) {
    const x = -w / 2 + (w * i) / lights;
    const mullion = new THREE.BoxGeometry(w * 0.035, h * 0.94, d);
    mullion.translate(x, cy, cz + d * 0.2);
    parts.push(mullion);
  }
  for (const [y, th] of [
    [cy - h / 2, h * 0.18],
    [cy + h / 2, h * 0.14],
  ] as const) {
    const band = new THREE.BoxGeometry(w * 1.04, th, d * 1.5);
    band.translate(0, y, cz + d * 0.25);
    parts.push(band);
  }
  return mergeNonIndexed(parts);
}
