/**
 * RACE KIT PROPS (§T.194) — the geometry a race boat passes within 5-30 m.
 *
 *   granite blocks  flat-faced fractured blocks (a box clipped by 10-18 seeded
 *                   planes, so every face is a FRACTURE PLANE and every edge an
 *                   arris — the answer to the smooth pirate potatoes), piled on
 *                   the rock garden's waterline, capping its boulder field, and
 *                   as beachrock slabs in a cay's intertidal. They wear the kit
 *                   rock material: the same tidal zonation as the ground.
 *   driftwood       bleached logs and a root-wad stump along the strandline,
 *                   laid alongshore the way a wave leaves them
 *   rubble          the drowned town: concrete slabs with rebar, cinder blocks,
 *                   asphalt plates and timber, on the knoll's shore and shallows
 *
 * One InstancedMesh per variant per island (§V17: a handful of draws, no
 * per-prop draw), pure f(seed, heightmap, mask) through createRng (§V2), LOD-
 * gated as a unit like the rocks. Materials are shared world-wide.
 */
import * as THREE from 'three/webgpu';
import { attribute, float, mix, normalWorldGeometry, positionGeometry, positionWorld, uniform, vec2, vec3 } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createRng, type Rng } from '../state/rng';
import type { IslandHeightmap } from '../island/heightmap';
import type { KitDecor, KitDecorContext } from '../island/kitIsland';
import { fbm2, valueNoise2 } from '../terrain/noise';
import { periodResolved, coordFilter } from '../ship/bandLimit';
import type { KitRenderInfo } from './kitRender';
import { sampleKitSurface, type KitSurfaceMask } from './kitSurface';
import { distanceToClosed } from './courseLine';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyNode = any;
type V3 = [number, number, number];

/** decor is hidden past this camera distance to the island centre (m) — the rocks' own cull is further, these are small */
export const KIT_DECOR_CULL = 1400;

// ── convex fractured blocks ──────────────────────────────────────────────────

const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** clip a closed convex polyhedron (outward-wound faces) by the half-space n·x ≤ d, capping the cut */
export function clipPolyhedron(faces: V3[][], n: V3, d: number): V3[][] {
  const out: V3[][] = [];
  const cap: V3[] = [];
  for (const poly of faces) {
    const res: V3[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const da = dot(n, a) - d;
      const db = dot(n, b) - d;
      if (da <= 0) res.push(a);
      if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
        const t = da / (da - db);
        const p: V3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        res.push(p);
        cap.push(p);
      }
    }
    if (res.length >= 3) out.push(res);
  }
  if (cap.length >= 3) {
    const c: V3 = [0, 0, 0];
    for (const p of cap) for (let k = 0; k < 3; k++) c[k] += p[k] / cap.length;
    const u = norm(Math.abs(n[1]) < 0.9 ? cross(n, [0, 1, 0]) : cross(n, [1, 0, 0]));
    const v = cross(n, u);
    const ring = cap
      .map((p) => ({ p, a: Math.atan2(dot(sub3(p, c), v), dot(sub3(p, c), u)) }))
      .sort((x, y) => x.a - y.a)
      .map((e) => e.p)
      .filter((p, i, arr) => i === 0 || Math.hypot(...sub3(p, arr[i - 1])) > 1e-5);
    // u × v = n, so increasing angle is CCW seen from outside
    if (ring.length >= 3) out.push(ring);
  }
  return out;
}

function boxFaces(hx: number, hy: number, hz: number): V3[][] {
  const P = (x: number, y: number, z: number): V3 => [x * hx, y * hy, z * hz];
  return [
    [P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), P(1, -1, 1)],
    [P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1), P(-1, -1, -1)],
    [P(-1, 1, -1), P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1)],
    [P(-1, -1, 1), P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1)],
    [P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)],
    [P(1, -1, -1), P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1)],
  ];
}

