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
  float,
  mix,
  normalWorld,
  positionWorld,
  smoothstep,
  step,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import { terrainParams } from '../params/terrain';
// §V34 receiver hook. Safe before setActiveCaustics() and with caustics
// disabled — it returns identity nodes that fold away. It does WARN once,
// though, because TSL bakes the graph at construction: main.ts must call
// setActiveCaustics() BEFORE createArchipelago() or the beaches are baked
// without caustics and only a rebuild can give them any.
import { activeCaustics, waterLighting } from '../caustics';
import { fbm2, hash2, valueNoise2 } from './noise';
// §V.48 — one band-limit implementation project-wide (src/ship for historical
// reasons, §B.20 was found on the hull; the maths carries nothing ship-specific)
import { periodResolved } from '../ship/bandLimit';
import {
  buildShoreNodes,
  createShoreUniforms,
  updateShoreUniforms,
  type ShoreUniforms,
} from './shoreRunup';
import {
  buildRockNodes,
  createRockUniforms,
  updateRockUniforms,
  type RockMaterialOptions,
} from './rockMaterial';
import {
  buildCoverNodes,
  coverSlopeWeight,
  createCoverUniforms,
  updateCoverUniforms,
} from './groundCover';
import {
  aerialOutputNode,
  createAerialUniforms,
  updateAerialUniforms,
} from './aerialPerspective';

export interface SandMaterialOptions {
  /** initial world-space sun direction (unit, pointing AT the sun) */
  sunDirection?: THREE.Vector3;
}

/**
 * Sea surface height at a world XZ, and the depth below it (positive
 * submerged — the sign convention §V34's `depthBelowSurface` wants).
 *
 * With caustics bound this is the LIVE displaced FFT surface sampled per
 * fragment. That costs 3 texture taps, but they are the SAME 3 taps the
 * caustics receiver call would otherwise make for itself, so passing the
 * result on as `depthBelowSurface` pays them once — and it upgrades the swash
 * from a per-island scalar sea level to a waterline that follows the actual
 * waves. A 69 m swell moves the shoreline metres in and out along a flat
 * beach; a scalar drew that as one breathing contour.
 *
 * With nothing bound (tests, a stand-alone beach, `receiveCaustics` off) it
 * falls back to the flat `waterline` uniform the island drives from CpuOcean.
 */
function seaDepthNode(u: SandUniforms, worldXZ: any) {
  const active = terrainParams.receiveCaustics ? activeCaustics() : undefined;
  const seaY: any = active ? active.waterHeight(worldXZ) : u.waterline;
  return { seaY, depthBelow: seaY.sub(positionWorld.y), live: Boolean(active) };
}

/**
 * Apply §V34 water lighting to a receiver, gated on actually being in the
 * water. See `terrainParams.causticsWaterlineBand` for why the gate is ours
 * and not the caustics module's: `mode: 'below'` asserts "this receiver is
 * never above the waterline", which is true of a seabed and false of an
 * island that runs from the seabed to a 35 m peak in one material.
 *
 * Gating here also settles the double-wetness overlap: above the band the
 * caustics module's own wet tint is gone entirely and the swash owns the
 * beach, which is the model that actually knows where the waves have been.
 */
function applyWaterLighting(
  base: { color: any; roughness: any; emissive: any },
  depthBelow: any,
  band: any,
) {
  const w = waterLighting({
    worldPos: positionWorld,
    normal: normalWorld,
    depthBelowSurface: depthBelow,
    mode: 'below',
  });
  // increasing ramp: 0 a band above the waterline, 1 a band below it
  const inWater = smoothstep(band.negate(), band, depthBelow);
  return {
    color: base.color.mul(mix(vec3(1, 1, 1), w.tint, inWater)),
    roughness: base.roughness.mul(mix(float(1), w.roughnessScale, inWater)),
    emissive: base.emissive.add(w.addLight.mul(inWater)),
  };
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
    causticsBand: uniform(p.causticsWaterlineBand),
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
  u.causticsBand.value = p.causticsWaterlineBand;
  u.wetBand.value = p.wetBand;
  u.wetDarken.value = p.wetDarken;
}

/**
 * Build sand color/roughness/emissive nodes. Exported for the blend material.
 * Sand is sampled on the world XZ plane (beaches are near-horizontal; the
 * blend material hands steep faces to rock, so no tri-planar needed here).
 */
