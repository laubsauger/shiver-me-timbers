/**
 * §T.34 rig-and-furniture detail geometry: flags, ratlines, belaying pin
 * racks, the binnacle, and the stern cabin lights.
 *
 * Every builder is sized from plain shape hints so an AI-generated mesh can
 * replace it without touching code (§V18), and every one carries deterministic
 * seeded variation (§V2 via variation.ts) — hand-seized ratlines are not
 * evenly spaced, belaying pins are not identical, and a flag's fly is frayed.
 */
import * as THREE from 'three';
import type { AABB } from './pieceTypes';
import { aabbSize, mergeNonIndexed } from './pieceGeometryShapes';
import { shipDetailParams } from '../params/ship';
import { vjitter } from './variation';

/** tag every vertex with (clothWeight, fly, hoist, style) for flagMaterial */
function withFlagShape(
  geo: THREE.BufferGeometry,
  weight: number,
  fly: number,
  hoist: number,
  style: number,
): THREE.BufferGeometry {
  const count = geo.attributes.position.count;
  const data = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    data[i * 4] = weight;
    data[i * 4 + 1] = fly;
    data[i * 4 + 2] = hoist;
    data[i * 4 + 3] = style;
  }
  geo.setAttribute('flagShape', new THREE.BufferAttribute(data, 4));
  return geo;
}

const FLY_SEGMENTS = 22; // enough that the travelling ripple reads smooth
const HOIST_SEGMENTS = 4;

/**
 * Flag / pennant cloth grid. Local frame: the hoist edge is at x = 0 with its
 * head at y = `headY`, and the fly runs along +x. flagMaterial rebuilds every
 * cloth position from (u, v), so this grid only has to supply the parameter
 * space, the hoist profile and a sane fallback shape.
 *
 * `shape`: fly, hoist, style, taper (0 = rectangle, →1 = coachwhip point),
 * headY, staff (1 = build a staff below the head).
 */
export function buildPennantGeometry(shape: Record<string, number>): THREE.BufferGeometry {
  const fly = Math.max(0.05, shape.fly ?? 1);
  const hoist = Math.max(0.05, shape.hoist ?? 0.5);
  const style = shape.style ?? 0;
  const taper = Math.min(0.95, Math.max(0, shape.taper ?? 0));
  const headY = shape.headY ?? 0;
  const jitter = Math.max(0, shipDetailParams.irregularity);

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= FLY_SEGMENTS; i++) {
    const u = i / FLY_SEGMENTS;
    // a flogged flag is eaten away at the fly, never a clean rectangle
    const frayed = 1 + vjitter(0.05 * jitter, fly, u * 100) * u;
    const localHoist = hoist * (1 - taper * u) * frayed;
    for (let j = 0; j <= HOIST_SEGMENTS; j++) {
      const v = j / HOIST_SEGMENTS;
      positions.push(u * fly, headY - (1 - v) * localHoist, 0);
      uvs.push(u, v);
    }
  }
  const row = HOIST_SEGMENTS + 1;
  for (let i = 0; i < FLY_SEGMENTS; i++) {
    for (let j = 0; j < HOIST_SEGMENTS; j++) {
      const a = i * row + j;
      const b = (i + 1) * row + j;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const cloth = new THREE.BufferGeometry();
  cloth.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  cloth.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  cloth.setIndex(indices);
  cloth.computeVertexNormals();
  withFlagShape(cloth, 1, fly, hoist, style);

  const parts = [cloth];
  if ((shape.staff ?? 0) === 1) {
    const staff = new THREE.CylinderGeometry(0.045, 0.06, headY + 0.12, 6);
    staff.translate(0, (headY + 0.12) / 2 - 0.06, 0);
    const truck = new THREE.SphereGeometry(0.08, 6, 5);
    truck.translate(0, headY + 0.06, 0);
    parts.push(
      withFlagShape(staff, 0, fly, hoist, style),
      withFlagShape(truck, 0, fly, hoist, style),
    );
  }
  const geo = mergeNonIndexed(parts);
  // The shader swings the cloth through every heading, so the built AABB is
  // NOT the drawn extent. Without an explicit bound, three culls the flag the
  // moment it streams away from its built +x — it would vanish on one tack.
  geo.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(0, headY - hoist * 0.5, 0),
    fly * 1.3 + hoist,
  );
  return geo;
}

