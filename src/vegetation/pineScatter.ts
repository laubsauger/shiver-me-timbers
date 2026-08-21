/**
 * Sierra vegetation (§T.99, §T.112a, §T.112e): the ONE conifer-family material
 * and the assembly of every plant batch on a sierra island — pines, junipers,
 * manzanita, and the dead snags standing in the water on a drowned ridge's
 * treeline. Reuses the palm stack wholesale — `scatterPalms` for the instance
 * buffers, `applyWindSway` for the motion (§V95: there is ONE wind system),
 * the same `IslandPalms` contract so island.ts swaps one for the other by
 * archetype family and nothing downstream notices.
 *
 * WHERE THE PLANTS COME FROM (§T.112e). The candidate set is
 * `sierraCandidates` in sierraScatter.ts — three ecological density maps read
 * off T112d's terrain-info channels, sampled on a jittered grid. This file
 * owns the second half: FOOTPRINT COMPETITION, which is what turns a density
 * sample into a stand that looks grown, and the batching.
 *
 * Placement rules (pinned by tests/sierraVegetation.test.ts + tests/sierra.ts):
 * - pines in the moist concave hollows, junipers on the bare windward convex
 *   knobs, manzanita on sunny bare gravel and thick along the distraction fork
 * - NOTHING inside the route or fork corridor masks (T112b) — the walk stays
 *   walkable and there is no foliage collision
 * - dead pines exactly at the heightmap's `sierra.treeline` markers, feet on
 *   the seabed, so the trunk stands in water and the top clears it
 * The counts scale with the HABITAT AREA the island actually offers, so an
 * island with little level ground gets a thin stand rather than a placement
 * that throws.
 */
import * as THREE from 'three/webgpu';
import { attribute, float, mix, step, uniform, uv } from 'three/tsl';
import { createRng } from '../state/rng';
import { sierraParams, type SierraParams } from '../params/sierra';
import { vegetationParams, type VegetationParams } from '../params/vegetation';
import { islandParams } from '../params/island';
import { gradientAt, type IslandHeightmap } from '../island/heightmap';
import { palmLodCount, type IslandPalms } from '../island/palms';
import { scatterPalms, type PlacementFn } from './scatter';
import { applyWindSway, type WindSway } from './windSway';
import { buildPineGeometry } from './pineGeometry';
import { buildJuniperGeometry } from './juniperGeometry';
import { buildManzanitaGeometry } from './manzanitaGeometry';
import {
  createFoliageLightUniforms,
  foliageEmissive,
  updateFoliageLightUniforms,
  type FoliageLightUniforms,
} from './foliage';
import { sierraCandidates, type SierraPlant } from './sierraScatter';

/** re-rolls per point before giving up — algorithm bound, not a look tunable */
const PLACEMENT_ATTEMPTS = 96;
/** bench-area probe resolution */
const BENCH_PROBES = 48;
const JUNIPER_SEED_OFFSET = 577;
const DEAD_SEED_OFFSET = 1153;
const MANZANITA_SEED_OFFSET = 2311;

// ── material ──────────────────────────────────────────────────────────────

