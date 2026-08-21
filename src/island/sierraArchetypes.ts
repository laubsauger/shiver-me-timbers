/**
 * Sierra archetypes (§T.99, §V90) — pure CPU, ZERO three imports.
 *
 * The pirate archetypes (archetypes.ts) are lists of radial features merged
 * with `smoothMax`, and that composition can say three things: "land rises
 * here", "a wall stands here", "nothing here". A flooded Sierra needs three
 * shapes that composition cannot express on its own:
 *
 *   dome         a glacial-polished granite crown with EXFOLIATION TERRACES —
 *                level slabs stepping down one flank. A step is a monotone
 *                remap of height, not a feature, so the dome owns its own
 *                `landAt` and quantises itself inside a seeded sector.
 *   drownedRidge a long narrow ridge along a seeded azimuth whose crest goes
 *                UNDER the water to leeward and keeps going as a shallow bank.
 *                Features can only add land, so the drowned section is a
 *                `shape` hook that pulls the field toward a negative target —
 *                the same one-directional guarantee `lagoonBasin` carries
 *                (never creates dry land). Along that bank `emitTreeline`
 *                marks where dead pines stand in the water.
 *   cirque       a half-ring of cliffs open to one side around a still
 *                lagoon. The ring IS expressible as features (an arc of ridge
 *                segments), so the interior reuses heightmap.ts's lagoon basin
 *                verbatim — `findBayBearing` finds the opening from the
 *                features and the basin sits inside the ring.
 *   halfDome     the `dome` crown with one face sheared off near-vertical —
 *                silhouette only, flagged unreachable by the site generator.
 *
 * The hook into the existing pipeline is ONE object (`SierraShape`): the
 * feature list (so bay scans and tests keep working), a `landAt` that replaces
 * `combineFeatures`, and an optional `shape` applied after the lagoon basin.
 * Coast noise, surface detail, the beach apron, the rim envelope and the peak
 * floor are the same code for every island, which is what keeps the DG-sand
 * beach continuous from the waterline (§V90) without a second apron.
 */
import { combineFeatures, type Feature } from './archetypes';
import { sierraParams, type SierraParams } from '../params/sierra';

export const SIERRA_ARCHETYPES = ['dome', 'drownedRidge', 'cirque', 'halfDome'] as const;
export type SierraArchetypeName = (typeof SIERRA_ARCHETYPES)[number];

/** the three a player can land on — what the slice is built from */
export const SIERRA_SLICE_ARCHETYPES = ['dome', 'drownedRidge', 'cirque'] as const;

export function isSierraArchetype(name: string): name is SierraArchetypeName {
  return (SIERRA_ARCHETYPES as readonly string[]).includes(name);
}

/** a dead pine standing in the water on the drowned crest, island-local */
export interface TreelineMarker {
  x: number;
  z: number;
  /** seabed height here (m, negative) — the trunk foot */
  floor: number;
}

export interface SierraMeta {
  name: SierraArchetypeName;
  /** seeded azimuth (rad): ridge axis, cirque opening, terraced flank, sheared face */
  axis: number;
  /** dome/halfDome: bearing of the terraced flank */
  terraceAzimuth: number;
  /** dome/halfDome: how many terrace steps were authored */
  terraceCount: number;
  /** drownedRidge: dead pines in the water (empty for the other families) */
  treeline: TreelineMarker[];
  /**
   * T112c: seeded ice-flow azimuth (rad). The erosion stage drags the form
   * along it (stoss upstream: polished and gentle; lee downstream: plucked
   * and steep). Drawn LAST from the rng so every earlier draw is unchanged.
   */
  iceAzimuth: number;
}