function facesToGeometry(faces: V3[][]): THREE.BufferGeometry {
  const pos: number[] = [];
  for (const f of faces) for (let i = 1; i + 1 < f.length; i++) pos.push(...f[0], ...f[i], ...f[i + 1]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals(); // non-indexed: one flat normal per fracture face
  return g;
}

export type BlockStyle = 'granite' | 'slab' | 'cinder';

/**
 * A fractured block about the unit size: a jittered box, its corners and edges
 * knocked off by seeded planes. `slab` is a bedded plate (beachrock, a concrete
 * floor slab), `cinder` a crisp construction block.
 */
export function buildBlockGeometry(seed: number, style: BlockStyle): THREE.BufferGeometry {
  const rng = createRng(seed);
  const dims: V3 =
    style === 'slab' ? [0.95 + 0.3 * rng(), 0.22 + 0.1 * rng(), 0.7 + 0.25 * rng()] : style === 'cinder' ? [0.8, 0.4, 0.4] : [0.9 + 0.25 * rng(), 0.62 + 0.3 * rng(), 0.72 + 0.25 * rng()];
  let faces = boxFaces(...dims);
  const cuts = style === 'granite' ? 10 + Math.floor(rng() * 8) : style === 'slab' ? 6 + Math.floor(rng() * 4) : 3;
  for (let i = 0; i < cuts; i++) {
    // a corner or edge direction, jittered: knocks the arris off at a random depth
    const n = norm([(rng() < 0.5 ? -1 : 1) * (0.3 + rng()), (rng() < 0.5 ? -0.6 : 1) * (0.2 + rng()), (rng() < 0.5 ? -1 : 1) * (0.3 + rng())]);
    // the support of the box along n, then cut a fraction of it away
    const support = Math.abs(n[0]) * dims[0] + Math.abs(n[1]) * dims[1] + Math.abs(n[2]) * dims[2];
    const keep = style === 'cinder' ? 0.97 : 0.66 + rng() * 0.28;
    faces = clipPolyhedron(faces, n, support * keep);
  }
  // a tilted fracture on one face so no block reads as a box
  if (style === 'granite') {
    const n = norm([rng() - 0.5, 1.2, rng() - 0.5]);
    faces = clipPolyhedron(faces, n, dims[1] * (0.75 + 0.2 * rng()));
  }
  return facesToGeometry(faces);
}

/** a bleached log along +x, unit length, with a gentle bend and two branch stubs */
export function buildLogGeometry(seed: number, rootWad = false): THREE.BufferGeometry {
  const rng = createRng(seed);
  const parts: THREE.BufferGeometry[] = [];
  const bend = (rng() - 0.5) * 0.12;
  const trunk = new THREE.CylinderGeometry(rootWad ? 0.05 : 0.035, rootWad ? 0.09 : 0.05, 1, 9, 6, false);
  trunk.rotateZ(Math.PI / 2);
  const p = trunk.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    p.setY(i, p.getY(i) * (1 + 0.15 * Math.sin(x * 19 + seed)) + bend * (1 - 4 * x * x));
  }
  parts.push(trunk.toNonIndexed());
  const stubs = rootWad ? 6 : 2;
  for (let s = 0; s < stubs; s++) {
    const len = rootWad ? 0.08 + rng() * 0.07 : 0.08 + rng() * 0.12;
    const stub = new THREE.CylinderGeometry(rootWad ? 0.012 : 0.006, rootWad ? 0.035 : 0.014, len, 5, 1, true);
    stub.translate(0, len / 2, 0);
    const at = rootWad ? -0.5 : (rng() - 0.5) * 0.7;
    stub.rotateX((rng() - 0.5) * 1.2 + (rootWad ? (s / stubs) * Math.PI * 2 : Math.PI / 2 * (rng() < 0.5 ? 1 : -1)));
    stub.rotateZ(rootWad ? -Math.PI / 2 + (rng() - 0.5) * 0.9 : (rng() - 0.5) * 0.8);
    stub.translate(at, 0, 0);
    parts.push(stub.toNonIndexed());
  }
  return mergeParts(parts);
}

/** merge position-only parts (uv/normal dropped: the materials are procedural, normals are recomputed) */
function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  for (const g of parts) {
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'rebar') g.deleteAttribute(name);
  }
  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error('kitDecor: prop parts failed to merge'); // §Rule 8
  merged.computeVertexNormals();
  return merged;
}

/** a concrete slab with rebar ends sticking out of one broken edge */
function buildRebarSlabGeometry(seed: number): THREE.BufferGeometry {
  const rng = createRng(seed + 17);
  const slab = buildBlockGeometry(seed, 'slab');
  const parts: THREE.BufferGeometry[] = [slab];
  const rods = 2 + Math.floor(rng() * 3);
  for (let r = 0; r < rods; r++) {
    const len = 0.25 + rng() * 0.45;
    const rod = new THREE.CylinderGeometry(0.012, 0.012, len, 5, 3, true);
    const rp = rod.getAttribute('position') as THREE.BufferAttribute;
    const curl = (rng() - 0.5) * 0.6;
    for (let i = 0; i < rp.count; i++) {
      const t = rp.getY(i) / len + 0.5;
      rp.setX(i, rp.getX(i) + curl * t * t * len);
    }
    rod.rotateZ(-Math.PI / 2 + (rng() - 0.5) * 0.5);
    rod.translate(0.8 + len * 0.4, (rng() - 0.5) * 0.12, (rng() - 0.5) * 1.1);
    parts.push(rod.toNonIndexed());
  }
  // rust vertex tint marks the rebar (1) against the concrete (0)
  for (const g of parts) {
    const n = g.getAttribute('position').count;
    g.setAttribute('rebar', new THREE.Float32BufferAttribute(new Float32Array(n).fill(g === slab ? 0 : 1), 1));
  }
  return mergeParts(parts);
}

