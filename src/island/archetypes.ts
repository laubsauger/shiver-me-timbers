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

/** one height contribution in island-local metres */
export interface Feature {
  kind: 'cone' | 'mesa' | 'ridge';
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
export type ArchetypeName = (typeof ARCHETYPES)[number];

type Rng = () => number;
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Build the feature list for an archetype.
 * `extent` is the radius the features are allowed to occupy (metres) — they
 * must die out well inside the grid so the coastline belongs to the noise.
 */
export function buildArchetype(
  name: ArchetypeName,
  rng: Rng,
  extent: number,
  peak: number,
): Feature[] {
  const spin = rng() * Math.PI * 2;
  const at = (angle: number, dist: number): [number, number] => [
    Math.cos(angle + spin) * dist,
    Math.sin(angle + spin) * dist,
  ];

  switch (name) {
    case 'twinPeaks': {
      // two summits of clearly different height with a saddle between — reads
      // as one island with a notch in its skyline, not as a cone
      const sep = extent * lerp(0.3, 0.45, rng());
      const [ax, az] = at(0, sep);
      const [bx, bz] = at(Math.PI, sep * lerp(0.7, 1, rng()));
      return [
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
      return lobes;
    }
    case 'crestedDome':
    default: {
      // the old shape kept ON PURPOSE as one member of the set — a broad hill
      // is a legitimate island, it just cannot be the ONLY island
      const [px, pz] = at(0, extent * lerp(0.15, 0.35, rng()));
      return [
        { kind: 'cone', x: 0, z: 0, radius: extent * 0.92, height: peak * 0.62, power: 1.2 },
        { kind: 'cone', x: px, z: pz, radius: extent * lerp(0.26, 0.38, rng()), height: peak, power: 2.4 },
      ];
    }
  }
}

/**
 * Pick an archetype from a seed. `avoid` lets the archipelago hand out
 * distinct silhouettes — a world where two of five islands are the same shape
 * fails the "identifiable from miles out" bar as surely as one where all five
 * are (§V43).
 */
export function pickArchetype(rng: Rng, avoid: readonly ArchetypeName[] = []): ArchetypeName {
  const pool = ARCHETYPES.filter((a) => !avoid.includes(a));
  const from = pool.length > 0 ? pool : ARCHETYPES;
  return from[Math.floor(rng() * from.length) % from.length];
}
