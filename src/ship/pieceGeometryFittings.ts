/**
 * Deck fittings greybox (T8 visual pass): cannon barrel + carriage, and
 * rails as post-and-top-rail runs instead of solid planks. Sized from the
 * piece AABB like every other builder (§V18).
 */
import * as THREE from 'three';
import type { AABB } from './pieceTypes';
import { aabbCenter, aabbSize, mergeNonIndexed } from './pieceGeometryShapes';
import { COAMING_HEIGHT, COAMING_WIDTH, GRATING_HEIGHT } from './deckHeightfield';

/**
 * Cannon: tapered barrel along +z (outboard once the piece is rotated),
 * carriage box + two wheel discs. Piece-local origin at the deck mount.
 */
export function buildCannonGeometry(aabb: AABB): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const barrelLen = s.z * 0.82;
  const barrelR = s.x * 0.2;
  const barrel = new THREE.CylinderGeometry(barrelR * 0.7, barrelR, barrelLen, 10);
  barrel.rotateX(Math.PI / 2); // cylinder +y → +z, muzzle outboard
  barrel.translate(0, s.y * 0.55, aabb.min[2] + s.z * 0.18 + barrelLen / 2);

  const carriage = new THREE.BoxGeometry(s.x * 0.7, s.y * 0.45, s.z * 0.4);
  carriage.translate(0, s.y * 0.24, aabb.min[2] + s.z * 0.28);

  const wheels: THREE.BufferGeometry[] = [];
  for (const dz of [-0.12, 0.16]) {
    const wheel = new THREE.CylinderGeometry(s.y * 0.16, s.y * 0.16, s.x * 0.8, 8);
    wheel.rotateZ(Math.PI / 2); // axle across the carriage (x)
    wheel.translate(0, s.y * 0.14, aabb.min[2] + s.z * (0.28 + dz));
    wheels.push(wheel);
  }
  return mergeNonIndexed([barrel, carriage, ...wheels]);
}

/** ship's wheel: spoked rim on a pedestal, athwartships plane (faces ±z) */
export function buildWheelGeometry(aabb: AABB): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const rimR = s.x * 0.36;
  const hubY = aabb.min[1] + s.y * 0.62;
  const parts: THREE.BufferGeometry[] = [];
  const pedestal = new THREE.BoxGeometry(s.x * 0.22, s.y * 0.62, s.z * 0.5);
  pedestal.translate(0, aabb.min[1] + s.y * 0.31, 0);
  parts.push(pedestal);
  const rim = new THREE.TorusGeometry(rimR, rimR * 0.12, 8, 20);
  rim.translate(0, hubY, 0); // torus lies in XY → wheel faces fore-aft
  parts.push(rim);
  for (let i = 0; i < 4; i++) {
    // 4 crossed spokes = 8 handles poking past the rim
    const spoke = new THREE.CylinderGeometry(rimR * 0.07, rimR * 0.07, rimR * 2.55, 6);
    spoke.rotateZ((i * Math.PI) / 4);
    spoke.translate(0, hubY, 0);
    parts.push(spoke);
  }
  const hub = new THREE.SphereGeometry(rimR * 0.2, 8, 6);
  hub.translate(0, hubY, 0);
  parts.push(hub);
  return mergeNonIndexed(parts);
}

/** capstan: tapered drum + head disc + crossed handspike bars */
export function buildCapstanGeometry(aabb: AABB): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const drumH = s.y * 0.75;
  const parts: THREE.BufferGeometry[] = [];
  const drum = new THREE.CylinderGeometry(s.x * 0.2, s.x * 0.27, drumH, 10);
  drum.translate(0, aabb.min[1] + drumH / 2, 0);
  parts.push(drum);
  const head = new THREE.CylinderGeometry(s.x * 0.3, s.x * 0.26, s.y * 0.16, 10);
  head.translate(0, aabb.min[1] + drumH + s.y * 0.08, 0);
  parts.push(head);
  for (const angle of [0, Math.PI / 2]) {
    const bar = new THREE.CylinderGeometry(0.035, 0.035, s.x * 0.95, 6);
    bar.rotateZ(Math.PI / 2);
    bar.rotateY(angle);
    bar.translate(0, aabb.min[1] + drumH + s.y * 0.1, 0);
    parts.push(bar);
  }
  return mergeNonIndexed(parts);
}

