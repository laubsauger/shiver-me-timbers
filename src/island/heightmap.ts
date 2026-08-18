/**
 * Island heightmap — pure CPU (T20). ZERO three.js imports on purpose: tests
 * (tests/island.test.ts) and sim code (buoyancy/grounding later) import this
 * without touching GPU/material modules.
 *
 * Shape is COMPOSED, not sampled (§V43 — see archetypes.ts for why a radial
 * dome × fbm could never produce a silhouette). Three sources, in this order:
 *   1. the ARCHETYPE's features — the landmass and its skyline family
 *   2. HEADLANDS — `sheer` masses pushed out toward the rim so a wall crosses
 *      the waterline: the half of the coastline that is a cliff. Nothing else
 *      here can make one (every other kind reaches its rim tangentially).
 *   3. SEA STACKS — `sheer` columns standing off in open water, in the height
 *      field rather than as rock meshes so they survive to the horizon.
 * then coast noise, surface detail, the rim envelope and the beach apron.
 * Deterministic per seed (§V2-adjacent: createRng only — same seed →
 * byte-identical Float32Array).
 *
 * Guarantees (pinned by tests):
 * - rim submerged: the dome shape is 0 at d ≥ radius, and noise is scaled by
 *   the shape, so every boundary sample sits exactly at -rimDepth < 0.
 * - interior peak ≥ minPeakHeight: positive heights are rescaled up if the
 *   noise undershoots the target (degenerate params that never break the
 *   waterline throw — fail loud, §Rule 8).
 * - beach apron: heights inside ±beachBandWidth of the waterline are slope-
 *   compressed (×beachFlatness at the line, blending to 1 at the band edge),
 *   giving the gentle 0..~2 m sand ring of the refs. The remap is monotone,
 *   so it never creates new waterline crossings.
 *
 * heightAt(x, z) bilinearly samples the grid (island-local coords, y-up,
 * x/z ∈ [-radius, radius]; outside → -rimDepth). Mesh vertices come from the
 * same grid, so heightAt matches the rendered surface exactly at vertices and
 * to within one triangle's diagonal split elsewhere.
 */
import { createRng } from '../state/rng';
import { fbm2Cpu } from '../terrain/noiseCpu';
import {
  buildArchetype,
  buildHeadlands,
  buildSeaStacks,
  combineFeatures,
  pickArchetype,
  type ArchetypeName,
  type Feature,
} from './archetypes';

/** structural subset of params/island.ts `IslandParams` used by generation */
export interface IslandHeightmapParams {
  radius: number;
  gridSize: number;
  peakHeight: number;
  minPeakHeight: number;
  noiseScale: number;
  noiseStrength: number;
  noiseOctaves: number;
  /** fraction of the footprint the archetype's features may occupy */
  featureExtent: number;
  /** metres over which two features fuse instead of creasing */
  featureBlend: number;
  /** coastline noise: world frequency (1/m) and amplitude as a fraction of peak */
  coastNoiseScale: number;
  coastNoiseStrength: number;
  /** fraction of the radius inside which the rim envelope does not act */
  rimStart: number;
  beachBandWidth: number;
  beachFlatness: number;
  /** authored lagoon floor — see lagoonBasin below; 0 disables */
  lagoonDepth: number;
  lagoonRadius: number;
  lagoonFeather: number;
  lagoonLandGuard: number;
  lagoonFloorRelief: number;
  lagoonOffset: number;
  rimDepth: number;
  /**
   * Force a silhouette family instead of drawing one from the seed. Exists for
   * ONE caller — the hand-placed showcase island (island/showcase.ts), which
   * has to be a lagoon every time rather than 23% of the time. Undefined (the
   * normal case) leaves `pickArchetype` in charge.
   */
  archetype?: ArchetypeName;
  /** sea stacks (see archetypes.buildSeaStacks) — fractions, resolved below */
  seaStackCount: number;
  seaStackRing: number;
  seaStackRadiusMin: number;
  seaStackRadiusMax: number;
  seaStackHeightMin: number;
  seaStackHeightMax: number;
  /** headlands (see archetypes.buildHeadlands) — fractions, resolved below */
  headlandCount: number;
  headlandOffset: number;
  headlandRadiusMin: number;
  headlandRadiusMax: number;
  headlandHeightMin: number;
  headlandHeightMax: number;
  headlandEdge: number;
}

