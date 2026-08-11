/**
 * Tri-planar plank wood + sail cloth TSL builders (T8 wood PBR, §V16).
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
  normalWorld,
  positionLocal,
  smoothstep,
  step,
  uniform,
  vec3,
} from 'three/tsl';
import { fbm2, triplanarFbm } from '../terrain/noise';
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

/** shared sun direction for sail backlight — app updates once per frame */
export const uShipSunDirection = /*@__PURE__*/ uniform(
  new THREE.Vector3(0.4, 0.75, 0.3).normalize(),
);

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

/** off-white weathered canvas w/ warp+weft noise and backlit translucency
 *  fake (emissive when the sun is behind the cloth, palmMaterial-style). */
export function createSailClothMaterial(
  p: ShipMaterialParams = shipMaterialParams,
): ShipMaterialHandle {
  const material = new THREE.MeshStandardNodeMaterial();
  material.side = THREE.DoubleSide; // sails are single surfaces
  material.metalness = 0;
  material.roughness = 0.95;

  const uLight = uniform(new THREE.Color(p.sailLight));
  const uDark = uniform(new THREE.Color(p.sailDark));
  const uWeaveScale = uniform(p.sailWeaveScale);
  const uBacklitColor = uniform(new THREE.Color(p.sailBacklitColor));
  const uBacklitStrength = uniform(p.sailBacklitStrength);

  // warp/weft: two crossed fbm bands in the sail's local plane (sails are
  // built in local XY), summed for a woven shimmer
  const warp = fbm2(positionLocal.xy.mul(uWeaveScale).mul(vec3(1, 6, 0).xy), 2);
  const weft = fbm2(positionLocal.xy.mul(uWeaveScale).mul(vec3(6, 1, 0).xy), 2);
  const weave = warp.add(weft).mul(0.5);
  material.colorNode = mix(uDark, uLight, weave);

  // translucency fake: sun behind the cloth → warm glow through it
  const backlit = normalWorld.dot(uShipSunDirection).min(0).negate();
  material.emissiveNode = uBacklitColor.mul(backlit).mul(uBacklitStrength);

  return {
    material,
    refresh(): void {
      uLight.value.set(p.sailLight);
      uDark.value.set(p.sailDark);
      uWeaveScale.value = p.sailWeaveScale;
      uBacklitColor.value.set(p.sailBacklitColor);
      uBacklitStrength.value = p.sailBacklitStrength;
    },
  };
}