export function buildSandNodes(
  u: SandUniforms,
  octaves: number,
  /**
   * Shore swash (T33). Pass null for a plain beach with only the static wet
   * band. Like `octaves`, this is a BUILD-TIME branch (terrainParams
   * .runupEnabled) — flipping it needs a material rebuild, not a uniform push.
   */
  shore: ShoreUniforms | null = null,
) {
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

  // fine grain: ±grainStrength/2 brightness modulation.
  // §V.48: 0.071 m at `sandGrainScale` 14 — sub-pixel from 140 m head-on and
  // from 14 m at 10× grazing, and a beach seen from a ship IS grazing. No
  // edge here, just a smooth term whose whole period goes sub-pixel, so this
  // is the `periodResolved` branch: fade the amplitude to the mean (which is
  // 1, i.e. no modulation) rather than widening anything.
  const grainCoord = ground.mul(u.grainScale);
  const grain = valueNoise2(grainCoord);
  albedo = albedo.mul(
    grain.sub(0.5).mul(u.grainStrength).mul(periodResolved(grainCoord)).add(1),
  );

  // elevation above the live sea surface (m) — the axis everything shore-side
  // is expressed on. Negated depth so the two can never disagree about where
  // the water is.
  const sea = seaDepthNode(u, ground);
  const heightAbove = sea.depthBelow.negate();

  // Static shore wetness: the permanently-damp band right at the water; the
  // swash model below adds the part that MOVES.
  // §V23 chained form — receiver is x: smoothstep(0, wetBand, heightAbove) is
  // 0 at the waterline and 1 a band above it, so oneMinus() gives 1 at the
  // water fading to 0 up the beach.
  const staticWet = heightAbove.smoothstep(float(0), u.wetBand.max(1e-3)).oneMinus();

  // T33 swash: the wave tongue, its foam line, and the drying wet memory
  const swash = shore ? buildShoreNodes(shore, heightAbove, ground) : null;
  const wet = swash ? staticWet.max(swash.wet) : staticWet;
  albedo = albedo.mul(wet.mul(u.wetDarken).oneMinus());
  if (swash && shore) {
    // thin water film over sand reads turquoise, not blue-black
    albedo = mix(albedo, shore.sheetColor, swash.sheet.mul(shore.sheetStrength));
    albedo = mix(albedo, shore.foamColor, swash.foam);
  }

  // sparkle glints: hashed cells, random facet normal, sun/view half-vector.
  //
  // §V.48, and this was the worst offender in the terrain stack because it
  // ends up in an ADDITIVE slot (§V44): `sparkleDensity` 6 gives a 0.167 m
  // cell, the gate is a BINARY step() and the facet normal is per-cell RANDOM,
  // so once a cell is under a pixel the pow(dot,26) term is per-pixel random
  // white — the exact §B.20 signature ("uniform speckle over a whole surface")
  // multiplied by `sparkleStrength` 1.4 straight into emissive. It goes
  // sub-pixel at 326 m head-on and at 33 m at 10× grazing.
  //
  // The correct filtered value of a random per-cell glint over a footprint
  // spanning many cells is its MEAN, and the mean of a pow(·,26) lobe gated at
  // 6% coverage is ≈0 — so fading the amplitude is not an approximation here,
  // it IS the answer. `periodResolved` on the cell coordinate (1 unit = 1
  // cell) is exactly that gate.
  const cellCoord = ground.mul(u.sparkleDensity);
  const sparkleResolved = periodResolved(cellCoord);
  const cell = cellCoord.floor();
  const gate = step(u.sparkleCoverage.oneMinus(), hash2(cell));
  const jitter = vec3(
    hash2(cell.add(vec2(7.7, 3.1))).sub(0.5),
    hash2(cell.add(vec2(1.3, 9.7))).sub(0.5),
    hash2(cell.add(vec2(4.9, 6.3))).sub(0.5),
  );
  const facet = normalWorld.add(jitter).normalize();
  const viewDir = cameraPosition.sub(positionWorld).normalize();
  const halfDir = viewDir.add(u.sunDirection).normalize();
  // dry sand glitters; a wet or foamed patch does not — gating on `wet` is
  // what makes the swash edge read as a material change, not just a tint
  const glint = facet
    .dot(halfDir)
    .clamp(0, 1)
    .pow(u.sparklePower)
    .mul(gate)
    .mul(u.sparkleStrength)
    .mul(wet.oneMinus())
    .mul(sparkleResolved); // §V.48 — see the note above the cell coordinate

  // wet sand is glossy, foam is not — foam pulls roughness back up
  const gloss = swash ? wet.max(swash.sheet).mul(swash.foam.oneMinus()) : wet;

  return {
    color: albedo,
    roughness: mix(u.roughnessDry, u.roughnessWet, gloss),
    emissive: vec3(glint),
    wet,
    swash,
    /** metres below the live sea surface, positive submerged (§V34 receiver) */
    depthBelow: sea.depthBelow,
    /** true when the sea height is the live FFT surface, not the flat uniform */
    liveWaterHeight: sea.live,
  };
}

