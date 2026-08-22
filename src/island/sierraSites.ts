/**
 * The Sierra slice (§T.99, §V90): a start anchorage at the origin, three
 * walkable islands 500–700 m apart — one dome, one drowned ridge, one cirque
 * — a few minor islets, and ONE Half-Dome silhouette on the far horizon that
 * is flagged `unreachable` and kept ≥ `halfDomeDistanceFactor`× the furthest
 * slice island away.
 *
 * Same shape of contract as `generateIslandSites` (§V2: pure f(seed, params),
 * rejection sampling, throws rather than returning a partial world) but a
 * different layout rule: the pirate scatter fills an annulus so there is
 * always something at the haze distance; the slice is a CLUSTER the raft can
 * cross in minutes, and the far plane is the silhouette's job.
 *
 * WIRING (main-raft): `createArchipelago({ seed, sites: world.sites })` and
 * spawn the raft at `world.start`.
 */
import { createRng } from '../state/rng';
import { islandParams, type IslandParams } from '../params/island';
import { sierraParams, type SierraParams } from '../params/sierra';
import { islandPeakHeights, type ResolvedIslandParams } from './island';
import { siteParams, type IslandSite } from './archipelago';
import { generateIslandHeightmap, type IslandHeightmapParams } from './heightmap';
import type { PoiKind } from './pathGraph';
import { SIERRA_SLICE_ARCHETYPES, type SierraArchetypeName } from './sierraArchetypes';

/** placement attempts before the layout is declared impossible */
const PLACEMENT_ATTEMPTS = 512;
/** decorrelates each island's generation stream from the layout stream */
const SITE_SEED_STRIDE = 7919;
const HALF_DOME_SEED_STRIDE = 104729;
const FILLER_SEED_STRIDE = 3001;

export interface SierraStart {
  x: number;
  z: number;
  /** yaw (rad) putting the nearest slice island dead ahead */
  heading: number;
}

export interface SierraWorld {
  /** slice islands first (one per archetype), then fillers, then the half dome */
  sites: IslandSite[];
  start: SierraStart;
  /**
   * T112b: the slice islands in visiting order (indices into `sites`): the
   * start's nearest first, then nearest-unvisited. Each slice site's
   * `overrides` carries `pathApproach` (bearing toward where you sail from)
   * and `pathNext` (toward the next station) for the path graph.
   */
  order: number[];
}

/** a route POI in WORLD coordinates (island offset applied) */
export interface SierraPoi {
  kind: PoiKind;
  x: number;
  y: number;
  z: number;
  /** index into `SierraWorld.sites` */
  site: number;
}

/** the per-island path hints the slice sites carry in `overrides` */
export type SierraPathHints = Pick<IslandHeightmapParams, 'pathApproach' | 'pathNext'>;

/**
 * The route POIs of one slice site — landing, station, exit, fork — in world
 * coordinates, by BAKING the island (the POIs are where the carve put them,
 * §V71: one resolution path, `siteParams`). The archipelago bakes the same
 * island for rendering; read `island.heightmap.path.pois` there instead of
 * calling this twice. Empty for a site with no route (fillers, Half Dome).
 */
export function sierraSitePois(sites: IslandSite[], index: number): SierraPoi[] {
  const site = sites[index];
  const hm = generateIslandHeightmap(site.seed, siteParams(site));
  if (!hm.path) return [];
  return hm.path.pois.map((q) => ({
    kind: q.kind,
    x: q.x + site.position[0],
    y: q.y,
    z: q.z + site.position[1],
    site: index,
  }));
}

/**
 * The per-family param overrides a sierra island is built with. ONE function
 * so the site generator and the tests resolve the same island (§V71 — the
 * pirate world has `siteParams` for the same reason).
 */
