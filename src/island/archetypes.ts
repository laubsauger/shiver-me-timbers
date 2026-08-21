/**
 * Island archetypes (§V43, T33 rewrite) — pure CPU, ZERO three imports.
 *
 * WHY THIS REPLACES THE NOISE FIELD. The old shape was
 * `pow(max(1−d²,0), falloffPower) × fbm`: radially symmetric BY CONSTRUCTION,
 * so no amount of tuning could ever produce a distinct silhouette. Measured,
 * five islands came out with peak/radius 0.149–0.198 and mean slope 18–20° —
 * statistically the same gentle dome at five sizes. Sea of Thieves islands are
 * identifiable from kilometres out and each is different: a flat-topped cliff
 * with a notch, a multi-spire fortress rock, an asymmetric shark-fin peak.
 * That is authored composition, not a sampled field.
 *
 * So an island is now a short list of FEATURES — cones, mesas, ridges — placed
 * by an ARCHETYPE recipe and merged with a smooth max. The archetype fixes the
 * silhouette family ("the one with the spine"); the seed varies everything
 * inside it. Archetype is data, so adding one is a recipe, not a new code path.
 *
 * The features carry the LANDMASS. Coastline shape is a separate concern and
 * deliberately not their job — see heightmap.ts, where noise is applied at
 * absolute amplitude out where the features have already died away. Scaling
 * noise BY the old dome zeroed it exactly at the rim, which is precisely where
 * coastline lives, and measured a shore-radius variation of only 10–16%.
 */

import type { SierraArchetypeName } from './sierraArchetypes';

/** one height contribution in island-local metres */
export interface Feature {
  kind: 'cone' | 'mesa' | 'ridge' | 'sheer';
  /** centre (cone/mesa) or segment start (ridge), island-local metres */
  x: number;
  z: number;
  /** ridge segment end */
  x2?: number;
  z2?: number;
  /** footprint radius (cone/mesa) or half-width (ridge), metres */
  radius: number;
  /** peak contribution, metres above the waterline */
  height: number;
  /** profile exponent: <1 domed, 1 conical, >1 spiky with flared skirts */
  power: number;
  /** mesa only: width of the cliff band inside `radius` */
  edge?: number;
}