// ── shared materials ─────────────────────────────────────────────────────────

let driftwoodMaterial: THREE.MeshStandardNodeMaterial | null = null;
let rubbleMaterial: THREE.MeshStandardNodeMaterial | null = null;
const decorWater = { level: uniform(0) };

function faded(coord: AnyNode, octaves: number): AnyNode {
  const f = coordFilter(coord);
  return mix(float(0.5), fbm2(coord, octaves), periodResolved(coord, f.x.max(f.y)));
}

function getDriftwoodMaterial(): THREE.MeshStandardNodeMaterial {
  if (driftwoodMaterial) return driftwoodMaterial;
  const m = new THREE.MeshStandardNodeMaterial();
  // grain runs along the log (+x of the geometry): stretched noise, faded when sub-pixel (§V48)
  const grainCoord = vec2(positionGeometry.x.mul(2.5), positionGeometry.y.add(positionGeometry.z.mul(0.7)).mul(55));
  const grain = faded(grainCoord, 2);
  const tone = faded(positionWorld.xz.mul(0.7), 2);
  const silver = vec3(0.56, 0.54, 0.5);
  const warm = vec3(0.42, 0.36, 0.29);
  let color: AnyNode = mix(warm, silver, tone.mul(0.6).add(0.35)).mul(grain.mul(0.45).add(0.78));
  // wet and weedy where it sits in the swash
  // @band-limited-elsewhere: elevation band on world height against the live water level, no period
  const wet = positionWorld.y.sub(decorWater.level).smoothstep(0.5, 0);
  color = mix(color, color.mul(0.5), wet);
  m.colorNode = color;
  m.roughnessNode = mix(float(0.88), float(0.35), wet);
  m.metalness = 0;
  driftwoodMaterial = m;
  return m;
}

function getRubbleMaterial(): THREE.MeshStandardNodeMaterial {
  if (rubbleMaterial) return rubbleMaterial;
  const m = new THREE.MeshStandardNodeMaterial();
  const tint = attribute('kitTint', 'vec3');
  const rebar = attribute('rebar', 'float');
  const speckCoord = positionWorld.xz.add(normalWorldGeometry.xz.mul(positionWorld.y)).mul(9);
  const speck = mix(float(0.5), valueNoise2(speckCoord), periodResolved(speckCoord, coordFilter(speckCoord).x.max(coordFilter(speckCoord).y)));
  const stain = faded(positionWorld.xz.mul(0.8).add(positionWorld.y), 2);
  let color: AnyNode = tint.mul(speck.mul(0.3).add(0.85)).mul(stain.mul(0.3).add(0.82));
  // rust bleeding down from the rebar
  color = mix(color, vec3(0.3, 0.13, 0.05), rebar.mul(0.9));
  // tidal: algae and wet below the swash line
  // @band-limited-elsewhere: elevation band on world height against the live water level, no period
  const wet = positionWorld.y.sub(decorWater.level).smoothstep(0.7, 0);
  // @band-limited-elsewhere: elevation band on world height
  const algae = positionWorld.y.sub(decorWater.level).smoothstep(0.15, -0.3);
  color = mix(color, color.mul(0.55), wet);
  color = mix(color, vec3(0.1, 0.12, 0.05), algae.mul(stain.smoothstep(0.35, 0.6)).mul(0.85));
  m.colorNode = color;
  m.roughnessNode = mix(mix(float(0.9), float(0.55), rebar), float(0.3), wet);
  m.metalness = 0;
  rubbleMaterial = m;
  return m;
}

/** the live sea level at the shore being looked at (islandMaterials pushes it for the terrain) */
export function setKitDecorWaterLevel(y: number): void {
  decorWater.level.value = y;
}

// ── placement ────────────────────────────────────────────────────────────────

