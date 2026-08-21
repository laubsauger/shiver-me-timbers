/**
 * SPECIES DENSITY MAPS + BLUE-NOISE PLACEMENT (§T.112e, §V94, research §2d
 * "ecosystem placement"; Guerrilla's GPU procedural placement is the reference
 * — density maps derived from terrain facts, thresholded against a blue-noise
 * pattern, then resolved by footprint competition).
 *
 * THE DEFECT THIS CLOSES. T112a's stand scatter (`pineCandidates`) picked
 * `pineStandCount` seeded points on any bench and jittered trees around them.
 * That clusters, which was the win it was after, but the clusters are
 * ARBITRARY: the trees are not where a tree would be. The island therefore had
 * one plant community, distributed by a random number, on ground that T112c
 * and T112d had already given a moisture field, a curvature field, an aspect
 * and a route. A forest that ignores all four reads as scatter — the "Playmobil"
 * complaint one level up from the geometry.
 *
 * WHAT REPLACES IT: three density maps, in instances per m², each a product of
 * terrain facts read through the T112d channels (`terrainInfo.ts`):
 *
 *   PINE       concave · moist · slope < `pineSlopeLimit` · above the beach
 *              → the hollows and the drainage lines, where the water is
 *   JUNIPER    convex · bare · WINDWARD aspect
 *              → the polished knobs the ice came over, where nothing else holds
 *   MANZANITA  sunny (sky-exposed, sun-facing) · bare, PLUS a strong additive
 *              term along the distraction FORK
 *              → open gravel, and the corridor the fork walks through
 *   SNAGS      unchanged: T112c's `hm.sierra.treeline` markers on the drowned
 *              crest, which are by construction below the waterline
 *
 * NOTHING GROWS IN THE CORRIDOR. Every density is hard zero inside
 * `routeMask` or `forkMask` (T112b): the walk must stay walkable and there is
 * no foliage collision, so a shrub on the tread is a shrub you walk THROUGH,
 * which is worse than no shrub at all. Manzanita is allowed to crowd right up
 * to the mask edge — that is what makes the fork read as a way THROUGH
 * something (the user's "dense but walkable shrub corridor").
 *
 * COUNTS SCALE WITH AREA, NOT RADIUS. The candidate set is a jittered grid at
 * `vegSampleSpacing`, one cell = one chance per species, accepted with
 * probability `density · spacing²`. The expected count is therefore exactly
 * ∫ density dA over the habitat — a stratified estimate of an integral over an
 * AREA. A bigger island with no more bench gets no more trees, which is the
 * property `pinesPerRadius` (linear in R) could not express.
 *
 * WHY A JITTERED GRID IS THE BLUE NOISE. `count` uniform points in a disc is a
 * Poisson process: it clumps and holes at every scale, so raising the count to
 * fill the holes only makes the clumps denser (the same lesson groundCover.ts
 * learned). A grid with a full-cell jitter is spectrally blue by construction,
 * the density map is what says how much goes where, and the CLUSTERING is put
 * back deliberately by a per-species clump noise plus the ecology itself —
 * moisture and curvature are spatially correlated fields, so plants that
 * follow them cluster the way plants do.
 *
 * PURE over (heightmap, terrain info, params, seed) — no three types, no
 * renderer, node-test-safe (§V88). `competeFootprints` lives in pineScatter.ts
 * and is applied by `planSierraVegetation` there; this file stops at
 * candidates so the two modules stay acyclic.
 */
import { createRng } from '../state/rng';
import { sierraParams, type SierraParams } from '../params/sierra';
import { vegetationParams, type VegetationParams } from '../params/vegetation';
import { gradientAt, type IslandHeightmap } from '../island/heightmap';
import { terrainInfoFor } from '../island/terrainInfoBake';
import { decodeTerrainInfo, sampleTerrainChannel, type TerrainInfo } from '../island/terrainInfo';
import { fbm2Cpu } from '../terrain/noiseCpu';
// type-only: the understory hands its placements to the cover batches, and a
// value import would close a terrain → vegetation → terrain cycle
import type { CoverPlacement } from '../terrain/groundCoverMesh';

