/**
 * Cloud cores (§V11 stage 1, §V11b shape contract).
 *
 * WHAT CHANGED AND WHY. These used to be billboard puffs. A billboard is a
 * disc with a radial falloff: its outline is a circle no matter where you
 * stand, so a pile of them can only ever read as a pile of blobs. The talk
 * slide "Clouds: Iteration" says the cores are POLYGONAL MESHES (ref: Paths
 * of Hate) with "billboards for 'fluff'" on top, and §V11b makes that an
 * invariant. So a core is now a LOBE: an icosphere whose radius is pushed
 * around by two octaves of value noise, instanced a few hundred times. The
 * silhouette of the union is faceted and notched — sculpted, not soft — and
 * each lobe has a real surface normal, so one side catches the sun and the
 * other holds shadow. The billboards survive as one soft FLUFF sprite per
 * lobe, feathering the polygonal rim.
 *
 * WHAT DID NOT CHANGE. The §V11 pipeline and its channel packing: lobes and
 * fluff both forward-render into the same 4-channel RT as
 *   R = sunlight, G = skylight, B = alpha, A = normalized depth
 * all PREMULTIPLIED by alpha and summed with ONE/ONE blending, so the blur
 * and composite stages recover weighted averages as channel/B. The composite
 * and the reflection stand-in both depend on that; do not change it here
 * without changing them.
 *
 * SHAPE IS PARAMETRIC (§V7). `silhouetteRadius` is one continuous family:
 * anvilSpread 0 gives fair-weather cumulus, anvilSpread ~1.2 with a narrow
 * waist and a tall clusterHeight gives the storm anvil/mushroom monuments
 * from "Clouds: Concept". Storm is a set of numbers, not a branch.
 *
 * AND THE NUMBERS ARE LOCAL (§V46). Each cluster samples the storm field at
 * its OWN world XZ and blends between the two ends of that family, so a blue
 * sunny sky with one anvil on the horizon is the DEFAULT case, not a preset.
 * The cluster sits over the same cell the rain and the sea read, so sailing
 * toward the cloud sails you into the squall.
 *
 * WHY THE RNG STREAM MUST NOT DEPEND ON THE FIELD: the field drifts, so a
 * cluster is regenerated whenever its quantised storm level moves. Every
 * regeneration walks the same seeded rng in the same order and draws the same
 * number of values, so lobe `i` keeps its identity and only shifts position
 * as the shape blends. Make the lobe COUNT (or any rng call) storm-dependent
 * and every step of the field would reshuffle the entire sky instead.
 *
 * Generation is pure + seeded (§V2): no Math.random, no GPU side effects at
 * import time, same seed → same sky on every client.
 */
import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  float,
  instancedBufferAttribute,
  mix,
  modelViewMatrix,
  mx_noise_float,
  positionGeometry,
  select,
  smoothstep,
  uniform,
  uv,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { ShaderNodeObject } from 'three/tsl';
import { createRng } from '../state/rng';
import { hashCell } from '../weather/field';
import type { StormCell } from '../weather/field';
import type { CloudParams } from '../params/clouds';
import type { ShaftSlot } from './cloudComposite';

type N = ShaderNodeObject<Node>;

/**
 * THE PACK'S BLENDING CONTRACT, in one place because THREE materials now write
 * it: the lobes, the fluff, and the banded stratus sheet (cloudBands.ts).
 * R/G/A are PREMULTIPLIED by alpha and everything is summed ONE/ONE, which is
 * what lets the blur and the composite recover weighted averages as channel/B.
 * A fourth writer that got one of these flags wrong would not error — it would
 * quietly take the whole RT off its own contract, so there is one definition.
 */
export function applyPackedBlending(m: THREE.NodeMaterial): void {
  m.transparent = true;
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneFactor;
  m.blendSrcAlpha = THREE.OneFactor;
  m.blendDstAlpha = THREE.OneFactor;
  m.depthTest = false;
  m.depthWrite = false;
  m.fog = false;
}

/** A polygonal core. `radius` is the mean radius; rx/ry/rz are the ellipsoid. */
export interface CloudLobe {
  x: number;
  y: number;
  z: number;
  /** mean radius (m) — the fluff sprite rides on this */
  radius: number;
  rx: number;
  ry: number;
  rz: number;
  /** per-lobe deterministic noise offset, 0..1 */
  seed: number;
  /** normalized height inside the cluster, 0 = base 1 = top */
  heightN: number;
  /** unit offset direction from cluster centre (cluster sun-side gradient) */
  dirX: number;
  dirY: number;
  dirZ: number;
  /** 0..1, 1 = buried deep in the mass → gets the least direct sun */
  interior: number;
  /** 0..1 local storm strength of the owning cluster (§V46) */
  storm: number;
}

