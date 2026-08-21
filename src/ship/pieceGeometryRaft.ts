/**
 * Low-poly greybox geometry for the raft's piece kinds (§T89). Sized from the
 * piece AABB like every other family (§V18); `shape` hints are plain numbers.
 * Logs = tapered cylinders, 12 sides; mats/planks/thatch = slabs; weave = a
 * thin box (the material does the weave, §T90). Tri budget well under the
 * brigantine — tests/raft.test.ts measures both.
 */
import * as THREE from 'three';
import type { AABB } from './pieceTypes';
import { aabbCenter, aabbSize, mergeNonIndexed } from './pieceGeometryShapes';

function slab(aabb: AABB): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const c = aabbCenter(aabb);
  return new THREE.BoxGeometry(s.x, s.y, s.z).translate(c.x, c.y, c.z);
}

/** balsa log along local z: stern (−z) radius from the aabb, bow tapered + chamfered */
export function buildLogGeometry(aabb: AABB, shape: Record<string, number> = {}): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const c = aabbCenter(aabb);
  const r = s.x / 2;
  const taper = Math.min(1, Math.max(0.3, shape.taper ?? 1));
  const chamfer = Math.min(s.z * 0.4, Math.max(0, shape.chamfer ?? 0));
  const sides = Math.max(6, Math.round(shape.sides ?? 12));
  const bodyLen = s.z - chamfer;
  const rBow = r * taper;
  const parts: THREE.BufferGeometry[] = [];
  // CylinderGeometry runs along +y with radiusTop at +y; rotateX(π/2) maps +y → +z (bow)
  const body = new THREE.CylinderGeometry(rBow, r, bodyLen, sides);
  body.rotateX(Math.PI / 2);
  body.translate(0, 0, -s.z / 2 + bodyLen / 2);
  parts.push(body);
  if (chamfer > 0) {
    const tip = new THREE.CylinderGeometry(rBow * 0.3, rBow, chamfer, sides);
    tip.rotateX(Math.PI / 2);
    tip.translate(0, 0, s.z / 2 - chamfer / 2);
    parts.push(tip);
  }
  return mergeNonIndexed(parts).translate(c.x, c.y, c.z);
}

/** crossbeam along local x */
export function buildCrossbeamGeometry(aabb: AABB, shape: Record<string, number> = {}): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const c = aabbCenter(aabb);
  const sides = Math.max(6, Math.round(shape.sides ?? 10));
  const geo = new THREE.CylinderGeometry(s.y / 2, s.y / 2, s.x, sides);
  geo.rotateZ(Math.PI / 2);
  return geo.translate(c.x, c.y, c.z);
}

/** a pole along local +y from aabb.min.y (bipod legs, flag pole), or a rope ladder */
export function buildPoleGeometry(aabb: AABB, shape: Record<string, number> = {}): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const c = aabbCenter(aabb);
  if ((shape.ladder ?? 0) > 0) return ladder(aabb, shape.rungPitch ?? 0.35);
  const r = s.x / 2;
  const taper = Math.min(1, Math.max(0.3, shape.taper ?? 1));
  const sides = Math.max(6, Math.round(shape.sides ?? 10));
  const geo = new THREE.CylinderGeometry(r * taper, r, s.y, sides);
  return geo.translate(c.x, aabb.min[1] + s.y / 2, c.z);
}

/** two side ropes + wooden rungs, in the aabb's xy plane */
function ladder(aabb: AABB, pitch: number): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const c = aabbCenter(aabb);
  const parts: THREE.BufferGeometry[] = [];
  const ropeR = 0.015;
  for (const sign of [-1, 1]) {
    const rope = new THREE.CylinderGeometry(ropeR, ropeR, s.y, 5);
    rope.translate(sign * (s.x / 2 - ropeR), aabb.min[1] + s.y / 2, c.z);
    parts.push(rope);
  }
  const count = Math.max(1, Math.floor(s.y / Math.max(0.15, pitch)));
  for (let i = 1; i <= count; i++) {
    const rung = new THREE.CylinderGeometry(0.02, 0.02, s.x, 6);
    rung.rotateZ(Math.PI / 2);
    rung.translate(0, aabb.min[1] + i * pitch, c.z);
    parts.push(rung);
  }
  return mergeNonIndexed(parts).translate(c.x, 0, 0);
}

