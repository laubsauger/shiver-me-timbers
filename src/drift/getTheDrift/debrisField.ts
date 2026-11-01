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
import { Fn, abs, atan, attribute, cameraPosition, cameraProjectionMatrix, cos, float, max, mix, modelWorldMatrix, modelWorldMatrixInverse, normalGeometry, normalWorld, positionGeometry, positionWorld, reflect, screenSize, select, sin, smoothstep, texture, uv, vec2, vec3, vec4 } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rng } from '../undertime/web';
import { hash2 as nhash } from '../../terrain/noise';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

/** m: the field's radius (a galaxy of debris 24 km across: from 30 km up it spans ~40° of the dome, low in front) */
export const DEBRIS_RADIUS = 12000;
/** the pattern: Act 2's own spiral look (galaxies.ts OUR_LOOK, at its old 13° pitch: our galaxy's arms opened to 18° on
 * 2026-11-01 against the far disc's rings; the debris, seen from above, keeps the tighter wind and its pieces' places) */
const ARMS = 2;
const WIND = 1 / Math.tan((13 * Math.PI) / 180);
const PHASE = 0.6;
/** rad/s the field turns at (timeline.ts: the landing comes down onto a point of it, and follows it) */
export { DEBRIS_SPIN } from './timeline';
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
  /** per piece: what it is (DebrisKind) */
  kind: Uint8Array;
  /** per piece: its freeboard (share of its height above the water), a seed (0..1: its warp, its broken ends), how
   * sun-bleached its dry top is (0..1), 0 */
  extra: Float32Array;
}

/**
 * WHAT A PIECE IS. Most of the field is the waterlogged wood of a drowned world — planks and boards, square beams,
 * round logs, panels of roof and wall — and among it the things people owned (the user's story note, 2026-10-29:
 * "without someone telling me the story it doesn't become apparent"; sunken-world-cues.md cue 2, "human things, not
 * boxes"): crates, a plastic drum, a lifebuoy, jerrycans, a plastic chair, a tyre, a navigation buoy, a bread crate, a
 * plastic tank, a roller-shutter door, an upturned picnic table, a cardboard box, a suitcase.
 * Near the raft the logs and the things are scanned (CC0, Poly Haven: SCANS); everywhere else every kind is drawn as
 * the warped, broken-ended board (`createDebrisField`).
 */
export const enum DebrisKind {
  Plank = 0,
  Beam = 1,
  Log = 2,
  Panel = 3,
  CrateLong = 4,
  Barrel = 5,
  Lifebuoy = 6,
  Jerrycan = 7,
  Crate = 8,
  Chair = 9,
  Tyre = 10,
  Buoy = 11,
  PlasticCrate = 12,
  PlasticCan = 13,
  Tank = 14,
  Door = 15,
  Table = 16,
  Box = 17,
  Suitcase = 18,
}
/** the things people owned, by share of the relics (the rest of a relic draw), their real size (m: length along the
 * piece, width, height as it floats) and freeboard range (share of the height above the water) */
const THINGS: Array<{ kind: DebrisKind; share: number; size: [number, number, number]; freeboard: [number, number] }> = [
  { kind: DebrisKind.CrateLong, share: 0.1, size: [1.17, 0.53, 0.47], freeboard: [0.3, 0.45] },
  { kind: DebrisKind.Crate, share: 0.08, size: [0.83, 0.41, 0.35], freeboard: [0.3, 0.45] },
  // (a plastic drum lying on its side, its bung up: it floats high)
  { kind: DebrisKind.Barrel, share: 0.1, size: [0.88, 0.49, 0.49], freeboard: [0.4, 0.55] },
  // (closed-cell foam: a ring lying flat rides most of its thickness out of the water)
  { kind: DebrisKind.Lifebuoy, share: 0.05, size: [0.84, 0.84, 0.16], freeboard: [0.55, 0.7] },
  // (a sealed can on its side)
  { kind: DebrisKind.Jerrycan, share: 0.06, size: [0.52, 0.35, 0.17], freeboard: [0.45, 0.6] },
  // (a monobloc chair on its back, legs up: hollow plastic, it floats high and reads at once)
  { kind: DebrisKind.Chair, share: 0.12, size: [0.89, 0.66, 0.63], freeboard: [0.45, 0.6] },
  // (a tyre lying flat, half awash)
  { kind: DebrisKind.Tyre, share: 0.1, size: [0.61, 0.6, 0.17], freeboard: [0.4, 0.6] },
  // (a navigation buoy, upright as it is moored to float: most of it out of the water)
  { kind: DebrisKind.Buoy, share: 0.03, size: [1.08, 0.99, 2.65], freeboard: [0.55, 0.65] },
  { kind: DebrisKind.PlasticCrate, share: 0.07, size: [0.41, 0.3, 0.26], freeboard: [0.4, 0.55] },
  { kind: DebrisKind.PlasticCan, share: 0.06, size: [0.34, 0.32, 0.27], freeboard: [0.45, 0.6] },
  { kind: DebrisKind.Tank, share: 0.05, size: [0.64, 0.44, 0.43], freeboard: [0.4, 0.55] },
  // (a door lying flat, awash)
  { kind: DebrisKind.Door, share: 0.04, size: [2.4, 1.08, 0.3], freeboard: [0.2, 0.35] },
  // (a picnic table upside down, its top awash and its legs in the air: the flood's own picture)
  { kind: DebrisKind.Table, share: 0.04, size: [3.02, 2.24, 0.74], freeboard: [0.8, 0.88] },
  { kind: DebrisKind.Box, share: 0.05, size: [0.52, 0.39, 0.34], freeboard: [0.3, 0.45] },
  // (a suitcase lying flat)
  { kind: DebrisKind.Suitcase, share: 0.05, size: [0.44, 0.35, 0.15], freeboard: [0.4, 0.6] },
];
/** the things set where the eye will be (`thingsAt`), in this order: the most legible first — a table upside down, a
 * chair, a tyre, a drum, a door — then round the rest */