export type SierraSpecies = 'pine' | 'juniper' | 'manzanita';
export const SIERRA_SPECIES: readonly SierraSpecies[] = ['pine', 'juniper', 'manzanita'];

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
/** clump-noise offsets, one per species — the same field would stack them */
const CLUMP_OFFSET: Record<SierraSpecies, [number, number]> = {
  pine: [0, 0],
  juniper: [137.7, -41.3],
  manzanita: [-83.1, 219.5],
};
/**
 * Resolution of the baked fork-distance field. 128² over a 250 m island is a
 * ~3.9 m cell, and it is read bilinearly against a `manzanitaForkRange` of
 * ~14 m — the corridor's edge lands within a metre, which is finer than a
 * manzanita is wide.
 */
const FORK_FIELD = 128;

/**
 * Everything the density maps read, baked once per island. The terrain-info
 * bake is shared through `terrainInfoFor` (never rebaked), the fork samples
 * are flattened for a fast nearest-point query, and the windward bearing comes
 * from T112c's ice vector.
 */
export interface SierraHabitat {
  hm: IslandHeightmap;
  info: TerrainInfo;
  /**
   * Metres to the nearest FORK centreline, on a `FORK_FIELD` grid over
   * [−R, R]². Baked once (grid × fork samples) rather than solved per query:
   * the candidate loop asks ~30 k times and the understory loop ~100 k more,
   * and a brute-force min over a few hundred polyline samples at each of those
   * is the whole placement budget spent on one term. Null when the island has
   * no fork (no path, or a pirate island).
   */
  forkDistance: Float32Array | null;
  forkSize: number;
  forkCell: number;
  /**
   * The bearing a WINDWARD face looks down. T112c's `iceAzimuth` is the
   * direction the ice FLOWED; the stoss (windward, polished) flank is the
   * upstream one, so its downhill aspect points back along it — hence + π.
   */
  windwardAzimuth: number;
  bakeMs: number;
}

const habitatCache = new WeakMap<IslandHeightmap, SierraHabitat>();

/** one habitat bake per heightmap, shared by placement, the understory and tests */
export function sierraHabitatFor(hm: IslandHeightmap): SierraHabitat {
  let hab = habitatCache.get(hm);
  if (!hab) {
    const t0 = performance.now();
    const info = terrainInfoFor(hm);
    const R = hm.worldRadius;
    const forks = hm.path?.routes.forks ?? [];
    let samples = 0;
    for (const f of forks) samples += f.length;
    let forkDistance: Float32Array | null = null;
    const forkSize = FORK_FIELD;
    const forkCell = (2 * R) / (forkSize - 1);
    if (samples > 0) {
      forkDistance = new Float32Array(forkSize * forkSize).fill(Infinity);
      for (const f of forks) {
        for (const s of f) {
          const sx = s[0];
          const sz = s[2];
          for (let iz = 0; iz < forkSize; iz++) {
            const dz = -R + iz * forkCell - sz;
            for (let ix = 0; ix < forkSize; ix++) {
              const dx = -R + ix * forkCell - sx;
              const d = dx * dx + dz * dz;
              const i = iz * forkSize + ix;
              if (d < forkDistance[i]) forkDistance[i] = d;
            }
          }
        }
      }
      for (let i = 0; i < forkDistance.length; i++) forkDistance[i] = Math.sqrt(forkDistance[i]);
    }
    hab = {
      hm,
      info,
      forkDistance,
      forkSize,
      forkCell,
      windwardAzimuth: (hm.sierra?.iceAzimuth ?? 0) + Math.PI,
      bakeMs: performance.now() - t0,
    };
    habitatCache.set(hm, hab);
  }
  return hab;
}

