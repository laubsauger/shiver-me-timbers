/**
 * Stylized tri-planar rock material (T27, §V16 — all tunables from
 * params/terrain.ts, mutable live via updateFromParams()).
 *
 * Look (docs/ship-full-view.png rocks): chunky, soft-beveled, hand-sculpted.
 * - layered tint: grey-tan base, warm sun-bleached top catch, darker crevices
 *   driven by low-frequency cavity noise + steep-slope darkening (ao-ish)
 * - soft color banding: noise posterized into a few painterly steps, softness
 *   tunable (0 = hard cel bands, 1 = fully smooth)
 * - tri-planar sampling on world position → works on ANY rock mesh, no UVs
 *
 * Constructible without a renderer: only a node graph is built here, the GPU
 * is touched lazily on first render — safe to import anywhere (tests, sim).
 * Changing `noiseOctaves` requires rebuilding the material (loop unrolls at
 * build time); every other param is a live uniform.
 */
import * as THREE from 'three/webgpu';
import { float, mix, normalWorld, positionWorld, uniform } from 'three/tsl';
import { terrainParams } from '../params/terrain';
import { triplanarFbm } from './noise';

export interface RockMaterialOptions {
  /** initial world-space sun direction (unit, pointing AT the sun) */
  sunDirection?: THREE.Vector3;
}

/** Live GPU uniforms mirroring the rock section of terrainParams. */
export function createRockUniforms(opts: RockMaterialOptions = {}) {
  const p = terrainParams;
  return {
    baseColor: uniform(new THREE.Color(p.rockBaseColor)),
    topColor: uniform(new THREE.Color(p.rockTopColor)),
    creviceColor: uniform(new THREE.Color(p.rockCreviceColor)),
    scale: uniform(p.rockScale),
    bands: uniform(p.rockBands),
    bandSoftness: uniform(p.rockBandSoftness),
    creviceScale: uniform(p.rockCreviceScale),
    creviceStrength: uniform(p.rockCreviceStrength),
    topPower: uniform(p.rockTopPower),
    topStrength: uniform(p.rockTopStrength),
    sideDarken: uniform(p.rockSideDarken),
    roughness: uniform(p.rockRoughness),
    sharpness: uniform(p.triplanarSharpness),
    /** update per frame from the sky/sun system (T15) */
    sunDirection: uniform(
      (opts.sunDirection ?? new THREE.Vector3(0.4, 0.8, 0.2)).clone().normalize(),
    ),
  };
}

export type RockUniforms = ReturnType<typeof createRockUniforms>;

/** Copy current terrainParams values into the uniforms (call on change). */
export function updateRockUniforms(u: RockUniforms): void {
  const p = terrainParams;
  u.baseColor.value.setHex(p.rockBaseColor);
  u.topColor.value.setHex(p.rockTopColor);
  u.creviceColor.value.setHex(p.rockCreviceColor);
  u.scale.value = p.rockScale;
  u.bands.value = p.rockBands;
  u.bandSoftness.value = p.rockBandSoftness;
  u.creviceScale.value = p.rockCreviceScale;
  u.creviceStrength.value = p.rockCreviceStrength;
  u.topPower.value = p.rockTopPower;
  u.topStrength.value = p.rockTopStrength;
  u.sideDarken.value = p.rockSideDarken;
  u.roughness.value = p.rockRoughness;
  u.sharpness.value = p.triplanarSharpness;
}

/**
 * Build the rock color/roughness node graph from a uniform set. Exported so
 * terrainBlendMaterial (sandMaterial.ts) can compose rock+sand in one shader.
 */
export function buildRockNodes(u: RockUniforms, octaves: number) {
  const p = terrainParams;
  const pos = positionWorld.mul(u.scale);

  // painterly banded structure noise, tri-planar → no UVs needed
  const n = triplanarFbm(
    pos,
    normalWorld,
    u.sharpness,
    octaves,
    p.noiseLacunarity,
    p.noiseGain,
  );
  // soft posterize: crossfade of width `softness` around each band edge.
  // half-width clamped ≥ 1e-3 so smoothstep edges never coincide (NaN guard).
  const b = n.mul(u.bands);
  const half = u.bandSoftness.mul(0.5).max(1e-3);
  const edgeMix = b.fract().smoothstep(float(0.5).sub(half), float(0.5).add(half));
  const stepped = b.floor().add(edgeMix).div(u.bands);

  // layered tint: crevice → base by band value
  let albedo: any = mix(u.creviceColor, u.baseColor, stepped);

  // low-frequency cavities pull back toward the crevice tint (ao-ish)
  const cav = triplanarFbm(
    positionWorld.mul(u.creviceScale),
    normalWorld,
    u.sharpness,
    octaves,
    p.noiseLacunarity,
    p.noiseGain,
  );
  const cavMask = cav.smoothstep(0.25, 0.55).oneMinus().mul(u.creviceStrength);
  albedo = mix(albedo, u.creviceColor, cavMask);

  // steep side faces darken slightly (fake occlusion in folds)
  const up = normalWorld.y.clamp(0, 1);
  albedo = albedo.mul(up.oneMinus().mul(u.sideDarken).oneMinus());

  // sun-bleached top: upward faces catch a warm light tint, biased to sun
  const sunCatch = normalWorld.dot(u.sunDirection).clamp(0, 1).mul(0.5).add(0.5);
  const topMask = up.pow(u.topPower).mul(sunCatch).mul(u.topStrength);
  albedo = mix(albedo, u.topColor, topMask);

  return { color: albedo, roughness: u.roughness };
}

/**
 * Stand-alone rock material for arbitrary rock meshes.
 * Returns the material plus its uniform handle; call updateFromParams() after
 * Tweakpane edits and set uniforms.sunDirection.value from the sky system.
 */
export function createRockMaterial(opts: RockMaterialOptions = {}) {
  const uniforms = createRockUniforms(opts);
  const nodes = buildRockNodes(uniforms, terrainParams.noiseOctaves);
  const material = new THREE.MeshStandardNodeMaterial();
  material.colorNode = nodes.color;
  material.roughnessNode = nodes.roughness;
  material.metalness = 0;
  return {
    material,
    uniforms,
    updateFromParams(): void {
      updateRockUniforms(uniforms);
    },
    dispose(): void {
      material.dispose();
    },
  };
}

export type RockMaterialHandle = ReturnType<typeof createRockMaterial>;