/**
 * Belaying pin rack at a mast foot: the fiferail every running line is made
 * off to. Pins lean at slightly different angles — they are hand-turned and
 * hand-dropped into their holes.
 */
export function buildPinRailGeometry(aabb: AABB): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const count = Math.max(0, Math.round(shipDetailParams.pinCount));
  const jitter = Math.max(0, shipDetailParams.irregularity);
  const railY = aabb.min[1] + s.y * 0.72;
  const parts: THREE.BufferGeometry[] = [];

  for (const sx of [-1, 1]) {
    const post = new THREE.BoxGeometry(0.1, s.y * 0.72, 0.1);
    post.translate((sx * s.x) / 2 - sx * 0.08, aabb.min[1] + s.y * 0.36, 0);
    parts.push(post);
  }
  const rail = new THREE.BoxGeometry(s.x, 0.11, 0.14);
  rail.translate(0, railY, 0);
  parts.push(rail);

  for (let i = 0; i < count; i++) {
    const x = count === 1 ? 0 : -s.x * 0.42 + (s.x * 0.84 * i) / (count - 1);
    const pin = new THREE.CylinderGeometry(0.024, 0.032, s.y * 0.42, 5);
    pin.rotateX(vjitter(0.09 * jitter, x, i));
    pin.rotateZ(vjitter(0.07 * jitter, i, x, 2));
    pin.translate(x + vjitter(0.015 * jitter, i, 7), railY + s.y * 0.06, 0);
    parts.push(pin);
    const head = new THREE.SphereGeometry(0.038, 5, 4);
    head.translate(x, railY + s.y * 0.28, 0);
    parts.push(head);
  }
  return mergeNonIndexed(parts);
}

/** binnacle: the compass cabinet abaft the wheel — box, hood and a lamp bulb */
export function buildBinnacleGeometry(aabb: AABB): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const parts: THREE.BufferGeometry[] = [];
  const body = new THREE.BoxGeometry(s.x, s.y * 0.78, s.z);
  body.translate(0, aabb.min[1] + s.y * 0.39, 0);
  parts.push(body);
  const hood = new THREE.CylinderGeometry(s.x * 0.42, s.x * 0.55, s.y * 0.26, 8);
  hood.translate(0, aabb.min[1] + s.y * 0.85, 0);
  parts.push(hood);
  for (const sx of [-1, 1]) {
    const lamp = new THREE.SphereGeometry(s.x * 0.16, 6, 5);
    lamp.translate((sx * s.x) / 2, aabb.min[1] + s.y * 0.7, 0);
    parts.push(lamp);
  }
  return mergeNonIndexed(parts);
}

/**
 * Stern cabin lights: the glazing that goes BEHIND the gallery's mullions.
 * The gallery piece already builds a recessed panel with mullions between the
 * lights and had no glass in it at all, so the great cabin read as a blind
 * wall with battens on it (§T.34 gap list).
 */
export function buildWindowGeometry(aabb: AABB): THREE.BufferGeometry {
  const s = aabbSize(aabb);
  const c = [
    (aabb.min[0] + aabb.max[0]) / 2,
    (aabb.min[1] + aabb.max[1]) / 2,
    (aabb.min[2] + aabb.max[2]) / 2,
  ];
  const lights = 5; // matches buildGalleryGeometry's mullion count
  const jitter = Math.max(0, shipDetailParams.irregularity);
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < lights; i++) {
    const w = (s.x / lights) * 0.82;
    const x = -s.x / 2 + (s.x * (i + 0.5)) / lights;
    // panes are leaded up out of small quarrels; each light sits a hair
    // differently in its rebate, which is what stops a window wall reading
    // as one printed strip
    for (let j = 0; j < 2; j++) {
      const h = s.y * 0.4;
      const pane = new THREE.BoxGeometry(w, h * 0.92, Math.max(0.02, s.z * 0.4));
      pane.rotateZ(vjitter(0.012 * jitter, i, j));
      pane.translate(x, c[1] + (j === 0 ? -h * 0.5 : h * 0.5), c[2]);
      parts.push(pane);
    }
  }
  return mergeNonIndexed(parts);
}