/** distance from p to segment ab */
function segmentDistance(
  px: number, pz: number, ax: number, az: number, bx: number, bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 < 1e-9 ? 0 : Math.min(Math.max(((px - ax) * dx + (pz - az) * dz) / len2, 0), 1);
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

const smoothstep01 = (t: number): number => {
  const c = Math.min(Math.max(t, 0), 1);
  return c * c * (3 - 2 * c);
};

/** height a single feature contributes at an island-local point */
export function featureHeight(f: Feature, x: number, z: number): number {
  const r = Math.max(f.radius, 1e-3); // §V28 floored divisor
  if (f.kind === 'ridge') {
    const d = segmentDistance(x, z, f.x, f.z, f.x2 ?? f.x, f.z2 ?? f.z);
    return f.height * Math.pow(Math.max(1 - d / r, 0), f.power);
  }
  const d = Math.hypot(x - f.x, z - f.z);
  if (f.kind === 'mesa') {
    // flat top, then a steep band down to nothing — the cliff-island profile
    const edge = Math.max(f.edge ?? r * 0.35, 1e-3);
    return f.height * smoothstep01((r - d) / edge);
  }
  if (f.kind === 'sheer') {
    // THE VERTICAL-WALLED MASS — the profile behind both a sea stack and a
    // headland, which is why it is one kind at two scales rather than two.
    //
    // WHY IT HAS TO BE ITS OWN KIND, measured. Every other kind here reaches
    // its own rim TANGENTIALLY: `pow(1 − d/r, power)` has zero slope at d = r
    // for any power > 1, and a ridge likewise. So no cone, no ridge and no
    // amount of `featureExtent` can ever put a cliff at the waterline — a
    // sweep over featureExtent 0.62→0.94 moved the fraction of shoreline
    // steeper than 45° by nothing at all (6%→6%) and made the coastline
    // ROUNDER (shore-radius CV 0.256→0.188). Only a profile with a wall in it
    // can produce a coast that drops into the water, which is half of what
    // §V43's reference coastline actually is.
    //
    //   core  — vertical-walled over the inner 55% of the footprint: the hard
    //           edge that reads on the horizon, and the cliff at the water
    //   skirt — a low broken apron out to the full radius, so the waterline
    //           gets rubble to break on instead of a clean circle
    // max() rather than sum: the wall must not be lifted by its own base.
    const edge = Math.max(f.edge ?? r * 0.18, 1e-3); // §V28 floored divisor
    const core = smoothstep01((r * 0.55 - d) / edge);
    const skirt = Math.pow(Math.max(1 - d / r, 0), 3) * 0.35;
    return f.height * Math.max(core, skirt);
  }
  return f.height * Math.pow(Math.max(1 - d / r, 0), f.power);
}

/**
 * Smooth maximum. Plain max() would leave a visible crease where two features
 * meet; summing would pile them into one over-tall blob. This blends only
 * within `k` metres of the crossover, so features fuse into one landmass while
 * each keeps its own silhouette.
 */
export function smoothMax(a: number, b: number, k: number): number {
  const kk = Math.max(k, 1e-3); // §V28 floored divisor
  const h = Math.max(kk - Math.abs(a - b), 0) / kk;
  const top = Math.max(a, b);
  // The bump has to vanish where there is nothing to blend. The textbook
  // polynomial adds k/4 whenever the two operands are EQUAL — including the
  // vast area off the island where both features contribute exactly 0, which
  // silently lifted the whole sea floor by k/4 and made a zero-height island
  // still break the surface. Gating on the operands' own magnitude keeps the
  // blend where features actually meet.
  const active = smoothstep01(top / kk);
  return top + h * h * kk * 0.25 * active;
}

/** combined height of a feature list */
export function combineFeatures(features: readonly Feature[], x: number, z: number, blend: number): number {
  let h = 0;
  for (let i = 0; i < features.length; i++) {
    const fh = featureHeight(features[i], x, z);
    h = i === 0 ? fh : smoothMax(h, fh, blend);
  }
  return h;
}

export const ARCHETYPES = [
  'twinPeaks',
  'mesaCliff',
  'spine',
  'crestedDome',
  'lagoon',
] as const;
/** the galleon-era families this file builds — what `pickArchetype` draws from */
export type PirateArchetypeName = (typeof ARCHETYPES)[number];
/**
 * Every silhouette family the heightmap can be asked for. The sierra names
 * (§T.99, sierraArchetypes.ts) are never drawn by `pickArchetype`: they only
 * arrive as a forced `archetype` from a sierra site, so the pirate world's
 * seeded draws are untouched by their existence.
 */
export type ArchetypeName = PirateArchetypeName | SierraArchetypeName;

type Rng = () => number;
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Build the feature list for an archetype.
 * `extent` is the radius the features are allowed to occupy (metres) — they
 * must die out well inside the grid so the coastline belongs to the noise.
 */
/**
 * How much of the peak the shared BASE PLATFORM carries, and how far it
 * reaches. Every archetype gets one, and this is the fix for the single most
 * damning thing in the top-down reference shot: the island was FIVE SEPARATE
 * CONES joined by necks of ground at zero elevation.
 *
 * THE ARITHMETIC THAT MADE IT SO. Take `lagoon` with 4 lobes: they sit on a
 * ring at 0.50-0.62·extent with radii 0.34-0.46·extent, spread over
 * 2π − 2·gap ≈ 4.5 rad, so adjacent centres are ~1.5 rad apart — a chord of
 * 2·0.56·sin(0.75) ≈ 0.76·extent against a radius sum of ~0.80·extent. That is
 * 5% of one radius of overlap, and it happens at the very rim of both cones
 * where each contributes ~0 m. `smoothMax` then has nothing to blend: its
 * `active` gate is `smoothstep(top/k)`, which is zero when the tallest
 * operand is zero, so the necks got no lift at all. The result was a cluster
 * of rocks, not an island — and no amount of `featureBlend` could fix it,
 * because blend width cannot manufacture height that neither feature has.
 *
 * A broad low platform under everything makes the lobes one landmass by
 * construction, and at the reference's near-flat relief it IS most of the
 * island: the refs (docs/inspo/island/) are sand platforms a couple of metres
 * proud with boulders on top, not cones.
 */
const BASE_HEIGHT = 0.34;
const BASE_EXTENT = 1.05;
const BASE_POWER = 1.1;

/**
 * RELIEF PER FAMILY — how tall this silhouette is allowed to be, as a multiple
 * of the island's own `peakHeight`.
 *
 * WHY THIS EXISTS RATHER THAN ONE GLOBAL HEIGHT. Cutting `peakHeight` far
 * enough to make the anchorage island read as the reference's sand platform
 * (docs/inspo/island/ref-island-146/150.png — broad, a couple of metres proud,
 * relief carried by boulders rather than terrain) also flattened the two
 * families whose whole job is to be tall: the fraction of shoreline steeper
 * than 45° went to EXACTLY ZERO on every island in the world, which is the
 * §V43 "a cliff somewhere on every island" contract deleted by a params
 * change. Both readings are correct and they are about DIFFERENT ISLANDS —
 * the references contain sandbars AND fortress rocks, and §V43's actual demand
 * is that they be distinguishable from kilometres out.
 *
 * So relief becomes part of the silhouette family, like STACK_AFFINITY and
 * HEADLAND_AFFINITY already are. `lagoon` is deliberately the flattest: it is
 * the family the showcase island forces, i.e. the one the player anchors at
 * and walks on, and it is the one the user was looking at when they said the
 * scale made no sense.
 */
const ARCHETYPE_RELIEF: Record<PirateArchetypeName, number> = {
  mesaCliff: 2.4,
  spine: 2.1,
  twinPeaks: 1.5,
  crestedDome: 0.9,
  lagoon: 0.7,
};

/** the peak an archetype actually builds to, before any feature fractions */
export function archetypePeak(name: PirateArchetypeName, peak: number): number {
  return peak * ARCHETYPE_RELIEF[name];
}

export function buildArchetype(
  name: PirateArchetypeName,
  rng: Rng,
  extent: number,
  rawPeak: number,
): Feature[] {
  const spin = rng() * Math.PI * 2;
  const at = (angle: number, dist: number): [number, number] => [
    Math.cos(angle + spin) * dist,
    Math.sin(angle + spin) * dist,
  ];
  // every `peak` below is the FAMILY's relief, not the island's raw param
  const peak = archetypePeak(name, rawPeak);
  // FIRST in the list, so every other feature smooth-maxes against ground that
  // is already well above water and the joins happen at height instead of at
  // the waterline. Its own draw is taken from the same rng stream position for
  // every archetype, so adding it did not reshuffle anyone's silhouette.
  const base: Feature = {
    kind: 'cone',
    x: 0,
    z: 0,
    radius: extent * BASE_EXTENT,
    height: peak * BASE_HEIGHT,
    power: BASE_POWER,
  };

  switch (name) {
    case 'twinPeaks': {
      // two summits of clearly different height with a saddle between — reads
      // as one island with a notch in its skyline, not as a cone
      const sep = extent * lerp(0.3, 0.45, rng());
      const [ax, az] = at(0, sep);
      const [bx, bz] = at(Math.PI, sep * lerp(0.7, 1, rng()));
      return [
        base,
        { kind: 'cone', x: ax, z: az, radius: extent * 0.66, height: peak, power: 1.5 },
        { kind: 'cone', x: bx, z: bz, radius: extent * 0.58, height: peak * lerp(0.55, 0.78, rng()), power: 1.6 },
        { kind: 'ridge', x: ax, z: az, x2: bx, z2: bz, radius: extent * 0.3, height: peak * 0.42, power: 1.4 },
      ];
    }
    case 'mesaCliff': {
      // flat table pushed off-centre: one flank becomes a tall cliff running
      // straight into the sea, the other a long shelving apron
      const [mx, mz] = at(0, extent * lerp(0.18, 0.32, rng()));
      const [sx, sz] = at(Math.PI * lerp(0.6, 1.4, rng()), extent * 0.5);
      return [
        base,
        {
          kind: 'mesa', x: mx, z: mz, radius: extent * lerp(0.5, 0.62, rng()),
          height: peak, power: 1, edge: extent * lerp(0.1, 0.18, rng()),
        },
        { kind: 'cone', x: sx, z: sz, radius: extent * 0.45, height: peak * lerp(0.3, 0.5, rng()), power: 1.8 },
      ];
    }
    case 'spine': {
      // a long backbone with spires along it — the fortress-rock silhouette,
      // the most recognisable shape in the reference
      const half = extent * lerp(0.45, 0.6, rng());
      const [ax, az] = at(0, half);
      const [bx, bz] = at(Math.PI, half);
      const spires: Feature[] = [];
      const n = 2 + Math.floor(rng() * 2);
      for (let i = 0; i < n; i++) {
        const t = (i + lerp(0.2, 0.8, rng())) / n;
        spires.push({
          kind: 'cone',
          x: lerp(ax, bx, t), z: lerp(az, bz, t),
          radius: extent * lerp(0.2, 0.32, rng()),
          height: peak * lerp(0.62, 1, rng()),
          power: 2.1,
        });
      }
      return [
        base,
        { kind: 'ridge', x: ax, z: az, x2: bx, z2: bz, radius: extent * 0.34, height: peak * 0.55, power: 1.3 },
        ...spires,
      ];
    }
    case 'lagoon': {
      // an arc of low lobes around an open bay — the landmass wraps water
      // instead of filling a disc, which is what gives a real cove
      const gap = lerp(0.7, 1.15, rng()); // radians of open water
      const n = 3 + Math.floor(rng() * 2);
      const ring = extent * lerp(0.5, 0.62, rng());
      const lobes: Feature[] = [];
      for (let i = 0; i < n; i++) {
        const a = gap + ((Math.PI * 2 - gap * 2) * i) / (n - 1);
        const [lx, lz] = at(a, ring);
        lobes.push({
          kind: 'cone', x: lx, z: lz,
          radius: extent * lerp(0.34, 0.46, rng()),
          height: peak * lerp(0.5, 0.9, rng()),
          power: 1.7,
        });
      }
      return [base, ...lobes];
    }
    case 'crestedDome':
    default: {
      // the old shape kept ON PURPOSE as one member of the set — a broad hill
      // is a legitimate island, it just cannot be the ONLY island
      const [px, pz] = at(0, extent * lerp(0.15, 0.35, rng()));
      return [
        base,
        { kind: 'cone', x: 0, z: 0, radius: extent * 0.92, height: peak * 0.62, power: 1.2 },
        { kind: 'cone', x: px, z: pz, radius: extent * lerp(0.26, 0.38, rng()), height: peak, power: 2.4 },
      ];
    }
  }
}

/**
 * How readily each silhouette family stands stacks off its shore. This is
 * art direction, not physics: a spine of fortress rock is the shape that wants
 * outliers around it, a broad hill is the shape that does not. Zero would make
 * the family look impoverished next to the others, so the floor is one.
 */
const STACK_AFFINITY: Record<PirateArchetypeName, number> = {
  spine: 1,
  mesaCliff: 0.85,
  lagoon: 0.7,
  twinPeaks: 0.55,
  crestedDome: 0.35,
};

/** everything sea-stack placement needs, in island-local metres */
export interface SeaStackSpec {
  /** upper bound on stacks for the most stack-happy archetype */
  maxCount: number;
  /** distance from the island centre the stacks stand at (m) */
  ring: number;
  /** footprint radius range (m) */
  radiusMin: number;
  radiusMax: number;
  /** height above the waterline range (m) */
  heightMin: number;
  heightMax: number;
}

/**
 * Stacks standing OFF the shore, in open water (T20/§V43).
 *
 * WHY THESE ARE TERRAIN FEATURES AND NOT ROCK MESHES. `rocks.ts` already
 * scatters deformed icosahedra on the beach ring — but they are 3-8 m, half
 * embedded, and `lodRockCull` hides the whole batch past 1800 m, so they can
 * contribute nothing whatever to a silhouette at the 2-4 km range where the
 * silhouette is the ONLY thing left. Put into the height field instead, a
 * stack is part of the terrain mesh that is already being drawn: no extra
 * draw call, no extra pipeline (`getMaterialCacheKey` appends `object.uuid`
 * per InstancedMesh, so every new rock batch is a new pipeline), no cull
 * distance, and the intersection foam (§V10) breaks on it for free because
 * the terrain mesh is already a foam target.
 *
 * The size floor matters and is not cosmetic: the far terrain LOD decimates
 * the grid by `lodTerrainStride`, so a stack narrower than a few decimated
 * cells is simply not sampled and vanishes at exactly the distance it exists
 * for. `radiusMin` has to stay comfortably above that cell size.
 */
export function buildSeaStacks(
  name: PirateArchetypeName,
  rng: Rng,
  spec: SeaStackSpec,
): Feature[] {
  const budget = Math.floor(spec.maxCount * STACK_AFFINITY[name]);
  if (budget <= 0) return [];
  const n = 1 + Math.floor(rng() * budget);
  const stacks: Feature[] = [];
  // one seeded rotation, then a jittered sector each: two stacks landing on
  // top of each other read as one lump, and evenly spaced ones read as a fence
  const phase = rng();
  for (let i = 0; i < n; i++) {
    const a = ((i + lerp(0.15, 0.85, rng())) / n + phase) * Math.PI * 2;
    const ring = spec.ring * lerp(0.88, 1.12, rng());
    stacks.push({
      kind: 'sheer',
      x: Math.cos(a) * ring,
      z: Math.sin(a) * ring,
      radius: lerp(spec.radiusMin, spec.radiusMax, rng()),
      height: lerp(spec.heightMin, spec.heightMax, rng()),
      power: 1,
    });
  }
  return stacks;
}

/**
 * How much cliff coast each family carries. Not uniform, for the same reason
 * as STACK_AFFINITY — but the FLOOR is 1 headland, deliberately: an island
 * with no cliff anywhere on it is the shipping look this work exists to
 * replace, so no family is allowed back to a beach on every bearing.
 */
const HEADLAND_AFFINITY: Record<PirateArchetypeName, number> = {
  mesaCliff: 1,
  spine: 1,
  twinPeaks: 0.7,
  lagoon: 0.7,
  crestedDome: 0.4,
};

/** everything headland placement needs, in island-local metres */
export interface HeadlandSpec {
  /** headlands per island (0 disables) */
  count: number;
  /** how far from the island centre the mass sits (m) */
  offset: number;
  /** footprint radius range (m) */
  radiusMin: number;
  radiusMax: number;
  /** height range (m above the waterline) */
  heightMin: number;
  heightMax: number;
  /** wall width as a fraction of the footprint radius (small = sheerer) */
  edgeFraction: number;
}

/**
 * HEADLANDS — the half of the coastline that is a cliff (§V43, T33).
 *
 * The complaint this answers is "a single skirt of sand all the way round".
 * It was structurally true: between `featureExtent` and the rim the height
 * field is nothing but low-amplitude coast noise, so every island shelved
 * into the water at a measured median 5-8° on every bearing, and only the one
 * archetype that owns a `mesa` had any steep coast at all.
 *
 * A headland is a `sheer` mass pushed out toward the rim so its wall crosses
 * the waterline on the seaward side while its skirt merges into the landmass
 * on the inland side. That gives ONE island both coasts — cliff on one
 * bearing, beach on the next — which is the variation the shoreline foam
 * (§V10, §T33) also needs, because a swash model has nothing to say on a
 * vertical face and everything to say on the beach beside it.
 *
 * `offset` is deliberately a fraction of the FOOTPRINT radius and not of
 * `featureExtent`: the whole point is to reach past where the landmass
 * features stop.
 */
export function buildHeadlands(
  name: PirateArchetypeName,
  rng: Rng,
  spec: HeadlandSpec,
): Feature[] {
  // Per-family, for the same reason as STACK_AFFINITY: three tables on the
  // broad-hill archetype erased the one family whose job is to be a broad
  // hill, and §V43 asks for five silhouettes, not five copies of the best one.
  const n = Math.max(0, Math.round(spec.count * HEADLAND_AFFINITY[name]));
  if (n === 0) return [];
  const out: Feature[] = [];
  const phase = rng();
  for (let i = 0; i < n; i++) {
    const a = ((i + lerp(0.2, 0.8, rng())) / n + phase) * Math.PI * 2;
    const radius = lerp(spec.radiusMin, spec.radiusMax, rng());
    out.push({
      kind: 'sheer',
      x: Math.cos(a) * spec.offset,
      z: Math.sin(a) * spec.offset,
      radius,
      height: lerp(spec.heightMin, spec.heightMax, rng()),
      power: 1,
      edge: Math.max(radius * spec.edgeFraction, 1e-3), // §V28 floored divisor
    });
  }
  return out;
}

/**
 * Pick an archetype from a seed. `avoid` lets the archipelago hand out
 * distinct silhouettes — a world where two of five islands are the same shape
 * fails the "identifiable from miles out" bar as surely as one where all five
 * are (§V43).
 */
export function pickArchetype(rng: Rng, avoid: readonly ArchetypeName[] = []): PirateArchetypeName {
  const pool = ARCHETYPES.filter((a) => !avoid.includes(a));
  const from = pool.length > 0 ? pool : ARCHETYPES;
  return from[Math.floor(rng() * from.length) % from.length];
}
