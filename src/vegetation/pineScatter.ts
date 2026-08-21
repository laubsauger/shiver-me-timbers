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
 *   obvious generated tell): seeded stand centres inland, triangular jitter
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
  const needleMask = step(float(0.5), role).mul(step(float(1.5), role).oneMinus());
  const deadMask = step(float(1.5), role).mul(step(float(2.5), role).oneMinus());
  const juniperMask = step(float(2.5), role);
  const trunkMask = step(float(0.5), role).oneMinus();

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

/**
 * Terrain-aware PlacementFn: a stand, a jitter, then the bench rules.
 * Rejection sampling on the rng the scatter hands in (§V2: same stream,
 * same trees). Throws after PLACEMENT_ATTEMPTS — `sierraPineCount` keeps the
 * count proportional to the bench area precisely so this does not fire.
 */
export function sierraPinePlacement(
  hm: IslandHeightmap,
  seed: number,
  p: SierraParams = sierraParams,
  v: VegetationParams = vegetationParams,
): PlacementFn {
  const stands = pineStandCentres(hm, seed, p);
  return (rng) => {
    for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
      const [sx, sz] = stands[Math.floor(rng() * stands.length) % stands.length];
      // triangular jitter packs the stand toward its centre
      const x = sx + (rng() + rng() - 1) * p.pineStandSpread;
      const z = sz + (rng() + rng() - 1) * p.pineStandSpread;
      if (Math.hypot(x, z) > hm.worldRadius) continue;
      if (!isBench(hm, x, z, p)) continue;
      return {
        position: [x, hm.heightAt(x, z), z],
        scale: v.scaleMin + (v.scaleMax - v.scaleMin) * rng(),
        rotation: rng() * Math.PI * 2,
      };
    }
    throw new Error(
      `sierraPinePlacement: no bench found after ${PLACEMENT_ATTEMPTS} attempts — pineSlopeLimit/pineMinHeight too strict for this heightmap?`,
    );
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

  const live = sierraPineCount(hm, p);
  const junipers = Math.round(live * Math.min(Math.max(p.juniperFraction, 0), 1));
  const pines = live - junipers;
  const dead = hm.sierra?.treeline.length ?? 0;

  const pineGeometry = buildPineGeometry(opts.seed, 'pine', p);
  const juniperGeometry = buildPineGeometry(opts.seed + JUNIPER_SEED_OFFSET, 'juniper', p);
  const deadGeometry = buildPineGeometry(opts.seed + DEAD_SEED_OFFSET, 'dead', p);

  const mesh = scatterPalms({
    count: pines,
    seed: opts.seed,
    geometry: pineGeometry,
    material,
    placementFn: sierraPinePlacement(hm, opts.seed, p),
    lodSort: true,
  });
  mesh.name = 'island-pines';
  const juniperMesh = scatterPalms({
    count: junipers,
    seed: opts.seed + JUNIPER_SEED_OFFSET,
    geometry: juniperGeometry,
    material,
    placementFn: sierraPinePlacement(hm, opts.seed + JUNIPER_SEED_OFFSET, p),
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