/**
 * Hatch grating with its COAMING — the raised curb round the opening. The
 * grating had no curb at all, so the deck-water sim would have poured straight
 * down the hatch and the eye had nothing telling it there was an opening
 * there. Curb height/width come from deckHeightfield.ts so the lip the water
 * banks against is the lip you can see (§T.34 / talk "Surface Water: Setup").
 */
export function buildGratingGeometry(aabb: AABB): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const c = aabbCenter(aabb);
  const parts: THREE.BufferGeometry[] = [];

  // coaming: four curb timbers standing proud of the deck round the opening
  for (const [sx, sz, wx, wz] of [
    [-1, 0, COAMING_WIDTH, s.z + COAMING_WIDTH * 2],
    [1, 0, COAMING_WIDTH, s.z + COAMING_WIDTH * 2],
    [0, -1, s.x, COAMING_WIDTH],
    [0, 1, s.x, COAMING_WIDTH],
  ] as const) {
    const curb = new THREE.BoxGeometry(wx, COAMING_HEIGHT, wz);
    curb.translate(
      c.x + (sx * (s.x + COAMING_WIDTH)) / 2,
      aabb.min[1] + COAMING_HEIGHT / 2,
      c.z + (sz * (s.z + COAMING_WIDTH)) / 2,
    );
    parts.push(curb);
  }

  const frame = new THREE.BoxGeometry(s.x, GRATING_HEIGHT * 0.5, s.z);
  frame.translate(c.x, aabb.min[1] + GRATING_HEIGHT * 0.25, c.z);
  parts.push(frame);
  const bars = 5;
  for (let i = 0; i < bars; i++) {
    const off = -0.4 + (0.8 * i) / (bars - 1);
    const alongZ = new THREE.BoxGeometry(s.x * 0.08, GRATING_HEIGHT * 0.6, s.z * 0.94);
    alongZ.translate(c.x + off * s.x, aabb.min[1] + GRATING_HEIGHT * 0.7, c.z);
    parts.push(alongZ);
    const alongX = new THREE.BoxGeometry(s.x * 0.94, GRATING_HEIGHT * 0.6, s.z * 0.08);
    alongX.translate(c.x, aabb.min[1] + GRATING_HEIGHT * 0.7, c.z + off * s.z);
    parts.push(alongX);
  }
  return mergeNonIndexed(parts);
}

/** companionway stairs: even steps climbing toward +z over the aabb */
export function buildStairsGeometry(aabb: AABB): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const steps = Math.max(3, Math.round(s.y / 0.4));
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < steps; i++) {
    const h = (s.y * (i + 1)) / steps;
    const step = new THREE.BoxGeometry(s.x, h, s.z / steps);
    step.translate(0, aabb.min[1] + h / 2, aabb.min[2] + (s.z * (i + 0.5)) / steps);
    parts.push(step);
  }
  return mergeNonIndexed(parts);
}

/**
 * Rail run: top rail + evenly spaced posts along the longest horizontal
 * axis, so decks read as railed, not walled. Deterministic post count.
 */
export function buildRailGeometry(aabb: AABB): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const c = aabbCenter(aabb);
  const alongZ = s.z >= s.x;
  const runLength = alongZ ? s.z : s.x;
  const thickness = alongZ ? s.x : s.z;
  const capH = Math.min(0.12, s.y * 0.2);

  const parts: THREE.BufferGeometry[] = [];
  const cap = alongZ
    ? new THREE.BoxGeometry(thickness, capH, runLength)
    : new THREE.BoxGeometry(runLength, capH, thickness);
  cap.translate(c.x, aabb.max[1] - capH / 2, c.z);
  parts.push(cap);

  const postCount = Math.max(2, Math.round(runLength / 1.1) + 1);
  const postW = thickness * 0.7;
  const postH = s.y - capH;
  for (let i = 0; i < postCount; i++) {
    const along = -runLength / 2 + (runLength * i) / (postCount - 1);
    const post = new THREE.BoxGeometry(postW, postH, postW);
    post.translate(
      c.x + (alongZ ? 0 : along),
      aabb.min[1] + postH / 2,
      c.z + (alongZ ? along : 0),
    );
    parts.push(post);
  }
  // mid rail ties the posts together visually
  const mid = alongZ
    ? new THREE.BoxGeometry(postW * 0.8, capH * 0.7, runLength)
    : new THREE.BoxGeometry(runLength, capH * 0.7, postW * 0.8);
  mid.translate(c.x, aabb.min[1] + s.y * 0.45, c.z);
  parts.push(mid);

  return mergeNonIndexed(parts);
}
