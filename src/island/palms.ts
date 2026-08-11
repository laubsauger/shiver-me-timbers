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
import { vegetationParams } from '../params/vegetation';
import { islandParams, type IslandParams } from '../params/island';
import { findShoreRadius, gradientAt, type IslandHeightmap } from './heightmap';

/** re-rolls per palm before giving up — algorithm bound, not a look tunable */
const PLACEMENT_ATTEMPTS = 64;

/** terrain-aware PlacementFn for scatterPalms/generatePlacements */
export function islandPalmPlacement(
  hm: IslandHeightmap,
  p: IslandParams = islandParams,
): PlacementFn {
  const v = vegetationParams;
  return (rng) => {
    for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
      const beach = rng() < p.palmBeachFraction;
      const angle = rng() * Math.PI * 2;
      let x: number;
      let z: number;
      if (beach) {
        // just inland of the shoreline: setback × [0.4, 1.4) for depth spread
        const r = Math.max(findShoreRadius(hm, angle) - p.palmBeachSetback * (0.4 + rng()), 0);
        x = Math.cos(angle) * r;
        z = Math.sin(angle) * r;
      } else {
        // sparse interior: uniform over a disc (sqrt for area uniformity)
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
}

export interface IslandPalms {
  mesh: THREE.InstancedMesh;
  /** per-frame: sim time (s), wind direction xz, wind strength 0..1+ */
  update(time: number, windDir: [number, number], windStrength: number): void;
  dispose(): void;
}

/**
 * Full island palm setup — same wiring as vegetation/createPalms but with the
 * terrain placement fn (createPalms has no placementFn passthrough; composing
 * from its exported parts keeps T26 untouched).
 */
export function createIslandPalms(opts: CreateIslandPalmsOptions): IslandPalms {
  const count = opts.count ?? islandParams.palmCount;
  const geometry = buildPalmGeometry(opts.seed);
  const palmMaterial = createPalmMaterial();
  const sway = applyWindSway(palmMaterial.material, {
    instancePhase: attribute('instancePhase', 'float'),
    amplitudeScale: attribute('instanceSway', 'float'),
  });
  const mesh = scatterPalms({
    count,
    seed: opts.seed,
    geometry,
    material: palmMaterial.material,
    placementFn: islandPalmPlacement(opts.heightmap),
  });

  return {
    mesh,
    update(time, windDir, windStrength): void {
      sway.setWind(time, windDir, windStrength);
      sway.syncParams();
      palmMaterial.refresh();
    },
    dispose(): void {
      geometry.dispose();
      palmMaterial.material.dispose();
      mesh.dispose();
    },
  };
}