export interface CloudCluster {
  x: number;
  y: number;
  z: number;
  radius: number;
  /** 0..1 storm field sample at this cluster's own world XZ (§V46) */
  storm: number;
  /**
   * Cloud BASE altitude (m). Equal to `y` — every lobe sits at `y + h·vert`
   * with h ≥ 0 — but named separately because the rain shafts hang FROM it
   * (§V.63). Rain that starts at an arbitrary altitude is detached however
   * good the horizontal coupling is.
   */
  base: number;
  /** lattice identity of the storm cell this cluster stands on, or null for
   *  a ring (fair-weather) cluster. §V.63: what makes the coupling checkable. */
  cell: { i: number; j: number } | null;
  lobes: CloudLobe[];
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** §V28: a caller-supplied sampler is untrusted input — NaN must not reach a buffer */
const clamp01 = (v: number): number =>
  Number.isNaN(v) ? 0 : Math.min(1, Math.max(0, v));

/** 0..1 local storm strength at a world XZ — `weather.stormAt` (§V46) */
export type StormSampler = (x: number, z: number) => number;

/**
 * A storm cell to stand a cloud on (§V.63). This is `weather.StormCell`
 * itself, IMPORTED rather than restated: the whole point of the coupling is
 * that the cloud is placed from the same numbers the rain is gated on, and a
 * structural copy of the interface here is precisely how the two would drift
 * apart again without a compile error.
 */
export type StormCellSite = StormCell;

/**
 * A deterministic int seed for one lattice square's own rng stream. Reuses the
 * field's audited integer mixer (§V2) rather than inventing a second one —
 * salt 7 is not used by the field itself.
 */
function cellSalt(i: number, j: number): number {
  return (hashCell(0x5bf03635, i | 0, j | 0, 7) * 4294967296) | 0;
}

/** the subset of CloudParams that `silhouetteRadius` reads */
export interface ShapeProfile {
  domeExponent: number;
  waistWidth: number;
  waistHeight: number;
  anvilStart: number;
  capRound: number;
  anvilSpread: number;
}

/** ShapeProfile plus the two lobe-distribution knobs a cluster also blends */
export interface ClusterShape extends ShapeProfile {
  clusterHeight: number;
  heightBias: number;
  radiusScale: number;
  baseDrop: number;
  lobeScale: number;
}

/**
 * The silhouette family blended toward its storm end by `storm` 0..1 (§V46).
 * Note waistHeight/anvilStart/capRound are NOT blended: they are positions
 * along h, and at anvilSpread 0 the cap terms they control vanish anyway, so
 * one shared value serves both ends.
 */
export function clusterShapeAt(p: CloudParams, storm: number): ClusterShape {
  const t = clamp01(storm);
  return {
    domeExponent: lerp(p.domeExponent, p.stormDomeExponent, t),
    waistWidth: lerp(p.waistWidth, p.stormWaistWidth, t),
    waistHeight: p.waistHeight,
    anvilStart: p.anvilStart,
    capRound: p.capRound,
    anvilSpread: lerp(p.anvilSpread, p.stormAnvilSpread, t),
    clusterHeight: lerp(p.clusterHeight, p.stormClusterHeight, t),
    heightBias: lerp(p.heightBias, p.stormHeightBias, t),
    radiusScale: lerp(1, p.stormRadiusScale, t),
    baseDrop: p.stormBaseDrop * t,
    lobeScale: lerp(1, p.stormLobeScale, t),
  };
}

/**
 * CPU MIRRORS of the two light-path terms added to the sunlight channel, so
 * their contracts can be driven headless (a TSL graph cannot be). Documented
 * transliteration pair, same convention as bandLimit.ts and cloudBands.ts —
 * if you change one of these, change the graph in `createCloudCores` with it.
 */

/** floor on the PRODUCT of the direct attenuations — see multiScattered() */
export function multiScatteredValue(
  direct: number,
  p: Pick<CloudParams, 'multiScatterFloor'>,
): number {
  const f = clamp01(p.multiScatterFloor);
  return f + (1 - f) * clamp01(direct);
}

/**
 * Warm uplight on downward-facing faces at low key elevation.
 * `keyY` is the key direction's y component, i.e. sin(elevation).
 */
export function baseGlowValue(
  downFace: number,
  keyY: number,
  p: Pick<CloudParams, 'baseGlow' | 'baseGlowLowSun'>,
): number {
  const span = Math.max(1e-3, p.baseGlowLowSun);
  const lowKey = clamp01(1 - Math.abs(keyY) / span);
  return Math.max(0, Math.min(2, p.baseGlow)) * lowKey * clamp01(downFace);
}

/**
 * CPU mirror of `stormBaseFactor` — the top-to-bottom darkening that makes a
 * storm cloud read as one (§V.63). `heightN` is 0 at the cloud base, 1 at the
 * top. See the graph in `createCloudCores` for why it is on both channels.
 */
export function stormBaseDarkValue(
  storm: number,
  heightN: number,
  p: Pick<CloudParams, 'stormBaseDark'>,
): number {
  return 1 - clamp01(p.stormBaseDark) * clamp01(storm) * (1 - clamp01(heightN));
}

/** the whole sunlight channel for a lobe face, before the storm cut */
export function lobeSunValue(
  direct: number,
  downFace: number,
  keyY: number,
  p: Pick<CloudParams, 'multiScatterFloor' | 'baseGlow' | 'baseGlowLowSun'>,
): number {
  return Math.min(2, multiScatteredValue(direct, p) + baseGlowValue(downFace, keyY, p));
}

/** clamped smoothstep on a already-normalized t */
const smooth01 = (t: number): number => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};

/** §V28 companion on the CPU side: never divide by an unbounded-small number */
const floorDiv = (v: number): number => (Math.abs(v) < 1e-3 ? 1e-3 : v);

/**
 * Silhouette radius (0..1) of a cluster at normalized height h (0 base, 1
 * top). ONE continuous family covering both weather extremes (§V7):
 *
 *   dome   — rounds the mass off toward the top. Low `domeExponent` domes it
 *            early (cumulus); high keeps it near full width until near the
 *            top, which is what lets a storm cloud read as a column.
 *   waist  — narrows the trunk to `waistWidth` by `waistHeight`. This is the
 *            anvil's stalk; at waistWidth 1 there is no waist at all.
 *   cap    — flares back out above `anvilStart`, then rolls in past
 *            `capRound`. `anvilSpread` 0 removes the cap entirely.
 */
export function silhouetteRadius(h: number, s: ShapeProfile): number {
  const dome = Math.sqrt(Math.max(0, 1 - Math.pow(h, s.domeExponent)));
  const waist = lerp(1, s.waistWidth, smooth01(h / floorDiv(s.waistHeight)));
  const flare = smooth01((h - s.anvilStart) / floorDiv(1 - s.anvilStart));
  const roll = 1 - smooth01((h - s.capRound) / floorDiv(1 - s.capRound));
  return Math.max(0.05, dome * waist + s.anvilSpread * flare * roll);
}

/**
 * Deterministic cluster layout: same (seed, params, field) → identical lobes.
 * Pure data, safe to import in node tests.
 *
 * `sampleStorm` is `weather.stormAt` (§V46), sampled ONCE per cluster at the
 * cluster's own world XZ — ~117 ns a call, so 11 calls is free. Sampling per
 * LOBE would be both wasteful and wrong: a cloud is one weather system, not a
 * few hundred independent ones.
 */
