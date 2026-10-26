/**
 * Drift-2's matter (the storyboard's shot 07: "debris swirls into galaxies on the water" — wood and relics
 * pulled into spiral arms; direction-part-b.md B5): ONE field of floating pieces, laid out by the same galaxy
 * model as Act 2's galaxies (galaxyModel.ts: logarithmic arms, a dense core, clumps along the arms), so the
 * flood's debris rhymes with the galaxies the act began among. Seeded: every lane and both scenes hold the
 * same pieces.
 *
 * The same field is drawn in both scenes the descent crosses: the planet's (act.ts, the group anchored at the
 * gathering point and scaled from metres to Mm) and the sea's (wandering/sea.ts, in metres). From tens of km a
 * piece is far below a pixel and the field is drawn by the sea's own colour (debris.ts, the same arms); each
 * piece fades in as it grows to about a pixel, so the field resolves from a pattern into wood as we come down,
 * and never shimmers.
 *
 * Coordinates: the tangent plane at the field's centre, metres: x east, y up, z north (timeline.ts gatherFrame,
 * where east × up = north: a right-handed frame, so the planet's scene and the sea's are one turn apart). The whole
 * field turns slowly as one (`spin` rad/s), a pure function of time.
 */
import * as THREE from 'three/webgpu';
import { Fn, attribute, cameraPosition, max, normalWorld, positionWorld, smoothstep, vec4 } from 'three/tsl';
import { rng } from '../undertime/web';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

/** m: the field's radius (a galaxy of debris 24 km across: from 30 km up it spans ~40° of the dome, low in front) */
export const DEBRIS_RADIUS = 12000;
/** the pattern: Act 2's own spiral look (galaxies.ts OUR_LOOK) */
const ARMS = 2;
const WIND = 1 / Math.tan((13 * Math.PI) / 180);
const PHASE = 0.6;
/** rad/s the field turns at */
export const DEBRIS_SPIN = 0.0005;
const PIECES = 120000;
/** m: the clumps' two scales */
export const CLUMP_BIG = 180;
export const CLUMP_SMALL = 60;
/** the matter's spread: the core's and the disk's scale (field radii), and the arms' sharpness — wider than a
 * star galaxy's, so the arms reach out to the rim and the shape reads from afar */
export const CORE = 0.05;
export const DISK = 0.5;
export const ARM_SHARP = 3;
export const ARM_COUNT = ARMS;
export const ARM_WIND = WIND;
export const ARM_PHASE = PHASE;

/** an integer hash to [0, 1] — the same bits on the CPU and in the shader (debris.ts), so the clumps the
 * pieces are placed by and the clumps the sea's colour draws are one pattern */
export function hash2(i: number, j: number, seed: number): number {
  let h = (Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ seed) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967295;
}

/** value noise on that hash (the clumps along the arms) */
export function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = x - xi;
  const v = y - yi;
  const su = u * u * (3 - 2 * u);
  const sv = v * v * (3 - 2 * v);
  const a = hash2(xi, yi, seed) + (hash2(xi + 1, yi, seed) - hash2(xi, yi, seed)) * su;
  const b = hash2(xi, yi + 1, seed) + (hash2(xi + 1, yi + 1, seed) - hash2(xi, yi + 1, seed)) * su;
  return a + (b - a) * sv;
}

const smoothstepJs = (a: number, b: number, x: number): number => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/** the arms' strength (0..1) at radius r (field radii) and angle θ — galaxyModel.ts armWave, sharpness 4 */
export function armAt(r: number, theta: number, lag = 0, sharp = 4): number {
  const phase = ARMS * (theta - Math.log(Math.max(r, 0.02)) * WIND) + PHASE + lag;
  return Math.pow(Math.cos(phase) * 0.5 + 0.5, sharp);
}

/** how much matter floats at (x, z) m from the centre (0..~2.5): a core, the disk, the arms with clumps */
export function debrisDensity(x: number, z: number): number {
  const r = Math.hypot(x, z) / DEBRIS_RADIUS;
  if (r > 1.15) return 0;
  const theta = Math.atan2(-z, x);
  const core = Math.exp(-r / CORE) * 2.2;
  const disk = Math.exp(-r / DISK);
  const arm = armAt(r, theta, 0, ARM_SHARP) * smoothstepJs(0.05, 0.16, r);
  const clump = Math.pow(valueNoise(x / CLUMP_BIG, z / CLUMP_BIG, 31) * 0.6 + valueNoise(x / CLUMP_SMALL, z / CLUMP_SMALL, 83) * 0.4, 1.6);
  return (core + disk * (0.12 + 1.6 * arm * (clump * 1.4 + 0.2))) * (1 - smoothstepJs(0.9, 1.15, r));
}

export interface DebrisData {
  count: number;
  /** per piece: x, z, yaw, length (m) */
  place: Float32Array;
  /** per piece: width, height (m), and its albedo (rgb) */
  shape: Float32Array;
  albedo: Float32Array;
}

// weathered wood (grey, brown, sun-bleached), the odd painted plank or barrel
const WOODS = [[0.16, 0.14, 0.12], [0.22, 0.19, 0.15], [0.3, 0.27, 0.22], [0.12, 0.1, 0.085], [0.36, 0.33, 0.28]];
const RELICS = [[0.12, 0.2, 0.3], [0.35, 0.12, 0.08], [0.4, 0.38, 0.33], [0.16, 0.24, 0.14]];

