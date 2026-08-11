/**
 * Vegetation integration (T26): one-call palm setup wiring geometry
 * (palmGeometry) + material (palmMaterial) + wind sway (windSway) + instanced
 * scatter (scatter). Deterministic per seed (§V2-adjacent); all tunables in
 * params/vegetation (§V16). Render-side only — reads sim wind through
 * update(), never writes SimState (§V3).
 */
import { attribute } from 'three/tsl';
import type * as THREE from 'three/webgpu';
import { vegetationParams, type VegetationParams } from '../params/vegetation';
import { buildPalmGeometry } from './palmGeometry';
import { createPalmMaterial } from './palmMaterial';
import { applyWindSway } from './windSway';
import { scatterPalms } from './scatter';

export { buildPalmGeometry } from './palmGeometry';
export { createPalmMaterial } from './palmMaterial';
export { applyWindSway, type WindSway } from './windSway';
export { scatterPalms, generatePlacements, ringClusterPlacement, sortForLod } from './scatter';

/**
 * Sea state → sway strength. Keeps the reference wind speed in params (§V16)
 * instead of a literal at the call site, so retuning the sea retunes the
 * palms with it.
 */
export function palmWindStrength(
  windSpeed: number,
  p: VegetationParams = vegetationParams,
): number {
  return windSpeed / Math.max(p.windReferenceSpeed, 1e-3); // §V28 floored divisor
}

export interface CreatePalmsOptions {
  seed: number;
  /** instance count; defaults to vegetationParams.count */
  count?: number;
}

export interface Palms {
  mesh: THREE.InstancedMesh;
  /** per-frame: sim time (s), wind direction xz, wind strength 0..1+ */
  update(time: number, windDir: [number, number], windStrength: number): void;
  dispose(): void;
}

export function createPalms(opts: CreatePalmsOptions): Palms {
  const count = opts.count ?? vegetationParams.count;
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