export interface SierraShape {
  features: Feature[];
  /** the landmass term — replaces `combineFeatures` for this island */
  landAt(x: number, z: number): number;
  /** post-basin shaping (the drowned crest); identity when absent */
  shape?(h: number, land: number, x: number, z: number): number;
  meta: Omit<SierraMeta, 'treeline'>;
  /** the family's peak (m) — the erosion stage's UPLIFT mask is landAt/peak */
  peak: number;
  /** drownedRidge: the axis segment the treeline is emitted along */
  treelineSegment?: { ax: number; az: number; bx: number; bz: number };
}

type Rng = () => number;
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smoothstep01 = (t: number): number => {
  const c = Math.min(Math.max(t, 0), 1);
  return c * c * (3 - 2 * c);
};
/** shortest signed angular difference */
const angleDelta = (a: number, b: number): number => {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

/** the peak a sierra family builds to, before the surface terms */
export function sierraPeak(
  name: SierraArchetypeName,
  rawPeak: number,
  p: SierraParams = sierraParams,
): number {
  switch (name) {
    case 'dome':
      return rawPeak * p.domeRelief;
    case 'drownedRidge':
      return rawPeak * p.ridgeRelief;
    case 'cirque':
      return rawPeak * p.cirqueRelief;
    case 'halfDome':
      // the silhouette island's peak is authored absolutely (it is ONE island
      // and it has to read from 3 km) — the raw peak is its floor
      return Math.max(rawPeak * p.domeRelief, p.halfDomePeak);
  }
}

/**
 * Glacial dome crown: `(1 − u²)^k`, k > 1. Flat on top (zero slope at the
 * summit) and TANGENTIAL at the foot (zero slope at u = 1), with the steepest
 * ground on the shoulder — which is both what a polished dome looks like and
 * what keeps the foot of the crown walkable (§V90). `1 − u^n` was tried first
 * and is the wrong shape: its steepest slope is AT the rim, i.e. a mesa.
 */
function crown(u: number, k: number): number {
  if (u >= 1) return 0;
  return Math.pow(1 - u * u, k);
}

/**
 * Exfoliation terraces: quantise height into `rise`-metre steps with a
 * smoothstep riser over the top `riser` fraction of each step. Monotone in h
 * (tread slope 0, riser slope ≥ 0), maps the band [h0, h0 + n·rise] onto
 * itself, identity outside it — so it never moves the shoreline and never
 * creates a new waterline crossing.
 */
export function terraceSteps(h: number, h0: number, n: number, rise: number, riser: number): number {
  const r = Math.max(rise, 1e-3); // §V28 floored divisor
  const top = h0 + n * r;
  if (h <= h0 || h >= top || n <= 0) return h;
  const k = (h - h0) / r;
  const step = Math.floor(k);
  const f = k - step;
  const rf = Math.min(Math.max(riser, 0.05), 0.95);
  const riserT = smoothstep01((f - (1 - rf)) / rf);
  return h0 + (step + riserT) * r;
}

function buildDome(
  rng: Rng,
  extent: number,
  peak: number,
  p: SierraParams,
  sheared: boolean,
): SierraShape {
  const axis = rng() * Math.PI * 2;
  const crownR = extent * lerp(0.92, 1.05, rng());
  // the crown is pushed slightly off-centre so the island is not a target
  const ox = Math.cos(axis + Math.PI) * extent * lerp(0.04, 0.12, rng());
  const oz = Math.sin(axis + Math.PI) * extent * lerp(0.04, 0.12, rng());
  const n = p.domeCrownPower;
  const terraceCount = Math.round(lerp(p.domeTerraceMin, p.domeTerraceMax, rng()));
  // the terrace band sits on the shoulder: its floor is a multiple of the
  // rise so the remap is continuous at the band edge
  const rise = p.domeTerraceRise;
  const bandFloor = Math.max(rise * Math.round((peak * lerp(0.3, 0.5, rng())) / rise), rise);
  const sector = p.domeTerraceSector;
  const faceDirX = Math.cos(axis);
  const faceDirZ = Math.sin(axis);
  const faceAt = p.halfDomeFaceOffset * extent;
  const faceW = Math.max(p.halfDomeFaceWidth * extent, 1e-3); // §V28 floored divisor
  // bookkeeping feature for the bay scan / debugging: one cone of the crown
  const features: Feature[] = [
    { kind: 'cone', x: ox, z: oz, radius: crownR, height: peak, power: 1 },
  ];
  return {
    features,
    meta: { name: sheared ? 'halfDome' : 'dome', axis, terraceAzimuth: axis, terraceCount, iceAzimuth: 0 },
    peak,
    landAt(x, z): number {
      const dx = x - ox;
      const dz = z - oz;
      const u = Math.hypot(dx, dz) / crownR;
      let h = peak * crown(u, n);
      if (!sheared) {
        // terraces on ONE flank: the sector weight fades over its own edge so
        // a step does not end in a wall at the sector boundary
        const bearing = Math.atan2(dz, dx);
        const w = 1 - smoothstep01((Math.abs(angleDelta(bearing, axis)) - sector * 0.6) / (sector * 0.4));
        if (w > 0) {
          const stepped = terraceSteps(h, bandFloor, terraceCount, rise, p.domeTerraceRiser);
          h = h + (stepped - h) * w;
        }
      } else {
        // the sheared face: beyond a plane through the crown the height drops
        // to a scree fraction over `faceW` — near-vertical at 3 km, which is
        // all it is for
        const s = dx * faceDirX + dz * faceDirZ;
        const cut = smoothstep01((s - faceAt) / faceW);
        h = h * (1 - 0.82 * cut);
      }
      return h;
    },
  };
}

function buildDrownedRidge(
  rng: Rng,
  extent: number,
  peak: number,
  blend: number,
  p: SierraParams,
): SierraShape {
  const axis = rng() * Math.PI * 2;
  const ax = Math.cos(axis);
  const az = Math.sin(axis);
  const half = extent * p.ridgeLength * 0.5;
  // windward end at −half, leeward end at +half; the crest is a chain of
  // segments whose heights undulate and then taper to nothing past
  // `ridgeDrownStart`, where the `shape` hook takes over
  const segments = 7;
  const width = extent * p.ridgeWidth;
  const features: Feature[] = [];
  const undulation = p.ridgeUndulation;
  const phase = rng() * Math.PI * 2;
  for (let i = 0; i < segments; i++) {
    const t0 = i / segments;
    const t1 = (i + 1) / segments;
    const tm = (t0 + t1) * 0.5;
    const wave = 1 - undulation * (0.5 + 0.5 * Math.sin(tm * Math.PI * 3.1 + phase));
    const taper = 1 - smoothstep01((tm - p.ridgeDrownStart * 0.75) / (p.ridgeDrownStart * 0.3));
    // the windward end is the high end: a drowned ridge is a ridge that dips
    const lift = 0.55 + 0.45 * (1 - tm);
    const height = peak * wave * taper * lift;
    if (height <= 0) continue;
    features.push({
      kind: 'ridge',
      x: ax * lerp(-half, half, t0), z: az * lerp(-half, half, t0),
      x2: ax * lerp(-half, half, t1), z2: az * lerp(-half, half, t1),
      radius: width * lerp(0.85, 1.15, rng()),
      height,
      // concave flank: steep under the crest, long gentle foot — the foot is
      // where the DG-sand band has to be (§V90)
      power: 1.7,
    });
  }
  // an elongated low platform under the land half — NOT the pirate disc: a
  // round base is what makes every island read as a cone, and this family's
  // whole identity is its aspect ratio
  // (a ridge segment reaches `radius` past its endpoints, so the platform
  // stops a width short of where the crest goes under — measured with the
  // platform run out to the drown point it carried land 0.4·R past it)
  const drownFrom = p.ridgeDrownStart;
  const platformEnd = lerp(-half, half, drownFrom) - width * 1.2;
  features.unshift({
    kind: 'ridge',
    x: ax * -half * 0.9, z: az * -half * 0.9,
    x2: ax * platformEnd, z2: az * platformEnd,
    radius: width * 1.2,
    height: peak * 0.22,
    power: 1.1,
  });
  const leeDepth = p.ridgeLeeDepth;
  const bankW = Math.max(width * 0.9, 1e-3); // §V28 floored divisor
  return {
    features,
    meta: { name: 'drownedRidge', axis, terraceAzimuth: axis, terraceCount: 0, iceAzimuth: 0 },
    peak,
    // from just past the drown point to a little beyond the ridge's own end
    // — the bank keeps going under the rim envelope's reach
    treelineSegment: {
      ax: ax * lerp(-half, half, drownFrom + 0.12), az: az * lerp(-half, half, drownFrom + 0.12),
      bx: ax * half * 1.05, bz: az * half * 1.05,
    },
    landAt(x, z): number {
      return combineFeatures(features, x, z, blend);
    },
    shape(h, land, x, z): number {
      // along-axis parameter 0..1 from windward to leeward end
      const t = ((x * ax + z * az) / half + 1) * 0.5;
      // the bank starts only once the crest has already gone under (the
      // chain tapers out by ~drownFrom + 0.03): ramping it in OVER the tip
      // moved the shoreline up the crest and its own ramp became a 17° bank
      // exactly where the beach has to be (measured, seed 1965)
      if (t < drownFrom) return h;
      const lateral = Math.abs(-x * az + z * ax);
      const across = 1 - smoothstep01((lateral - bankW * 0.5) / bankW);
      const along = smoothstep01((t - drownFrom - 0.03) / 0.2) * (1 - smoothstep01((t - 1.05) / 0.12));
      // yields to the archetype's own land exactly as lagoonBasin does — over
      // a WIDE guard. The fade itself is a slope: the shoreline ends up where
      // the bank's pull and the crest's rise balance, and d(h)/d(land) there
      // carries a `(target − h)·guard′` term. Measured: guard 3 m → a 2 m
      // step (45° one metre above the water); 12 m → 18°; 24 m keeps the
      // crest's tip inside the §V90 beach grade.
      const guard = 1 - smoothstep01(land / 24);
      const w = across * along * guard;
      if (w <= 0) return h;
      // the bank shallows toward the old shore and deepens toward the tip
      const target = -leeDepth * (0.55 + 0.45 * smoothstep01((t - drownFrom) / (1 - drownFrom)));
      return h + (target - h) * w;
    },
  };
}

function buildCirque(
  rng: Rng,
  extent: number,
  peak: number,
  blend: number,
  p: SierraParams,
): SierraShape {
  // `axis` is the OPENING: the arc of cliffs is centred opposite it
  const axis = rng() * Math.PI * 2;
  const back = axis + Math.PI;
  const arc = p.cirqueArc;
  const ring = extent * p.cirqueRing;
  const n = 7;
  const features: Feature[] = [];
  // NO platform under the bowl: the interior has to be water for the basin
  // term to fire (it yields to the archetype's own land, lagoonBasin's
  // guard), so the ring's skirt is the only ground — wide, with a concave
  // profile (power > 1) so the outer flank is a long ramp: the §V90 clue path
  let prevX = 0;
  let prevZ = 0;
  for (let i = 0; i <= n; i++) {
    const a = back + (i / n - 0.5) * arc;
    const r = ring * lerp(0.92, 1.08, rng());
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (i > 0) {
      // the wall is tallest at the back of the bowl and falls off toward the
      // two horns framing the opening
      const mid = Math.abs(i - 0.5 - n / 2) / (n / 2);
      const height = peak * lerp(1, 0.45, mid * mid) * lerp(0.85, 1, rng());
      features.push({
        kind: 'ridge', x: prevX, z: prevZ, x2: x, z2: z,
        radius: extent * 0.46, height, power: 1.6,
      });
    }
    prevX = x;
    prevZ = z;
  }
  return {
    features,
    meta: { name: 'cirque', axis, terraceAzimuth: axis, terraceCount: 0, iceAzimuth: 0 },
    peak,
    landAt(x, z): number {
      // the ring's inner face is steepened by a smooth max against the
      // platform, the same operator the pirate features use
      return combineFeatures(features, x, z, blend);
    },
  };
}

/**
 * Open water inside the footprint is SUNK where the family puts no land.
 *
 * WHY. heightmap.ts lays coast noise over the whole footprint at absolute
 * amplitude (±4 m at the sierra budget), which on a pirate island is harmless
 * because the base disc carries every point above it. The sierra families
 * have no disc — the ridge's identity is its aspect ratio, the cirque's is
 * the water inside the ring — so without this term every footprint grew a
 * field of noise islets and measured, the drowned ridge's land mask came out
 * at aspect 1.08. Monotone in `land` (slope ≥ 1), so it moves no shoreline
 * the features own; it only takes the empty water down to a real seabed.
 */
// 10 m raw is ~5 m after the beach apron's band compression; the guard is
// wide so the sink's own slope (≤ 1.75× the feature's) stays gentle through
// the shore band — measured at guard 6 it was 2.25× and the beach came out
// at 45° one metre above the waterline
const SEABED_SINK = 10;
const SEABED_SINK_GUARD = 20;
function sinkOpenWater(land: number): number {
  return land - SEABED_SINK * (1 - smoothstep01(land / SEABED_SINK_GUARD));
}

export function buildSierraShape(
  name: SierraArchetypeName,
  rng: Rng,
  extent: number,
  rawPeak: number,
  blend: number,
  p: SierraParams = sierraParams,
): SierraShape {
  const peak = sierraPeak(name, rawPeak, p);
  let shape: SierraShape;
  switch (name) {
    case 'dome':
      shape = buildDome(rng, extent, peak, p, false);
      break;
    case 'halfDome':
      shape = buildDome(rng, extent, peak, p, true);
      break;
    case 'drownedRidge':
      shape = buildDrownedRidge(rng, extent, peak, blend, p);
      break;
    case 'cirque':
      shape = buildCirque(rng, extent, peak, blend, p);
      break;
  }
  const raw = shape.landAt;
  shape.landAt = (x, z) => sinkOpenWater(raw(x, z));
  // T112c: the ice vector, drawn after everything else so the family's own
  // draws (axis, offsets, terrace count) are byte-identical to pre-erosion
  shape.meta.iceAzimuth = rng() * Math.PI * 2;
  return shape;
}

/**
 * Dead pines along the drowned crest — sampled from the FINISHED heightmap
 * (after noise, apron, rim and the peak floor), never from the authored
 * target, so a marker is exactly where the water actually is that shallow.
 * Emitted every `treelineSpacing` metres where the floor is inside the depth
 * band; the trunk must stand in water (floor < 0) and its top must clear it.
 */
export function emitTreeline(
  heightAt: (x: number, z: number) => number,
  seg: { ax: number; az: number; bx: number; bz: number },
  p: SierraParams = sierraParams,
): TreelineMarker[] {
  const len = Math.hypot(seg.bx - seg.ax, seg.bz - seg.az);
  const spacing = Math.max(p.treelineSpacing, 1);
  const steps = Math.floor(len / spacing);
  const out: TreelineMarker[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i * spacing) / Math.max(len, 1e-3);
    const x = seg.ax + (seg.bx - seg.ax) * t;
    const z = seg.az + (seg.bz - seg.az) * t;
    const floor = heightAt(x, z);
    const depth = -floor;
    if (depth < p.treelineDepthMin || depth > p.treelineDepthMax) continue;
    out.push({ x, z, floor });
  }
  return out;
}