export function generateClusters(
  seed: number,
  p: CloudParams,
  sampleStorm: StormSampler = () => 0,
  /**
   * §V.63 storm cells near the viewer, WORLD frame — `weather.stormCellsNear`.
   * Each one gets a cloud standing ON it, which is what makes storm cloud and
   * rain the same object rather than two systems that happen to be driven by
   * the same number. Omit it and only the ring clusters exist, which is the
   * pre-§V.63 behaviour: measured r = 0.00 between rain and cloud along a
   * sail track, because the ring sits around the world ORIGIN and the rain
   * follows the ship.
   */
  stormCells: readonly StormCellSite[] = [],
): CloudCluster[] {
  const rng = createRng(seed);
  const clusters: CloudCluster[] = [];

  // -- cell-anchored storm clouds -------------------------------------------
  // Placed FIRST so they take the low instance indices: if `maxLobes`
  // overflows, the thing that gets dropped is a distant fair-weather bank,
  // never the anvil the player is sailing under.
  //
  // OWN RNG STREAM PER CELL, keyed on the cell's LATTICE coordinates. Two
  // reasons, both structural:
  //  - it decouples them from the ring stream, so adding or losing a cell as
  //    the ship sails cannot reshuffle the fair-weather sky;
  //  - a cell's identity (i, j) is fixed while its amplitude breathes on the
  //    lifecycle, so lobe COUNT and lobe seeds are drawn from something that
  //    does not move. Drawing them from `amp` would rebuild a different cloud
  //    every quantisation step — the same trap the header note describes for
  //    the ring.
  for (const cell of stormCells) {
    const storm = clamp01(cell.amp);
    if (storm < p.stormCellMin) continue;
    const cellRng = createRng((seed ^ cellSalt(cell.i, cell.j)) | 0);
    const shape = clusterShapeAt(p, storm);
    // radius comes from the CELL, not from clusterRadiusMin/Max × radiusScale:
    // the cloud's footprint has to be the squall's footprint or you get rain
    // outside the cloud at exactly the range where you would notice.
    const cr = Math.max(cell.radius * Math.max(p.stormCellRadius, 0), 1);
    const cy =
      lerp(p.altitudeMin, p.altitudeMax, cellRng()) * (1 - shape.baseDrop);
    const count =
      p.stormCellLobesMin +
      Math.floor(cellRng() * (p.stormCellLobesMax - p.stormCellLobesMin + 1));
    clusters.push({
      x: cell.x,
      y: cy,
      z: cell.z,
      radius: cr,
      storm,
      base: cy,
      cell: { i: cell.i, j: cell.j },
      lobes: buildLobes(cellRng, p, shape, cell.x, cy, cell.z, cr, count, storm),
    });
  }

  for (let c = 0; c < p.clusterCount; c++) {
    // -- rng block A: the SITE. Storm-independent by construction, so a cell
    // drifting over a cluster never moves it (and never moves it out of the
    // cell, which would be a feedback loop).
    const angle = rng() * Math.PI * 2;
    // SQRT, not a straight lerp: a straight lerp is uniform in RADIUS, and the
    // area of an annulus grows with radius, so it piles clusters into the near
    // ring — measured on the shipped layout, all 11 sat inside 2.6 km with a
    // mean angular width of 27.7° and the largest at 50.2°, i.e. a field of
    // boulders directly over the player's head. sqrt(u) is uniform per unit
    // AREA, which is how cloud is actually distributed over a sea, and it is
    // what puts small banks near the horizon where the references keep them.
    // Still exactly one rng() call, so lobe identity across storm-field drift
    // is unaffected (see the header note on the rng stream).
    const dist = lerp(p.ringInner, p.ringOuter, Math.sqrt(rng()));
    const cx = Math.cos(angle) * dist;
    const cz = Math.sin(angle) * dist;
    const cy0 = lerp(p.altitudeMin, p.altitudeMax, rng());
    const cr0 = lerp(p.clusterRadiusMin, p.clusterRadiusMax, rng());
    const count = p.lobesMin + Math.floor(rng() * (p.lobesMax - p.lobesMin + 1));

    // -- the field decides what KIND of cloud stands on that site
    const storm = clamp01(sampleStorm(cx, cz));
    const shape = clusterShapeAt(p, storm);
    const cr = cr0 * shape.radiusScale;
    const cy = cy0 * (1 - shape.baseDrop);

    clusters.push({
      x: cx,
      y: cy,
      z: cz,
      radius: cr,
      storm,
      base: cy,
      cell: null,
      // -- rng block B: the LOBES. Same call count and same order at every
      // storm level (see the header note) — lobe i keeps its identity as
      // cells drift.
      lobes: buildLobes(rng, p, shape, cx, cy, cz, cr, count, storm),
    });
  }
  return clusters;
}

/**
 * The lobe cloud of ONE cluster. Shared verbatim by the ring clusters and the
 * §V.63 cell-anchored storm clusters — the difference between fair weather and
 * a squall is entirely in `shape` and `cr` (§V7: storm is a set of numbers, not
 * a branch), and having two copies of this loop is how they would stop being.
 *
 * `rng` is the caller's stream; the call COUNT is fixed at 6 per lobe and does
 * not depend on `storm`, which is what preserves lobe identity across a
 * regeneration (see the file header).
 */
function buildLobes(
  rng: () => number,
  p: CloudParams,
  shape: ClusterShape,
  cx: number,
  cy: number,
  cz: number,
  cr: number,
  count: number,
  storm: number,
): CloudLobe[] {
  const horiz = cr * p.clusterFlatten;
  const vert = cr * shape.clusterHeight;
  const lobes: CloudLobe[] = [];
  for (let i = 0; i < count; i++) {
    const a = rng() * Math.PI * 2;
    // heightBias > 1 packs lobes toward the base (cumulus); 1 spreads them
    // evenly up a storm column
    const h = Math.pow(rng(), shape.heightBias);
    const profile = silhouetteRadius(h, shape);
    // THE COMMENT HERE USED TO SAY "rng^0.6 is centre-biased" AND IT WAS
    // BACKWARDS. An exponent BELOW 1 pushes a uniform sample UP — pow(0.5,
    // 0.6) = 0.66 — so 0.6 is very nearly sqrt(u), i.e. uniform over the
    // disc's AREA, which spreads lobes evenly to the rim. That is why a
    // cluster read as a handful of separate potatoes rather than one mass:
    // the lobes were laid out to cover the footprint, not to overlap in it.
    // Above 1 biases toward the centre, which is what packs a cumulus.
    const rN = Math.pow(rng(), p.lobePacking);
    const px = Math.cos(a) * rN * profile * horiz;
    const py = h * vert;
    const pz = Math.sin(a) * rN * profile * horiz;
    const len = Math.hypot(px, py, pz);
    // lobe size as a FRACTION of the cluster (no metre-scale magic number),
    // shrinking with height so the mass tapers into cauliflower at the top
    const size =
      lerp(p.lobeScaleMin, p.lobeScaleMax, rng()) * cr * shape.lobeScale * (1 - 0.4 * h);
    lobes.push({
      x: cx + px,
      y: cy + py,
      z: cz + pz,
      radius: size,
      // slight per-axis anisotropy so the union never reads as stacked balls
      rx: size * lerp(0.9, 1.25, rng()),
      ry: size * p.lobeOblate,
      rz: size * lerp(0.9, 1.25, rng()),
      seed: rng(),
      heightN: h,
      dirX: len > 1e-6 ? px / len : 0,
      dirY: len > 1e-6 ? py / len : 1,
      dirZ: len > 1e-6 ? pz / len : 0,
      // buried = near the axis AND low down; that underside is the part a
      // real cumulus keeps in its own shadow
      interior: Math.min(1, Math.max(0, (1 - rN * 0.6) * (1 - h))),
      storm,
    });
  }
  return lobes;
}