export interface IslandHeightmap {
  /** which silhouette family this island belongs to — "the one with the spine" */
  archetype: ArchetypeName;
  /** the features that carry the landmass (silhouette debugging / tests) */
  features: Feature[];
  /** row-major heights, data[iz * size + ix], meters relative to waterline 0 */
  data: Float32Array;
  /** grid resolution per side */
  size: number;
  /** grid spans [-worldRadius, worldRadius] on x and z */
  worldRadius: number;
  /**
   * Island-local centre of the authored lagoon basin, or null when this island
   * has none (`lagoonDepth` 0 — every procedurally scattered island). PUBLISHED
   * rather than recomputed by consumers: the anchorage solver and the tests
   * both need "where is the lagoon", and two derivations of the same bearing
   * are two things that can disagree.
   */
  lagoonCenter: [number, number] | null;
  /** bilinear height sample, island-local coords; outside grid → -rimDepth */
  heightAt(x: number, z: number): number;
}

const smoothstep01 = (t: number): number => {
  const c = Math.min(Math.max(t, 0), 1);
  return c * c * (3 - 2 * c);
};

/** bearings scanned for the bay opening — resolution, not a look tunable */
const BAY_SCAN_ANGLES = 96;
/** radial samples per bearing in that scan */
const BAY_SCAN_STEPS = 24;

/**
 * WHERE THE ARCHETYPE LEFT ITS BAY OPEN — the bearing carrying the least
 * landmass, measured, so the basin can be pushed out along it.
 *
 * WHY THIS IS NEEDED AND THE ISLAND ORIGIN IS NOT ENOUGH. The `lagoon`
 * archetype rings its lobes around the origin with a `gap` of 0.7-1.15 rad of
 * open bearing — but each lobe sits at ring ∈ 0.50-0.62·extent with radius
 * 0.34-0.46·extent, so it reaches ±asin(r/ring) = ±33-67° around its own
 * bearing. The two lobes bounding the gap therefore close most or all of it
 * from the sides. Measured over five world seeds with the basin at the origin:
 * bay openness 1-7% of bearings, widest mouth 2-22°. That is a CRATER, not a
 * cove — a pool with no way in and nothing to see it from.
 *
 * It is not the noise. Dropping `coastNoiseStrength` 0.14→0.05 and
 * `noiseStrength` 0.18→0.08 made it WORSE (widest mouth 4°→0°), because a
 * flatter field also flattens the deep channels the ship needs.
 *
 * So: score each bearing by the TALLEST landmass anywhere along it and take
 * the lowest. Purely a function of the feature list, so it costs one scan at
 * build time and moves with the archetype's own seeded spin (§V71 — resolve
 * against the real surface, never against an authored constant that happened
 * to match one seed).
 */
function findBayBearing(features: readonly Feature[], R: number, blend: number): number {
  let bestAngle = 0;
  let bestPeak = Infinity;
  for (let i = 0; i < BAY_SCAN_ANGLES; i++) {
    const angle = (i / BAY_SCAN_ANGLES) * Math.PI * 2;
    const cx = Math.cos(angle);
    const cz = Math.sin(angle);
    let peak = -Infinity;
    for (let k = 1; k <= BAY_SCAN_STEPS; k++) {
      const r = (k / BAY_SCAN_STEPS) * R;
      const land = combineFeatures(features, cx * r, cz * r, blend);
      if (land > peak) peak = land;
    }
    if (peak < bestPeak) {
      bestPeak = peak;
      bestAngle = angle;
    }
  }
  return bestAngle;
}

