/**
 * Sierra vegetation (§T.99): pines and junipers on the benches, dead pines
 * standing in the water on a drowned ridge's treeline. Reuses the palm stack
 * wholesale — `scatterPalms` for the instance buffers, `applyWindSway` for the
 * motion, the same `IslandPalms` contract so island.ts swaps one for the
 * other by archetype family and nothing downstream notices.
 *
 * Placement rules (pinned by tests/sierra.test.ts):
 * - live trees on BENCHES: |∇h| ≤ `pineSlopeLimit` (tan 25°) and height above
 *   `pineMinHeight` (the DG-sand band is bare)
 * - in STANDS, like the palms' groves (§V43 — a Poisson scatter is the most
 *   obvious generated tell): seeded stand centres inland, triangular jitter,
 *   fewer on south-facing benches, then FOOTPRINT COMPETITION (§T.112a):
 *   the smaller of any two overlapping crowns dies, two rounds
 * - dead pines exactly at the heightmap's `sierra.treeline` markers, feet on
 *   the seabed, so the trunk stands in water and the top clears it
 * The count scales with the bench area actually available, so an island with
 * little level ground gets a thin stand rather than a placement that throws.
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

/** re-rolls per tree before giving up — algorithm bound, not a look tunable */
const PLACEMENT_ATTEMPTS = 96;
/** bench-area probe resolution */
const BENCH_PROBES = 48;
const JUNIPER_SEED_OFFSET = 577;
const DEAD_SEED_OFFSET = 1153;

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

  // role masks: 0 trunk, 1 needles, 2 dead wood, 3 juniper (pineGeometry.ts)
  const role = attribute('role', 'float');
  // @band-limited-elsewhere: `role` is a per-vertex integer tag (0..3), constant across each
  // primitive — these steps select a vertex class, they are not edges in space
  const needleMask = step(float(0.5), role).mul(step(float(1.5), role).oneMinus()); // @band-limited-elsewhere: vertex class tag
  const deadMask = step(float(1.5), role).mul(step(float(2.5), role).oneMinus()); // @band-limited-elsewhere: vertex class tag
  const juniperMask = step(float(2.5), role); // @band-limited-elsewhere: vertex class tag
  const trunkMask = step(float(0.5), role).oneMinus(); // @band-limited-elsewhere: vertex class tag

  // needles: darker low on the tree, lit toward the top tier — a flat band
  // per tier reads as cut-out; the ramp is what makes a cone read as foliage
  const needle = mix(uNeedleDark, uNeedleLight, uv().y);
  material.colorNode = uBark
    .mul(trunkMask)
    .add(needle.mul(needleMask))
    .add(uDead.mul(deadMask))
    .add(mix(uJuniper, uNeedleLight, uv().y.mul(0.5)).mul(juniperMask));

  return {
    material,
    /** re-read live-tweakable params (Tweakpane mutates them in place) */
    refresh(): void {
      uBark.value.set(p.pineBarkColor);
      uNeedleDark.value.set(p.needleDarkColor);
      uNeedleLight.value.set(p.needleLightColor);
      uJuniper.value.set(p.juniperNeedleColor);
      uDead.value.set(p.deadWoodColor);
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

/** one shader for every conifer in the world (§V17) */
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
 * Fraction of the footprint that is bench (level, above the sand band).
 * Drives the count so a steep island thins its stand instead of throwing.
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

/** live trees for this island: linear in radius (like the palms), scaled by bench area */
export function sierraPineCount(hm: IslandHeightmap, p: SierraParams = sierraParams): number {
  const nominal = hm.worldRadius * p.pinesPerRadius;
  // a footprint at the reference bench fraction carries the nominal stand;
  // less, proportionally fewer
  const area = Math.min(benchFraction(hm, p) / Math.max(p.pineBenchReference, 1e-3), 1);
  return Math.max(0, Math.round(nominal * area));
}

/** seeded stand centres: inland points on benches, each jittered around */
export function pineStandCentres(hm: IslandHeightmap, seed: number, p: SierraParams = sierraParams): [number, number][] {
  const rng = createRng(seed);
  const out: [number, number][] = [];
  const count = Math.max(1, Math.floor(p.pineStandCount));
  for (let i = 0; i < count; i++) {
    let placed = false;
    for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS && !placed; attempt++) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * hm.worldRadius * 0.8;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (!isBench(hm, x, z, p)) continue;
      out.push([x, z]);
      placed = true;
    }
  }
  // no bench anywhere: the stand centre is the island centre and the
  // placement below will find whatever it can
  if (out.length === 0) out.push([0, 0]);
  return out;
}