/**
 * Quantised fingerprint of the field under a set of cluster SITES. The field
 * drifts continuously; without this the lobe set would be regenerated every
 * frame forever. Cluster sites are storm-independent, so sampling the cached
 * cluster list is exact, not an approximation.
 */
export function stormFieldKey(
  clusters: CloudCluster[],
  sampleStorm: StormSampler,
  steps: number,
): string {
  const n = Math.max(1, Math.floor(steps) || 1);
  let key = '';
  for (const c of clusters) key += `${Math.round(clamp01(sampleStorm(c.x, c.z)) * n)}|`;
  return key;
}

/**
 * Quantised fingerprint of the CELL SET around the viewer (§V.63). The
 * companion to `stormFieldKey`, and it has to be a second key rather than an
 * extension of that one: the ring keys off a fixed set of sites and only their
 * strengths move, whereas cells APPEAR and DISAPPEAR as the ship sails, so the
 * identity of the set is itself part of the key.
 *
 * Amplitude is quantised on the same `stormQuantSteps` grid for the same
 * reason: a cell breathing on its lifecycle moves continuously and would
 * otherwise rebuild every lobe in the sky on every frame forever.
 */
export function stormCellKey(
  cells: readonly StormCellSite[],
  steps: number,
): string {
  const n = Math.max(1, Math.floor(steps) || 1);
  let key = '';
  for (const c of cells) key += `${c.i},${c.j}:${Math.round(clamp01(c.amp) * n)}|`;
  return key;
}

/**
 * The nearest cell-anchored storm clusters to (x, z), strongest-eligible
 * first, as rain-shaft slots (§V.63).
 *
 * Read off the CLUSTERS, not off the cell list, and that is the point: a shaft
 * is only ever emitted for a cloud that is actually being drawn, at that
 * cloud's own footprint and its own base altitude. There is no way to get a
 * shaft hanging out of clear sky, or hanging from the wrong height, without
 * the cloud being wrong first.
 */
export function shaftSlots(
  clusters: readonly CloudCluster[],
  x: number,
  z: number,
  count: number,
  out: ShaftSlot[],
): ShaftSlot[] {
  const n = Math.max(Math.floor(count) || 0, 0);
  out.length = 0;
  if (n === 0) return out;
  for (const c of clusters) {
    if (!c.cell || c.storm <= 0) continue;
    out.push({ x: c.x, z: c.z, radius: c.radius, base: c.base, strength: c.storm });
  }
  // nearest first — the shaft slots are a scarce, unrolled resource, so they
  // go to the squalls the player can actually see the shape of
  out.sort(
    (a, b) =>
      (a.x - x) * (a.x - x) +
      (a.z - z) * (a.z - z) -
      ((b.x - x) * (b.x - x) + (b.z - z) * (b.z - z)),
  );
  out.length = Math.min(out.length, n);
  return out;
}

/** Total lobe count a cluster list would draw. */
export function countLobes(clusters: CloudCluster[]): number {
  let n = 0;
  for (const c of clusters) n += c.lobes.length;
  return n;
}

/**
 * Instanced polygonal lobes + their fluff billboards, both writing the packed
 * 4-channel core RT. Instance buffers are allocated once at `p.maxLobes`
 * capacity (§V28: buffer sizes are sanitized construction-time ints) and
 * refilled in place by `rebuild()` when a layout param moves.
 */