/** metres to the nearest distraction-fork centreline; Infinity when there is none */
export function forkDistanceAt(hab: SierraHabitat, x: number, z: number): number {
  const f = hab.forkDistance;
  if (!f) return Infinity;
  const R = hab.hm.worldRadius;
  const n = hab.forkSize;
  const gx = Math.min(Math.max((x + R) / hab.forkCell, 0), n - 1);
  const gz = Math.min(Math.max((z + R) / hab.forkCell, 0), n - 1);
  const x0 = Math.min(Math.floor(gx), n - 2);
  const z0 = Math.min(Math.floor(gz), n - 2);
  const tx = gx - x0;
  const tz = gz - z0;
  const a = f[z0 * n + x0];
  const b = f[z0 * n + x0 + 1];
  const c = f[(z0 + 1) * n + x0];
  const d = f[(z0 + 1) * n + x0 + 1];
  return a + (b - a) * tx + ((c + (d - c) * tx) - (a + (b - a) * tx)) * tz;
}

/** 1 inside the main OR a fork corridor mask (nearest cell) — nothing grows there */
export function inCorridor(hab: SierraHabitat, x: number, z: number): boolean {
  const path = hab.hm.path;
  if (!path) return false;
  const size = hab.hm.size;
  const cell = (2 * hab.hm.worldRadius) / (size - 1);
  const ix = Math.round((x + hab.hm.worldRadius) / cell);
  const iz = Math.round((z + hab.hm.worldRadius) / cell);
  if (ix < 0 || iz < 0 || ix >= size || iz >= size) return false;
  const i = iz * size + ix;
  return path.routeMask[i] === 1 || path.forkMask[i] === 1;
}

/**
 * Per-species clump noise: 0 over the bare fraction of the field, ramping to 1
 * in the stands. This is what puts the GAPS back — a density map alone gives
 * an even wash of plants at the map's value, and real ground has thickets and
 * clearings inside one habitat.
 */
function clumpGate(x: number, z: number, species: SierraSpecies, p: SierraParams): number {
  const [ox, oz] = CLUMP_OFFSET[species];
  // WAVELENGTH FROM `pineStandSpread`, the knob that already means "how big is
  // a stand" (T112a used it as a jitter radius). One knob, one fact: a second
  // clump-scale param would be a second thing to disagree with it.
  const f = 1 / Math.max(2 * p.pineStandSpread, 1); // §V28
  const n = fbm2Cpu((x + ox) * f, (z + oz) * f, 2);
  return clamp01((n - p.vegClumpBare) / Math.max(1 - p.vegClumpBare, 1e-3));
}

/** the terrain facts one point offers, decoded to physical units */
export interface HabitatSample {
  /** exact central-difference slope (rise/run) — the predicate T112a's bench test reads */
  gradient: number;
  /** terrain-info slope channel (rise/run), the smoothed one the maps prefer */
  slopeTan: number;
  /** mean curvature 1/m, + convex */
  curvature: number;
  moisture: number;
  skyAO: number;
  /** downhill azimuth, rad */
  aspect: number;
  /** metres above the waterline */
  height: number;
  /** metres to the nearest fork centreline */
  forkDistance: number;
  corridor: boolean;
}

export function habitatSample(hab: SierraHabitat, x: number, z: number): HabitatSample {
  const info = hab.info;
  return {
    gradient: gradientAt(hab.hm, x, z),
    slopeTan: decodeTerrainInfo.slopeTan(sampleTerrainChannel(info, 'slope', x, z)),
    curvature: decodeTerrainInfo.curvaturePerMetre(sampleTerrainChannel(info, 'curvature', x, z)),
    moisture: sampleTerrainChannel(info, 'moisture', x, z),
    skyAO: sampleTerrainChannel(info, 'skyAO', x, z),
    aspect: decodeTerrainInfo.aspectRad(sampleTerrainChannel(info, 'aspect', x, z)),
    height: hab.hm.heightAt(x, z),
    forkDistance: forkDistanceAt(hab, x, z),
    corridor: inCorridor(hab, x, z),
  };
}

/**
 * How much a face looks at the sun, 0 (away) .. 1 (straight at it), on the
 * aspect channel's own convention (downhill azimuth, atan2(z, x)).
 * `vegSunAspect` is the one bearing both the pine penalty and the manzanita
 * preference read — two knobs for one fact are two things that can disagree.
 */
function sunAspect(aspect: number, p: SierraParams): number {
  return 0.5 + 0.5 * Math.cos(aspect - p.vegSunAspect);
}