const PLACED: DebrisKind[] = [
  DebrisKind.Table, DebrisKind.Chair, DebrisKind.Tyre, DebrisKind.Barrel, DebrisKind.Door, DebrisKind.Lifebuoy,
  DebrisKind.Buoy, DebrisKind.Suitcase, DebrisKind.CrateLong, DebrisKind.Tank, DebrisKind.PlasticCrate, DebrisKind.Box,
  DebrisKind.Jerrycan, DebrisKind.PlasticCan, DebrisKind.Crate,
];

// weathered wood (grey, brown, sun-bleached), the odd painted plank or barrel
const WOODS = [[0.16, 0.14, 0.12], [0.22, 0.19, 0.15], [0.3, 0.27, 0.22], [0.12, 0.1, 0.085], [0.36, 0.33, 0.28]];
const RELICS = [[0.12, 0.2, 0.3], [0.35, 0.12, 0.08], [0.4, 0.38, 0.33], [0.16, 0.24, 0.14]];

/**
 * One piece at (x, z) into slot n: its kind, size (a power law: most small, a few beams), turn and colour. The draws
 * from `r` are the SAME, in the same order, as the boxes' were (kind, length, two or three for its shape and colour,
 * tone, yaw), so every piece lies where it always lay; what it IS now also follows where it lies (REGIONS: one clump
 * of the field is planks, another logs and branches, another a house's wreckage and things; the sizes swell and shrink
 * over hundreds of metres), and its warp and freeboard come from its own hash.
 */
function makePiece(d: DebrisData, n: number, x: number, z: number, r: () => number): void {
  const k0 = r();
  const len0 = 0.6 + 5.4 * Math.pow(r(), 3.2);
  const a = r();
  // (the boxes drew a second shape number for every kind but the logs)
  const b = k0 < 0.55 || k0 >= 0.88 ? r() : 0.5;
  const cpick = r();
  const tone = 0.8 + 0.4 * r();
  const yaw = r() * Math.PI;
  // where it lies: log-rich (0..1), a house's worth of things (0..1), the clump's size, how bleached
  const logs = valueNoise(x / REGIONS.logs, z / REGIONS.logs, 91);
  const house = Math.pow(valueNoise(x / REGIONS.house, z / REGIONS.house, 211), 2);
  const grand = 0.65 + 0.8 * valueNoise(x / REGIONS.size, z / REGIONS.size, 57);
  const bleach = smoothstepJs(0.45, 0.8, valueNoise(x / REGIONS.bleach, z / REGIONS.bleach, 13));
  const h1 = hash2(n, 7, 5501);
  const h2 = hash2(n, 11, 5503);
  let kind: DebrisKind;
  let len = len0 * grand;
  let w: number;
  let h: number;
  let fb: number;
  let c: number[] = WOODS[Math.floor(cpick * WOODS.length)];
  if (k0 >= 0.98 - 0.04 * house) {
    // the things people owned (their real sizes: a crate is a crate)
    let pick = h1;
    const t = THINGS.find((q) => (pick -= q.share) < 0) ?? THINGS[0];
    kind = t.kind;
    const s = 0.9 + 0.25 * a;
    [len, w, h] = [t.size[0] * s, t.size[1] * s, t.size[2] * s];
    fb = t.freeboard[0] + (t.freeboard[1] - t.freeboard[0]) * h2;
    c = RELICS[Math.floor(cpick * RELICS.length)];
  } else if (k0 < 0.55 - 0.25 * logs) {
    // planks and boards, waterlogged: a fifth to a third of their thickness out of the water
    kind = DebrisKind.Plank;
    w = Math.min(0.45, len * (0.12 + 0.18 * a));
    h = 0.04 + 0.05 * b;
    fb = 0.2 + 0.15 * h2;
  } else if (k0 < 0.88) {
    // timber: square beams, or round logs and trunks (more of them where the field is log-rich)
    if (h1 < 0.35 + 0.45 * logs) {
      kind = DebrisKind.Log;
      len = Math.max(1.2, len);
      w = Math.min(0.6, 0.12 + len * (0.04 + 0.05 * a));
      h = w;
      fb = 0.22 + 0.15 * h2;
    } else {
      kind = DebrisKind.Beam;
      w = Math.min(0.35, len * (0.06 + 0.06 * a));
      h = w * (0.8 + 0.2 * h2);
      fb = 0.18 + 0.15 * h2;
    }
  } else {
    // wreckage: panels of roof and wall, nailed boards, barely awash
    kind = DebrisKind.Panel;
    // (at most a few boards wide: a 3 m sheet floating flat read as plywood pasted on the water, the 2026-10-29
    // review of the landing still; and barely awash — its top a centimetre or two out, its low corners under)
    w = Math.min(1.4, len * (0.3 + 0.4 * a));
    h = 0.06 + 0.08 * b;
    fb = 0.1 + 0.12 * h2;
  }
  d.place.set([x, z, yaw, len], n * 4);
  d.shape.set([w, h], n * 2);
  d.albedo.set([c[0] * tone, c[1] * tone, c[2] * tone], n * 3);
  d.kind[n] = kind;
  d.extra.set([fb, hash2(n, 13, 5507), bleach * hash2(n, 17, 5509), 0], n * 4);
}

