/**
 * Stylized sand material + slope-blend terrain material (T27, §V16 — all
 * tunables from params/terrain.ts, live via updateFromParams()).
 *
 * Look (docs/ship-full-view.png beach): warm bright sand, painterly.
 * - fine grain: high-frequency value noise brightness modulation
 * - large-scale shade variation: low-frequency fbm mixes two warm tints
 * - sparkle glints: world-space hash cells with a random facet normal, lit by
 *   pow(dot(facet, half(view,sun))) — view-dependent glitter that stays
 *   anchored to the ground (screen-stable), emitted so it survives shading
 * - wetness band hook: `waterline` + `wetBand` uniforms darken + gloss sand
 *   near the water for the shore blend (T20 sets waterline, ocean owns level)
 *
 * terrainBlendMaterial(rockOpts, sandOpts): one shader, sand on flat ground,
 * rock on steep slopes (normal.y vs slopeThreshold, noise-jittered edge) —
 * this is the material T20's heightmap island terrain consumes.
 *
 * Constructible without a renderer (lazy GPU touch), same as rockMaterial.
 */
import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  mix,
  normalWorld,
  positionWorld,
  step,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import { terrainParams } from '../params/terrain';
import { fbm2, hash2, valueNoise2 } from './noise';
import {
  buildRockNodes,
  createRockUniforms,
  updateRockUniforms,
  type RockMaterialOptions,
} from './rockMaterial';

export interface SandMaterialOptions {
  /** initial world-space sun direction (unit, pointing AT the sun) */
  sunDirection?: THREE.Vector3;
}

/** Live GPU uniforms mirroring the sand/shore section of terrainParams. */
export function createSandUniforms(opts: SandMaterialOptions = {}) {
  const p = terrainParams;
  return {
    baseColor: uniform(new THREE.Color(p.sandBaseColor)),
    shadeColor: uniform(new THREE.Color(p.sandShadeColor)),
    shadeScale: uniform(p.sandShadeScale),
    grainScale: uniform(p.sandGrainScale),
    grainStrength: uniform(p.sandGrainStrength),
    sparkleDensity: uniform(p.sparkleDensity),
    sparkleCoverage: uniform(p.sparkleCoverage),
    sparklePower: uniform(p.sparklePower),
    sparkleStrength: uniform(p.sparkleStrength),
    roughnessDry: uniform(p.sandRoughnessDry),
    roughnessWet: uniform(p.sandRoughnessWet),
    waterline: uniform(p.waterline),
    wetBand: uniform(p.wetBand),
    wetDarken: uniform(p.wetDarken),
    /** update per frame from the sky/sun system (T15) */
    sunDirection: uniform(
      (opts.sunDirection ?? new THREE.Vector3(0.4, 0.8, 0.2)).clone().normalize(),
    ),
  };
}

export type SandUniforms = ReturnType<typeof createSandUniforms>;

/** Copy current terrainParams values into the uniforms (call on change). */
export function updateSandUniforms(u: SandUniforms): void {
  const p = terrainParams;
  u.baseColor.value.setHex(p.sandBaseColor);
  u.shadeColor.value.setHex(p.sandShadeColor);
  u.shadeScale.value = p.sandShadeScale;
  u.grainScale.value = p.sandGrainScale;
  u.grainStrength.value = p.sandGrainStrength;
  u.sparkleDensity.value = p.sparkleDensity;
  u.sparkleCoverage.value = p.sparkleCoverage;
  u.sparklePower.value = p.sparklePower;
  u.sparkleStrength.value = p.sparkleStrength;
  u.roughnessDry.value = p.sandRoughnessDry;
  u.roughnessWet.value = p.sandRoughnessWet;
  u.waterline.value = p.waterline;
  u.wetBand.value = p.wetBand;
  u.wetDarken.value = p.wetDarken;
}

/**
 * Build sand color/roughness/emissive nodes. Exported for the blend material.
 * Sand is sampled on the world XZ plane (beaches are near-horizontal; the
 * blend material hands steep faces to rock, so no tri-planar needed here).
 */
