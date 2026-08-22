/**
 * Island palm placement (T20): reuses the T26 vegetation stack (palmGeometry,
 * palmMaterial, windSway, scatterPalms) with a terrain-aware PlacementFn that
 * samples heightmap.heightAt. Deterministic per seed (§V2-adjacent: the fn
 * only draws from the rng that generatePlacements hands it — rejection
 * sampling consumes the same stream on every run).
 *
 * Placement rules (pinned by tests/island.test.ts):
 * - beach band: `palmBeachFraction` of palms sit just inland of the shoreline
 *   (findShoreRadius − setback), the rest scatter sparsely in the interior
 * - never below the waterline: height ≥ palmMinHeight
 * - never on steep slope: |∇h| ≤ palmSlopeLimit (central differences)
 * Candidates violating a rule are re-rolled; a site that never validates
 * throws (fail loud, §Rule 8) instead of planting palms in the sea.
 *
 * islandPalmPlacement is CPU-pure over the heightmap; createIslandPalms wires
 * materials/sway (node graphs only — GPU touched lazily on first render).
 */
import { attribute } from 'three/tsl';
import type * as THREE from 'three/webgpu';
import {
  buildPalmGeometry,
  createPalmMaterial,
  applyWindSway,
  scatterPalms,
} from '../vegetation';
import type { PlacementFn } from '../vegetation/scatter';
import type { PalmMaterial } from '../vegetation/palmMaterial';
import type { WindSway } from '../vegetation/windSway';
import { vegetationParams } from '../params/vegetation';
import { islandParams, type IslandParams } from '../params/island';
import { createRng } from '../state/rng';
import { findShoreRadius, gradientAt, type IslandHeightmap } from './heightmap';

/** re-rolls per palm before giving up — algorithm bound, not a look tunable */
const PLACEMENT_ATTEMPTS = 64;

/**
 * Grove centre angles: `palmGroveCount` stands spaced around the island, each
 * jittered inside its own sector so the ring is never regular. Derived from a
 * seed rather than the placement rng because every palm has to agree on where
 * the groves ARE — drawing them per-palm would just be scatter again.
 */
export function palmGroveAngles(seed: number, p: IslandParams = islandParams): number[] {
  const rng = createRng(seed);
  const count = Math.max(1, Math.floor(p.palmGroveCount));
  const phase = rng();
  const angles: number[] = [];
  for (let i = 0; i < count; i++) {
    angles.push(((i + 0.15 + rng() * 0.7) / count + phase) * Math.PI * 2);
  }
  return angles;
}

/**
 * Terrain-aware PlacementFn for scatterPalms/generatePlacements.
 *
 * §V43: palms grow in GROVES. Measured angular-gap CV was 0.84 with a uniform
 * random angle — statistically Poisson, which is what "evenly scattered" looks
 * like and the most obvious generated tell on an island. Each palm now picks a
 * stand and sits inside it, so the coast alternates between dense stands and
 * genuinely empty beach the way the references do.
 *
 * `seed` fixes the grove positions; omit it and every island gets the same
 * ring of stands, which is why createIslandPalms always passes one.
 */
export function islandPalmPlacement(
  hm: IslandHeightmap,
  p: IslandParams = islandParams,
  seed = 0,
): PlacementFn {
  const v = vegetationParams;
  const groves = palmGroveAngles(seed, p);
  // metres of arc → radians, at the scale of this island
  const radiusForArc = Math.max(hm.worldRadius, 1e-3); // §V28 floored divisor
  return (rng) => {
    for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
      const beach = rng() < p.palmBeachFraction;
      const centre = groves[Math.floor(rng() * groves.length) % groves.length];
      // triangular jitter (sum of two uniforms): packs the stand toward its
      // centre and thins at the edges, instead of a hard-edged uniform blob
      const spread = (p.palmGroveSpread / radiusForArc) * (beach ? 1 : p.palmGroveInlandFlare);
      const angle = centre + (rng() + rng() - 1) * spread;
      let x: number;
      let z: number;
      if (beach) {
        // just inland of the shoreline: setback × [0.4, 1.4) for depth spread
        const r = Math.max(findShoreRadius(hm, angle) - p.palmBeachSetback * (0.4 + rng()), 0);
        x = Math.cos(angle) * r;
        z = Math.sin(angle) * r;
      } else {
        // the stand's inland tail — same bearing, drawn back up the slope, so
        // vegetation reads as a mass running inland rather than a beach fringe
        const r = Math.sqrt(rng()) * hm.worldRadius * p.palmInteriorRadius;
        x = Math.cos(angle) * r;
        z = Math.sin(angle) * r;
      }
      const h = hm.heightAt(x, z);
      if (h < p.palmMinHeight) continue; // submerged / waterline — reject
      if (gradientAt(hm, x, z) > p.palmSlopeLimit) continue; // too steep
      return {
        position: [x, h, z],
        scale: v.scaleMin + (v.scaleMax - v.scaleMin) * rng(),
        rotation: rng() * Math.PI * 2,
      };
    }
    throw new Error(
      `islandPalmPlacement: no valid site after ${PLACEMENT_ATTEMPTS} attempts — palmSlopeLimit/palmMinHeight too strict for this heightmap?`,
    );
  };
}