export function createPineMaterial(p: SierraParams = sierraParams) {
  const material = new THREE.MeshStandardNodeMaterial();
  material.roughness = 0.9;
  material.metalness = 0;

  const uBark = uniform(new THREE.Color(p.pineBarkColor));
  const uNeedleDark = uniform(new THREE.Color(p.needleDarkColor));
  const uNeedleLight = uniform(new THREE.Color(p.needleLightColor));
  const uJuniper = uniform(new THREE.Color(p.juniperNeedleColor));
  const uDead = uniform(new THREE.Color(p.deadWoodColor));
  const uManzanitaLeaf = uniform(new THREE.Color(p.manzanitaLeafColor));
  const uManzanitaStem = uniform(new THREE.Color(p.manzanitaStemColor));
  const foliage: FoliageLightUniforms = createFoliageLightUniforms(p);

  // role masks: 0 trunk, 1 needles, 2 dead wood, 3 juniper, 4 manzanita leaf,
  // 5 manzanita stem (pineGeometry.ts)
  const role = attribute('role', 'float');
  // @band-limited-elsewhere: `role` is a per-vertex integer tag (0..5), constant across each
  // primitive — these steps select a vertex class, they are not edges in space
  const atLeast = (v: number) => step(float(v), role); // @band-limited-elsewhere: vertex class tag
  const trunkMask = atLeast(0.5).oneMinus();
  const needleMask = atLeast(0.5).mul(atLeast(1.5).oneMinus());
  const deadMask = atLeast(1.5).mul(atLeast(2.5).oneMinus());
  const juniperMask = atLeast(2.5).mul(atLeast(3.5).oneMinus());
  const manzLeafMask = atLeast(3.5).mul(atLeast(4.5).oneMinus());
  const manzStemMask = atLeast(4.5);

  // needles: darker low on the tree, lit toward the top tier — a flat band
  // per tier reads as cut-out; the ramp is what makes a cone read as foliage
  const needle = mix(uNeedleDark, uNeedleLight, uv().y);
  const juniperLeaf = mix(uJuniper, uNeedleLight, uv().y.mul(0.5));
  const manzLeaf = mix(uManzanitaLeaf, uNeedleLight, uv().y.mul(0.35));
  const albedo = uBark
    .mul(trunkMask)
    .add(needle.mul(needleMask))
    .add(uDead.mul(deadMask))
    .add(juniperLeaf.mul(juniperMask))
    .add(manzLeaf.mul(manzLeafMask))
    .add(uManzanitaStem.mul(manzStemMask));
  material.colorNode = albedo;

  // §T.112e: wrap + back transmission on the LEAF roles only. Wood is opaque,
  // and a glowing trunk is the tell that someone masked this wrong.
  const leafMask = needleMask.add(juniperMask).add(manzLeafMask);
  material.emissiveNode = foliageEmissive(foliage, albedo, leafMask);

  return {
    material,
    foliage,
    /** world-space direction TO the sun — drives wrap + back transmission */
    setSunDirection(v: THREE.Vector3): void {
      (foliage.sunDirection.value as THREE.Vector3).copy(v).normalize();
    },
    /** re-read live-tweakable params (Tweakpane mutates them in place) */
    refresh(): void {
      uBark.value.set(p.pineBarkColor);
      uNeedleDark.value.set(p.needleDarkColor);
      uNeedleLight.value.set(p.needleLightColor);
      uJuniper.value.set(p.juniperNeedleColor);
      uDead.value.set(p.deadWoodColor);
      uManzanitaLeaf.value.set(p.manzanitaLeafColor);
      uManzanitaStem.value.set(p.manzanitaStemColor);
      updateFoliageLightUniforms(foliage, p);
    },
  };
}

export type PineMaterial = ReturnType<typeof createPineMaterial>;

export interface PineMaterialSet {
  pine: PineMaterial;
  sway: WindSway;
}

/**
 * The sway params a conifer reads: the palms' timing, a stiffer amplitude.
 * Getters, not a copy — `syncParams` re-reads the object every frame and the
 * panel mutates the originals in place.
 */
function pineSwayParams(p: SierraParams, v: VegetationParams): VegetationParams {
  return {
    ...v,
    get swayAmplitude(): number {
      return p.pineSwayAmplitude;
    },
    get flutterAmplitude(): number {
      return p.pineFlutterAmplitude;
    },
  };
}

/** one shader for every conifer and shrub in the world (§V17) */
export function createPineMaterialSet(p: SierraParams = sierraParams): PineMaterialSet {
  const pine = createPineMaterial(p);
  const sway = applyWindSway(pine.material, {
    instancePhase: attribute('instancePhase', 'float'),
    amplitudeScale: attribute('instanceSway', 'float'),
    params: pineSwayParams(p, vegetationParams),
  });
  return { pine, sway };
}

// ── placement (CPU-pure over the heightmap) ───────────────────────────────

function isBench(hm: IslandHeightmap, x: number, z: number, p: SierraParams): boolean {
  if (hm.heightAt(x, z) < p.pineMinHeight) return false;
  return gradientAt(hm, x, z) <= p.pineSlopeLimit;
}

/**
 * Fraction of the footprint that is bench (level, above the sand band). The
 * coarse habitat measure the panel and the T112a tests read; the species maps
 * (sierraScatter.ts) are the fine one.
 */
export function benchFraction(hm: IslandHeightmap, p: SierraParams = sierraParams): number {
  let hits = 0;
  const R = hm.worldRadius;
  for (let iz = 0; iz < BENCH_PROBES; iz++) {
    for (let ix = 0; ix < BENCH_PROBES; ix++) {
      const x = -R + ((ix + 0.5) / BENCH_PROBES) * 2 * R;
      const z = -R + ((iz + 0.5) / BENCH_PROBES) * 2 * R;
      if (isBench(hm, x, z, p)) hits++;
    }
  }
  return hits / (BENCH_PROBES * BENCH_PROBES);
}