/** Stand-alone sand material (flat beach meshes, decks of sand, etc). */
export function createSandMaterial(opts: SandMaterialOptions = {}) {
  const uniforms = createSandUniforms(opts);
  const shore = terrainParams.runupEnabled ? createShoreUniforms() : null;
  const nodes = buildSandNodes(uniforms, terrainParams.noiseOctaves, shore);
  const material = new THREE.MeshStandardNodeMaterial();
  // §V34 water lighting, same contract as terrainBlendMaterial below
  const lit = applyWaterLighting(nodes, nodes.depthBelow, uniforms.causticsBand);
  material.colorNode = lit.color;
  material.roughnessNode = lit.roughness;
  material.emissiveNode = lit.emissive;
  material.metalness = 0;
  return {
    material,
    uniforms,
    shore,
    ...shoreControls(uniforms, shore),
    updateFromParams(): void {
      updateSandUniforms(uniforms);
      if (shore) updateShoreUniforms(shore);
    },
    dispose(): void {
      material.dispose();
    },
  };
}

/**
 * The three per-frame inputs the swash needs from outside the terrain system.
 * Shared by both sand-bearing materials so the island wires them once.
 */
function shoreControls(sand: SandUniforms, shore: ShoreUniforms | null) {
  return {
    /** sim time (s) — drives the swash cycle (§V2: sim time, not wall clock) */
    setTime(seconds: number): void {
      if (shore) shore.time.value = seconds;
    },
    /**
     * Live still-water level (m) at this shore. Drive it from the SAME CPU
     * ocean mirror buoyancy samples (§V8) or the painted bands drift off the
     * waterline the ocean mesh actually draws.
     */
    setWaterline(y: number): void {
      sand.waterline.value = y;
    },
    /**
     * Swell AMPLITUDE (m) ≈ Hs/2 — deeper runup in heavier weather. Wire it
     * to `oceanSim.heightRms * 2` (heightRms is σ; Hs = 4σ).
     */
    setSwell(meters: number): void {
      if (shore) shore.swell.value = meters;
    },
  };
}

export type SandMaterialHandle = ReturnType<typeof createSandMaterial>;

/**
 * Combined island terrain material for T20: a THREE-layer stack — sand in the
 * shore band, green cover on the ground above it, rock wherever it is too
 * steep to hold either.
 *
 * WHY THREE AND NOT TWO. Two layers split on SLOPE alone gave sand 82-98% of
 * every island's surface (mean terrain slope 19-23° against a 44° threshold),
 * i.e. one tan albedo from the water to the summit and no green on an island
 * at all — see groundCover.ts for the full measurement. The references band by
 * ELEVATION, so elevation is now the second axis. It costs no binding: the
 * axis is `positionWorld.y` against the `waterline` uniform already bound for
 * the swash, and the extra layer reuses the same analytic fbm.
 *
 * The two slope thresholds are deliberately different. Sand keeps the
 * permissive one (blown sand and shingle hold on a steep beach); cover uses a
 * stricter one, which is what makes a headland wall and a sea stack read as
 * BARE ROCK instead of a grassy ramp — the whole point of putting walls in the
 * height field in the first place (island/archetypes.ts `sheer`).
 */