/** one piece at (x, z) into slot n: its kind, size (a power law: most small, a few beams), turn and colour */
function makePiece(d: DebrisData, n: number, x: number, z: number, r: () => number): void {
  const kind = r();
  const len = 0.6 + 5.4 * Math.pow(r(), 3.2);
  let w: number;
  let h: number;
  let c: number[];
  if (kind < 0.55) {
    // planks and boards
    w = len * (0.12 + 0.18 * r());
    h = 0.05 + 0.05 * r();
    c = WOODS[Math.floor(r() * WOODS.length)];
  } else if (kind < 0.88) {
    // logs and beams
    w = Math.min(0.6, len * (0.08 + 0.08 * r()));
    h = w * 0.9;
    c = WOODS[Math.floor(r() * WOODS.length)];
  } else if (kind < 0.98) {
    // wreckage: chunks of roof and wall
    w = len * (0.5 + 0.5 * r());
    h = 0.15 + 0.4 * r();
    c = WOODS[Math.floor(r() * WOODS.length)];
  } else {
    // relics: barrels, crates, a door painted once
    w = 0.6 + 0.5 * r();
    h = 0.6 + 0.4 * r();
    c = RELICS[Math.floor(r() * RELICS.length)];
  }
  const tone = 0.8 + 0.4 * r();
  d.place.set([x, z, r() * Math.PI, len], n * 4);
  d.shape.set([w, h], n * 2);
  d.albedo.set([c[0] * tone, c[1] * tone, c[2] * tone], n * 3);
}

const emptyData = (count: number): DebrisData => ({
  count,
  place: new Float32Array(count * 4),
  shape: new Float32Array(count * 2),
  albedo: new Float32Array(count * 3),
});

/** the pieces, seeded: rejection-sampled from the density */
export function debrisPieces(count = PIECES, seed = 2100): DebrisData {
  const r = rng(seed);
  const d = emptyData(count);
  let n = 0;
  while (n < count) {
    const a = r() * Math.PI * 2;
    const rr = Math.sqrt(r()) * DEBRIS_RADIUS * 1.15;
    const x = Math.cos(a) * rr;
    const z = Math.sin(a) * rr;
    if (r() * 2.6 > debrisDensity(x, z)) continue;
    makePiece(d, n++, x, z, r);
  }
  return d;
}

/** a mat of pieces round (cx, cz), `radius` m, densest at its middle (the bed the raft floats in) */
export function matPieces(cx: number, cz: number, radius: number, count: number, seed = 2101): DebrisData {
  const r = rng(seed);
  const d = emptyData(count);
  for (let n = 0; n < count; n++) {
    const a = r() * Math.PI * 2;
    const rr = Math.pow(r(), 0.8) * radius;
    makePiece(d, n, cx + Math.cos(a) * rr, cz + Math.sin(a) * rr, r);
  }
  return d;
}

export interface DebrisUniforms {
  /** unit toward the Sun (world) */
  sun: V3;
  /** the sunlight's radiance on a white surface facing it, and the sky's (linear) */
  sunLight: V3;
  skyLight: V3;
  /** 0..1 how much has floated free */
  presence: F;
  pixelAngle: F;
  /** world units per metre (1 in the sea's scene, 1e-6 in the planet's, which is in Mm) */
  metres: F;
}

/**
 * The field as instanced boxes (planks, logs, chunks, relics), riding half in the water, in a group at the
 * field's centre (the caller places and orients it, and turns it by DEBRIS_SPIN).
 */
export function createDebrisField(data: DebrisData, U: DebrisUniforms): THREE.Group {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  geometry.translate(0, 0.15, 0); // most of each piece below the surface
  const size = new Float32Array(data.count);
  const albedo = new THREE.InstancedBufferAttribute(data.albedo, 3);
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
  const A = attribute<'vec3'>('debrisAlbedo', 'vec3');
  const S = attribute<'float'>('debrisSize', 'float');
  // a piece shows once it is about a pixel across: below that the sea's colour carries the field (debris.ts)
  const px = S.mul(U.metres).div(positionWorld.sub(cameraPosition).length().mul(U.pixelAngle).max(1e-12));
  const seen = smoothstep(0.5, 1.4, px).mul(U.presence);
  material.colorNode = Fn(() => {
    const lit = U.sunLight.mul(max(normalWorld.dot(U.sun), 0)).add(U.skyLight.mul(normalWorld.y.mul(0.35).add(0.65)));
    return vec4(A.mul(lit), seen);
  })();
  material.name = 'drift-debris';
  const mesh = new THREE.InstancedMesh(geometry, material, data.count);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < data.count; i++) {
    const [x, z, yaw, len] = data.place.subarray(i * 4, i * 4 + 4);
    const [w, h] = data.shape.subarray(i * 2, i * 2 + 2);
    q.setFromAxisAngle(up, yaw);
    m.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(len, h, w));
    mesh.setMatrixAt(i, m);
    size[i] = Math.max(len, w);
  }
  geometry.setAttribute('debrisAlbedo', albedo);
  geometry.setAttribute('debrisSize', new THREE.InstancedBufferAttribute(size, 1));
  mesh.frustumCulled = false;
  mesh.name = 'drift-debris';
  const group = new THREE.Group();
  group.name = 'drift-debris-field';
  group.add(mesh);
  return group;
}