/** the nominal stand size the panel authors: linear in radius, scaled by bench area */
export function sierraPineCount(hm: IslandHeightmap, p: SierraParams = sierraParams): number {
  const nominal = hm.worldRadius * p.pinesPerRadius;
  // a footprint at the reference bench fraction carries the nominal stand;
  // less, proportionally fewer
  const area = Math.min(benchFraction(hm, p) / Math.max(p.pineBenchReference, 1e-3), 1);
  return Math.max(0, Math.round(nominal * area));
}

export interface PineCandidate {
  x: number;
  z: number;
  y: number;
  scale: number;
  /** crown radius (m) at round 0 */
  footprint: number;
  juniper: boolean;
}

/** the minimum any competitor has to expose: where it is and how wide it is */
export interface FootprintCandidate {
  x: number;
  z: number;
  scale: number;
  footprint: number;
}

export interface PinePlan {
  pines: PineCandidate[];
  junipers: PineCandidate[];
  /** how many candidates the density maps produced before competition */
  candidates: number;
}

/**
 * FOOTPRINT COMPETITION (§T.112a, extended to every species in §T.112e,
 * research §2 vegetation): of any two crowns that overlap, the smaller dies.
 * Each round grows the crowns by `pineFootprintGrowth` and re-runs, so
 * survivors end up spaced by their own size and the stand reads as a grown
 * thing rather than a jitter. Removals in a round are decided against the set
 * that ENTERED the round, in index order, so the result is independent of
 * iteration tricks (deterministic).
 *
 * GENERIC over the candidate type, and it compares FOOTPRINT rather than
 * `scale`: T112e runs one competition across all three species at once, and
 * `scale` is per-species (a manzanita at scale 1.2 is a 0.6 m bush, a pine at
 * scale 0.9 is a 12 m tree). Crown radius is the only currency the three have
 * in common, and it is what "the smaller of two overlapping crowns" means.
 */
export function competeFootprints<T extends FootprintCandidate>(
  candidates: readonly T[],
  rounds: number,
  growth: number,
): T[] {
  let alive = candidates.map((_, i) => i);
  for (let r = 0; r < Math.max(0, Math.floor(rounds)); r++) {
    const k = 1 + r * growth;
    const dead = new Set<number>();
    for (let a = 0; a < alive.length; a++) {
      const i = alive[a];
      const ci = candidates[i];
      for (let b = a + 1; b < alive.length; b++) {
        const j = alive[b];
        const cj = candidates[j];
        const reach = (ci.footprint + cj.footprint) * k;
        const dx = ci.x - cj.x;
        const dz = ci.z - cj.z;
        if (dx * dx + dz * dz >= reach * reach) continue;
        // the smaller crown dies; equal size → the later one (stable)
        dead.add(ci.footprint < cj.footprint ? i : cj.footprint < ci.footprint ? j : j);
      }
    }
    alive = alive.filter((i) => !dead.has(i));
  }
  return alive.map((i) => candidates[i]);
}

export interface SierraVegetationPlan {
  pines: SierraPlant[];
  junipers: SierraPlant[];
  manzanita: SierraPlant[];
  /** every survivor, in one list — the overlap and hash tests read this */
  all: SierraPlant[];
  /** how many the density maps produced before competition */
  candidates: number;
  bakeMs: number;
}

/**
 * The whole island's living layer: density maps → candidates → ONE competition
 * across all three species → the species split. One competition, not three: a
 * manzanita growing inside a pine's crown is the thing competition exists to
 * remove, and three separate passes would each be blind to the other two.
 */
export function planSierraVegetation(
  hm: IslandHeightmap,
  seed: number,
  p: SierraParams = sierraParams,
  v: VegetationParams = vegetationParams,
): SierraVegetationPlan {
  const t0 = performance.now();
  const candidates = sierraCandidates(hm, seed, p, v);
  const survivors = competeFootprints(candidates, p.pineCompetitionRounds, p.pineFootprintGrowth);
  return {
    pines: survivors.filter((c) => c.species === 'pine'),
    junipers: survivors.filter((c) => c.species === 'juniper'),
    manzanita: survivors.filter((c) => c.species === 'manzanita'),
    all: survivors,
    candidates: candidates.length,
    bakeMs: performance.now() - t0,
  };
}