/**
 * The sun-baked weight T112a's `southness` measured with a finite difference:
 * sun-facing, but only where the ground is steep enough to HAVE an aspect
 * (flat ground faces the sky, not a bearing — tan 5° reaches full weight).
 */
function sunFacing(s: HabitatSample, p: SierraParams): number {
  return sunAspect(s.aspect, p) * Math.min(s.slopeTan / 0.0875, 1);
}

/**
 * DENSITY, instances per m². The whole ecology of the island is these three
 * expressions; everything downstream is sampling and bookkeeping.
 */
export function speciesDensity(
  species: SierraSpecies,
  s: HabitatSample,
  hab: SierraHabitat,
  x: number,
  z: number,
  p: SierraParams = sierraParams,
): number {
  // §V90 + T112b: the corridor and the beach band carry nothing, ever
  if (s.corridor) return 0;
  if (s.height < p.pineMinHeight) return 0;
  const ref = Math.max(p.vegCurvatureRef, 1e-6); // §V28
  const moistFeather = Math.max(p.vegMoistureFeather, 1e-3);
  // NO EARLY-OUT ON THE CLUMP GATE. It used to be `if (clump <= 0) return 0`,
  // which is right for the two canopy species and WRONG for manzanita: the
  // fork-corridor term is deliberately additive (see below) so that it can
  // make a thicket where the base map reads zero, and a clump early-out put
  // 60% of every corridor back to bare ground — the fork stopped reading as a
  // way through anything, which is the one job the shrub layer has.
  const clump = clumpGate(x, z, species, p);

  if (species === 'pine') {
    // the EXACT bench predicate, not the smoothed channel: T112a pinned "every
    // tree sits on a bench" against `gradientAt`, and a bilinear slope byte
    // rounds the wrong way at the limit
    if (s.gradient > p.pineSlopeLimit) return 0;
    const concave = clamp01((ref - s.curvature) / (2 * ref));
    const moist = clamp01((s.moisture - p.pineMoistureMin) / moistFeather);
    // taper out over the top half of the slope band: the last few degrees of a
    // bench are already scree
    const flat = clamp01((p.pineSlopeLimit - s.slopeTan) / Math.max(p.pineSlopeLimit * 0.5, 1e-3));
    // T112a's south-aspect rule, kept and now measured off the aspect channel:
    // a sun-baked face carries `pineSouthAspectFactor` of a shaded one
    const aspectW = 1 - sunFacing(s, p) * (1 - clamp01(p.pineSouthAspectFactor));
    return p.pineDensity * concave * moist * flat * aspectW * clump;
  }

  if (species === 'juniper') {
    if (s.gradient > p.pineSlopeLimit) return 0;
    const convex = clamp01((s.curvature + ref) / (2 * ref));
    const bare = clamp01((p.juniperMoistureMax - s.moisture) / moistFeather);
    const facing = 0.5 + 0.5 * Math.cos(s.aspect - hab.windwardAzimuth);
    const wind = 1 - p.juniperWindWeight + p.juniperWindWeight * facing;
    // `juniperFraction` (T112a) survives as what its name says: the juniper
    // share of the mixed stand, now a scale on the juniper map
    return p.juniperDensity * p.juniperFraction * convex * bare * wind * clump;
  }

  if (s.gradient > p.manzanitaSlopeLimit) return 0;
  const sun =
    Math.pow(clamp01(s.skyAO), Math.max(p.manzanitaSkyExponent, 0)) *
    (1 - p.manzanitaAspectWeight + p.manzanitaAspectWeight * sunAspect(s.aspect, p));
  const bare = clamp01((p.manzanitaMoistureMax - s.moisture) / moistFeather);
  // THE FORK CORRIDOR IS ADDITIVE, not a multiplier. A multiplier cannot make
  // a thicket where the base map happens to read zero — and the corridor has
  // to be continuous or it is not a corridor, it is a hedge with a hole in it.
  const forkW = clamp01((p.manzanitaForkRange - s.forkDistance) / Math.max(p.manzanitaForkRange, 1e-3));
  return p.manzanitaDensity * clamp01(sun * bare * clump + p.manzanitaForkBoost * forkW);
}