export interface Placed {
  pos: V3;
  yaw: number;
  tilt: V3; // tilt axis (xz) and angle in [2]
  scale: V3;
  tint?: V3;
}

function gradient(hm: IslandHeightmap, x: number, z: number): [number, number] {
  const e = (2 * hm.worldRadius) / (hm.size - 1);
  return [(hm.heightAt(x + e, z) - hm.heightAt(x - e, z)) / (2 * e), (hm.heightAt(x, z + e) - hm.heightAt(x, z - e)) / (2 * e)];
}

/** one candidate per jittered grid cell, in a stable order (§V2) */
function scan(hm: IslandHeightmap, spacing: number, rng: Rng, visit: (x: number, z: number) => void): void {
  const R = hm.worldRadius;
  const n = Math.floor((2 * R) / spacing);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -R + (i + rng()) * spacing;
      const z = -R + (j + rng()) * spacing;
      visit(x, z);
    }
  }
}

function seatBlock(hm: IslandHeightmap, x: number, z: number, size: number, rng: Rng, squash: number, embed: number): Placed {
  const [gx, gz] = gradient(hm, x, z);
  const slope = Math.hypot(gx, gz);
  // seated on the LOWEST ground under its footprint: a block centred on a knob's shoulder must not
  // bridge the hollow beside it (the "floating block" the sunset shot caught)
  const r = size * 0.4;
  const sy = size * squash;
  const centre = hm.heightAt(x, z);
  const lowest = Math.min(centre, hm.heightAt(x + r, z), hm.heightAt(x - r, z), hm.heightAt(x, z + r), hm.heightAt(x, z - r));
  // … but never so low that the ground under its middle swallows it
  const h = Math.max(lowest, centre - sy * (0.9 - embed));
  // a big block lies nearly level (it settled); a small one tumbles with the ground
  const maxTilt = size > 3 ? 0.18 : 0.6;
  return {
    pos: [x, h + sy * (0.5 - embed), z],
    yaw: rng() * Math.PI * 2,
    tilt: [slope > 1e-4 ? -gz / slope : 1, slope > 1e-4 ? gx / slope : 0, Math.min(Math.atan(slope) * 0.8, maxTilt) + (rng() - 0.5) * (size > 3 ? 0.1 : 0.3)],
    scale: [size, sy, size * (0.75 + 0.4 * rng())],
  };
}

function toInstanced(name: string, geometry: THREE.BufferGeometry, material: THREE.Material, placed: Placed[], castShadows: boolean): THREE.InstancedMesh | null {
  if (placed.length === 0) return null;
  const mesh = new THREE.InstancedMesh(geometry, material, placed.length);
  mesh.name = name;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const qt = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const tints = new Float32Array(placed.length * 3);
  placed.forEach((p, i) => {
    q.setFromAxisAngle(up, p.yaw);
    axis.set(p.tilt[0], 0, p.tilt[1]).normalize();
    qt.setFromAxisAngle(axis, p.tilt[2]);
    mesh.setMatrixAt(i, m.compose(new THREE.Vector3(...p.pos), qt.multiply(q), new THREE.Vector3(...p.scale)));
    tints.set(p.tint ?? [1, 1, 1], i * 3);
  });
  geometry.setAttribute('kitTint', new THREE.InstancedBufferAttribute(tints, 3));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.castShadow = castShadows;
  mesh.receiveShadow = true;
  return mesh;
}

// ── the island ───────────────────────────────────────────────────────────────

/** every kit prop an island gets, by batch — pure f(seed, heightmap, mask, info) (§V2), what the tests read */
export interface KitDecorPlan {
  blocks: Placed[][];
  slabs: Placed[];
  logs: Placed[][];
  rubble: Placed[][];
}

/** the half-extent (m) a placed prop reaches horizontally — its corridor clearance adds this */
export function propReach(p: Placed): number {
  return Math.max(Math.abs(p.scale[0]), Math.abs(p.scale[2])) * 0.75;
}