/** the T112a-shaped view of the plan: the two CANOPY species only */
export function planSierraPines(
  hm: IslandHeightmap,
  seed: number,
  p: SierraParams = sierraParams,
  v: VegetationParams = vegetationParams,
): PinePlan {
  const plan = planSierraVegetation(hm, seed, p, v);
  const strip = (c: SierraPlant): PineCandidate => ({
    x: c.x,
    z: c.z,
    y: c.y,
    scale: c.scale,
    footprint: c.footprint,
    juniper: c.juniper,
  });
  return {
    pines: plan.pines.map(strip),
    junipers: plan.junipers.map(strip),
    // the canopy share of the candidate pool, so "thinned, not razed" is
    // measured against the pool these survivors actually came from
    candidates: Math.round(
      (plan.candidates * (plan.pines.length + plan.junipers.length)) / Math.max(plan.all.length, 1),
    ),
  };
}

/** mean nearest-neighbour distance of a point set (m); NaN below 2 points */
export function meanNearestNeighbour(points: readonly { x: number; z: number }[]): number {
  if (points.length < 2) return NaN;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    let best = Infinity;
    for (let j = 0; j < points.length; j++) {
      if (i === j) continue;
      const d = Math.hypot(points[i].x - points[j].x, points[i].z - points[j].z);
      if (d < best) best = d;
    }
    sum += best;
  }
  return sum / points.length;
}

/** Clark–Evans: expected mean NN distance of n uniform-random points on an area */
export function uniformNearestNeighbour(n: number, area: number): number {
  return 0.5 / Math.sqrt(Math.max(n, 1) / Math.max(area, 1e-6));
}

/**
 * The uniform-random reference ON THE SAME BENCH SET: `n` points drawn
 * uniformly over the footprint and kept where `isBench` holds (no density
 * maps, no clumping, no competition). Clark–Evans assumes a contiguous area; a
 * ridge's bench is a thin broken strip where the 2-D formula under-reads the
 * uniform NN distance, so the clustering test measures against THIS.
 */
export function uniformBenchNearestNeighbour(
  hm: IslandHeightmap,
  n: number,
  seed: number,
  p: SierraParams = sierraParams,
): number {
  const rng = createRng(seed);
  const pts: { x: number; z: number }[] = [];
  let guard = 0;
  while (pts.length < n && guard++ < n * PLACEMENT_ATTEMPTS) {
    const x = (rng() * 2 - 1) * hm.worldRadius;
    const z = (rng() * 2 - 1) * hm.worldRadius;
    if (isBench(hm, x, z, p)) pts.push({ x, z });
  }
  return meanNearestNeighbour(pts);
}

/**
 * PlacementFn over a planned list: hands the survivors out in order. The
 * scatter's own rng is still consumed for rotation so the wind phase etc.
 * stay on the same stream as before (§V2).
 */
export function plannedPlacement(
  list: readonly { x: number; y: number; z: number; scale: number }[],
): PlacementFn {
  let i = 0;
  return (rng) => {
    const c = list[i++];
    if (!c) throw new Error('plannedPlacement: asked for more plants than the plan holds'); // §Rule 8
    return { position: [c.x, c.y, c.z], scale: c.scale, rotation: rng() * Math.PI * 2 };
  };
}

/** dead pines: one per treeline marker, in order, feet on the seabed */
export function treelinePlacement(hm: IslandHeightmap): PlacementFn {
  const markers = hm.sierra?.treeline ?? [];
  let i = 0;
  return (rng) => {
    const m = markers[i % Math.max(markers.length, 1)];
    i++;
    if (!m) throw new Error('treelinePlacement: no treeline markers on this heightmap'); // §Rule 8
    return {
      position: [m.x, m.floor, m.z],
      scale: 0.9 + rng() * 0.2,
      rotation: rng() * Math.PI * 2,
    };
  };
}

// ── the island-facing wrapper ─────────────────────────────────────────────

export interface CreateSierraPinesOptions {
  seed: number;
  heightmap: IslandHeightmap;
  /** shared shader set (islandMaterials.ts); omit and this owns its own */
  shared?: PineMaterialSet;
  params?: SierraParams;
}