/** aspect of the slope at a point: +1 facing −z ("south", sun-baked), −1 facing +z */
function southness(hm: IslandHeightmap, x: number, z: number): number {
  const eps = (2 * hm.worldRadius) / (hm.size - 1);
  const dhdx = (hm.heightAt(x + eps, z) - hm.heightAt(x - eps, z)) / (2 * eps);
  const dhdz = (hm.heightAt(x, z + eps) - hm.heightAt(x, z - eps)) / (2 * eps);
  const g = Math.hypot(dhdx, dhdz);
  // flat ground has no aspect: weight the term by how steep it is (tan 5° → full)
  const steep = Math.min(g / 0.0875, 1);
  // the slope FACES downhill = −∇h; facing −z is dhdz > 0
  return g > 1e-6 ? (dhdz / g) * steep : 0;
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

export interface PinePlan {
  pines: PineCandidate[];
  junipers: PineCandidate[];
  /** how many candidates the stands produced before competition */
  candidates: number;
}

/** seed offset for the candidate stream — distinct from the scatter's own */
const CANDIDATE_SEED_OFFSET = 911;

/**
 * Generate the stand candidates: a stand, a jitter, the bench rules, then the
 * ASPECT rule (§T.112a): a south-facing bench is sun-baked and carries fewer
 * trees than a north-facing one — `pineSouthAspectFactor` is the acceptance
 * on a full south face, 1 on a north face. Deterministic over (hm, seed).
 */
export function pineCandidates(
  hm: IslandHeightmap,
  seed: number,
  count: number,
  p: SierraParams = sierraParams,
  v: VegetationParams = vegetationParams,
): PineCandidate[] {
  const stands = pineStandCentres(hm, seed, p);
  const rng = createRng(seed + CANDIDATE_SEED_OFFSET);
  const out: PineCandidate[] = [];
  for (let i = 0; i < count; i++) {
    for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
      const [sx, sz] = stands[Math.floor(rng() * stands.length) % stands.length];
      // triangular jitter packs the stand toward its centre
      const x = sx + (rng() + rng() - 1) * p.pineStandSpread;
      const z = sz + (rng() + rng() - 1) * p.pineStandSpread;
      if (Math.hypot(x, z) > hm.worldRadius) continue;
      if (!isBench(hm, x, z, p)) continue;
      const south = Math.max(0, southness(hm, x, z));
      const accept = 1 - south * (1 - Math.min(Math.max(p.pineSouthAspectFactor, 0), 1));
      if (rng() > accept) continue;
      const scale = v.scaleMin + (v.scaleMax - v.scaleMin) * rng();
      out.push({
        x,
        z,
        y: hm.heightAt(x, z),
        scale,
        footprint: p.pineFootprint * scale,
        juniper: rng() < p.juniperFraction,
      });
      break;
    }
  }
  return out;
}

/**
 * FOOTPRINT COMPETITION (§T.112a, research §2 vegetation): of any two crowns
 * that overlap, the smaller dies. Each round grows the crowns by
 * `pineFootprintGrowth` and re-runs, so survivors end up spaced by their own
 * size and the stand reads as a grown thing rather than a jitter. Removals
 * in a round are decided against the set that ENTERED the round, in index
 * order, so the result is independent of iteration tricks (deterministic).
 */
export function competeFootprints(
  candidates: readonly PineCandidate[],
  rounds: number,
  growth: number,
): PineCandidate[] {
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
        // the smaller dies; equal size → the later one (stable)
        dead.add(ci.scale < cj.scale ? i : cj.scale < ci.scale ? j : j);
      }
    }
    alive = alive.filter((i) => !dead.has(i));
  }
  return alive.map((i) => candidates[i]);
}

/** the whole stand for an island: candidates → competition → species split */
export function planSierraPines(
  hm: IslandHeightmap,
  seed: number,
  p: SierraParams = sierraParams,
  v: VegetationParams = vegetationParams,
): PinePlan {
  const candidates = pineCandidates(hm, seed, sierraPineCount(hm, p), p, v);
  const survivors = competeFootprints(candidates, p.pineCompetitionRounds, p.pineFootprintGrowth);
  return {
    pines: survivors.filter((c) => !c.juniper),
    junipers: survivors.filter((c) => c.juniper),
    candidates: candidates.length,
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
 * uniformly over the footprint and kept where `isBench` holds (no stands, no
 * aspect, no competition). Clark–Evans assumes a contiguous area; a ridge's
 * bench is a thin broken strip where the 2-D formula under-reads the uniform
 * NN distance, so the clustering test measures against THIS.
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
export function plannedPlacement(list: readonly PineCandidate[]): PlacementFn {
  let i = 0;
  return (rng) => {
    const c = list[i++];
    if (!c) throw new Error('plannedPlacement: asked for more trees than the plan holds'); // §Rule 8
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
 * juniper and dead-pine batches hang off the pine batch as children: one
 * handle, one visibility toggle, one LOD.
 */
export function createSierraPines(opts: CreateSierraPinesOptions): IslandPalms {
  const p = opts.params ?? sierraParams;
  const hm = opts.heightmap;
  const set = opts.shared ?? createPineMaterialSet(p);
  const material = set.pine.material;

  const plan = planSierraPines(hm, opts.seed, p);
  const pines = plan.pines.length;
  const junipers = plan.junipers.length;
  const live = pines + junipers;
  const dead = hm.sierra?.treeline.length ?? 0;

  const pineGeometry = buildPineGeometry(opts.seed, 'pine', p);
  const juniperGeometry = buildPineGeometry(opts.seed + JUNIPER_SEED_OFFSET, 'juniper', p);
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
  mesh.add(juniperMesh, deadMesh);
  for (const m of [mesh, juniperMesh, deadMesh]) {
    m.castShadow = islandParams.castShadows;
    m.receiveShadow = true;
  }

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
      deadMesh.count = palmLodCount(dead, cameraDistance);
      const any = mesh.count + juniperMesh.count + deadMesh.count > 0;
      mesh.visible = any;
      juniperMesh.visible = juniperMesh.count > 0;
      deadMesh.visible = deadMesh.count > 0;
    },
    setSunDirection(): void {
      // no backlit term on needles — nothing to push
    },
    dispose(): void {
      pineGeometry.dispose();
      juniperGeometry.dispose();
      deadGeometry.dispose();
      if (!opts.shared) material.dispose();
      mesh.dispose();
      juniperMesh.dispose();
      deadMesh.dispose();
    },
  };
}