/**
 * The published PINE-DENSITY FIELD, normalised 0..1. The under-canopy layers
 * (deadfall, cones, and any future litter shading) key off THIS rather than
 * re-deriving "where would a pine be" — two derivations of the same fact are
 * two things that can disagree, and T112d's litter layer is currently keyed to
 * a moisture proxy precisely because this did not exist yet.
 */
export function pineDensityAt(hab: SierraHabitat, x: number, z: number, p: SierraParams = sierraParams): number {
  const s = habitatSample(hab, x, z);
  return clamp01(speciesDensity('pine', s, hab, x, z, p) / Math.max(p.pineDensity, 1e-9));
}

export interface SierraPlant {
  species: SierraSpecies;
  x: number;
  z: number;
  y: number;
  scale: number;
  /** crown radius (m) at this scale — the competition's currency */
  footprint: number;
  /** T112a compatibility: the pine batch splits on this */
  juniper: boolean;
}

/** per-species scale band and crown radius at scale 1 */
function speciesSize(species: SierraSpecies, roll: number, p: SierraParams, v: VegetationParams): [number, number] {
  if (species === 'pine') {
    const scale = v.scaleMin + (v.scaleMax - v.scaleMin) * roll;
    return [scale, p.pineFootprint * scale];
  }
  if (species === 'juniper') {
    const scale = 0.8 + 0.5 * roll;
    return [scale, p.juniperFootprint * scale];
  }
  const scale = 0.75 + 0.6 * roll;
  return [scale, p.manzanitaFootprint * scale];
}

/**
 * The candidate set: a jittered grid over the footprint, one acceptance roll
 * per species per cell. Every roll is drawn UNCONDITIONALLY and in a fixed
 * order, so the stream never depends on which gate rejected — determinism must
 * not be gate-dependent (groundCover.ts learned the same thing).
 */
export function sierraCandidates(
  hm: IslandHeightmap,
  seed: number,
  p: SierraParams = sierraParams,
  v: VegetationParams = vegetationParams,
): SierraPlant[] {
  const hab = sierraHabitatFor(hm);
  const R = hm.worldRadius;
  const step = Math.max(p.vegSampleSpacing, 0.5); // §V28
  const cellArea = step * step;
  const cells = Math.floor((2 * R) / step);
  const out: SierraPlant[] = [];
  const rng = createRng(seed);
  const accept: number[] = [0, 0, 0];
  const size: number[] = [0, 0, 0];

  for (let iz = 0; iz < cells; iz++) {
    for (let ix = 0; ix < cells; ix++) {
      const jx = rng();
      const jz = rng();
      for (let k = 0; k < 3; k++) accept[k] = rng();
      for (let k = 0; k < 3; k++) size[k] = rng();
      const x = -R + (ix + jx) * step;
      const z = -R + (iz + jz) * step;
      if (x * x + z * z > R * R) continue;
      const s = habitatSample(hab, x, z);
      if (s.corridor || s.height < p.pineMinHeight) continue;
      const y = s.height;
      for (let k = 0; k < 3; k++) {
        const species = SIERRA_SPECIES[k];
        const density = speciesDensity(species, s, hab, x, z, p);
        if (density <= 0) continue;
        // expected count = Σ density·cellArea = ∫ density dA (the area law)
        if (accept[k] >= Math.min(density * cellArea, 1)) continue;
        const [scale, footprint] = speciesSize(species, size[k], p, v);
        out.push({ species, x, z, y, scale, footprint, juniper: species === 'juniper' });
      }
    }
  }
  return out;
}

/**
 * ∫ density dA over the footprint (m² of "one plant's worth of habitat"), by
 * the same stratified rule the placement uses but without the acceptance roll.
 * Tests use it to assert the AREA LAW: counts track this, not the radius.
 */