export function sierraOverrides(
  name: SierraArchetypeName,
  p: SierraParams = sierraParams,
): Partial<IslandParams> {
  const common: Partial<IslandParams> = {
    // cliffs and stacks are the pirate coast; the sierra coast is DG sand
    headlandCount: 0,
    seaStackCount: 0,
    // no authored hut shelf: the terraces and benches are the level ground
    terraceRadius: 0,
    // granite is smooth and the coast noise is what makes random islets
    noiseSlope: p.graniteNoiseSlope,
    // T130: the finest octave was 3.6 m — two cells at 256² and the scale the
    // user read as noise from the deck. See sierra.graniteNoiseOctaves.
    noiseOctaves: p.graniteNoiseOctaves,
    coastNoiseSlope: p.sierraCoastSlope,
    beachBandWidth: p.dgSandBand,
    // the apron's land gate exists to keep `sheer` walls out of the beach
    // remap; a sierra coast has no walls, and its shoreline sits where the
    // crown is already ~7 m proud of the sunk seabed, so the gate must stay
    // open well past that or the beach stops one metre above the water
    beachLandGuard: 60,
    featureExtent: 0.7,
    // no pirate settlement on a Sierra bench
    structureSettlements: 0,
    structureHutCount: 0,
  };
  switch (name) {
    case 'cirque':
      return {
        ...common,
        // the still lagoon INSIDE the ring — the basin term reused verbatim;
        // the offset is small because the ring encloses the island centre
        lagoonDepth: p.cirqueLagoonDepth,
        lagoonRadius: p.cirqueLagoonRadius,
        lagoonOffset: 0.12,
        lagoonFeather: 0.16,
        lagoonLandGuard: 4,
        lagoonFloorRelief: 0.04,
        // the basin floor must stay inside the readable band, and a ring
        // island's rim is close to its walls
        rimStart: 0.86,
      };
    case 'halfDome':
      return {
        ...common,
        // one face, one silhouette: the crown fills the footprint
        featureExtent: 0.78,
        rimStart: 0.9,
        rimDepth: 10,
        skirtDepth: 14,
        peakHeight: p.halfDomePeak,
        minPeakHeight: p.halfDomePeak * 0.8,
        // nothing is ever close enough to read it
        rockCount: 0,
        cliffCount: 0,
      };
    default:
      return common;
  }
}