export function planKitDecor(hm: IslandHeightmap, info: KitRenderInfo, mask: KitSurfaceMask, seed: number): KitDecorPlan {
  const rng = createRng(seed + 90917);
  const blocks: Placed[][] = [[], [], []];
  const slabs: Placed[] = [];
  const logs: Placed[][] = [[], []];
  const rubble: Placed[][] = [[], [], []];

  const heavy = (): number => rng() ** 2.6;

  if (info.kind === 'rockGarden') {
    // the waterline talus: blocks piled where the rock meets the surf, clustered
    scan(hm, 3.2, rng, (x, z) => {
      const h = hm.heightAt(x, z);
      if (h < -1.8 || h > 1.6) return;
      if (sampleKitSurface(mask, 0, x, z) < 0.5) return;
      const cluster = Math.sin(x * 0.11 + seed) * Math.cos(z * 0.13 - seed) * 0.5 + 0.5;
      if (rng() > 0.18 + 0.5 * cluster) return;
      const size = 0.45 + 2.4 * heavy();
      blocks[Math.floor(rng() * 3)].push(seatBlock(hm, x, z, size, rng, 0.75, 0.25));
    });
    // the boulder field's hazards, capped with a real block and its fallen pieces
    for (const f of hm.features) {
      if (f.kind !== 'sheer') continue;
      // capped where the terrain bump actually is (its noise and tilt put the top off the authored number),
      // as a cluster of 2-3 blocks no bigger than a house: one 9 m polyhedron read as a prop, not a boulder field
      const pieces = 2 + Math.floor(rng() * 2);
      for (let k = 0; k < pieces; k++) {
        const a = rng() * Math.PI * 2;
        const off = k === 0 ? 0 : f.radius * (0.2 + 0.25 * rng());
        const size = Math.min(f.radius * (0.3 + 0.15 * rng()), 5.5 - k);
        blocks[Math.floor(rng() * 3)].push(seatBlock(hm, f.x + Math.cos(a) * off, f.z + Math.sin(a) * off, size, rng, 0.6, 0.4));
      }
      const bits = 3 + Math.floor(rng() * 5);
      for (let b = 0; b < bits; b++) {
        const a = rng() * Math.PI * 2;
        const r = f.radius * (0.8 + rng() * 0.7);
        const bx = f.x + Math.cos(a) * r;
        const bz = f.z + Math.sin(a) * r;
        if (hm.heightAt(bx, bz) < -2.5) continue;
        blocks[Math.floor(rng() * 3)].push(seatBlock(hm, bx, bz, 0.6 + 2.2 * heavy(), rng, 0.7, 0.3));
      }
    }
    // erratics on the whalebacks
    scan(hm, 26, rng, (x, z) => {
      const h = hm.heightAt(x, z);
      if (h < 2.5 || rng() > 0.35) return;
      blocks[Math.floor(rng() * 3)].push(seatBlock(hm, x, z, 1.2 + 2 * heavy(), rng, 0.7, 0.2));
    });
  }

  if (info.kind === 'sandCay' || info.kind === 'drownedTown') {
    // beachrock / shore slabs where the mask found cemented rock in the intertidal
    scan(hm, 4, rng, (x, z) => {
      if (sampleKitSurface(mask, 0, x, z) < 0.45) return;
      const h = hm.heightAt(x, z);
      if (h < -1.4 || h > 1.2 || rng() > 0.55) return;
      const p = seatBlock(hm, x, z, 1.2 + 2.2 * heavy(), rng, 0.25, 0.55);
      p.tilt[2] = Math.min(p.tilt[2], 0.25);
      slabs.push(p);
    });
    // driftwood along the strandline, alongshore
    scan(hm, 7, rng, (x, z) => {
      if (sampleKitSurface(mask, 3, x, z) < 0.35) return;
      const h = hm.heightAt(x, z);
      if (h < 0.35 || h > 2.4 || rng() > 0.32) return;
      const [gx, gz] = gradient(hm, x, z);
      const along = Math.atan2(gz, gx) + Math.PI / 2 + (rng() - 0.5) * 0.9;
      const root = rng() < 0.12;
      const len = root ? 1.6 + rng() * 1.4 : 1.8 + 6 * heavy();
      const girth = root ? len * 1.1 : len * (0.55 + 0.5 * rng());
      logs[root ? 1 : 0].push({ pos: [x, h + girth * 0.035, z], yaw: -along, tilt: [1, 0, (rng() - 0.5) * 0.08], scale: [len, girth, girth] });
    });
  }

  if (info.kind === 'drownedTown') {
    // the town's rubble: slabs with rebar, cinder blocks, asphalt plates and planks
    const concrete: V3 = [0.46, 0.45, 0.42];
    const asphalt: V3 = [0.22, 0.22, 0.22];
    const brick: V3 = [0.42, 0.26, 0.19];
    const timber: V3 = [0.33, 0.29, 0.24];
    scan(hm, 2.6, rng, (x, z) => {
      if (sampleKitSurface(mask, 1, x, z) < 0.4) return;
      const h = hm.heightAt(x, z);
      if (h < -2.2 || h > 3.5 || rng() > 0.4) return;
      const r = rng();
      if (r < 0.4) {
        const p = seatBlock(hm, x, z, 0.8 + 2 * heavy(), rng, 1, 0.35);
        p.tint = rng() < 0.75 ? concrete : asphalt;
        rubble[0].push(p);
      } else if (r < 0.75) {
        const p = seatBlock(hm, x, z, 0.35 + 0.25 * rng(), rng, 1, 0.1);
        p.tint = rng() < 0.6 ? concrete : brick;
        rubble[1].push(p);
      } else {
        const p = seatBlock(hm, x, z, 1.2 + 2.5 * rng(), rng, 1, 0.1);
        p.scale = [p.scale[0], 0.06, 0.18];
        p.pos[1] = hm.heightAt(x, z) + 0.05;
        p.tint = timber;
        rubble[2].push(p);
      }
    });
  }

  // nothing within the corridor's clearance: a block a boat could hit is a hazard the course author never placed
  const clear = (p: Placed): boolean => distanceToClosed(info.corridor as [number, number][], [p.pos[0], p.pos[2]]) - propReach(p) > info.corridorClearance;
  return {
    blocks: blocks.map((b) => b.filter(clear)),
    slabs: slabs.filter(clear),
    logs: logs.map((b) => b.filter(clear)),
    rubble: rubble.map((b) => b.filter(clear)),
  };
}

