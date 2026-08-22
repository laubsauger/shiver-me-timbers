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
 * - T130 profile (SIERRA ONLY): the same operator at the scale of the island
 *   rather than of the sand — `profileApron` below. Also monotone and also
 *   zero at h = 0, so it lowers the island without moving its shoreline.
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
  archetypePeak,
  combineFeatures,
  pickArchetype,
  type ArchetypeName,
  type Feature,
} from './archetypes';
import {
  buildSierraShape,
  emitTreeline,
  isSierraArchetype,
  sierraPeak,
  type SierraMeta,
  type SierraShape,
} from './sierraArchetypes';
import {
  buildErosionContext,
  defaultErosionPasses,
  erodeAndShape,
  insertPassBefore,
  type BakeStats,
  type ErosionBake,
} from './erosion';
import { pathCarvePass, type IslandPath, type PathCarve } from './pathCarve';
import { defaultPathHints } from './pathGraph';
import { SIERRA_SLICE_ARCHETYPES } from './sierraArchetypes';
import { sierraParams } from '../params/sierra';

/** structural subset of params/island.ts `IslandParams` used by generation */
export interface IslandHeightmapParams {
  radius: number;
  gridSize: number;
  peakHeight: number;
  minPeakHeight: number;
  noiseScale: number;
  /** detail relief as a SLOPE budget (m/m) — see params/island.noiseSlope */
  noiseSlope: number;
  noiseOctaves: number;
  /** fraction of the footprint the archetype's features may occupy */
  featureExtent: number;
  /** metres over which two features fuse instead of creasing */
  featureBlend: number;
  /** coastline noise: world frequency (1/m) and its own slope budget (m/m) */
  coastNoiseScale: number;
  coastNoiseSlope: number;
  /** fraction of the radius inside which the rim envelope does not act */
  rimStart: number;
  beachBandWidth: number;
  beachFlatness: number;
  beachLandGuard: number;
  /** authored level shelf — see terrace below; 0 disables */
  terraceRadius: number;
  terraceFeather: number;
  terraceHeight: number;
  terraceCompress: number;
  terraceToe: number;
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
  /**
   * T112c: sierra islands run the erosion pass stage after the analytic
   * composition. 'shapeOnly' keeps the old analytic result reachable (A/B in
   * tests); undefined = 'full'. Pirate islands never enter the stage.
   */
  erosion?: 'full' | 'shapeOnly';
  /**
   * T112b: island-local bearings (rad) the path graph is authored against —
   * the landing faces `pathApproach` (where the raft comes from), the exit
   * and the Journey tilt face `pathNext` (the next slice island). Set by
   * `generateSierraSites`; undefined draws both from the seed.
   */
  pathApproach?: number;
  pathNext?: number;
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
  /**
   * Sierra-only metadata (§T.99): the seeded axis, terrace count and the
   * treeline markers for dead pines standing in the water. Undefined on every
   * pirate island.
   */
  sierra?: SierraMeta;
  /**
   * T112c: the erosion bake's debris layer (m, talus thickness per cell —
   * T112d/f read it) and its performance.now() timings. Undefined when the
   * stage did not run (pirate islands, 'shapeOnly').
   */
  erosion?: { debris: Float32Array; bakeStats: BakeStats };
  /**
   * T112b: the authored route — distance to the nearest centreline (m, full
   * grid), corridor masks, POIs and the route polylines with final y. Slice
   * islands only (sierra, radius ≥ `pathMinRadius`, the erosion stage ran).
   */
  path?: IslandPath;
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

/**
 * BEACH APRON — slope compression around the waterline, as the INTEGRAL of a
 * slope multiplier rather than as a multiply on the height.
 *
 * WHY THE OBVIOUS FORM IS WRONG, measured. The old apron was
 * `h·(f + (1−f)·S(|h|/b))`. Differentiate it: the output slope is
 * `s·(f + |h|·f′)`, not `s·f`. That second term means the compression is only
 * real in a vanishing band at exactly h = 0, and it goes the WRONG WAY as soon
 * as you leave it — at h = 1.5 m the ground came out at 23° where the raw
 * terrain was 20°, i.e. the apron STEEPENED the ground just above the
 * waterline, which is precisely the strip the beach is made of. Measured
 * horizontal run from the waterline to +2 m: 6.0 m, and widening the band from
 * 3 m to 14 m only bought 12.5 m of it. The user's note — "a beach doesn't go
 * down with 12 or 15 or 20 or 25 degrees" — was describing this exactly.
 *
 * Integrating instead makes the output slope `s·g(|h|)` by construction, with
 * g ramping f → 1 across the band, so the grade is what the number says and
 * the run follows from it. With the §V43 noise budget leaving ~9° of natural
 * grade near the shore, f = 0.15 lands the sand at about 3° over ~35 m.
 *
 * Closed form of ∫₀^h g, with S the smoothstep 3t²−2t³:
 *   h ≤ b:  f·h + (1−f)·b·((h/b)³ − (h/b)⁴/2)
 *   h > b:  h − (1−f)·b/2            (slope exactly 1× again, a constant drop)
 *
 * Odd in h, so the submerged side gets the same shelf — that is the shore
 * break — and the sign of h is never changed, which is what keeps the
 * shoreline where the field put it.
 */
function beachApron(h: number, land: number, p: IslandHeightmapParams): number {
  // A CLIFF IS NOT A BEACH, and a wide band makes that distinction load-
  // bearing. At the old 3 m band the apron only ever touched the immediate
  // waterline, so nothing else noticed it. At the 10 m band a beach actually
  // needs, it also swept up every `sheer` headland wall crossing the sea —
  // measured, it took the fraction of shoreline steeper than 45° to EXACTLY
  // ZERO on every island in the world and erased the §V43 "a cliff somewhere
  // on every island" contract in one line. Gate on the ARCHETYPE's landmass,
  // the same way `lagoonBasin` does and for the same reason: the features are
  // what know whether this is a beach or the foot of a wall, and the noise is
  // what would lie about it.
  const guard = Math.max(p.beachLandGuard, 1e-3); // §V28 floored divisor
  const gate = 1 - smoothstep01(land / guard);
  const f = p.beachFlatness + (1 - p.beachFlatness) * (1 - gate);
  const b = Math.max(p.beachBandWidth, 1e-3); // §V28 floored divisor
  const a = Math.abs(h);
  const s = Math.sign(h);
  if (a >= b) return s * (a - (1 - f) * b * 0.5);
  const t = a / b;
  return s * (f * a + (1 - f) * b * (t * t * t - (t * t * t * t) * 0.5));
}

/**
 * T130 PROFILE — HEIGHT EARNED OVER DISTANCE, not at the waterline.
 *
 * WHAT WAS WRONG, measured from the raft's own eye (1.6 m) rather than in
 * plan. Sailing up to a 250 m dome: the horizon angle 20 m off the beach was
 * 23°, the ground was 27 m up 50 m inland and 45 m up 100 m inland, and the
 * whole run from the waterline to +5 m was 13 m of shore. From a deck 1.6 m
 * above the sea that is a WALL. §V90's beach test passed the entire time,
 * because it only ever asked about the FIRST METRE of rise — 8 m of run to
 * +2 m is a fine 14° first metre and a hopeless landfall.
 *
 * WHY THE ISLAND WAS SHAPED THAT WAY, and why it is not the archetype's
 * fault. `sinkOpenWater` (sierraArchetypes.ts) takes the empty water down 10 m
 * so a ridge does not grow noise islets, so the SHORELINE sits where the raw
 * landmass is ~7.5 m — and on the dome's `(1 − u²)^k` crown that contour is at
 * u ≈ 0.86, i.e. the waterline cuts the crown high on its own shoulder, right
 * where the curve is steepest. The island has no foot: it starts at the
 * steepest ground it owns.
 *
 * THE OPERATOR IS `beachApron`'S, AT THE SCALE OF THE ISLAND INSTEAD OF THE
 * SAND. Integrate a slope multiplier `g(h) = a + (1−a)·S(h/H)` so the output
 * slope is `s·g(h)` BY CONSTRUCTION (the same reason beachApron integrates —
 * multiplying the height instead makes the compression real only in a
 * vanishing band at h = 0 and steepens the ground just above it). Closed form,
 * with S the smoothstep 3t² − 2t³:
 *   h ≤ H:  a·h + (1−a)·H·((h/H)³ − (h/H)⁴/2)
 *   h > H:  h − (1−a)·H/2          (slope exactly 1× again: a constant drop)
 *
 * PROPERTIES IT CARRIES. Monotone (g ≥ a > 0), so it creates no new waterline
 * crossing and cannot reorder any two heights — every §V90/§T.112b property
 * that is stated on the shoreline or on a route's slope keeps holding in the
 * same places. Zero at h = 0, so THE SHORELINE DOES NOT MOVE: this makes the
 * island lower, never smaller. Identity above the band bar a constant, so the
 * crown keeps its own profile and only rides lower.
 *
 * LAND ONLY, deliberately. `beachApron` is odd in h because a shore break is
 * symmetric over ±12 m of sand; this band is tens of metres and its odd twin
 * would lift the seabed with it — the drowned crest's treeline stands in
 * 0.4-5 m of water (§T.99), the cirque lagoon is 2.2 m deep and the raft's
 * berth needs 1.5 m (§T.125). Those depths are measured contracts; the
 * complaint was about height above the water, so that is all this touches.
 *
 * @param h    height (m) after the archetype, noise and the beach apron
 * @param toe  slope multiplier at the waterline (sierra.profileToeGrade)
 * @param rise the band (m) over which it ramps back to 1
 */
function profileApron(h: number, toe: number, rise: number): number {
  if (h <= 0) return h;
  const H = Math.max(rise, 1e-3); // §V28 floored divisor
  const a = Math.min(Math.max(toe, 0.02), 1);
  if (h >= H) return h - (1 - a) * H * 0.5;
  const t = h / H;
  return a * h + (1 - a) * H * (t * t * t - t * t * t * t * 0.5);
}

/**
 * TERRACE — the level ground the composition could not previously express.
 *
 * Every archetype feature is a monotone radial falloff merged with `smoothMax`,
 * so the field can only ADD land and every primitive is flat only exactly at
 * its own summit. There was no way to say "this ground is level at +5 m", and
 * the consequence was measurable: across the entire shipped world the largest
 * contiguous patch above 1.5 m with a gradient under 6° was 222 m² at a 4.6 m
 * inscribed radius. The ship is 35 m long. Nowhere in the world could a hut
 * have stood level.
 *
 * THE OPERATOR IS `beachApron`'S, KEYED ON POSITION INSTEAD OF ON |h|: compress
 * the departure from a target, do not clamp to it. A clamp leaves a lip
 * wherever the land was already above the target and a step at the disc edge;
 * a compression blended over a feather has neither, by construction rather
 * than by tuning.
 *
 * THE TOE GATE IS THE SAFETY PROPERTY, and it is the dual of `lagoonBasin`'s.
 * The basin lerps toward a NEGATIVE target and guarantees it can never create
 * dry land. This lerps toward a POSITIVE one, so ungated it lifts shallow
 * water into land and MOVES THE SHORELINE — measured, it added 4,000 m² of
 * land doing exactly that. Ramping the weight from 0 at `toe` to 1 at `2·toe`
 * makes the operator the identity at and below the waterline, so the shoreline
 * cannot move however the shelf is tuned.
 *
 * MONOTONE IN h, WHICH IS THE PROPERTY THAT MATTERS, and it constrains the
 * params. With W(h) the toe ramp, the map is
 *   f(h) = T + (h−T)·(1 − W(h)·(1−c))
 *   f′(h) = (1 − W(1−c)) − (h−T)·W′·(1−c)
 * The first term is ≥ c > 0. The second can only turn f′ negative where
 * h > T, and W′ is non-zero only on h ∈ [toe, 2·toe] — so requiring
 * T ≥ 2·toe puts the whole ramp below the target and f′ > 0 everywhere.
 * `terraceHeight` is floored against that below. Monotone ⇒ no new waterline
 * crossings, which is the same guarantee the apron carries and the reason
 * both are safe to run before the rim envelope.
 *
 * @param h  height (m) here, after the archetype, noise and basin
 * @param d  distance (m) from the shelf CENTRE (see findTerraceSite)
 */
function terrace(h: number, d: number, R: number, p: IslandHeightmapParams): number {
  if (p.terraceRadius <= 0) return h;
  const toe = Math.max(p.terraceToe, 1e-3); // §V28 floored divisor
  // the monotonicity constraint derived above, enforced rather than trusted
  const target = Math.max(p.terraceHeight, 2 * toe);
  const feather = Math.max(p.terraceFeather * R, 1e-3); // §V28 floored divisor
  const disc = 1 - smoothstep01((d - p.terraceRadius * R) / feather);
  if (disc <= 0) return h;
  const w = disc * smoothstep01((h - toe) / toe);
  if (w <= 0) return h;
  return target + (h - target) * (1 - w * (1 - p.terraceCompress));
}

/** candidate shelf centres scanned — resolution, not a look tunable */
const TERRACE_SCAN_ANGLES = 48;
/** radial stations per bearing in that scan */
const TERRACE_SCAN_RINGS = [0.3, 0.4, 0.5, 0.6] as const;
/** ring samples used to score one candidate */
const TERRACE_SCORE_SAMPLES = 20;

/**
 * WHERE THE SHELF GOES — the gentlest ground already near the target
 * elevation, MEASURED, exactly as `findBayBearing` measures where the bay is
 * (§V71: resolve against the real surface, never an authored constant that
 * happened to match one seed).
 *
 * Scoring on |h − target| rather than on slope is deliberate: the terrace can
 * flatten any slope, but it cannot move ground a long way vertically without
 * the feather turning into a wall, so the cheap shelf is the one already at
 * roughly the right height. The waterline penalty keeps it off ground the toe
 * gate would make it inert on anyway.
 */
function findTerraceSite(
  rawHeight: (x: number, z: number) => number,
  R: number,
  p: IslandHeightmapParams,
): [number, number] {
  const target = Math.max(p.terraceHeight, 2 * Math.max(p.terraceToe, 1e-3));
  const rad = p.terraceRadius * R;
  let bestX = 0;
  let bestZ = 0;
  let bestScore = Infinity;
  for (let i = 0; i < TERRACE_SCAN_ANGLES; i++) {
    const a = (i / TERRACE_SCAN_ANGLES) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    for (const frac of TERRACE_SCAN_RINGS) {
      const cx = ca * frac * R;
      const cz = sa * frac * R;
      let score = 0;
      for (let k = 0; k < TERRACE_SCORE_SAMPLES; k++) {
        const aa = (k / TERRACE_SCORE_SAMPLES) * Math.PI * 2;
        // two rings, so a candidate straddling a ridge scores worse than one
        // sitting in a bowl of the same mean height
        for (const rr of [0.45, 0.85]) {
          const h = rawHeight(cx + Math.cos(aa) * rad * rr, cz + Math.sin(aa) * rad * rr);
          // below the toe the terrace is inert, so a candidate hanging over
          // water is not merely worse, it is a shelf that would not exist
          score += Math.abs(h - target) + (h < p.terraceToe ? target * 8 : 0);
        }
      }
      if (score < bestScore) {
        bestScore = score;
        bestX = cx;
        bestZ = cz;
      }
    }
  }
  return [bestX, bestZ];
}

/** the analytic composition + (sierra) the erosion bake, split so a loader can yield */
interface IslandBuild {
  /** null when the island does not enter the erosion stage */
  bake: ErosionBake | null;
  finalize(): IslandHeightmap;
}

function buildIsland(
  seed: number,
  params: IslandHeightmapParams,
  avoidArchetypes: readonly ArchetypeName[],
): IslandBuild {
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
  const blend = Math.max(p.featureBlend, 1e-3); // §V28 floored divisor
  let familyPeak: number;
  let features: Feature[];
  let sierra: SierraShape | null = null;
  if (isSierraArchetype(archetype)) {
    // SIERRA BRANCH (§T.99): a sierra family owns its landmass term outright —
    // see sierraArchetypes.ts for why a terrace or a drowned crest cannot be a
    // feature. No headlands and no stacks: those are the pirate coast's
    // cliffs, and §V90 wants a DG-sand beach continuous from the waterline.
    sierra = buildSierraShape(archetype, rng, R * p.featureExtent, p.peakHeight, blend);
    familyPeak = sierraPeak(archetype, p.peakHeight);
    features = sierra.features;
  } else {
    // Landmass first, then the stacks standing off it. Both go through the same
    // smooth-max, so a stack that happens to land against a headland fuses with
    // it instead of creasing, and one in open water stays an isolated column.
    // Headlands and stacks scale off the FAMILY's relief, not the island's raw
    // `peakHeight` — they are fractions of "how tall is this island", and a
    // cliff family whose walls were sized off the flat number would have a
    // fortress-rock skyline with sandbar cliffs at the water.
    familyPeak = archetypePeak(archetype, p.peakHeight);
    features = [
      ...buildArchetype(archetype, rng, R * p.featureExtent, p.peakHeight),
      ...buildHeadlands(archetype, rng, {
        count: p.headlandCount,
        offset: R * p.headlandOffset,
        radiusMin: R * p.headlandRadiusMin,
        radiusMax: R * p.headlandRadiusMax,
        heightMin: familyPeak * p.headlandHeightMin,
        heightMax: familyPeak * p.headlandHeightMax,
        edgeFraction: p.headlandEdge,
      }),
      ...buildSeaStacks(archetype, rng, {
        maxCount: p.seaStackCount,
        ring: R * p.seaStackRing,
        radiusMin: R * p.seaStackRadiusMin,
        radiusMax: R * p.seaStackRadiusMax,
        heightMin: familyPeak * p.seaStackHeightMin,
        heightMax: familyPeak * p.seaStackHeightMax,
      }),
    ];
  }
  // SLOPE BUDGET, NOT A FRACTION OF PEAK (§V43). Amplitude used to be
  // `peakHeight × strength`, and `peakHeight` scales with radius while these
  // frequencies are WORLD-space and do not — so noise slope grew linearly with
  // island size and every "make it bigger" move made the island strictly
  // steeper. At R = 260 the detail field was ±20.8 m over a 29 m wavelength,
  // a 55° slope laid over every square metre INCLUDING the flat ground the
  // archetypes had already built: `mesaCliff` at that size has 16,865 m² of
  // sub-6° ground with the noise off and 134 m² — one grid cell — with it on.
  // `slope × (halfWavelength)` is radius-independent by construction, so the
  // shape of an island stops depending on its size.
  const coastAmp = p.coastNoiseSlope * (0.5 / Math.max(p.coastNoiseScale, 1e-6));
  const detailAmp = p.noiseSlope * (0.5 / Math.max(p.noiseScale, 1e-6));
  const rimStart = Math.min(Math.max(p.rimStart, 0.05), 0.99);
  const rimSpan = Math.max(1 - rimStart, 1e-3); // §V28 floored divisor

  // T130: the band `profileApron` ramps over, as a fraction of the FAMILY's
  // peak rather than in metres — §V43's lesson (a fixed-metre band would
  // flatten a 70 m filler islet outright and be invisible on the Half Dome).
  // 0 on every pirate island and whenever the knob is off, which is what
  // keeps the term out of the pinned pirate grids.
  const profileRise =
    sierra !== null && sierraParams.profileEnabled > 0
      ? Math.max(sierraParams.profileRiseFraction * familyPeak, 1e-3)
      : 0;

  // basin centre: out along the archetype's own opening, so the lagoon is a
  // COVE (open to the sea, sheltered on three sides) instead of a crater
  const bayAngle = p.lagoonDepth > 0 ? findBayBearing(features, R, blend) : 0;
  const bayX = Math.cos(bayAngle) * p.lagoonOffset * R;
  const bayZ = Math.sin(bayAngle) * p.lagoonOffset * R;

  // Pre-terrace field. Split out so `findTerraceSite` can probe the same
  // surface the grid will be built from — the shelf is sited against the real
  // field, not against a guess about where the archetype put its land (§V71).
  const landField = (x: number, z: number): { h: number; land: number; detail: number } => {
    const land = sierra ? sierra.landAt(x, z) : combineFeatures(features, x, z, blend);

    // COASTLINE NOISE at absolute amplitude. The old field multiplied noise by
    // the dome, which zeroed it exactly at the rim — the one place coastline
    // shape lives — and measured a shore-radius variation of only 10-16%.
    // Out here the features have already died to ~0, so this term alone
    // decides where the land meets the water: coves, spits and headlands.
    const coast = (fbm2Cpu(x * p.coastNoiseScale + cx, z * p.coastNoiseScale + cz, 3) * 2 - 1) * coastAmp;

    // surface detail, weighted up on high ground so summits are broken and
    // the beach apron stays walkable
    const n = fbm2Cpu(x * p.noiseScale + ox, z * p.noiseScale + oz, p.noiseOctaves) * 2 - 1;
    const relief = Math.min(Math.max(land / Math.max(familyPeak, 1e-3), 0), 1);
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
    // APRON HERE — ON THE NATURAL FIELD, AHEAD OF THE BASIN AND THE ENVELOPE.
    // It used to run dead last, which was harmless only because its band was
    // 3 m. At the 10 m band a beach needs, running last meant it also
    // compressed (a) the authored lagoon floor, crushing the basin's -4.5 m to
    // -1.26 m so the lagoon drained, and (b) the envelope's guaranteed
    // -rimDepth, so the deepest water anywhere inside the footprint became
    // ~2.6 m and `findLagoonAnchorage` could not find a berth she would float
    // at. Both are the same mistake: the apron shapes the BEACH, so it belongs
    // on the field the beach is made of, before anything authored is written
    // over the top of it.
    // T130: the island's own profile, after the sand's. Sierra only — a
    // pirate island's grid is pinned byte-for-byte (tests/sierra.test.ts).
    const beached = beachApron(land + coast + detail, land, p);
    return { h: profileRise > 0 ? profileApron(beached, sierraParams.profileToeGrade, profileRise) : beached, land, detail };
  };

  // The basin is a WATER feature and the terrace a LAND one, so the shelf is
  // sited on the field BEFORE the basin. Siting it after coupled the two: the
  // basin moves the surface it probes, so turning the basin on or off relocated
  // the shelf and changed land heights on the far side of the island by ~1 mm —
  // enough to break the basin's own "can never make land taller" guarantee for
  // a reason that had nothing to do with the basin. The terrace's toe gate
  // already makes it inert over water, so nothing is lost by ignoring the
  // basin here.
  const preTerrace = (x: number, z: number): number => landField(x, z).h;

  // WHERE THE SHELF GOES — measured off the field above, once, before the grid
  // loop. Costs one 48×4×40 probe sweep at build time (~4 ms on a 260 m
  // island) and nothing at all per frame.
  const [terraceX, terraceZ] =
    p.terraceRadius > 0 ? findTerraceSite(preTerrace, R, p) : [0, 0];

  const rawHeight = (x: number, z: number): number => {
    const { h: beached, land, detail } = landField(x, z);
    const bayDist = Math.hypot(x - bayX, z - bayZ);
    const basined0 = lagoonBasin(beached, land, detail, bayDist, R, p);
    // the drowned crest (sierraArchetypes.ts) — a second negative-target term
    // with the basin's own guarantee, so it sits where the basin sits
    const basined = sierra?.shape ? sierra.shape(basined0, land, x, z) : basined0;
    // TERRACE BEFORE THE RIM ENVELOPE, for the reason the basin is: applied
    // after, its feather would overwrite the envelope's guaranteed -rimDepth
    // near the footprint edge and leave a step in the seabed field exactly on
    // the square boundary (§T.52's 7.5 m ledge, by the same route). Ahead of
    // it the rim guarantee is untouched by construction.
    const shaped = terrace(basined, Math.hypot(x - terraceX, z - terraceZ), R, p);

    // RIM ENVELOPE. The rim guarantee used to be bought by multiplying the
    // whole field by a dome that vanished at d=1, which is what made every
    // coastline a circle. This instead leaves everything inside `rimStart`
    // completely free and only forces the last band under water, so the
    // guarantee costs nothing where the shore actually is.
    const d = Math.hypot(x, z) / Math.max(R, 1e-3);
    const t = Math.min(Math.max((d - rimStart) / rimSpan, 0), 1);
    const edge = t * t * (3 - 2 * t);
    return shaped * (1 - edge) + -p.rimDepth * edge;
  };

  const data = new Float32Array(size * size);
  const cell = (2 * R) / (size - 1);
  let max = -Infinity;
  // T112c: the archetype's landmass is the erosion stage's UPLIFT mask, read
  // off during the same sweep rather than evaluated a second time
  const erode = sierra !== null && p.erosion !== 'shapeOnly' && sierraParams.erosionEnabled > 0;
  const uplift = erode ? new Float64Array(size * size) : null;
  for (let iz = 0; iz < size; iz++) {
    const z = -R + iz * cell;
    for (let ix = 0; ix < size; ix++) {
      const x = -R + ix * cell;
      const h = rawHeight(x, z);
      data[iz * size + ix] = h;
      if (h > max) max = h;
      if (uplift && sierra) {
        uplift[iz * size + ix] = Math.min(Math.max(sierra.landAt(x, z) / sierra.peak, 0), 1);
      }
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

  // ── T112c EROSION PASS STAGE ─────────────────────────────────────────────
  // After the peak floor, on the finished analytic grid: the archetype is the
  // uplift, the passes own the silhouette from here. `heightAt` below reads
  // the grid the stage wrote, so it stays the one truth for everything.
  let bake: ErosionBake | null = null;
  let carve: PathCarve | null = null;
  let field: { bedrock: Float64Array; debris: Float64Array } | null = null;
  if (erode && sierra && uplift) {
    const bedrock = Float64Array.from(data);
    const debris = new Float64Array(size * size);
    field = { bedrock, debris };
    const name = sierra.meta.name;
    const streamIters =
      name === 'drownedRidge'
        ? sierraParams.streamItersRidge
        : name === 'cirque'
          ? sierraParams.streamItersCirque
          : sierraParams.streamItersDome;
    const ctx = buildErosionContext({
      size,
      cell,
      worldRadius: R,
      peak: sierra.peak,
      iceAzimuth: sierra.meta.iceAzimuth,
      uplift,
      h0: Float64Array.from(data),
      noiseOffset: [ox, oz],
      p: sierraParams,
      streamIters,
    });
    // T112b: the path carve goes between rockfallThermal and thermalSmooth,
    // on the slice islands only (a filler islet has no station to walk to)
    const passes = defaultErosionPasses(ctx);
    const routed =
      sierraParams.pathEnabled > 0 &&
      R >= sierraParams.pathMinRadius &&
      (SIERRA_SLICE_ARCHETYPES as readonly string[]).includes(name);
    if (routed) {
      const hints = defaultPathHints(seed);
      carve = pathCarvePass({
        seed,
        hints: { approach: p.pathApproach ?? hints.approach, next: p.pathNext ?? hints.next },
      });
      insertPassBefore(passes, 'thermalSmooth', carve.pass);
    }
    bake = erodeAndShape({ size, cell, bedrock, debris }, ctx, passes);
  }

  const finalize = (): IslandHeightmap => {
    if (bake && !bake.done) throw new Error('generateIslandHeightmap: erosion bake not finished');
    let erosion: IslandHeightmap['erosion'];
    if (bake && field) {
      for (let i = 0; i < data.length; i++) data[i] = field.bedrock[i] + field.debris[i];
      erosion = { debris: Float32Array.from(field.debris), bakeStats: bake.stats };
    }
    const hm = assemble(erosion);
    if (carve) hm.path = carve.publish(hm.heightAt);
    return hm;
  };

  const assemble = (erosion: IslandHeightmap['erosion']): IslandHeightmap => {
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
      // the treeline is read off the FINISHED grid (after the peak floor and
      // the erosion stage), so a marker is where the water actually is that
      // shallow
      sierra: sierra
        ? {
            ...sierra.meta,
            treeline: sierra.treelineSegment ? emitTreeline(heightAt, sierra.treelineSegment) : [],
          }
        : undefined,
      erosion,
    };
  };

  return { bake, finalize };
}

export function generateIslandHeightmap(
  seed: number,
  params: IslandHeightmapParams,
  /** archetypes the caller wants avoided — the archipelago spreads silhouettes */
  avoidArchetypes: readonly ArchetypeName[] = [],
): IslandHeightmap {
  const b = buildIsland(seed, params, avoidArchetypes);
  b.bake?.finish();
  return b.finalize();
}

/**
 * CHUNKED twin of `generateIslandHeightmap` (T112c): `step(msBudget)` does
 * the analytic composition on its first call (one piece — it is a single
 * sweep) and then erosion pass steps until the budget is spent; returns true
 * once finished, after which `result()` assembles the island. Same code path
 * as the one-shot, so the grids are byte-identical (pinned in
 * tests/erosion.test.ts).
 */
export function generateIslandHeightmapChunked(
  seed: number,
  params: IslandHeightmapParams,
  avoidArchetypes: readonly ArchetypeName[] = [],
): { advance(msBudget: number): boolean; result(): IslandHeightmap } {
  let b: IslandBuild | null = null;
  let out: IslandHeightmap | null = null;
  return {
    advance(msBudget) {
      if (!b) b = buildIsland(seed, params, avoidArchetypes);
      if (b.bake && !b.bake.done) return b.bake.advance(msBudget);
      return true;
    },
    result() {
      if (!b) {
        b = buildIsland(seed, params, avoidArchetypes);
        b.bake?.finish();
      }
      if (!out) out = b.finalize();
      return out;
    },
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
