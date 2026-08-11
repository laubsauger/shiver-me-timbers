/**
 * Tri-planar plank wood TSL builder (T8 wood PBR, §V16). Sail cloth moved to
 * sailMaterial.ts when it grew wind dynamics (file cap, §C).
 * Sampled in PIECE-LOCAL space (positionLocal/normalLocal) so grain sticks
 * to each piece while the ship moves and rolls; no UVs needed. fbm and
 * tri-planar helpers come from src/terrain/noise.ts — not duplicated.
 * §V23 (§B B1/B2): 3-arg math uses functional mix()/smoothstep() ONLY —
 * chained `a.mix(b,t)` reads the receiver as the FACTOR. No chained forms here.
 */
import * as THREE from 'three/webgpu';
import {
  float,
  fract,
  mix,
  normalLocal,
  positionLocal,
  smoothstep,
  step,
  uniform,
  vec3,
} from 'three/tsl';
import { triplanarFbm } from '../terrain/noise';
import { shipMaterialParams, type ShipMaterialParams } from '../params/ship';

export interface WoodTones {
  light: number;
  dark: number;
  /** darker horizontal wale strakes (hull family only) */
  wale: boolean;
}

export interface ShipMaterialHandle {
  material: THREE.MeshStandardNodeMaterial;
  /** re-read live params (Tweakpane mutates them in place, §V16) */
  refresh(): void;
}

export function createWoodMaterial(
  tones: WoodTones,
  p: ShipMaterialParams = shipMaterialParams,
): ShipMaterialHandle {
  const material = new THREE.MeshStandardNodeMaterial();
  material.metalness = 0;

  const uLight = uniform(new THREE.Color(tones.light));
  const uDark = uniform(new THREE.Color(tones.dark));
  const uGrainScale = uniform(p.grainScale);
  const uGrainStretch = uniform(p.grainStretch);
  const uSharpness = uniform(p.triplanarSharpness);
  const uPlankWidth = uniform(p.plankWidth);
  const uSeamWidth = uniform(p.seamWidth);
  const uSeamDarken = uniform(p.seamDarken);
  const uWaleFrequency = uniform(p.waleFrequency);
  const uWaleRatio = uniform(p.waleRatio);
  const uWaleDarken = uniform(p.waleDarken);

  // grain: fbm stretched along z (plank axis) so streaks read lengthwise
  const samplePos = positionLocal
    .mul(uGrainScale)
    .mul(vec3(1, 1, uGrainStretch));
  const grain = triplanarFbm(samplePos, normalLocal, uSharpness, p.grainOctaves);

  // plank seams: stacked in y on vertical faces, side-by-side in x on decks
  const upness = smoothstep(float(0.6), float(0.9), normalLocal.y.abs());
  const across = mix(positionLocal.y, positionLocal.x, upness);
  const f = fract(across.div(uPlankWidth));
  const edgeDistance = f.min(f.oneMinus()); // 0 at a seam, 0.5 mid-plank
  const seamMask = smoothstep(float(0), uSeamWidth, edgeDistance); // 0 = seam

  const base = mix(uDark, uLight, grain);
  let color = mix(base.mul(uSeamDarken), base, seamMask);

  if (tones.wale) {
    // wale strakes: periodic darker horizontal bands along hull height
    const band = step(uWaleRatio, fract(positionLocal.y.mul(uWaleFrequency)));
    color = mix(color.mul(uWaleDarken), color, band);
  }

  material.colorNode = color;
  // weathered wood: rougher in the grain valleys
  material.roughnessNode = float(0.78).add(grain.mul(0.18));

  return {
    material,
    refresh(): void {
      uLight.value.set(tones.light);
      uDark.value.set(tones.dark);
      uGrainScale.value = p.grainScale;
      uGrainStretch.value = p.grainStretch;
      uSharpness.value = p.triplanarSharpness;
      uPlankWidth.value = p.plankWidth;
      uSeamWidth.value = p.seamWidth;
      uSeamDarken.value = p.seamDarken;
      uWaleFrequency.value = p.waleFrequency;
      uWaleRatio.value = p.waleRatio;
      uWaleDarken.value = p.waleDarken;
    },
  };
}