export function createCloudCores(clusters: CloudCluster[], p: CloudParams) {
  const capacity = Math.max(1, Math.floor(p.maxLobes) || 1);

  const offsets = new Float32Array(capacity * 3);
  const radii = new Float32Array(capacity * 3);
  const dirs = new Float32Array(capacity * 3);
  const scales = new Float32Array(capacity);
  const seeds = new Float32Array(capacity);
  const heights = new Float32Array(capacity);
  const interiors = new Float32Array(capacity);
  const storms = new Float32Array(capacity);

  const offsetAttr = new THREE.InstancedBufferAttribute(offsets, 3);
  const radiusAttr = new THREE.InstancedBufferAttribute(radii, 3);
  const dirAttr = new THREE.InstancedBufferAttribute(dirs, 3);
  const scaleAttr = new THREE.InstancedBufferAttribute(scales, 1);
  const seedAttr = new THREE.InstancedBufferAttribute(seeds, 1);
  const heightAttr = new THREE.InstancedBufferAttribute(heights, 1);
  const interiorAttr = new THREE.InstancedBufferAttribute(interiors, 1);
  const stormAttr = new THREE.InstancedBufferAttribute(storms, 1);
  const allAttrs = [
    offsetAttr,
    radiusAttr,
    dirAttr,
    scaleAttr,
    seedAttr,
    heightAttr,
    interiorAttr,
    stormAttr,
  ];

  let lobeCount = 0;
  let overflowed = false;

  function fill(list: CloudCluster[]): void {
    const flat = list.flatMap((c) => c.lobes);
    const n = Math.min(flat.length, capacity);
    if (flat.length > capacity && !overflowed) {
      // §V8 fail loud: silently dropping cloud lobes would look like a tuning
      // problem forever. Warn once, then keep rendering what fits.
      overflowed = true;
      console.warn(
        `[clouds] ${flat.length} lobes requested but capacity is ${capacity} ` +
          `(cloudParams.maxLobes) — extra lobes dropped. Raise maxLobes and reload.`,
      );
    }
    for (let i = 0; i < n; i++) {
      const l = flat[i];
      offsets[i * 3 + 0] = l.x;
      offsets[i * 3 + 1] = l.y;
      offsets[i * 3 + 2] = l.z;
      radii[i * 3 + 0] = l.rx;
      radii[i * 3 + 1] = l.ry;
      radii[i * 3 + 2] = l.rz;
      dirs[i * 3 + 0] = l.dirX;
      dirs[i * 3 + 1] = l.dirY;
      dirs[i * 3 + 2] = l.dirZ;
      scales[i] = l.radius * 2; // sprite geometry is a unit quad → diameter
      seeds[i] = l.seed;
      heights[i] = l.heightN;
      interiors[i] = l.interior;
      storms[i] = l.storm;
    }
    lobeCount = n;
    for (const a of allAttrs) a.needsUpdate = true;
  }

  fill(clusters);

  // -- shared uniforms -------------------------------------------------------
  const uSunWorld = uniform(new THREE.Vector3(0, 1, 0));
  const uSunView = uniform(new THREE.Vector3(0, 1, 0));
  const uUpView = uniform(new THREE.Vector3(0, 1, 0));
  const uCoverage = uniform(p.coverage);
  const uMaxDist = uniform(p.maxCloudDist);
  const uRelief = uniform(p.lobeRelief);
  const uReliefScale = uniform(p.lobeReliefScale);
  const uChordPower = uniform(p.lobeChordPower);
  const uLobeDensity = uniform(p.lobeDensity);
  const uSunPower = uniform(p.sunPower);
  const uSunSideGain = uniform(p.sunSideGain);
  const uSelfShadow = uniform(p.selfShadow);
  const uSilver = uniform(p.silverLining);
  const uSkyMin = uniform(p.skyMin);
  const uSkyMax = uniform(p.skyMax);
  const uMultiScatter = uniform(p.multiScatterFloor);
  const uBaseGlow = uniform(p.baseGlow);
  const uBaseGlowSpan = uniform(p.baseGlowLowSun);
  const uStormSunCut = uniform(p.stormSunCut);
  const uStormSkyCut = uniform(p.stormSkyCut);
  const uStormBaseDark = uniform(p.stormBaseDark);
  const uFluffScale = uniform(p.fluffScale);
  const uFluffAlpha = uniform(p.fluffAlpha);
  const uFluffPower = uniform(p.fluffPower);
  const uFluffHollow = uniform(p.fluffHollow);
  const uFluffRing = uniform(p.fluffRing);
  const uFluffTopSharp = uniform(p.fluffTopSharp);
  const uFluffSunSharp = uniform(p.fluffSunSharp);
  const uFluffVary = uniform(p.fluffScaleVary);

  // -- shared instance attribute nodes ---------------------------------------
  const iOffset = instancedBufferAttribute(offsetAttr, 'vec3');
  const iRadius = instancedBufferAttribute(radiusAttr, 'vec3');
  const iDir = instancedBufferAttribute(dirAttr, 'vec3');
  const iSeed = instancedBufferAttribute(seedAttr, 'float');
  const iHeight = instancedBufferAttribute(heightAttr, 'float');
  const iInterior = instancedBufferAttribute(interiorAttr, 'float');
  const iStorm = instancedBufferAttribute(stormAttr, 'float');

  /**
   * A storm cluster is DARKER and FLATTER-LIT than its fair-weather
   * neighbours in the same sky. Both are multiplicative attenuations of light
   * arriving, never negative addends (§V44), and each is bounded at source by
   * clamping the CUT, not the product. Cutting the sun much harder than the
   * sky is what makes the storm mass go cool grey rather than black — and it
   * shifts the composite's `sunColor*R + skyColor*G` mix toward skyColor for
   * that cluster, so per-cluster colour falls out of the existing 4-channel
   * pack with no extra uniform and no pipeline change.
   */
  const stormSunFactor = (st: N): N =>
    float(1).sub(uStormSunCut.clamp(0, 1).mul(st.clamp(0, 1)));
  const stormSkyFactor = (st: N): N =>
    float(1).sub(uStormSkyCut.clamp(0, 1).mul(st.clamp(0, 1)));

  /**
   * THE DARK BASE (§V.63) — the strongest single cue that a cloud is about to
   * rain on you, and the one thing the two cuts above cannot give.
   *
   * They are whole-cluster: they take the same fraction off the anvil top as
   * off the underside, so a storm cluster gets uniformly dimmer and reads as a
   * grey cumulus rather than as a threatening one. What actually happens in a
   * cumulonimbus is a GRADIENT — it is optically thick enough that essentially
   * all the light that enters the top is scattered back out of the top, so the
   * base is lit only by what leaks through kilometres of water, while the anvil
   * stays brilliant white. That top-to-bottom contrast IS the storm.
   *
   * Applied to BOTH channels, unlike the cuts (which deliberately spare the sky
   * term so a squall goes cool grey rather than black): an underside is dark
   * because no light of any colour reaches it, so darkening only the sun term
   * would tip the base blue.
   *
   * §V44 bounded at source — the CUT is clamped, not the product, and the two
   * weights are independently in [0,1], so the factor cannot leave [1-cut, 1].
   */
  const stormBaseFactor = (st: N, heightN: N): N =>
    float(1).sub(
      uStormBaseDark.clamp(0, 1).mul(st.clamp(0, 1)).mul(heightN.clamp(0, 1).oneMinus()),
    );

  /** normalized view distance of an instance centre (RT alpha channel) */
  const depthOf = (centre: N): N =>
    modelViewMatrix.mul(vec4(centre, 1)).xyz.length().div(uMaxDist.max(1)).clamp(0, 1);

  /** cluster-level gradient: lobes on the sun side of their cluster get more */
  const sunSide = iDir.dot(uSunWorld).mul(0.5).add(0.5);

  /**
   * MULTIPLE SCATTERING, as a floor on the PRODUCT of the direct-light
   * attenuations — and it has to be the product, not the terms.
   *
   * Measured against the shipped params at the §T.39 sunset, a lobe buried in
   * a cluster and facing away and down took `wrapDiffuse 0.23 × sideTerm 0.2 ×
   * selfShadow 0.18` and arrived at 1.8% OF THE KEY. Every one of those three
   * is defensible alone — that is §V.56's shape — and lowering any one of them
   * flattens the clouds in a different direction: `skyMin` kills the
   * top-to-bottom ambient ramp, `selfShadow` kills the sense of a cluster
   * having an inside, `sunSideGain` kills the whole-mass gradient that makes a
   * cluster read as one object. So the cure is a floor on what they multiply
   * OUT to, which touches nothing at the lit end: at direct 0.95 this returns
   * 0.966, and at direct 0.018 it returns 0.28.
   *
   * IT IS NOT A FUDGE, it is the term the model is missing. A cumulus is
   * optically thick and highly forward-scattering, so photons entering the
   * sunlit face random-walk through it and leave in every direction; measured
   * cloud-base reflectance runs 30-60% of the top, which is why a real cumulus
   * base is grey-white and not black. Every other light path in this system is
   * single-scattering: the wrapped diffuse is direct light on a surface, and
   * the composite's transmission term is gated on `pow(dot(view,sun),8)` (half
   * power at 19°) TIMES `exp(-transDepth·coverage)` (dead by coverage 3-6, i.e.
   * everywhere inside a cluster), so beyond ~20° from the sun there is
   * currently no transmitted path AT ALL. This floor is that path's isotropic
   * component, which is the part that does not depend on where you stand.
   */
  const multiScattered = (direct: N): N =>
    mix(uMultiScatter.clamp(0, 1), float(1), direct.clamp(0, 1));

  /**
   * WARM UPLIGHT ON THE BASES at low sun. When the sun is near the horizon its
   * light passes UNDER the cloud deck and lights the bases, which is why a
   * sunset cumulus has a glowing underside and is the single most recognisable
   * thing about the reference frames. It rides the SUNLIGHT channel rather
   * than needing a third colour slot, and that is physically the right slot,
   * not a saving: this light IS the low sun's own reddened light, and
   * `sunColor` is already the haze-warmed key (cloudPalette.ts keeps the haze
   * for exactly these two jobs).
   *
   * §V44: an ADDITIVE term into a light channel, so bounded at source — the
   * gain is clamped, the low-key weight and the down-facing weight are both
   * clamped to [0,1], and it is applied only where the direct terms are small by
   * construction (a face pointing down at a low sun cannot also be facing it).
   */
  const lowKey = float(1)
    .sub(uSunWorld.y.abs().div(uBaseGlowSpan.max(1e-3)))
    .clamp(0, 1);
  const baseGlowAt = (downFace: N): N =>
    uBaseGlow.clamp(0, 2).mul(lowKey).mul(downFace.clamp(0, 1));

  // == polygonal lobes =======================================================
  const detail = Math.max(0, Math.min(3, Math.floor(p.lobeDetail) || 0));
  const base = new THREE.IcosahedronGeometry(1, detail);
  const lobeGeo = new THREE.InstancedBufferGeometry();
  // normal/uv are carried even though the shader derives its own normal:
  // NodeMaterial still builds the default lighting flow before `outputNode`
  // replaces it, and a missing attribute there is a silent fallback. WebGPU
  // only binds attributes the compiled shader actually reads, so unused ones
  // cost nothing. `base` is intentionally NOT disposed — lobeGeo shares its
  // BufferAttributes and lobeGeo.dispose() releases them.
  for (const name of ['position', 'normal', 'uv'] as const) {
    const attr = base.getAttribute(name);
    if (attr) lobeGeo.setAttribute(name, attr);
  }
  if (base.index) lobeGeo.setIndex(base.index);
  lobeGeo.instanceCount = lobeCount;

  const lobeMat = new THREE.MeshBasicNodeMaterial();

  // unit sphere direction; on a radius-1 icosphere the position IS the normal
  const unit = positionGeometry.normalize();
  // per-lobe noise offset — without it every lobe would be the same rock
  const nSeed = vec3(iSeed.mul(23.1), iSeed.mul(51.7), iSeed.mul(9.4));
  /**
   * Radial displacement factor at a unit direction. Two octaves: the first
   * carves the big bulges that make the silhouette, the second the smaller
   * cauliflower bumps. mx_noise_float is roughly [-1,1], so the factor stays
   * inside [1 - 1.45*relief, 1 + 1.45*relief] — bounded at source (§V44),
   * and lobeRelief is capped at 0.6 on the panel, so it can never invert.
   */
  const reliefAt = (d: N): N =>
    mx_noise_float(d.mul(uReliefScale).add(nSeed))
      .add(mx_noise_float(d.mul(uReliefScale.mul(2.7)).add(nSeed).add(11.3)).mul(0.45))
      .mul(uRelief)
      .add(1);

  // finite-difference normal needs two directions that are never parallel to
  // `unit`; cross with Y degenerates at the poles, so fall back to X there
  const tanA = unit.cross(vec3(0, 1, 0));
  const tanB = unit.cross(vec3(1, 0, 0));
  const tangent = select(tanA.dot(tanA).greaterThan(0.01), tanA, tanB).normalize();
  const bitangent = unit.cross(tangent); // |unit|=|tangent|=1, orthogonal → unit length

  const FD = float(0.12);
  const dC = unit;
  const dT = unit.add(tangent.mul(FD)).normalize();
  const dB = unit.add(bitangent.mul(FD)).normalize();
  const pC = dC.mul(reliefAt(dC));
  const pT = dT.mul(reliefAt(dT));
  const pB = dB.mul(reliefAt(dB));
  // cross(tangent, bitangent) === unit, so this cross points outward
  const nLocal = pT.sub(pC).cross(pB.sub(pC)).normalize();

  const lobeWorld = iOffset.add(pC.mul(iRadius));
  // an ellipsoid's normal transforms by the INVERSE scale (§V28 floored)
  const nWorld = nLocal.div(iRadius.max(1e-3)).normalize();
  // The SMOOTH normal of the undisplaced ellipsoid — the lobe's gross form
  // with the cauliflower taken off. Only the rim feather uses it; see below.
  const nSmoothWorld = unit.div(iRadius.max(1e-3)).normalize();

  lobeMat.positionNode = lobeWorld;

  const vNormal = varying(nWorld, 'vCloudNormal');
  const vSmoothNormal = varying(nSmoothWorld, 'vCloudSmoothNormal');
  const vWorld = varying(lobeWorld, 'vCloudWorld');
  const vDepth = varying(depthOf(iOffset), 'vCloudDepth');
  const vHeight = varying(iHeight, 'vCloudHeight');
  const vInterior = varying(iInterior, 'vCloudInterior');
  const vSunSide = varying(sunSide, 'vCloudSunSide');
  const vStorm = varying(iStorm, 'vCloudStorm');

  const N = vNormal.normalize();
  const V = cameraPosition.sub(vWorld).normalize();
  /**
   * THE OPTICAL CHORD (§V11b). `|N·V|` at the smooth ellipsoid is exactly
   * `sqrt(1 - u²)` at projected radius fraction `u`, i.e. HALF THE CHORD a
   * view ray cuts through a sphere of uniform density. So `density ∝ |N·V|`
   * is not a softness knob — it is the optical depth of the volume the lobe
   * stands for, and `lobeChordPower` 1 is the physical answer.
   *
   * WHAT THIS REPLACES AND WHY, MEASURED. It used to be
   * `smoothstep(0, rimSoftness=0.42, |N·V|)`, which SATURATES at |N·V| ≥ 0.42,
   * i.e. at u ≤ 0.907. That made a lobe a TOP-HAT, not a falloff:
   *   - 92% of the projected disc area sat at ≥90% of peak alpha;
   *   - the 90%→10% feather was 0.041 lobe radii = 0.42 RT PIXELS, against a
   *     blurRadiusFar of 1.0 px.
   * A sphere drawn as a hard disc is a disc, and that single fact produced
   * every symptom in the "small clouds look like small explosions" report
   * (user 2026-08-18): too circular, too sharp, and — via the coverage-
   * weighted colour average, which swings wherever a lobe's α falls off a
   * cliff — "you can count the spheres". MEASURED at the interior rims of a
   * large cluster: 22.8% of them carried a visible tonal step (>0.02), p90
   * 0.033, p99 0.071. The chord profile takes that to 15.6%.
   *
   * TWO THINGS THIS IS *NOT*, both checked before landing:
   *  - it is NOT §V.63's "lobes barely overlap" defect (`27a0795`, islands).
   *    Median nearest-neighbour penetration here is 1.43× the SMALLER lobe
   *    radius and only 6.1% of lobes have no overlapping neighbour — they
   *    overlap almost concentrically. There was nothing wrong with the union;
   *    there was nothing for it to union, because each input was binary.
   *  - the composite operator is NOT additive-in-colour. Opacity is evaluated
   *    ONCE on accumulated density (`alpha = f(Σα)`), which is correct, and an
   *    unordered coverage-weighted colour average measures only 1.09× rougher
   *    than true front-to-back occlusion (mean difference 0.0315). The
   *    "additive" read was this cliff, not the blend.
   *
   * THE SMOOTH NORMAL, NOT THE BUMPY ONE — this was "strange holes and
   * ripped-off segments that don't really look right" (user 2026-08-12).
   * `vNormal` is a finite-difference normal of the RELIEF-DISPLACED surface,
   * and at lobeRelief 0.26 / reliefScale 2.3 its slopes swing far enough that
   * |N·V| passes through 0 in the MIDDLE of a lobe's projected disc, not just
   * at its outline. Confirmed by A/B: lobeRelief 0 removes every hole. An
   * optical depth is a property of the GROSS FORM — it must not follow bumps.
   * The displaced normal keeps doing all the LIGHTING below, which is what the
   * cauliflower is for.
   */
  const chord = vSmoothNormal.normalize().dot(V).abs();
  const rim = chord.pow(uChordPower.max(0.05));
  /**
   * ...and the lobe is a VOLUME ELEMENT, not a near-opaque disc. `lobeDensity`
   * is what lets optical depth ACCUMULATE ACROSS lobes instead of saturating
   * inside one: at the old density a single lobe already reached alpha 0.80,
   * so a union of 35 of them could only ever TILE — the second lobe along a
   * ray had nothing left to contribute. Total optical depth is conserved by
   * the exponential below (a cluster interior still runs 0.9+), while ONE lobe
   * now lands near 0.3 and two overlapping ones near 0.6.
   *
   * WHY NOT `coverage`: the weather presets drive `clouds.coverage` (0.8 clear,
   * 1.0 storm), so folding this into it would be overwritten on the next preset
   * apply. `coverage` keeps its meaning as the preset's relative density knob
   * and this is the absolute scale underneath it.
   */
  const lobeAlpha = rim.mul(uCoverage).mul(uLobeDensity.max(0)).clamp(0, 1);

  // every factor below is independently in [0,1] (or [1, 1+silver]) and they
  // are MULTIPLIED, so the product is bounded at source (§V44)
  const wrapDiffuse = N.dot(uSunWorld).mul(0.5).add(0.5).clamp(0, 1).pow(uSunPower.max(0.05));
  // §V44 "bounded AT SOURCE": clamp the gain, not the product it feeds
  const sideGain = uSunSideGain.clamp(0, 1);
  const sideTerm = mix(float(1).sub(sideGain), float(1), vSunSide);
  const selfShadow = mix(float(1), uSelfShadow, vInterior.clamp(0, 1));
  // silver lining: rim brightening when the sun is BEHIND the cloud. Expressed
  // as a multiplier ≥1, never as an addend into an already-summed channel.
  const backLit = uSunWorld.dot(V.negate()).clamp(0, 1).pow(6);
  const silver = backLit.mul(rim.oneMinus()).mul(uSilver).add(1);
  // the three DIRECT attenuations, floored as a product — see multiScattered().
  // The storm cut stays OUTSIDE the floor on purpose: a squall must still be
  // able to go dark, and it is a property of the cloud, not of the light path.
  const direct = wrapDiffuse.mul(sideTerm).mul(selfShadow);
  const lobeSun = multiScattered(direct)
    .mul(silver)
    .mul(stormSunFactor(vStorm))
    .mul(stormBaseFactor(vStorm, vHeight))
    .add(baseGlowAt(N.dot(vec3(0, 1, 0)).negate()))
    .clamp(0, 2);

  const skyFace = N.dot(vec3(0, 1, 0)).mul(0.5).add(0.5).clamp(0, 1);
  const heightLift = mix(float(0.85), float(1), vHeight.clamp(0, 1));
  const lobeSky = mix(uSkyMin, uSkyMax, skyFace)
    .mul(heightLift)
    .mul(stormSkyFactor(vStorm))
    .mul(stormBaseFactor(vStorm, vHeight))
    .clamp(0, 2);

  lobeMat.outputNode = vec4(
    lobeSun.mul(lobeAlpha),
    lobeSky.mul(lobeAlpha),
    lobeAlpha,
    vDepth.mul(lobeAlpha),
  );
  applyPackedBlending(lobeMat);

  const lobeMesh = new THREE.Mesh(lobeGeo, lobeMat);
  lobeMesh.frustumCulled = false;

  // == fluff billboards ======================================================
  // Deliberately dumb: no normals, no self-shadow. Their whole job is to blur
  // the polygonal rim, and giving them their own lighting model would fight
  // the lobes underneath.
  //
  // THE SPRITE MUST OVERHANG THE LOBE OR IT DOES NOTHING. A sprite of radius
  // `fluffScale` mean-radii against a lobe whose projected radius reaches
  // rx*(1+1.45*relief) mean radii is entirely interior below fluffScale~1.7,
  // and its own falloff has already decayed to ~5% by then. That is exactly
  // where this sat, so the "soft edge" layer was drawing full fill cost and
  // feathering nothing. See the §V11b overhang test in tests/clouds.test.ts.
  const fluffMat = new THREE.SpriteNodeMaterial();
  fluffMat.positionNode = iOffset;
  // per-lobe radius jitter, decorrelated from the alpha use of iSeed below, so
  // the feather is PATCHY along a silhouette rather than a uniform halo
  const fluffJitter = iSeed.mul(7.31).add(0.137).fract();
  // scale via a UNIFORM, not baked into the attribute: a baked fluffScale
  // would only take effect on the next layout rebuild, i.e. silently never
  fluffMat.scaleNode = instancedBufferAttribute(scaleAttr, 'float')
    .mul(uFluffScale.max(0))
    .mul(
      mix(
        float(1).sub(uFluffVary.clamp(0, 0.9)),
        float(1).add(uFluffVary.clamp(0, 0.9)),
        fluffJitter,
      ),
    );

  const q = uv().mul(2).sub(1);
  const r2 = q.dot(q);
  const shape = r2.oneMinus().max(0);
  // hollow the centre: the fluff belongs at the RIM. A solid disc at the alpha
  // needed to feather a silhouette would also lay its flat fake-sphere shading
  // over the lobe's sculpted lighting and flatten the mass (§V11b).
  const hollow = mix(
    float(1).sub(uFluffHollow.clamp(0, 1)),
    float(1),
    smoothstep(float(0), uFluffRing.clamp(0.02, 1), r2),
  );
  // A cloud is not uniformly soft any more than it is uniformly sharp (user,
  // 2026-08-12). Convecting cauliflower tops and sunward shoulders keep their
  // crisp polygonal edge; the dissipating base and the shadow side get the
  // feather. Both factors are in [1-sharp, 1] and MULTIPLIED (§V44 bounded at
  // source — the cut is clamped, not the product).
  const fluffSharpen = mix(
    float(1),
    float(1).sub(uFluffTopSharp.clamp(0, 1)),
    iHeight.clamp(0, 1),
  ).mul(mix(float(1), float(1).sub(uFluffSunSharp.clamp(0, 1)), sunSide));
  const fluffAlpha = shape
    .pow(uFluffPower.max(0.1))
    .mul(hollow)
    .mul(fluffSharpen)
    .mul(iSeed.mul(0.4).add(0.6))
    .mul(uFluffAlpha)
    .mul(uCoverage)
    // the skirt rides the same absolute density scale as the lobe it feathers,
    // or the fluff would become the opaque part of a translucent cloud
    .mul(uLobeDensity.max(0))
    .clamp(0, 1);

  // fake-sphere normal on the billboard, view space
  const fluffN = vec3(q.x, q.y, shape.sqrt());
  // same floor and same uplight as the lobes: the fluff sits ON the rim of the
  // mass it feathers, so a fluff sprite that stayed dark would redraw the black
  // margin the floor just removed
  const fluffDirect = fluffN
    .dot(uSunView)
    .mul(0.5)
    .add(0.5)
    .clamp(0, 1)
    .pow(uSunPower.max(0.05))
    .mul(mix(float(1).sub(sideGain), float(1), sunSide));
  const fluffSun = multiScattered(fluffDirect)
    .mul(stormSunFactor(iStorm))
    .mul(stormBaseFactor(iStorm, iHeight))
    .add(baseGlowAt(fluffN.dot(uUpView).negate()))
    .clamp(0, 2);
  const fluffSky = mix(uSkyMin, uSkyMax, fluffN.dot(uUpView).mul(0.5).add(0.5).clamp(0, 1))
    .mul(mix(float(0.85), float(1), iHeight.clamp(0, 1)))
    .mul(stormSkyFactor(iStorm))
    .mul(stormBaseFactor(iStorm, iHeight))
    .clamp(0, 2);
  const fluffDepth = varying(depthOf(iOffset), 'vFluffDepth');

  fluffMat.outputNode = vec4(
    fluffSun.mul(fluffAlpha),
    fluffSky.mul(fluffAlpha),
    fluffAlpha,
    fluffDepth.mul(fluffAlpha),
  );
  applyPackedBlending(fluffMat);

  const fluff = new THREE.Sprite(fluffMat as unknown as THREE.SpriteMaterial);
  fluff.count = lobeCount;
  fluff.frustumCulled = false;

  const object = new THREE.Group();
  object.add(lobeMesh);
  object.add(fluff);
  object.frustumCulled = false;

  return {
    object,
    lobeMaterial: lobeMat,
    fluffMaterial: fluffMat,
    uSunWorld,
    uSunView,
    uUpView,
    uCoverage,
    uMaxDist,
    uRelief,
    uReliefScale,
    uChordPower,
    uLobeDensity,
    uSunPower,
    uSunSideGain,
    uSelfShadow,
    uSilver,
    uSkyMin,
    uSkyMax,
    uMultiScatter,
    uBaseGlow,
    uBaseGlowSpan,
    uStormSunCut,
    uStormSkyCut,
    uStormBaseDark,
    uFluffScale,
    uFluffAlpha,
    uFluffPower,
    uFluffHollow,
    uFluffRing,
    uFluffTopSharp,
    uFluffSunSharp,
    uFluffVary,
    get lobeCount(): number {
      return lobeCount;
    },
    /** refill instance buffers in place after a layout param moved (§V7) */
    rebuild(list: CloudCluster[]): void {
      fill(list);
      lobeGeo.instanceCount = lobeCount;
      fluff.count = lobeCount;
    },
    dispose(): void {
      lobeGeo.dispose();
      lobeMat.dispose();
      fluffMat.dispose();
    },
  };
}

export type CloudCores = ReturnType<typeof createCloudCores>;