/** resolved build params for a sierra island — what a site's heightmap is made from */
export function sierraIslandParams(
  name: SierraArchetypeName,
  radius: number,
  gridSize: number,
  p: SierraParams = sierraParams,
  base: IslandParams = islandParams,
): ResolvedIslandParams {
  return {
    ...base,
    radius,
    ...islandPeakHeights(radius, base),
    ...sierraOverrides(name, p),
    gridSize,
    archetype: name,
  };
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Deterministic slice layout. Same (seed, params) → identical sites.
 *
 * The three slice islands form a triangle: A is placed on a seeded bearing
 * just past the start clearance, B at a seeded spacing from A, C at the
 * intersection of two seeded spacings from A and B (the solution further
 * from the start). Every pair lands in [sliceMinSpacing, sliceMaxSpacing] by
 * construction, and the gap/clearance constraints are tested rather than
 * assumed (§Rule 8: a layout that cannot satisfy them throws).
 */
export function generateSierraSites(
  seed: number,
  p: SierraParams = sierraParams,
): SierraWorld {
  const rng = createRng(seed);
  const count = Math.min(Math.max(Math.floor(p.sliceCount), 1), SIERRA_SLICE_ARCHETYPES.length);
  const lo = Math.min(p.sliceMinSpacing, p.sliceMaxSpacing);
  const hi = Math.max(p.sliceMinSpacing, p.sliceMaxSpacing);
  const rMin = Math.min(p.sliceRadiusMin, p.sliceRadiusMax);
  const rMax = Math.max(p.sliceRadiusMin, p.sliceRadiusMax);

  // the archetype order is seeded too, so which island is nearest the start
  // differs per world
  const order = [...SIERRA_SLICE_ARCHETYPES].slice(0, count);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  const okAgainst = (x: number, z: number, r: number, sites: IslandSite[], gap: number): boolean => {
    if (Math.hypot(x, z) - r < p.startClearance) return false;
    for (const o of sites) {
      if (Math.hypot(x - o.position[0], z - o.position[1]) < r + o.radius + gap) return false;
    }
    return true;
  };
  const pairOk = (x: number, z: number, o: IslandSite): boolean => {
    const d = Math.hypot(x - o.position[0], z - o.position[1]);
    return d >= lo && d <= hi;
  };

  let sites: IslandSite[] = [];
  let placed = false;
  for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS && !placed; attempt++) {
    sites = [];
    const radii = order.map(() => lerp(rMin, rMax, rng()));
    const mk = (i: number, x: number, z: number): IslandSite => ({
      seed: seed + SITE_SEED_STRIDE * (i + 1),
      position: [x, z],
      radius: radii[i],
      archetype: order[i],
      overrides: { ...sierraOverrides(order[i], p), gridSize: p.sliceGridSize },
    });
    // A: just past the start clearance on a seeded bearing
    const bearing = rng() * Math.PI * 2;
    const dA = p.startClearance + radii[0] + lerp(20, 120, rng());
    const A = mk(0, Math.cos(bearing) * dA, Math.sin(bearing) * dA);
    if (!okAgainst(A.position[0], A.position[1], A.radius, [], p.sliceGap)) continue;
    sites.push(A);
    if (count === 1) {
      placed = true;
      break;
    }
    // B: a seeded spacing from A, biased away from the start
    const dAB = lerp(Math.max(lo, radii[0] + radii[1] + p.sliceGap), hi, rng());
    const bBearing = bearing + (rng() - 0.5) * Math.PI * 1.2;
    const B = mk(1, A.position[0] + Math.cos(bBearing) * dAB, A.position[1] + Math.sin(bBearing) * dAB);
    if (!okAgainst(B.position[0], B.position[1], B.radius, sites, p.sliceGap)) continue;
    sites.push(B);
    if (count === 2) {
      placed = true;
      break;
    }
    // C: intersection of two seeded spacings from A and B
    const dAC = lerp(Math.max(lo, radii[0] + radii[2] + p.sliceGap), hi, rng());
    const dBC = lerp(Math.max(lo, radii[1] + radii[2] + p.sliceGap), hi, rng());
    const abx = B.position[0] - A.position[0];
    const abz = B.position[1] - A.position[1];
    const ab = Math.hypot(abx, abz);
    // triangle inequality — otherwise the circles do not meet
    if (dAC + dBC <= ab || Math.abs(dAC - dBC) >= ab) continue;
    const along = (dAC * dAC - dBC * dBC + ab * ab) / (2 * ab);
    const hh = dAC * dAC - along * along;
    if (hh <= 0) continue;
    const h = Math.sqrt(hh);
    const px = A.position[0] + (abx / ab) * along;
    const pz = A.position[1] + (abz / ab) * along;
    const nx = -abz / ab;
    const nz = abx / ab;
    const candidates: [number, number][] = [
      [px + nx * h, pz + nz * h],
      [px - nx * h, pz - nz * h],
    ];
    // the solution further from the start keeps the cluster off the spawn
    candidates.sort((u, v) => Math.hypot(v[0], v[1]) - Math.hypot(u[0], u[1]));
    let cPlaced = false;
    for (const [cx, cz] of candidates) {
      if (!okAgainst(cx, cz, radii[2], sites, p.sliceGap)) continue;
      if (!pairOk(cx, cz, A) || !pairOk(cx, cz, B)) continue;
      sites.push(mk(2, cx, cz));
      cPlaced = true;
      break;
    }
    if (cPlaced) placed = true;
  }
  if (!placed) {
    throw new Error(
      `generateSierraSites: could not lay out ${count} slice islands ${lo}..${hi} m apart ` +
        `(radii ${rMin}..${rMax}, gap ${p.sliceGap}, start clearance ${p.startClearance}) in ` +
        `${PLACEMENT_ATTEMPTS} attempts`,
    );
  }

  // furthest reachable station from the start — the half dome is measured
  // against THIS, not against the cluster centre (§V90)
  let furthest = 0;
  for (const s of sites) furthest = Math.max(furthest, Math.hypot(s.position[0], s.position[1]));

  // minor islets: low domes sprinkled around the cluster, no archetype
  // forced on them beyond 'dome' so they stay granite
  const fillers = Math.max(0, Math.floor(p.fillerCount));
  for (let i = 0; i < fillers; i++) {
    let done = false;
    for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS && !done; attempt++) {
      const a = rng() * Math.PI * 2;
      const d = lerp(p.startClearance, furthest * 1.15, rng());
      const r = lerp(p.fillerRadiusMin, p.fillerRadiusMax, rng());
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      if (!okAgainst(x, z, r, sites, p.sliceGap)) continue;
      sites.push({
        seed: seed + FILLER_SEED_STRIDE * (i + 1),
        position: [x, z],
        radius: r,
        archetype: 'dome',
        overrides: { ...sierraOverrides('dome', p), gridSize: p.fillerGridSize },
      });
      done = true;
    }
    if (!done) {
      throw new Error(`generateSierraSites: could not place filler islet ${i + 1}/${fillers}`);
    }
  }

  // the silhouette: out past everything, on the far side of the cluster from
  // the start so it sits on the horizon behind the islands you sail toward
  {
    let cx = 0;
    let cz = 0;
    for (let i = 0; i < count; i++) {
      cx += sites[i].position[0] / count;
      cz += sites[i].position[1] / count;
    }
    const a = Math.atan2(cz, cx) + (rng() - 0.5) * 0.5;
    const d = Math.max(p.halfDomeDistanceFactor, 1.5) * furthest + p.halfDomeRadius;
    sites.push({
      seed: seed + HALF_DOME_SEED_STRIDE,
      position: [Math.cos(a) * d, Math.sin(a) * d],
      radius: p.halfDomeRadius,
      archetype: 'halfDome',
      overrides: { ...sierraOverrides('halfDome', p), gridSize: p.fillerGridSize },
      unreachable: true,
    });
  }

  // the start: at the origin, facing the nearest slice island
  let nearest = sites[0];
  for (let i = 1; i < count; i++) {
    if (Math.hypot(sites[i].position[0], sites[i].position[1]) < Math.hypot(nearest.position[0], nearest.position[1])) {
      nearest = sites[i];
    }
  }
  // yaw convention as showcase.ts: forward is [sin h, cos h]
  const heading = Math.atan2(nearest.position[0], nearest.position[1]);

  // T112b: visiting order (nearest-unvisited chain from the start) and the
  // per-island bearings the path graph is authored against — the landing
  // faces where you sail from, the exit and the Journey tilt face the next
  // station (the last island faces home)
  const visit: number[] = [];
  {
    let px = 0;
    let pz = 0;
    const left = new Set<number>();
    for (let i = 0; i < count; i++) left.add(i);
    while (left.size) {
      let best = -1;
      let bd = Infinity;
      for (const i of left) {
        const d = Math.hypot(sites[i].position[0] - px, sites[i].position[1] - pz);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      visit.push(best);
      left.delete(best);
      px = sites[best].position[0];
      pz = sites[best].position[1];
    }
  }
  for (let k = 0; k < visit.length; k++) {
    const s = sites[visit[k]];
    const prev: [number, number] = k === 0 ? [0, 0] : sites[visit[k - 1]].position;
    const next: [number, number] = k === visit.length - 1 ? [0, 0] : sites[visit[k + 1]].position;
    const hints: SierraPathHints = {
      pathApproach: Math.atan2(prev[1] - s.position[1], prev[0] - s.position[0]),
      pathNext: Math.atan2(next[1] - s.position[1], next[0] - s.position[0]),
    };
    // `overrides` is Partial<IslandParams>; the hints are heightmap inputs
    // that `siteParams` spreads through untouched (they are not knobs)
    s.overrides = { ...s.overrides, ...hints } as IslandSite['overrides'];
  }

  return { sites, start: { x: 0, z: 0, heading }, order: visit };
}