/**
 * Same contract as `createIslandPalms` so island.ts can swap by family. The
 * juniper, manzanita and dead-pine batches hang off the pine batch as
 * children: one handle, one visibility toggle, one LOD, FOUR draws on ONE
 * material (T112g turns these into impostor buckets; until then the instance
 * count is the cost — see tests/sierraVegetation.test.ts).
 */
export function createSierraPines(opts: CreateSierraPinesOptions): IslandPalms {
  const p = opts.params ?? sierraParams;
  const hm = opts.heightmap;
  const set = opts.shared ?? createPineMaterialSet(p);
  const material = set.pine.material;

  const plan = planSierraVegetation(hm, opts.seed, p);
  const pines = plan.pines.length;
  const junipers = plan.junipers.length;
  const manzanita = plan.manzanita.length;
  const live = pines + junipers + manzanita;
  const dead = hm.sierra?.treeline.length ?? 0;

  const pineGeometry = buildPineGeometry(opts.seed, 'pine', p);
  const juniperGeometry = buildJuniperGeometry(opts.seed + JUNIPER_SEED_OFFSET, p);
  const manzanitaGeometry = buildManzanitaGeometry(opts.seed + MANZANITA_SEED_OFFSET, p);
  const deadGeometry = buildPineGeometry(opts.seed + DEAD_SEED_OFFSET, 'dead', p);

  const mesh = scatterPalms({
    count: pines,
    seed: opts.seed,
    geometry: pineGeometry,
    material,
    placementFn: plannedPlacement(plan.pines),
    lodSort: true,
  });
  mesh.name = 'island-pines';
  const juniperMesh = scatterPalms({
    count: junipers,
    seed: opts.seed + JUNIPER_SEED_OFFSET,
    geometry: juniperGeometry,
    material,
    placementFn: plannedPlacement(plan.junipers),
    lodSort: true,
  });
  juniperMesh.name = 'island-junipers';
  const manzanitaMesh = scatterPalms({
    count: manzanita,
    seed: opts.seed + MANZANITA_SEED_OFFSET,
    geometry: manzanitaGeometry,
    material,
    placementFn: plannedPlacement(plan.manzanita),
    lodSort: true,
  });
  manzanitaMesh.name = 'island-manzanita';
  const deadMesh = scatterPalms({
    count: dead,
    seed: opts.seed + DEAD_SEED_OFFSET,
    geometry: deadGeometry,
    material,
    placementFn: treelinePlacement(hm),
  });
  deadMesh.name = 'island-dead-pines';
  // the drowned treeline is THE read of a drowned ridge; it is tagged so the
  // §V10 intersection foam collars each trunk where it meets the water
  deadMesh.userData.foamTarget = true;
  mesh.add(juniperMesh, manzanitaMesh, deadMesh);
  const batches = [mesh, juniperMesh, manzanitaMesh, deadMesh];
  for (const m of batches) {
    m.castShadow = islandParams.castShadows;
    m.receiveShadow = true;
  }
  // a shrub's shadow is what puts it ON the ground rather than in front of it,
  // but a 1 m manzanita casts about a shadow texel at the shipped rig and
  // every caster is a second draw in the CPU-bound shadow pass — the same
  // trade groundCoverMesh.ts makes one size class down.
  manzanitaMesh.castShadow = false;

  return {
    mesh,
    maxCount: live + dead,
    update(time, windDir, windStrength): void {
      set.sway.setWind(time, windDir, windStrength);
      set.sway.syncParams();
      set.pine.refresh();
    },
    setLodDistance(cameraDistance: number): void {
      mesh.count = palmLodCount(pines, cameraDistance);
      juniperMesh.count = palmLodCount(junipers, cameraDistance);
      manzanitaMesh.count = palmLodCount(manzanita, cameraDistance);
      deadMesh.count = palmLodCount(dead, cameraDistance);
      const any = mesh.count + juniperMesh.count + manzanitaMesh.count + deadMesh.count > 0;
      mesh.visible = any;
      juniperMesh.visible = juniperMesh.count > 0;
      manzanitaMesh.visible = manzanitaMesh.count > 0;
      deadMesh.visible = deadMesh.count > 0;
    },
    setSunDirection(v: THREE.Vector3): void {
      set.pine.setSunDirection(v);
    },
    dispose(): void {
      pineGeometry.dispose();
      juniperGeometry.dispose();
      manzanitaGeometry.dispose();
      deadGeometry.dispose();
      if (!opts.shared) material.dispose();
      for (const m of batches) m.dispose();
    },
  };
}