export interface CreateIslandPalmsOptions {
  seed: number;
  heightmap: IslandHeightmap;
  /** defaults to islandParams.palmCount */
  count?: number;
  /**
   * Shared palm material + its wind sway (islandMaterials.ts). Omit and this
   * builds and owns its own; the archipelago injects one set for every island
   * (§V17). Geometry stays per-island — that is where the seed variation is.
   */
  shared?: { palm: PalmMaterial; sway: WindSway };
}

export interface IslandPalms {
  mesh: THREE.InstancedMesh;
  /** instances the scatter produced (the LOD ceiling) */
  readonly maxCount: number;
  /** per-frame: sim time (s), wind direction xz, wind strength 0..1+ */
  update(time: number, windDir: [number, number], windStrength: number): void;
  /** per-frame LOD (§V17): thin the instance count by camera distance */
  setLodDistance(cameraDistance: number): void;
  /** world sun direction (unit, pointing AT the sun) for the backlit fronds */
  setSunDirection(v: THREE.Vector3): void;
  /**
   * T112g, OPTIONAL: per-instance frustum cull against the camera. `mvp` is
   * projection × view × the island group's world matrix, so the cull runs in
   * the ISLAND-LOCAL space the instance matrices are written in — a batch that
   * is offset by its island and tested against world planes culls the wrong
   * plants, silently, and only when the island is far from the origin.
   *
   * Optional because the palm batches have nothing to gain from it (28
   * instances) and because an island whose caller never supplies a camera must
   * keep working — `setLodDistance` stays in charge until this is first called.
   */
  setCullCamera?(
    mvp: ArrayLike<number>,
    camX: number,
    camY: number,
    camZ: number,
    sunDirection?: THREE.Vector3,
  ): void;
  dispose(): void;
}

/**
 * Instances kept at a camera distance (§V17). Palms are the single most
 * expensive thing on an island (~6k tris each), and an island at 2 km puts
 * them under a few pixels, so the count ramps to zero rather than paying for
 * geometry nobody can resolve. Pure so tests pin the ramp without a renderer.
 * Instances are written largest-first (scatter `lodSort`), so the survivors
 * are always the palms that read best.
 */
export function palmLodCount(
  maxCount: number,
  cameraDistance: number,
  p: IslandParams = islandParams,
): number {
  const full = p.lodPalmFull;
  const cull = Math.max(p.lodPalmCull, full + 1e-3); // §V28 floored divisor
  if (cameraDistance <= full) return maxCount;
  if (cameraDistance >= cull) return 0;
  const t = (cameraDistance - full) / (cull - full);
  return Math.round(maxCount * (1 - t));
}

/**
 * Full island palm setup — same wiring as vegetation/createPalms but with the
 * terrain placement fn (createPalms has no placementFn passthrough; composing
 * from its exported parts keeps T26 untouched).
 */
export function createIslandPalms(opts: CreateIslandPalmsOptions): IslandPalms {
  const count = opts.count ?? islandParams.palmCount;
  const geometry = buildPalmGeometry(opts.seed);
  const palmMaterial = opts.shared?.palm ?? createPalmMaterial();
  const sway =
    opts.shared?.sway ??
    applyWindSway(palmMaterial.material, {
      instancePhase: attribute('instancePhase', 'float'),
      amplitudeScale: attribute('instanceSway', 'float'),
    });
  const mesh = scatterPalms({
    count,
    seed: opts.seed,
    geometry,
    material: palmMaterial.material,
    placementFn: islandPalmPlacement(opts.heightmap, islandParams, opts.seed),
    lodSort: true,
  });
  mesh.name = 'island-palms';
  mesh.castShadow = islandParams.castShadows;
  mesh.receiveShadow = true;

  return {
    mesh,
    maxCount: count,
    update(time, windDir, windStrength): void {
      sway.setWind(time, windDir, windStrength);
      sway.syncParams();
      palmMaterial.refresh();
    },
    setLodDistance(cameraDistance: number): void {
      const n = palmLodCount(count, cameraDistance);
      mesh.count = n;
      // a zero-instance draw is still a draw + a shadow-pass draw; skip it
      mesh.visible = n > 0;
    },
    setSunDirection(v: THREE.Vector3): void {
      (palmMaterial.uSunDirection.value as THREE.Vector3).copy(v).normalize();
    },
    dispose(): void {
      geometry.dispose();
      if (!opts.shared) palmMaterial.material.dispose(); // shared: caller owns it
      mesh.dispose();
    },
  };
}