export function terrainBlendMaterial(
  rockOpts: RockMaterialOptions = {},
  sandOpts: SandMaterialOptions = {},
) {
  const p = terrainParams;
  const rock = createRockUniforms(rockOpts);
  const sand = createSandUniforms(sandOpts);
  const cover = createCoverUniforms();
  const blend = {
    slopeThreshold: uniform(p.slopeThreshold),
    slopeBlendWidth: uniform(p.slopeBlendWidth),
    slopeNoiseAmount: uniform(p.slopeNoiseAmount),
  };

  const shore = p.runupEnabled ? createShoreUniforms() : null;
  const rockNodes = buildRockNodes(rock, p.noiseOctaves);
  const sandNodes = buildSandNodes(sand, p.noiseOctaves, shore);
  // elevation above the LIVE sea surface — handed over from the sand layer
  // rather than recomputed, so the shore band and the swash can never disagree
  // about where the water is (same rule as `waterline` itself)
  const coverNodes = buildCoverNodes(
    cover,
    sandNodes.depthBelow.negate(),
    sand.sunDirection,
    p.noiseOctaves,
  );

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
  const coverW = coverSlopeWeight(cover, up, blend.slopeBlendWidth);
  // 1 in the sand skirt at the water, 0 on the vegetated ground above it
  const shoreW = coverNodes.shoreWeight;

  const material = new THREE.MeshStandardNodeMaterial();
  // §V10 composition note: the swash foam is painted on the SAND only. Where
  // rock pierces the waterline the foam ring comes from the intersection-foam
  // machinery (flowfoam depth-compare), which is why this is a plain blend and
  // not a second foam source competing with it.
  const groundColor = mix(coverNodes.color, sandNodes.color, shoreW);
  const groundRough = mix(coverNodes.roughness, sandNodes.roughness, shoreW);
  // which slope rule applies is itself blended by the shore band, so the two
  // thresholds hand over exactly where the two materials do
  const groundW = mix(coverW, sandW, shoreW);
  const albedo = mix(rockNodes.color, groundColor, groundW);
  const roughness = mix(rockNodes.roughness, groundRough, groundW);

  // §V34: sun caustics over the shallows, sea bounce-fill, depth absorption.
  // The seabed and beach are the receivers the invariant names, and this is
  // the biggest one in the scene by screen coverage. `mode: 'below'` compiles
  // the reflected above-water branch away; `depthBelowSurface` is handed over
  // rather than re-derived so its 3 surface taps are shared with the swash.
  //
  // NOTE the overlap: water lighting carries its own wetness band around the
  // waterline (`tint`), which lands on top of the swash's wet sand in the
  // permanently-damp strip. Same physical phenomenon from two models — if it
  // reads too dark in the browser, `terrainParams.wetDarken` is the live knob.
  const lit = applyWaterLighting(
    {
      color: albedo,
      roughness,
      // the sparkle is a SAND phenomenon: gate it on the shore band as well as
      // the slope, or dry glitter appears on a hillside and reads as fireflies
      emissive: sandNodes.emissive.mul(groundW).mul(shoreW),
    },
    sandNodes.depthBelow,
    sand.causticsBand,
  );
  material.colorNode = lit.color;
  material.roughnessNode = lit.roughness;
  material.emissiveNode = lit.emissive;
  material.metalness = 0;

  // §V30/§V43 aerial perspective. The island melts into the atmosphere on the
  // SAME ramp the water does — the ocean owns the curve, this reads it — so
  // the two agree at the waterline instead of the land reading as a saturated
  // cut-out on hazed sea. `fog = false` and `outputNode` are a PAIR: the first
  // stops scene fog compositing a second time, the second is the only
  // post-lighting hook (haze must not be multiplied into albedo, or a shadowed
  // cliff would darken the air in front of it). See aerialPerspective.ts.
  const aerial = createAerialUniforms();
  material.fog = false;
  material.outputNode = aerialOutputNode(aerial);

  const sunDirection = (v: THREE.Vector3): void => {
    (rock.sunDirection.value as THREE.Vector3).copy(v).normalize();
    (sand.sunDirection.value as THREE.Vector3).copy(v).normalize();
  };

  return {
    material,
    uniforms: { rock, sand, cover, aerial, blend, shore },
    shore,
    /** set both sub-materials' sun direction (world, pointing at the sun) */
    setSunDirection: sunDirection,
    /**
     * Haze target colour (§V30) — drive it from `scene.fog.color`, the same
     * value the ocean copies into its own haze. The sky rig retints that every
     * frame, so passing anything else makes the land melt into a different
     * atmosphere from the sea at sunset.
     */
    setHazeColor(c: THREE.Color): void {
      (aerial.color.value as THREE.Color).copy(c);
    },
    ...shoreControls(sand, shore),
    updateFromParams(): void {
      updateRockUniforms(rock);
      updateSandUniforms(sand);
      updateCoverUniforms(cover);
      updateAerialUniforms(aerial);
      if (shore) updateShoreUniforms(shore);
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