/**
 * LAGOON BASIN — the one shape the composition could not previously express.
 *
 * Every feature in archetypes.ts is merged with `smoothMax`, so the field can
 * only ever ADD land: there is no term that says "this basin's floor is at
 * −N m". Measured on three `lagoon` seeds at R = 260 m, the bay inside the arc
 * of lobes is nothing but coast noise at absolute amplitude — 22-45k m² of it
 * 5-8 m deep and 4-12k m² deeper than 8 m, against ~13-19k m² in the 0-3 m
 * band, and none of it controlled. A lagoon you can see the sand through has
 * to be authored.
 *
 * TWO GATES:
 *  - the DISC (`radius` + `feather`) says where the lagoon is. Its feather is
 *    not cosmetic: it IS the shelving bank up out of the basin, so the floor
 *    meets the beach on a ramp instead of a step.
 *  - the LAND GUARD says the basin yields to the ARCHETYPE's own landmass,
 *    fading out over the first `landGuard` metres of feature height.
 *
 * THE GATE IS ON `land`, NOT ON `h`, AND THAT IS THE WHOLE POINT. Gating on
 * the finished height looks more obviously safe and does not work: coast and
 * detail noise are applied at ABSOLUTE amplitude, scaled off `peakHeight`,
 * which scales with the footprint — so on a 260 m island they are a ±16 m and
 * ±21 m field laid over everything, INCLUDING the bay. Measured with an
 * h-gate: the archetype's bay floor came out at +0.2 m at the island's own
 * centre and rose to +4.6 m fifteen metres out, i.e. the "lagoon" was dry
 * land, the basin's gate read it as land, and the basin fired NOWHERE. The
 * landmass is the thing that actually defines the bay; the noise is what the
 * basin is there to overrule.
 *
 * ONE COUPLING WORTH KNOWING ABOUT. Where the archetype puts no landmass but
 * the noise piled up anyway, the basin pulls that ground DOWN — correctly, it
 * is a lagoon — and if that happened to be the island's tallest point it lowers
 * the grid maximum. The `minPeakHeight` rescale below then scales every
 * positive height up to compensate, so turning the basin on can move land
 * heights elsewhere by a few centimetres. Benign, but it is the reason the
 * with/without comparison in the tests is stated as "water stays water" rather
 * than as a pointwise "never higher".
 *
 * WHAT IT GUARANTEES. Wherever it acts the result is `h' = h·(1−w) − depth·w`
 * with depth > 0 and w ∈ [0,1], so h' ≤ max(h, −depth): the basin can lift a
 * hole up toward the floor and it can sink a noise islet, but it can NEVER
 * create dry land, and inside the disc it guarantees water at the authored
 * depth. That one-directional guarantee is why it is safe to run before the
 * apron, which assumes it is handed a shoreline it may soften but not move.
 *
 * @param h     height (m) at this point before the basin
 * @param land  the ARCHETYPE's feature height here, before any noise
 * @param d     distance (m) from the BASIN CENTRE (see findBayBearing — it is
 *              pushed out along the archetype's own opening, not left at the
 *              island origin, or the lagoon is a landlocked crater)
 * @param R     footprint radius (m); the disc fractions resolve against it
 */
function lagoonBasin(
  h: number,
  land: number,
  detail: number,
  d: number,
  R: number,
  p: IslandHeightmapParams,
): number {
  if (p.lagoonDepth <= 0) return h;
  const feather = Math.max(p.lagoonFeather * R, 1e-3); // §V28 floored divisor
  const disc = 1 - smoothstep01((d - p.lagoonRadius * R) / feather);
  if (disc <= 0) return h;
  const guard = Math.max(p.lagoonLandGuard, 1e-3); // §V28 floored divisor
  const w = disc * (1 - smoothstep01(land / guard));
  // A FLOOR IS NOT A TABLE. At full weight the target is the only thing left,
  // so a constant would put a dead-flat 156 m disc under clear water with
  // caustics playing across it — the one place in this scene where the seabed
  // is genuinely visible is the last place it should be a plane. Keeping a
  // small fraction of the SAME detail field the rest of the island uses costs
  // nothing and stays band-limited by construction (this is a CPU height grid;
  // normals come from computeVertexNormals, not from screen-space derivatives,
  // so §V38/§V48 do not bite here).
  const target = -p.lagoonDepth + detail * p.lagoonFloorRelief;
  return h + (target - h) * w;
}

/** monotone slope compression around the waterline (see header) */
function beachApron(h: number, band: number, flatness: number): number {
  const b = Math.max(band, 1e-3);
  const a = Math.min(Math.abs(h) / b, 1);
  const t = a * a * (3 - 2 * a); // smoothstep
  return h * (flatness + (1 - flatness) * t);
}