export function speciesHabitatIntegral(
  hm: IslandHeightmap,
  species: SierraSpecies,
  p: SierraParams = sierraParams,
): number {
  const hab = sierraHabitatFor(hm);
  const R = hm.worldRadius;
  const step = Math.max(p.vegSampleSpacing, 0.5);
  const cells = Math.floor((2 * R) / step);
  let sum = 0;
  for (let iz = 0; iz < cells; iz++) {
    for (let ix = 0; ix < cells; ix++) {
      const x = -R + (ix + 0.5) * step;
      const z = -R + (iz + 0.5) * step;
      if (x * x + z * z > R * R) continue;
      const s = habitatSample(hab, x, z);
      sum += Math.min(speciesDensity(species, s, hab, x, z, p), 1 / (step * step)) * step * step;
    }
  }
  return sum;
}

// ── understory + litter (the sierra ground-cover set) ──────────────────────

export interface SierraUnderstory {
  /** dry bunchgrass on the moist flats */
  bunchgrass: CoverPlacement[];
  /** fallen limbs under the canopy — keyed to the PINE density field */
  deadfall: CoverPlacement[];
  /** cones, ditto, denser and smaller */
  cones: CoverPlacement[];
}

/**
 * The three small-instance layers, placed on the same jittered grid at
 * `understorySpacing`. Deadfall and cones read `pineDensityAt`, so the litter
 * IS under the pines rather than under a proxy — that is the coordination
 * T112d's `litterMoisture` comment was waiting for. Nothing is placed in the
 * corridor: the tread is where the player walks, and the implied trail is a
 * SHADING layer (T112d's wear), not something to trip over.
 */
export function sierraUnderstoryPlacements(
  seed: number,
  hm: IslandHeightmap,
  p: SierraParams = sierraParams,
): SierraUnderstory {
  const hab = sierraHabitatFor(hm);
  const R = hm.worldRadius;
  const step = Math.max(p.understorySpacing, 0.25); // §V28
  const cellArea = step * step;
  const cells = Math.floor((2 * R) / step);
  const rng = createRng(seed);
  const bunchgrass: CoverPlacement[] = [];
  const deadfall: CoverPlacement[] = [];
  const cones: CoverPlacement[] = [];
  const roll: number[] = [0, 0, 0];

  for (let iz = 0; iz < cells; iz++) {
    for (let ix = 0; ix < cells; ix++) {
      const jx = rng();
      const jz = rng();
      for (let k = 0; k < 3; k++) roll[k] = rng();
      const sizeRoll = rng();
      const yawRoll = rng();
      const tintRoll = rng();
      const phaseRoll = rng();
      const x = -R + (ix + jx) * step;
      const z = -R + (iz + jz) * step;
      if (x * x + z * z > R * R) continue;
      const s = habitatSample(hab, x, z);
      if (s.corridor || s.height < p.pineMinHeight) continue;
      if (s.gradient > p.understorySlopeLimit) continue;
      const at = (scaleMin: number, scaleMax: number, tintBase: number): CoverPlacement => ({
        position: [x, s.height, z],
        scale: scaleMin + (scaleMax - scaleMin) * sizeRoll,
        yaw: yawRoll * Math.PI * 2,
        // the sierra set lives at the DRY end of the shared cover palette
        // (groundCoverMesh.ts crosses to `coverDryColor` above tint 0.72) —
        // bunchgrass is straw and deadfall is bleached, not tropical green
        tint: tintBase + (1 - tintBase) * tintRoll,
        phase: phaseRoll * Math.PI * 2,
      });
      const pine = clamp01(speciesDensity('pine', s, hab, x, z, p) / Math.max(p.pineDensity, 1e-9));
      const grassD = clamp01(s.moisture * clumpGate(x, z, 'pine', p)) * p.understoryGrassDensity;
      if (roll[0] < Math.min(grassD * cellArea, 1)) bunchgrass.push(at(0.75, 1.35, 0.74));
      if (roll[1] < Math.min(pine * p.understoryDeadfallDensity * cellArea, 1)) deadfall.push(at(0.8, 1.4, 0.8));
      if (roll[2] < Math.min(pine * p.understoryConeDensity * cellArea, 1)) cones.push(at(0.7, 1.2, 0.85));
    }
  }
  return { bunchgrass, deadfall, cones };
}