/** woven wall panel; a gable end carries a triangle up to the ridge (`shape.gable` = rise) */
export function buildCabinWallGeometry(aabb: AABB, shape: Record<string, number> = {}): THREE.BufferGeometry {
  const rise = shape.gable ?? 0;
  if (rise <= 0) return slab(aabb);
  const s = aabbSize(aabb);
  const c = aabbCenter(aabb);
  const eave = s.y - rise;
  const profile = new THREE.Shape();
  profile.moveTo(-s.x / 2, 0);
  profile.lineTo(s.x / 2, 0);
  profile.lineTo(s.x / 2, eave);
  profile.lineTo(0, s.y);
  profile.lineTo(-s.x / 2, eave);
  profile.closePath();
  const geo = new THREE.ExtrudeGeometry(profile, { depth: s.z, bevelEnabled: false });
  return geo.translate(c.x, aabb.min[1], aabb.min[2]);
}

/** balsa block with its two thole-pins standing on top */
export function buildSternBlockGeometry(aabb: AABB, shape: Record<string, number> = {}): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const c = aabbCenter(aabb);
  const parts: THREE.BufferGeometry[] = [slab(aabb)];
  const pinH = shape.pinHeight ?? 0.3;
  const pinR = shape.pinRadius ?? 0.03;
  const spacing = shape.pinSpacing ?? 0.4;
  for (const sign of [-1, 1]) {
    const pin = new THREE.CylinderGeometry(pinR * 0.85, pinR, pinH, 6);
    pin.translate(c.x + sign * spacing / 2, aabb.max[1] + pinH / 2, c.z);
    parts.push(pin);
  }
  void s;
  return mergeNonIndexed(parts);
}

/** mangrove shaft along local z (+z inboard), fir blade at the aft end, tiller cross-piece */
export function buildSteeringOarGeometry(aabb: AABB, shape: Record<string, number> = {}): THREE.BufferGeometry {
  const inboard = shape.inboard ?? aabb.max[2];
  const aft = -aabb.min[2];
  const shaftR = shape.shaftRadius ?? 0.045;
  const bladeLen = Math.min(aft, shape.bladeLength ?? 1.2);
  const bladeW = shape.bladeWidth ?? 0.4;
  const tiller = shape.tillerLength ?? 0.9;
  const len = inboard + aft;
  const shaft = new THREE.CylinderGeometry(shaftR * 0.8, shaftR, len, 8);
  shaft.rotateX(Math.PI / 2);
  shaft.translate(0, 0, inboard - len / 2);
  const blade = new THREE.BoxGeometry(0.035, bladeW, bladeLen);
  blade.translate(0, 0, -aft + bladeLen / 2);
  const cross = new THREE.CylinderGeometry(0.03, 0.03, tiller, 6);
  cross.rotateZ(Math.PI / 2);
  cross.translate(0, 0, inboard - 0.3);
  return mergeNonIndexed([shaft, blade, cross]);
}

/** crates, cans, dinghy, cage: boxes; `shape.round` = a drum */
export function buildCrateGeometry(aabb: AABB, shape: Record<string, number> = {}): THREE.BufferGeometry {
  if ((shape.round ?? 0) > 0) {
    const s = aabbSize(aabb);
    const c = aabbCenter(aabb);
    const r = Math.min(s.x, s.z) / 2;
    return new THREE.CylinderGeometry(r, r, s.y, 12).translate(c.x, c.y, c.z);
  }
  return slab(aabb);
}

/** mats, thatch slabs, splashboards, guara planks: a box the size of the aabb */
export const buildRaftSlabGeometry = slab;