export function generateIslandHeightmap(
  seed: number,
  params: IslandHeightmapParams,
  /** archetypes the caller wants avoided — the archipelago spreads silhouettes */
  avoidArchetypes: readonly ArchetypeName[] = [],
): IslandHeightmap {
  const p = params;
  const size = Math.max(2, Math.floor(p.gridSize));
  const R = p.radius;
  const rng = createRng(seed);

  // seed-derived noise domain offsets (two independent fields: the coastline
  // one must not correlate with the surface-detail one, or headlands would
  // always coincide with ridges)
  const ox = rng() * 1024;
  const oz = rng() * 1024;
  const cx = rng() * 1024;
  const cz = rng() * 1024;

  // The draw is taken either way, so a forced archetype leaves the rest of the
  // rng stream byte-identical to the unforced one — the override changes the
  // silhouette family and nothing else about the island.
  const picked = pickArchetype(rng, avoidArchetypes);
  const archetype = p.archetype ?? picked;
  // Landmass first, then the stacks standing off it. Both go through the same
  // smooth-max, so a stack that happens to land against a headland fuses with
  // it instead of creasing, and one in open water stays an isolated column.
  const features = [
    ...buildArchetype(archetype, rng, R * p.featureExtent, p.peakHeight),
    ...buildHeadlands(archetype, rng, {
      count: p.headlandCount,
      offset: R * p.headlandOffset,
      radiusMin: R * p.headlandRadiusMin,
      radiusMax: R * p.headlandRadiusMax,
      heightMin: p.peakHeight * p.headlandHeightMin,
      heightMax: p.peakHeight * p.headlandHeightMax,
      edgeFraction: p.headlandEdge,
    }),
    ...buildSeaStacks(archetype, rng, {
      maxCount: p.seaStackCount,
      ring: R * p.seaStackRing,
      radiusMin: R * p.seaStackRadiusMin,
      radiusMax: R * p.seaStackRadiusMax,
      heightMin: p.peakHeight * p.seaStackHeightMin,
      heightMax: p.peakHeight * p.seaStackHeightMax,
    }),
  ];
  const blend = Math.max(p.featureBlend, 1e-3); // §V28 floored divisor
  // amplitude relative to peak, so a taller island gets a bolder coastline —
  // and so a zero-peak island stays fully submerged and throws below
  const coastAmp = p.peakHeight * p.coastNoiseStrength;
  const detailAmp = p.peakHeight * p.noiseStrength;
  const rimStart = Math.min(Math.max(p.rimStart, 0.05), 0.99);
  const rimSpan = Math.max(1 - rimStart, 1e-3); // §V28 floored divisor

  // basin centre: out along the archetype's own opening, so the lagoon is a
  // COVE (open to the sea, sheltered on three sides) instead of a crater
  const bayAngle = p.lagoonDepth > 0 ? findBayBearing(features, R, blend) : 0;
  const bayX = Math.cos(bayAngle) * p.lagoonOffset * R;
  const bayZ = Math.sin(bayAngle) * p.lagoonOffset * R;

  const rawHeight = (x: number, z: number): number => {
    const land = combineFeatures(features, x, z, blend);

    // COASTLINE NOISE at absolute amplitude. The old field multiplied noise by
    // the dome, which zeroed it exactly at the rim — the one place coastline
    // shape lives — and measured a shore-radius variation of only 10-16%.
    // Out here the features have already died to ~0, so this term alone
    // decides where the land meets the water: coves, spits and headlands.
    const coast = (fbm2Cpu(x * p.coastNoiseScale + cx, z * p.coastNoiseScale + cz, 3) * 2 - 1) * coastAmp;

    // surface detail, weighted up on high ground so summits are broken and
    // the beach apron stays walkable
    const n = fbm2Cpu(x * p.noiseScale + ox, z * p.noiseScale + oz, p.noiseOctaves) * 2 - 1;
    const relief = Math.min(Math.max(land / Math.max(p.peakHeight, 1e-3), 0), 1);
    const detail = n * detailAmp * (0.3 + 0.7 * relief);

    // BASIN BEFORE THE RIM ENVELOPE, and the order is load-bearing. The basin
    // is pushed out along the bay bearing (`lagoonOffset`), so at the offsets
    // that actually open the bay its disc reaches the footprint edge — and
    // applied AFTER the envelope it would overwrite the rim's guaranteed
    // -rimDepth with its own -4.5 m. `heightAt` still reports -rimDepth for
    // anything outside the grid, so that leaves a 7.5 m STEP in the seabed
    // field exactly on the square boundary: a ledge in the geometry and a hard
    // ring in the §V24 tint. Ahead of the envelope the rim guarantee is
    // untouched by construction and the basin blends out into it.
    const bayDist = Math.hypot(x - bayX, z - bayZ);
    const shaped = lagoonBasin(land + coast + detail, land, detail, bayDist, R, p);

    // RIM ENVELOPE. The rim guarantee used to be bought by multiplying the
    // whole field by a dome that vanished at d=1, which is what made every
    // coastline a circle. This instead leaves everything inside `rimStart`
    // completely free and only forces the last band under water, so the
    // guarantee costs nothing where the shore actually is.
    const d = Math.hypot(x, z) / Math.max(R, 1e-3);
    const t = Math.min(Math.max((d - rimStart) / rimSpan, 0), 1);
    const edge = t * t * (3 - 2 * t);
    const h = shaped * (1 - edge) + -p.rimDepth * edge;
    return beachApron(h, p.beachBandWidth, p.beachFlatness);
  };

  const data = new Float32Array(size * size);
  const cell = (2 * R) / (size - 1);
  let max = -Infinity;
  for (let iz = 0; iz < size; iz++) {
    const z = -R + iz * cell;
    for (let ix = 0; ix < size; ix++) {
      const h = rawHeight(-R + ix * cell, z);
      data[iz * size + ix] = h;
      if (h > max) max = h;
    }
  }

  // guarantee: interior peak ≥ minPeakHeight (scale positive heights only)
  if (max <= 0) {
    throw new Error(
      `generateIslandHeightmap: island never breaks the waterline (max=${max.toFixed(2)}m) — check radius/peakHeight/rimDepth params`,
    );
  }
  if (max < p.minPeakHeight) {
    const s = p.minPeakHeight / max;
    for (let i = 0; i < data.length; i++) {
      if (data[i] > 0) data[i] *= s;
    }
  }

  const heightAt = (x: number, z: number): number => {
    const gx = (x + R) / cell;
    const gz = (z + R) / cell;
    if (gx < 0 || gz < 0 || gx > size - 1 || gz > size - 1) return -p.rimDepth;
    const x0 = Math.min(Math.floor(gx), size - 2);
    const z0 = Math.min(Math.floor(gz), size - 2);
    const fx = gx - x0;
    const fz = gz - z0;
    const i00 = data[z0 * size + x0];
    const i10 = data[z0 * size + x0 + 1];
    const i01 = data[(z0 + 1) * size + x0];
    const i11 = data[(z0 + 1) * size + x0 + 1];
    const a = i00 + (i10 - i00) * fx;
    const b = i01 + (i11 - i01) * fx;
    return a + (b - a) * fz;
  };

  return {
    data,
    size,
    worldRadius: R,
    heightAt,
    archetype,
    features,
    lagoonCenter: p.lagoonDepth > 0 ? [bayX, bayZ] : null,
  };
}