export function buildSandNodes(u: SandUniforms, octaves: number) {
  const p = terrainParams;
  const ground = positionWorld.xz;

  // warm base with large-scale painterly shade variation
  const shade = fbm2(
    ground.mul(u.shadeScale),
    octaves,
    p.noiseLacunarity,
    p.noiseGain,
  );
  let albedo: any = mix(u.shadeColor, u.baseColor, shade);

  // fine grain: ±grainStrength/2 brightness modulation
  const grain = valueNoise2(ground.mul(u.grainScale));
  albedo = albedo.mul(grain.sub(0.5).mul(u.grainStrength).add(1));

  // shore wetness: 1 at/below waterline → 0 at waterline+wetBand
  const wet = positionWorld.y
    .smoothstep(u.waterline, u.waterline.add(u.wetBand.max(1e-3)))
    .oneMinus();
  albedo = albedo.mul(wet.mul(u.wetDarken).oneMinus());

  // sparkle glints: hashed cells, random facet normal, sun/view half-vector
  const cell = ground.mul(u.sparkleDensity).floor();
  const gate = step(u.sparkleCoverage.oneMinus(), hash2(cell));
  const jitter = vec3(
    hash2(cell.add(vec2(7.7, 3.1))).sub(0.5),
    hash2(cell.add(vec2(1.3, 9.7))).sub(0.5),
    hash2(cell.add(vec2(4.9, 6.3))).sub(0.5),
  );
  const facet = normalWorld.add(jitter).normalize();
  const viewDir = cameraPosition.sub(positionWorld).normalize();
  const halfDir = viewDir.add(u.sunDirection).normalize();
  const glint = facet
    .dot(halfDir)
    .clamp(0, 1)
    .pow(u.sparklePower)
    .mul(gate)
    .mul(u.sparkleStrength);

  return {
    color: albedo,
    roughness: mix(u.roughnessDry, u.roughnessWet, wet),
    emissive: vec3(glint),
    wet,
  };
}

/** Stand-alone sand material (flat beach meshes, decks of sand, etc). */
export function createSandMaterial(opts: SandMaterialOptions = {}) {
  const uniforms = createSandUniforms(opts);
  const nodes = buildSandNodes(uniforms, terrainParams.noiseOctaves);
  const material = new THREE.MeshStandardNodeMaterial();
  material.colorNode = nodes.color;
  material.roughnessNode = nodes.roughness;
  material.emissiveNode = nodes.emissive;
  material.metalness = 0;
  return {
    material,
    uniforms,
    updateFromParams(): void {
      updateSandUniforms(uniforms);
    },
    dispose(): void {
      material.dispose();
    },
  };
}

export type SandMaterialHandle = ReturnType<typeof createSandMaterial>;

/**
 * Combined island terrain material for T20: sand on flat, rock on steep.
 * Blend weight = smoothstep over normal.y around slopeThreshold, edge
 * jittered by fbm so the border reads hand-painted, not computed.
 */
export function terrainBlendMaterial(
  rockOpts: RockMaterialOptions = {},
  sandOpts: SandMaterialOptions = {},
) {
  const p = terrainParams;
  const rock = createRockUniforms(rockOpts);
  const sand = createSandUniforms(sandOpts);
  const blend = {
    slopeThreshold: uniform(p.slopeThreshold),
    slopeBlendWidth: uniform(p.slopeBlendWidth),
    slopeNoiseAmount: uniform(p.slopeNoiseAmount),
  };

  const rockNodes = buildRockNodes(rock, p.noiseOctaves);
  const sandNodes = buildSandNodes(sand, p.noiseOctaves);

  const edgeNoise = fbm2(
    positionWorld.xz.mul(rock.scale),
    2,
    p.noiseLacunarity,
    p.noiseGain,
  );
  const up = normalWorld.y.add(edgeNoise.sub(0.5).mul(blend.slopeNoiseAmount));
  const sandW = up.smoothstep(
    blend.slopeThreshold.sub(blend.slopeBlendWidth.max(1e-3)),
    blend.slopeThreshold.add(blend.slopeBlendWidth.max(1e-3)),
  );

  const material = new THREE.MeshStandardNodeMaterial();
  material.colorNode = mix(rockNodes.color, sandNodes.color, sandW);
  material.roughnessNode = mix(rockNodes.roughness, sandNodes.roughness, sandW);
  material.emissiveNode = sandNodes.emissive.mul(sandW);
  material.metalness = 0;

  const sunDirection = (v: THREE.Vector3): void => {
    (rock.sunDirection.value as THREE.Vector3).copy(v).normalize();
    (sand.sunDirection.value as THREE.Vector3).copy(v).normalize();
  };

  return {
    material,
    uniforms: { rock, sand, blend },
    /** set both sub-materials' sun direction (world, pointing at the sun) */
    setSunDirection: sunDirection,
    updateFromParams(): void {
      updateRockUniforms(rock);
      updateSandUniforms(sand);
      blend.slopeThreshold.value = terrainParams.slopeThreshold;
      blend.slopeBlendWidth.value = terrainParams.slopeBlendWidth;
      blend.slopeNoiseAmount.value = terrainParams.slopeNoiseAmount;
    },
    dispose(): void {
      material.dispose();
    },
  };
}

export type TerrainBlendMaterialHandle = ReturnType<typeof terrainBlendMaterial>;