export function createKitDecor(ctx: KitDecorContext, info: KitRenderInfo, mask: KitSurfaceMask): KitDecor | null {
  const hm = ctx.heightmap;
  const group = new THREE.Group();
  group.name = 'island-kit-decor';
  const owned: THREE.BufferGeometry[] = [];
  const foamTargets: THREE.Object3D[] = [];

  const { blocks, slabs, logs, rubble } = planKitDecor(hm, info, mask, ctx.seed);

  const castShadows = ctx.castShadows;
  const add = (mesh: THREE.InstancedMesh | null, straddles: boolean): void => {
    if (!mesh) return;
    group.add(mesh);
    if (straddles) {
      mesh.userData.foamTarget = true;
      foamTargets.push(mesh);
    }
  };

  if (ctx.rockMaterial) {
    blocks.forEach((pl, v) => {
      if (!pl.length) return;
      const g = buildBlockGeometry(ctx.seed + 311 * (v + 1), 'granite');
      owned.push(g);
      add(toInstanced(`island-kit-blocks${v}`, g, ctx.rockMaterial!, pl, castShadows), true);
    });
    if (slabs.length) {
      const g = buildBlockGeometry(ctx.seed + 977, 'slab');
      owned.push(g);
      add(toInstanced('island-kit-slabs', g, ctx.rockMaterial, slabs, castShadows), true);
    }
  }
  const wood = getDriftwoodMaterial();
  const rub = getRubbleMaterial();
  if (ctx.aerialOutput) {
    ctx.aerialOutput(wood);
    ctx.aerialOutput(rub);
  }
  logs.forEach((pl, v) => {
    if (!pl.length) return;
    const g = buildLogGeometry(ctx.seed + 53 * (v + 1), v === 1);
    owned.push(g);
    add(toInstanced(`island-kit-driftwood${v}`, g, wood, pl, castShadows), false);
  });
  const rubbleGeo = [buildRebarSlabGeometry(ctx.seed + 7), buildBlockGeometry(ctx.seed + 8, 'cinder'), new THREE.BoxGeometry(1, 1, 1).toNonIndexed()];
  rubble.forEach((pl, v) => {
    const g = rubbleGeo[v];
    if (!g.getAttribute('rebar')) g.setAttribute('rebar', new THREE.Float32BufferAttribute(new Float32Array(g.getAttribute('position').count), 1));
    if (!pl.length) {
      g.dispose();
      return;
    }
    owned.push(g);
    add(toInstanced(`island-kit-rubble${v}`, g, rub, pl, castShadows), true);
  });

  if (group.children.length === 0) {
    for (const g of owned) g.dispose();
    return null;
  }
  return {
    group,
    foamTargets,
    setLodDistance(d) {
      group.visible = d <= KIT_DECOR_CULL;
    },
    update(frame) {
      setKitDecorWaterLevel(frame.waterLevel);
    },
    dispose() {
      for (const g of owned) g.dispose();
      for (const c of group.children) (c as THREE.InstancedMesh).dispose?.();
    },
  };
}