/** m: the scales of the field's regions (makePiece) — where it is log-rich, where a house came apart, where the pieces
 * run large or small, where they lie sun-bleached */
const REGIONS = { logs: 260, house: 300, size: 420, bleach: 180 };

const emptyData = (count: number): DebrisData => ({
  count,
  place: new Float32Array(count * 4),
  shape: new Float32Array(count * 2),
  albedo: new Float32Array(count * 3),
  kind: new Uint8Array(count),
  extra: new Float32Array(count * 4),
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

/** a mat of pieces round (cx, cz), densest at its middle and thinning out as a Gaussian of `sigma` m (no edge
 * to it: the bed the raft floats in, melting into the field) */
export function matPieces(cx: number, cz: number, sigma: number, count: number, seed = 2101): DebrisData {
  const r = rng(seed);
  const d = emptyData(count);
  for (let n = 0; n < count; n++) {
    const a = r() * Math.PI * 2;
    const rr = sigma * Math.sqrt(-2 * Math.log(1 - r() * 0.9999));
    makePiece(d, n, cx + Math.cos(a) * rr, cz + Math.sin(a) * rr, r);
  }
  return d;
}

/**
 * THINGS SET WHERE THE EYE WILL BE (the user's story note, 2026-10-29: "one recognisable object near the eye … is
 * worth a thousand planks"): one of the people's things at each of `at` (field frame, m), turned and chosen by the
 * seed, in the order of PLACED round and round.
 */
export function thingsAt(at: ReadonlyArray<readonly [number, number]>, seed = 2102): DebrisData {
  const r = rng(seed);
  const d = emptyData(at.length);
  at.forEach(([x, z], n) => {
    const t = THINGS.find((q) => q.kind === PLACED[n % PLACED.length])!;
    const s = 0.95 + 0.15 * r();
    d.place.set([x, z, r() * Math.PI, t.size[0] * s], n * 4);
    d.shape.set([t.size[1] * s, t.size[2] * s], n * 2);
    const c = RELICS[n % RELICS.length];
    d.albedo.set(c, n * 3);
    d.kind[n] = t.kind;
    d.extra.set([t.freeboard[0] + (t.freeboard[1] - t.freeboard[0]) * r(), r(), 0, 0], n * 4);
  });
  return d;
}

/** the pieces that stay clear of a circle of `radius` m round (x, z), each by its own length (the raft's berth:
 * nothing floats through its hull) */
export function clearOf(d: DebrisData, x: number, z: number, radius: number): DebrisData {
  return keepIf(d, (px, pz, len) => Math.hypot(px - x, pz - z) - len / 2 > radius);
}

/** the pieces `keep(x, z, length)` says may stay */
export function keepIf(d: DebrisData, keepPiece: (x: number, z: number, len: number) => boolean): DebrisData {
  const keep: number[] = [];
  for (let i = 0; i < d.count; i++) {
    const [px, pz, , len] = d.place.subarray(i * 4, i * 4 + 4);
    if (keepPiece(px, pz, len)) keep.push(i);
  }
  return subset(d, keep);
}

/** the pieces at `keep` (indices into d) */
function subset(d: DebrisData, keep: readonly number[]): DebrisData {
  const out = emptyData(keep.length);
  keep.forEach((i, n) => {
    out.place.set(d.place.subarray(i * 4, i * 4 + 4), n * 4);
    out.shape.set(d.shape.subarray(i * 2, i * 2 + 2), n * 2);
    out.albedo.set(d.albedo.subarray(i * 3, i * 3 + 3), n * 3);
    out.kind[n] = d.kind[i];
    out.extra.set(d.extra.subarray(i * 4, i * 4 + 4), n * 4);
  });
  return out;
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
 * What the sea's scene gives the debris that the planet's cannot (both optional; without them, the planet's look):
 *   sky    the sky's radiance along a world direction (seaSky.dome): what the wet wood's film mirrors;
 *   swell  the sea's height (m) at a world-XZ node — its long waves, which the pieces ride;
 *   tilt   pitch and roll the pieces with the swell's slope too (four more swell reads a vertex: the near mat);
 *   scans  draw the logs and the things as their scans (the near mat; the far field stays boards).
 */
export interface DebrisLook {
  sky?: (dir: V3) => V3;
  swell?: (xz: THREE.Node<'vec2'>) => F;
  tilt?: boolean;
  scans?: boolean;
}

/** the wood the boards are made of: a scanned weathered plank (BlenderKit "PBR Wooden Planks", royalty-free,
 * public/drift/pbr/planks/, gitignored) — its atlas holds two broad planks, at these uv rectangles. Their own linear
 * luminance is 0.229 (measured on the image, 2026-10-29: the atlas's 0.10 mean is 56% black background) */
let plankTexture: THREE.Texture | null = null;
const PLANKS: Array<[number, number, number, number]> = [
  [0.039, 0.07, 0.205, 0.86],
  [0.27, 0.07, 0.205, 0.86],
];
const PLANK_LUM = 0.229;
/** m: a board's width and the length one atlas board covers (its rect is 4.2× as long as wide in the square image) */
const BOARD_W = 0.24;
const BOARD_L = 1.0;
function plank(): THREE.Texture {
  if (!plankTexture) {
    plankTexture = new THREE.TextureLoader().load(`${import.meta.env.BASE_URL}drift/pbr/planks/diffuse.jpg`);
    plankTexture.colorSpace = THREE.SRGBColorSpace;
    plankTexture.anisotropy = 8;
  }
  return plankTexture;
}

/**
 * THE SCANS (Poly Haven, CC0; fetched by scripts/drift-pbr-fetch.py, cut to a few hundred triangles and 512 px maps by
 * scripts/drift-prop-export.py into public/drift/pbr/<asset>/<asset>_float.glb — docs/drift/PIPELINES.md §5): turned so
 * the piece's length is x and its floating up is y, then scaled to the unit box, so a piece's own (length, height,
 * width) gives it its size. `lum`: the scan's own mean linear luminance (measured), for the wood whose tone the piece
 * sets; 0: drawn in its own colours (the things people made).
 */
const SCANS: Array<{ kinds: DebrisKind[]; file: string; lum: number; turn?: (g: THREE.BufferGeometry) => void; split?: (seed: number) => boolean }> = [
  { kinds: [DebrisKind.Log], file: 'dead_tree_trunk', lum: 0.034, split: (s) => s < 0.55 },
  { kinds: [DebrisKind.Log], file: 'dead_tree_trunk_02', lum: 0.1, split: (s) => s >= 0.55 },
  { kinds: [DebrisKind.CrateLong], file: 'wooden_crate_02', lum: 0.078, turn: (g) => g.rotateY(Math.PI / 2) },
  { kinds: [DebrisKind.Crate], file: 'wooden_crate_01', lum: 0.087 },
  { kinds: [DebrisKind.Barrel], file: 'Barrel_02', lum: 0, turn: (g) => g.rotateZ(Math.PI / 2) },
  { kinds: [DebrisKind.Lifebuoy], file: 'lifebuoy', lum: 0, turn: (g) => g.rotateX(Math.PI / 2) },
  { kinds: [DebrisKind.Jerrycan], file: 'metal_jerrycan_green', lum: 0, turn: (g) => g.rotateX(Math.PI / 2).rotateY(Math.PI / 2) },
  { kinds: [DebrisKind.Chair], file: 'plastic_monobloc_chair_01', lum: 0, turn: (g) => g.rotateX(Math.PI / 2).rotateY(Math.PI / 2) },
  { kinds: [DebrisKind.Tyre], file: 'old_tyre', lum: 0, turn: (g) => g.rotateX(Math.PI / 2) },
  { kinds: [DebrisKind.Buoy], file: 'ocean_buoy', lum: 0 },
  { kinds: [DebrisKind.PlasticCrate], file: 'plastic_crate_01', lum: 0, turn: (g) => g.rotateY(Math.PI / 2) },
  { kinds: [DebrisKind.PlasticCan], file: 'plastic_jerrycan', lum: 0, turn: (g) => g.rotateZ(Math.PI / 2).rotateY(Math.PI / 2) },
  { kinds: [DebrisKind.Tank], file: 'industrial_pastic_container', lum: 0, turn: (g) => g.rotateY(Math.PI / 2) },
  { kinds: [DebrisKind.Door], file: 'rollershutter_door', lum: 0, turn: (g) => g.rotateX(Math.PI / 2).rotateY(Math.PI / 2) },
  { kinds: [DebrisKind.Table], file: 'wooden_picnic_table', lum: 0, turn: (g) => g.rotateZ(Math.PI).rotateY(Math.PI / 2) },
  { kinds: [DebrisKind.Box], file: 'cardboard_box_01', lum: 0, turn: (g) => g.rotateY(Math.PI / 2) },
  { kinds: [DebrisKind.Suitcase], file: 'vintage_suitcase', lum: 0, turn: (g) => g.rotateX(Math.PI / 2) },
];

/** a scan's meshes merged (their transforms applied), turned and scaled to the unit box, one geometry group per part;
 * and each part's colour map (the door, the table and the suitcase are two materials) */
async function loadScan(file: string, turn?: (g: THREE.BufferGeometry) => void): Promise<{ geometry: THREE.BufferGeometry; maps: Array<THREE.Texture | null> }> {
  const gltf = await new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}drift/pbr/${file}/${file}_float.glb`);
  const parts: THREE.BufferGeometry[] = [];
  const maps: Array<THREE.Texture | null> = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'uv']) {
      const a = m.geometry.getAttribute(name);
      if (a) g.setAttribute(name, a.clone());
    }
    if (m.geometry.index) g.setIndex(m.geometry.index.clone());
    g.applyMatrix4(m.matrixWorld);
    // (every part indexed, or none: mergeGeometries takes one or the other)
    parts.push(g.index ? g : g.setIndex([...Array(g.getAttribute('position').count).keys()]));
    maps.push(((Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial).map ?? null);
  });
  const geometry = mergeGeometries(parts, true);
  if (!geometry) throw new Error(`debris: ${file} has no mesh`);
  turn?.(geometry);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const centre = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  geometry.translate(-centre.x, -centre.y, -centre.z);
  // (applyMatrix4 carries the scan's own normals through the scale by its normal matrix: smooth, as scanned)
  geometry.scale(1 / Math.max(size.x, 1e-3), 1 / Math.max(size.y, 1e-3), 1 / Math.max(size.z, 1e-3));
  return { geometry, maps };
}

/** the kinds a board can stand for (createDebrisField without scans): the wood, and the things shaped like boxes */
const BOARDABLE = new Set<DebrisKind>([
  DebrisKind.Plank, DebrisKind.Beam, DebrisKind.Log, DebrisKind.Panel, DebrisKind.CrateLong, DebrisKind.Crate,
  DebrisKind.Box, DebrisKind.PlasticCrate, DebrisKind.Tank, DebrisKind.Suitcase,
]);

/** px: the least each of a piece's three sizes is drawn across (createDebrisField: PIXEL-FLOORED) */
const FLOOR_PX = 1.5;
/** m: the waterline's darkest band on the wood (just above the water, where it is always wet and dries the least) and
 * the wet reach above it (the swell wets a waterlogged plank's top every few seconds) */
const WATERLINE = 0.06;
const WET_REACH = 0.18;

/**
 * The field: one instanced mesh per shape, all riding the water, in a group at the field's centre (the caller places
 * and orients it, and turns it by DEBRIS_SPIN). `ready` resolves once its scans are drawn (at once without `scans`).
 *
 * THE BOARD, everywhere: a box subdivided along its length and across, BROKEN at both ends (each end's vertices bitten
 * back by their own hash, up to a board's width or more: splintered, not sawn), BENT (a few cm over its length),
 * TWISTED (a few degrees end to end) — every one its own by its seed, so no two planks are the box they were — and cut
 * from the scanned plank: its grain along the piece, one of the two boards picked per piece, tinted by its own
 * weathered tone. THE SCANS near the raft (`scans`): the logs are trunks with their bark, the things are themselves.
 *
 * AFLOAT, NOT ON THE WATER (the 2026-10-29 review: "flat black CG slabs and plain boxes"): each rides at its freeboard
 * — a waterlogged plank a fifth to a third of its thickness out, a log a quarter, a crate half its height, a lifebuoy
 * most of it (the boxes sat 65% out: their `translate(0, 0.15, 0)` raised the unit box, it did not sink it) — on the
 * sea's long waves (`swell`), pitched and rolled with them near the raft (`tilt`).
 *
 * LIT AS WET WOOD AT SUNSET, NOT BLACK. Measured (2026-10-29): the boards were sampling their atlas at its rect
 * CORNERS — `positionLocal` in the fragment is the vertex's FINAL position (metres in the field), not the unit box, so
 * the grain lookup clamped to 0 or 1 — and those corners are the atlas's black background (linear 0.000 at six of the
 * eight). Every board was ~black whatever the light. Now the grain is looked up from the unit box itself, the tone
 * normalised by the plank's own luminance (0.229, not the atlas's 0.10 with its background), and the light is:
 *   - the Sun on the faces turned to it and the sky's irradiance (as before);
 *   - the WET FILM: a soaked plank's top mirrors the sky as the water round it does — Schlick's Fresnel (F₀ 0.02)
 *     against the sky's own radiance along the reflection (`sky`), at full strength in the wet band and a sixth on a
 *     dry, bleached top — so at a low sun a wet board catches the glowing horizon instead of going black against it;
 *   - the Sun's glint off that film (a tight Blinn lobe);
 *   - and the water line: darkest just above the water (WATERLINE), wet and dark below WET_REACH, the dry top lighter
 *     and, in places, sun-bleached grey;
 * and what is under the water dims and goes blue-green with depth (Beer–Lambert down and back), so the parts a glassy
 * sea shows through it read as waterlogged wood fading into it, not as pale shapes.
 */
export function createDebrisField(data: DebrisData, U: DebrisUniforms, look: DebrisLook = {}): THREE.Group & { ready: Promise<void> } {
  const group = new THREE.Group() as THREE.Group & { ready: Promise<void> };
  group.name = 'drift-debris-field';
  // which pieces each shape draws: the boards take every kind the scans do not (all of them without `scans`)
  // (−1: drawn as a board; −2: not drawn. Without the scans only the wood and the box-shaped things are boards — a
  // picnic table or a door drawn as a box was a 3 m slab with a door-sized slab on it mirroring the sky white, the
  // 2026-10-29 review of the landing still; a chair, a tyre or a buoy as a box is no better. Those are left to the
  // near mat's scans, a few percent of the far field's pieces gone)
  // NO BROAD PANELS NEAR THE EYE (the near mat, `scans`): a metre-and-more of flat boards floating on a glassy sea read
  // as a sheet laid on the water however it was textured, lain and awash — the 2026-10-29 review of the landing still.
  // The scanned door and the upturned table carry the broad wreckage there; the far field keeps its panels, a few
  // pixels each
  const scanOf = (i: number): number =>
    look.scans
      ? data.kind[i] === DebrisKind.Panel
        ? -2
        : SCANS.findIndex((s) => s.kinds.includes(data.kind[i]) && (!s.split || s.split(data.extra[i * 4 + 1])))
      : BOARDABLE.has(data.kind[i]) ? -1 : -2;
  const groups = new Map<number, number[]>();
  for (let i = 0; i < data.count; i++) {
    const k = scanOf(i);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(i);
  }
  const boards = groups.get(-1);
  if (boards?.length) {
    // (segments: 3 along a far board, 8 near — the bend and the broken ends need them; 2 across, for the bite)
    const segs = look.tilt ? 8 : 3;
    const g = new THREE.BoxGeometry(1, 1, 1, segs, 1, 2);
    group.add(debrisMesh(subset(data, boards), U, look, g, { board: true, maps: [plank()], lum: PLANK_LUM, segs }));
  }
  const loads: Array<Promise<void>> = [];
  for (const [k, idx] of groups) {
    if (k < 0) continue;
    const spec = SCANS[k];
    loads.push(
      loadScan(spec.file, spec.turn).then(({ geometry, maps }) => {
        group.add(debrisMesh(subset(data, idx), U, look, geometry, { board: false, maps, lum: spec.lum, segs: 1 }));
      }),
    );
  }
  group.ready = Promise.all(loads).then(() => undefined);
  return group;
}

/** one shape's pieces as an instanced mesh (see createDebrisField) */
function debrisMesh(
  data: DebrisData,
  U: DebrisUniforms,
  look: DebrisLook,
  geometry: THREE.BufferGeometry,
  o: { board: boolean; maps: Array<THREE.Texture | null>; lum: number; segs?: number },
): THREE.InstancedMesh {
  // (albedo and size in ONE instanced buffer: position, normal, uv, the instance matrix and five of ours were nine
  // vertex buffers, over WebGPU's eight — the pipeline failed to build, 2026-10-29)
  const albedoSize = new Float32Array(data.count * 4);
  const AS = attribute<'vec4'>('debrisAlbedo', 'vec4');
  const A = AS.xyz;
  const S = AS.w;
  const P = attribute<'vec4'>('debrisPlace', 'vec4');
  const D = attribute<'vec2'>('debrisShape', 'vec2');
  const E = attribute<'vec4'>('debrisExtra', 'vec4');
  // a piece shows once it is about a pixel across: below that the sea's colour carries the field (debris.ts)
  const px = S.mul(U.metres).div(positionWorld.sub(cameraPosition).length().mul(U.pixelAngle).max(1e-12));
  const seen = smoothstep(0.5, 1.4, px).mul(U.presence);
  // PIXEL-FLOORED (the user, 2026-10-29: "wild flickering" coming down to the raft, gone once settled). A plank
  // shows once it is about a pixel LONG, but its width and height are a tenth of that: a sliver that covered a
  // pixel's centre in one frame and missed it in the next as the eye came down, so every piece a few hundred
  // metres off blinked (a 512² clip at 320 s: ~250 px a frame flipping and back, none with the pieces hidden; not
  // the depth buffer, nor the draw order; their mirror images ~10 % of it). So each of a piece's three sizes is drawn
  // at least FLOOR_PX px, and its alpha cut by the area it shows the eye over the area drawn: the same wood on the
  // water, over pixels it always covers. The pixel is the master's or this camera's, whichever is larger (the
  // water's mirror draws the pieces into 512² faces, coarser than a 4K master's).
  // (the instance's frame: its centre on the water, turned by its yaw; local x its length, y its height, z its width)
  const centre = vec3(P.x, 0, P.y);
  const c = cos(P.z);
  const s = sin(P.z);
  const toPiece = modelWorldMatrix.mul(vec4(centre, 1)).xyz.sub(cameraPosition);
  const cameraPixel = atan(float(1).div(cameraProjectionMatrix.mul(vec4(0, 1, 0, 0)).y)).mul(2).div(screenSize.y);
  const least = toPiece.length().div(U.metres).mul(max(U.pixelAngle, cameraPixel)).mul(FLOOR_PX);
  const dims = vec3(P.w, D.y, D.x);
  const drawn = max(dims, vec3(least));
  const g = positionGeometry;
  /** rad: the piece's own lie on the water, along and across it — a waterlogged board never floats level: one end or
   * edge lower, under (for a 1.4 m panel, ±2° is ±2.5 cm at its edges, against a top 1–2 cm out) */
  const lieA = nhash(vec2(E.y.mul(71), 5.3)).sub(0.5).mul(0.07);
  const lieC = nhash(vec2(E.y.mul(83), 9.1)).sub(0.5).mul(0.07);
  // THE BOARD'S BREAKS, BEND AND TWIST (see createDebrisField), in the unit box then in metres
  let gx: THREE.Node<'float'> = g.x;
  if (o.board) {
    const side = select(g.x.greaterThan(0), float(1), float(-1));
    const atEnd = smoothstep(0.42, 0.5, g.x.abs());
    const cut = nhash(vec2(E.y.mul(131).add(side.mul(7)), g.z.mul(2).add(0.5).floor().add(g.y.mul(0.01))));
    // a bite back from the end of up to ~1.3 board-widths — and never past the end's own segment of the box. Bitten
    // further, an end vertex crossed the next one in: the quad between them turned over, the top's was culled and the
    // BOTTOM's showed through, its −y normal mirroring the sky at full Fresnel — the white rectangle on the broad
    // panel by the landing (2026-10-29, isolated to the near mat's boards in one boot)
    const bite = cut.mul(1.1).add(0.15).mul(D.x).div(P.w.max(1e-3)).min(0.9 / (o.segs ?? 1)).mul(atEnd);
    gx = g.x.sub(side.mul(bite));
  }
  const unit = vec3(gx, g.y, g.z);
  let m: THREE.Node<'vec3'> = unit.mul(drawn);
  if (o.board) {
    const bend = E.y.sub(0.5).mul(0.05).mul(P.w).mul(float(1).sub(gx.mul(gx).mul(4)));
    const twist = nhash(vec2(E.y.mul(57), 3.1)).sub(0.5).mul(0.25).mul(gx);
    const ct = twist.cos();
    const st = twist.sin();
    m = vec3(m.x, m.y.mul(ct).sub(m.z.mul(st)).add(bend), m.y.mul(st).add(m.z.mul(ct)));
  }
  // the freeboard: the unit box's top at E.x of its height above the water
  const afloat = m.add(vec3(0, D.y.mul(E.x.sub(0.5)), 0));
  // m above (−: below) the water at this point of the piece, for the wet band and the absorption
  const aboveWater = afloat.y.add(afloat.x.mul(lieA)).add(afloat.z.mul(lieC)).toVarying('vDebrisAbove');
  // (its lie: a shear, the angles a degree or two)
  const lying = afloat.add(vec3(0, afloat.x.mul(lieA).add(afloat.z.mul(lieC)), 0));
  const fieldPos = vec3(lying.x.mul(c).add(lying.z.mul(s)), lying.y, lying.z.mul(c).sub(lying.x.mul(s))).add(centre);
  let positionNode: THREE.Node<'vec3'> = fieldPos;
  if (look.swell) {
    // ON THE SEA'S LONG WAVES: the piece's centre at the sea's height there, and (`tilt`) its ends and sides at
    // theirs — the swell's slope along and across it, applied as a shear (its angles are a few degrees)
    const swell = look.swell;
    const at = (p: THREE.Node<'vec3'>): THREE.Node<'vec2'> => modelWorldMatrix.mul(vec4(p, 1)).xz;
    const h0 = swell(at(centre));
    let lift: THREE.Node<'float'> = h0;
    if (look.tilt) {
      const half = P.w.mul(0.5).max(0.25);
      const halfW = D.x.mul(0.5).max(0.25);
      const along = vec3(c, 0, s.negate());
      const acrossV = vec3(s, 0, c);
      const slopeA = swell(at(centre.add(along.mul(half)))).sub(swell(at(centre.sub(along.mul(half))))).div(half.mul(2));
      const slopeC = swell(at(centre.add(acrossV.mul(halfW)))).sub(swell(at(centre.sub(acrossV.mul(halfW))))).div(halfW.mul(2));
      lift = h0.add(afloat.x.mul(slopeA)).add(afloat.z.mul(slopeC));
    }
    // (the sea's scene is in metres and its group unscaled and level: the field's y is the world's)
    positionNode = fieldPos.add(vec3(0, lift, 0));
  }

  // the eye's direction in the piece's frame, and the area a box shows along it: each face's area × |its cosine|
  const v = modelWorldMatrixInverse.mul(vec4(toPiece, 0)).xyz;
  const bv = vec3(v.x.mul(c).sub(v.z.mul(s)), v.y, v.x.mul(s).add(v.z.mul(c))).abs();
  const shown = (d: V3): F => bv.x.mul(d.y).mul(d.z).add(bv.y.mul(d.x).mul(d.z)).add(bv.z.mul(d.x).mul(d.y)) as F;
  const cover = shown(dims).div(shown(drawn).max(1e-12)).toVarying('vDebrisCover');
  const unitV = positionGeometry.toVarying('vDebrisUnit');
  // one material per colour map (a scan's parts), sharing every other node
  const colourOf = (map: THREE.Texture | null): THREE.Node<'vec4'> => Fn(() => {
    // ── THE SURFACE: its colour where it is dry ────────────────────────────────────────────────────────────────
    let albedo: V3;
    if (o.board) {
      // AT ITS REAL SIZE (the 2026-10-29 review: a broad panel took one scanned board stretched across all of it — a
      // clean plywood sheet): the grain runs along the piece; across it the piece is BOARD_W-wide boards side by side
      // (its top and bottom across its width, its sides across its height), each its own board of the atlas at its
      // own offset along it, a dark seam between them
      const top = abs(normalGeometry.y).greaterThan(0.5);
      const acrossM = select(top, unitV.z.add(0.5).mul(D.x), unitV.y.add(0.5).mul(D.y));
      const alongM = unitV.x.add(0.5).mul(P.w);
      const board = acrossM.div(BOARD_W).floor();
      const inBoard = acrossM.div(BOARD_W).fract();
      const hb = nhash(vec2(board.add(E.y.mul(37)), 2.7));
      const r0 = vec4(...PLANKS[0]);
      const r1 = vec4(...PLANKS[1]);
      const rect = select(hb.greaterThan(0.5), r1, r0);
      const alongT = alongM.div(BOARD_L).add(hb.mul(7.3)).fract();
      // (inset a little from the board's own edge in the atlas: the background is black right to it)
      const at = vec2(rect.x.add(rect.z.mul(inBoard.clamp(0.04, 0.96))), rect.y.add(rect.w.mul(alongT.clamp(0.02, 0.98))));
      // the seams, only where a face is more than one board across
      const many = select(top, D.x, D.y).greaterThan(BOARD_W * 1.3);
      const seam = select(many, smoothstep(0, 0.07, inBoard).mul(smoothstep(1, 0.93, inBoard)).mul(0.6).add(0.4), float(1));
      albedo = texture(map!, at).rgb.mul(A.div(o.lum)).mul(hb.mul(0.3).add(0.85)).mul(seam) as V3;
    } else if (map && o.lum > 0) {
      // scanned wood: its own grain and bark, at the piece's tone
      albedo = texture(map, uv()).rgb.mul(A.div(o.lum)) as V3;
    } else {
      // the things people made, in their own colours
      albedo = (map ? texture(map, uv()).rgb : A) as V3;
    }
    const lum = albedo.dot(vec3(0.2126, 0.7152, 0.0722));
    const wood = o.board || o.lum > 0;
    // ── THE WATER ON IT ────────────────────────────────────────────────────────────────────────────────────────
    const h = aboveWater;
    const wet = smoothstep(WET_REACH, 0, h);
    const line = smoothstep(-0.04, 0, h).mul(smoothstep(WATERLINE, WATERLINE * 0.3, h));
    // wet wood darkens to ~half (water fills the pores), darkest at the line; plastic and paint hardly at all
    const darken = wood ? mix(float(1), float(0.55), wet).mul(mix(float(1), float(0.7), line)) : mix(float(1), float(0.85), wet);
    // the dry tops in the bleached clumps go silver-grey
    const bleached = wood ? mix(albedo, vec3(lum.mul(1.4)), E.z.mul(wet.oneMinus())) : albedo;
    // under the water: down to it and back up, Jerlov-ish per channel (R dies first)
    const under = vec3(2.2, 0.75, 0.55).mul(h.negate().max(0).mul(2)).negate().exp();
    const body = (bleached as V3).mul(darken).mul(under);
    // ── THE LIGHT ───────────────────────────────────────────────────────────────────────────────────────────────
    const N = normalWorld;
    const V = cameraPosition.sub(positionWorld).normalize();
    const sunTerm = U.sunLight.mul(max(N.dot(U.sun), 0));
    const skyTerm = U.skyLight.mul(N.y.mul(0.35).add(0.65));
    const diffuse = body.mul(sunTerm.add(skyTerm));
    // the wet film's mirror and the Sun's glint off it (plastic is glossy wet or dry)
    const cosV = max(N.dot(V), 0);
    const fresnel = float(0.02).add(float(0.98).mul(float(1).sub(cosV).pow(5)));
    const film = wood ? mix(float(0.16), float(1), wet) : float(0.6);
    const R = reflect(V.negate(), N);
    const Rup = vec3(R.x, R.y.max(0.02), R.z).normalize();
    const skyR = look.sky ? look.sky(Rup) : U.skyLight.mul(1.5);
    const H = U.sun.add(V).normalize();
    const glint = U.sunLight.mul(max(N.dot(H), 0).pow(120).mul(14)).mul(max(N.dot(U.sun), 0).greaterThan(0).select(float(1), float(0)));
    const spec = (skyR as V3).add(glint).mul(fresnel).mul(film).mul(under);
    return vec4(diffuse.add(spec), seen.mul(cover));
  })();
  const materials = o.maps.map((map) => {
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
    material.positionNode = positionNode;
    material.colorNode = colourOf(map);
    material.name = 'drift-debris';
    return material;
  });
  const mesh = new THREE.InstancedMesh(geometry, materials.length === 1 ? materials[0] : materials, data.count);
  const mat = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < data.count; i++) {
    const [x, z, yaw, len] = data.place.subarray(i * 4, i * 4 + 4);
    const [w, h] = data.shape.subarray(i * 2, i * 2 + 2);
    q.setFromAxisAngle(up, yaw);
    // (the instance matrix turns and sizes the NORMALS; the position is the positionNode's)
    mat.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(len, h, w));
    mesh.setMatrixAt(i, mat);
    albedoSize.set([data.albedo[i * 3], data.albedo[i * 3 + 1], data.albedo[i * 3 + 2], Math.max(len, w)], i * 4);
  }
  geometry.setAttribute('debrisAlbedo', new THREE.InstancedBufferAttribute(albedoSize, 4));
  geometry.setAttribute('debrisPlace', new THREE.InstancedBufferAttribute(data.place, 4));
  geometry.setAttribute('debrisShape', new THREE.InstancedBufferAttribute(data.shape, 2));
  geometry.setAttribute('debrisExtra', new THREE.InstancedBufferAttribute(data.extra, 4));
  mesh.frustumCulled = false;
  // AFTER THE SEA, always (the user, 2026-10-29: the pieces stopped at a hard edge left of the raft while their
  // mirror images went on, and flickered with the angle on the way down). The sea is in the transparent pass too
  // (its refraction reads the opaque scene) and writes depth; these write none. Sorted by distance per camera, the
  // order flipped between the dome's cube faces and as the eye moved: drawn first, the sea painted over them.
  // Drawn after it, their parts above the water show and the sea's depth hides the rest.
  mesh.renderOrder = 1;
  mesh.name = 'drift-debris';
  return mesh;
}