/**
 * Radial samples when locating the shoreline along a ray — resolution of the
 * search, not a look tunable, hence a named constant (comparable to gridSize).
 */
const SHORE_SAMPLES = 96;

/**
 * March a ray at `angle` from the rim INWARD and return the radius where the
 * terrain first rises above the waterline (the rim is guaranteed submerged,
 * so scanning outside-in never trips over interior noise valleys).
 * Fully-submerged rays (degenerate) return radius/2.
 */
export function findShoreRadius(hm: IslandHeightmap, angle: number): number {
  const cx = Math.cos(angle);
  const sz = Math.sin(angle);
  let prev = hm.worldRadius;
  for (let i = SHORE_SAMPLES; i >= 0; i--) {
    const r = (i / SHORE_SAMPLES) * hm.worldRadius;
    if (hm.heightAt(cx * r, sz * r) > 0) return (r + prev) / 2;
    prev = r;
  }
  return hm.worldRadius * 0.5;
}

/** central-difference gradient magnitude |∇h| (m/m) at an island-local point */
export function gradientAt(hm: IslandHeightmap, x: number, z: number): number {
  const eps = (2 * hm.worldRadius) / (hm.size - 1);
  const dhdx = (hm.heightAt(x + eps, z) - hm.heightAt(x - eps, z)) / (2 * eps);
  const dhdz = (hm.heightAt(x, z + eps) - hm.heightAt(x, z - eps)) / (2 * eps);
  return Math.hypot(dhdx, dhdz);
}
