/**
 * Sierra terrain material (§T.99, §T.112a): glacial-polished granite + DG
 * sand, as a RETINT of `terrainBlendMaterial` rather than a second shader.
 *
 * WHY A RETINT. The blend material already owns everything that is hard —
 * the sand/cover/rock slope+elevation stack, the swash, the wet band, water
 * lighting, aerial perspective (§B67 fix lives on the same node) — and all of
 * it is keyed to `terrainParams` through live uniforms. The granite look is
 * five things on top of that:
 *   1. the rock layer's own tint uniforms set to granite greys (light grey
 *      #A9A39A with a paler sun-bleached top and a darker crevice), and the
 *      sand layer's to a warm DG tone — re-applied after every
 *      `updateFromParams`, which would otherwise write the pirate colours back
 *   2. THE COVER LAYER REPLACED (§T.112a, research D1). `applyTones` never
 *      touched the cover layer, so everything under 35° on a dome — nearly all
 *      of it — wore the pirate 18 m tropical-green fbm. Here the cover weight
 *      is re-derived on the same uniforms the base uses and the pixel is
 *      blended to a granite/grus/litter palette: grus on the flats (< 20°),
 *      bare granite where it steepens (> 35°), pine litter where a 60 m macro
 *      field says a stand would drop it, and the same macro field varying the
 *      tone so no two hillsides share a value.
 *   3. a post-lit multiply on `colorNode`: JOINTING BANDS (two sets of
 *      near-vertical joints) and LICHEN patches, gated to the rock layer's
 *      own slope weight so the sand stays sand — shared with the boulders
 *      through `graniteOverlay` so a rock matches the ground it sits on
 *   4. a roughness pull on POLISHED FLATS
 *   5. HORIZON MAP (§T.112a, D5): sky AO into `aoNode`, sun self-shadow into
 *      `receivedShadowNode`, from `horizonMap.ts` — per island, which is why
 *      a handle is built per sierra heightmap (islandMaterials.ts) rather
 *      than once per world: the texture binding differs, the WGSL does not,
 *      so the pipeline cache still shares the program.
 *
 * §V48 on every periodic term: the joint is an edge of width `jointWidth`
 * inside a `jointSpacing` repeat — the feature, not the repeat, is what gets
 * band-limited. Smooth fbm fields (lichen, macro, grain) have no edge; their
 * only failure mode is the repeat going sub-pixel, which `periodResolved`
 * gates by fading each to its own mean. Slope masks are on the geometric
 * normal — not spatial, no period. §V23 functional forms only; §V57 pure
 * expression tree.
 *
 * Branching is BY ARCHETYPE FAMILY at the island (island.ts picks this handle
 * for sierra archetypes and the plain one otherwise) — no global switch, so
 * a pirate island in the same world renders exactly as before.
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  fract,
  mix,
  normalWorldGeometry,
  positionWorld,
  uniform,
  vec2,
} from 'three/tsl';
import {
  buildRockNodes,
  createRockUniforms,
  coverSlopeWeight,
  fbm2,
  terrainBlendMaterial,
  updateRockUniforms,
  type TerrainBlendMaterialHandle,
} from '../terrain';
import { terrainParams } from '../params/terrain';
import { bandLimitedEdge, periodResolved } from '../ship/bandLimit';
import { sierraParams, type SierraParams } from '../params/sierra';
import { createHorizonTextures, horizonNodes, type HorizonMap, type HorizonTextures } from './horizonMap';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyNode = any;

/** the two joint sets: seeded-looking fixed azimuths, ~70° apart */
const JOINT_AZIMUTH_A = 0.35;
const JOINT_AZIMUTH_B = 1.58;
/** lichen / macro / grain fbm octaves — build-time loop unroll, not a look knob */
const LICHEN_OCTAVES = 3;
const MACRO_OCTAVES = 2;
const GRAIN_OCTAVES = 2;
const DEG = Math.PI / 180;

export function createSierraUniforms(p: SierraParams = sierraParams) {
  return {
    jointSpacing: uniform(p.jointSpacing),
    jointWidth: uniform(p.jointWidth),
    jointStrength: uniform(p.jointStrength),
    lichenColor: uniform(new THREE.Color(p.lichenColor)),
    lichenScale: uniform(p.lichenScale),
    lichenCoverage: uniform(p.lichenCoverage),
    lichenStrength: uniform(p.lichenStrength),
    polishGloss: uniform(p.polishGloss),
    // cover retint
    grusColor: uniform(new THREE.Color(p.grusColor)),
    litterColor: uniform(new THREE.Color(p.litterColor)),
    /** stored as normal.y thresholds: cos(slope) */
    grusUp: uniform(Math.cos(p.coverGrusSlope * DEG)),
    bareUp: uniform(Math.cos(p.coverBareSlope * DEG)),
    macroScale: uniform(p.coverMacroScale),
    macroVariation: uniform(p.coverMacroVariation),
    litterCoverage: uniform(p.litterCoverage),
    litterStrength: uniform(p.litterStrength),
    grainScale: uniform(p.coverGrainScale),
    grainStrength: uniform(p.coverGrainStrength),
    // horizon
    shadowSoftness: uniform(p.horizonShadowSoftness),
    shadowStrength: uniform(p.horizonShadowStrength),
    skyAoStrength: uniform(p.horizonSkyAoStrength),
  };
}
export type SierraUniforms = ReturnType<typeof createSierraUniforms>;

export function updateSierraUniforms(u: SierraUniforms, p: SierraParams = sierraParams): void {
  u.jointSpacing.value = p.jointSpacing;
  u.jointWidth.value = p.jointWidth;
  u.jointStrength.value = p.jointStrength;
  u.lichenColor.value.setHex(p.lichenColor);
  u.lichenScale.value = p.lichenScale;
  u.lichenCoverage.value = p.lichenCoverage;
  u.lichenStrength.value = p.lichenStrength;
  u.polishGloss.value = p.polishGloss;
  u.grusColor.value.setHex(p.grusColor);
  u.litterColor.value.setHex(p.litterColor);
  u.grusUp.value = Math.cos(p.coverGrusSlope * DEG);
  u.bareUp.value = Math.cos(p.coverBareSlope * DEG);
  u.macroScale.value = p.coverMacroScale;
  u.macroVariation.value = p.coverMacroVariation;
  u.litterCoverage.value = p.litterCoverage;
  u.litterStrength.value = p.litterStrength;
  u.grainScale.value = p.coverGrainScale;
  u.grainStrength.value = p.coverGrainStrength;
  u.shadowSoftness.value = p.horizonShadowSoftness;
  u.shadowStrength.value = p.horizonShadowStrength;
  u.skyAoStrength.value = p.horizonSkyAoStrength;
}

/** one joint set: 1 away from a joint, dips toward 0 on it, band-limited */
function jointSet(azimuth: number, u: SierraUniforms): AnyNode {
  const dir = vec2(Math.cos(azimuth), Math.sin(azimuth));
  // the SMOOTH coordinate — one unit per joint — is what the filter measures
  const coord = positionWorld.xz.dot(dir).div(u.jointSpacing.max(1e-3));
  // distance to the nearest joint as a triangle wave: continuous everywhere,
  // so the wrap lands mid-block instead of on the edge (§V48, §B20)
  // @band-limited-elsewhere: this fract is the INPUT to bandLimitedEdge below, which filters on the joint width
  const distance = fract(coord.add(0.5)).sub(0.5).abs();
  const feature = u.jointWidth.div(u.jointSpacing.max(1e-3));
  return bandLimitedEdge(distance, coord, feature);
}

/** the 60 m macro field, faded to its mean (0.5) once its repeat is sub-pixel */
function macroField(u: SierraUniforms): AnyNode {
  const coord = positionWorld.xz.mul(u.macroScale);
  return mix(float(0.5), fbm2(coord, MACRO_OCTAVES), periodResolved(coord));
}

/**
 * Joints + lichen on a lit granite colour, gated by `rockW` (1 where the
 * surface is rock). SHARED by the terrain's rock layer and the boulders, so
 * the two carry the same masks and colours (§T.112a item 2).
 */
export function graniteOverlay(
  lit: AnyNode,
  graniteGrey: AnyNode,
  rockW: AnyNode,
  u: SierraUniforms,
): AnyNode {
  // jointing: two sets multiply — where both dip the block corner is darkest
  const joints = jointSet(JOINT_AZIMUTH_A, u).mul(jointSet(JOINT_AZIMUTH_B, u));
  const jointDarken = float(1).sub(joints.oneMinus().mul(u.jointStrength));

  // lichen: a low-frequency field thresholded around the coverage, faded to
  // its own mean once the repeat is sub-pixel
  const lichenCoord = positionWorld.xz.mul(u.lichenScale);
  const lichenField = fbm2(lichenCoord, LICHEN_OCTAVES);
  const edge = u.lichenCoverage.oneMinus();
  const lichenRaw = lichenField.smoothstep(edge.sub(0.08), edge.add(0.08));
  const lichenMask = mix(u.lichenCoverage, lichenRaw, periodResolved(lichenCoord))
    .mul(u.lichenStrength)
    .mul(rockW);

  // macro tone: the same 60 m field the cover reads, so a dark hillside is
  // dark in its rock and its grus alike
  const macroTone = float(1).add(macroField(u).sub(0.5).mul(u.macroVariation).mul(2));

  // post-lit modulation — albedo is linear in the lit result, so a multiply
  // here is a tint and not a lighting change; mix toward the lichen colour
  // RELATIVE to the granite so shadowed lichen stays shadowed
  const lichenRatio = u.lichenColor.div(graniteGrey.max(1e-3));
  const tinted = lit.mul(mix(float(1), jointDarken.mul(macroTone), rockW));
  return mix(tinted, tinted.mul(lichenRatio), lichenMask);
}

/**
 * The sierra ground cover albedo (item 2 above): grus / granite by slope,
 * litter by the macro field, a fine grain so the flats are not one value.
 */
function sierraCoverAlbedo(graniteGrey: AnyNode, u: SierraUniforms): AnyNode {
  const up = normalWorldGeometry.y;
  // @band-limited-elsewhere: slope mask on the geometric normal (no spatial period); width = bare..grus slope band
  const grusW = up.smoothstep(u.bareUp, u.grusUp.max(u.bareUp.add(1e-3)));
  const macro = macroField(u);
  // litter where the macro field says a stand stood: a soft threshold on a
  // smooth 60 m field (the lichen precedent); periodResolved inside macroField
  // already fades the field to its mean, which lands this on `litterCoverage`
  const litterEdge = u.litterCoverage.oneMinus();
  // @band-limited-elsewhere: threshold on macroField, which periodResolved fades to its mean; 0.2-wide in a 60 m field
  const litterW = macro.smoothstep(litterEdge.sub(0.1), litterEdge.add(0.1)).mul(u.litterStrength).mul(grusW);
  // grain: 2 m gravel mottle, faded to its mean when sub-pixel
  const grainCoord = positionWorld.xz.mul(u.grainScale);
  const grain = mix(float(0.5), fbm2(grainCoord, GRAIN_OCTAVES), periodResolved(grainCoord));
  const grus = u.grusColor.mul(float(1).add(grain.sub(0.5).mul(u.grainStrength).mul(2)));
  const ground = mix(graniteGrey, grus, grusW);
  const tone = float(1).add(macro.sub(0.5).mul(u.macroVariation).mul(2));
  return mix(ground, u.litterColor, litterW).mul(tone);
}

/** sky AO → aoNode, sun self-shadow → receivedShadowNode (§T.112a item 4) */
function applyHorizon(
  material: THREE.MeshStandardNodeMaterial,
  tex: HorizonTextures,
  sunDir: AnyNode,
  u: SierraUniforms,
): void {
  const h = horizonNodes(tex, sunDir, u.shadowSoftness);
  material.aoNode = mix(float(1), h.skyAO, u.skyAoStrength);
  const sunTerm = mix(float(1), h.sunVisibility, u.shadowStrength);
  material.receivedShadowNode = Fn(([shadow]: [AnyNode]) => shadow.mul(sunTerm)) as any;
}

export interface SierraMaterialOptions {
  /** baked horizon map for THIS island; omit for a horizon-less shared handle */
  horizon?: HorizonMap;
}

/**
 * Granite on the rock layer, DG sand on the beach, grus/litter on the cover
 * — built on the shared blend material. Returns the SAME handle shape so
 * island.ts can hand it to `createIslandMesh` in place of the plain one.
 */
export function createSierraTerrainMaterial(
  p: SierraParams = sierraParams,
  opts: SierraMaterialOptions = {},
): TerrainBlendMaterialHandle {
  const base = terrainBlendMaterial();
  const u = createSierraUniforms(p);
  const material = base.material;
  const { rock, sand, cover, blend } = base.uniforms;

  // the rock layer's slope weight, on the same geometric normal and the same
  // blend uniforms the base uses, so the granite tint lands exactly where the
  // base paints rock (§V71 — same surface, not a second derivation)
  const up = normalWorldGeometry.y;
  const w = blend.slopeBlendWidth.max(1e-3);
  // @band-limited-elsewhere: slope mask on the geometric normal (not a periodic spatial term); width = slopeBlendWidth param
  const rockW = up.smoothstep(blend.slopeThreshold.sub(w), blend.slopeThreshold.add(w)).oneMinus();

  // the COVER weight, re-derived on the base's own uniforms: the same slope
  // jitter fbm (same inputs → same value) and the same cover threshold, so
  // the retint covers exactly the pixels the base painted green. The shore
  // band is approximated from the waterline uniform (the base reads the live
  // swash height); on a 12 m DG apron the metre of difference is inside the
  // sand anyway.
  const edgeNoise = fbm2(positionWorld.xz.mul(rock.scale), 2, terrainParams.noiseLacunarity, terrainParams.noiseGain);
  const jitteredUp = up.add(edgeNoise.sub(0.5).mul(blend.slopeNoiseAmount));
  const coverW = coverSlopeWeight(cover, jitteredUp, blend.slopeBlendWidth);
  const heightAbove = positionWorld.y.sub(sand.waterline);
  // @band-limited-elsewhere: elevation band on world height (shoreHeight..+shoreFade), the base's own shore rule
  const aboveShore = heightAbove.smoothstep(cover.shoreHeight, cover.shoreHeight.add(cover.shoreFade.max(1e-3)));
  const coverMask = coverW.mul(aboveShore);

  const lit = material.colorNode as AnyNode;
  if (!lit) throw new Error('createSierraTerrainMaterial: blend material has no colorNode'); // §Rule 8
  const graniteGrey = rock.baseColor as AnyNode;
  const retinted = mix(lit, sierraCoverAlbedo(graniteGrey, u), coverMask);
  material.colorNode = graniteOverlay(retinted, graniteGrey, rockW, u);

  // polished flats: up-facing rock is glossier
  // @band-limited-elsewhere: slope mask on the geometric normal, 0.15 wide in normal.y — not a spatial edge
  const flatW = up.smoothstep(0.82, 0.97).mul(rockW);
  const rough = material.roughnessNode as AnyNode;
  if (rough) material.roughnessNode = rough.mul(float(1).sub(flatW.mul(u.polishGloss)));

  const horizonTex = opts.horizon ? createHorizonTextures(opts.horizon) : null;
  if (horizonTex) applyHorizon(material, horizonTex, rock.sunDirection, u);

  const applyTones = (): void => {
    rock.baseColor.value.setHex(p.graniteBaseColor);
    rock.topColor.value.setHex(p.graniteTopColor);
    rock.creviceColor.value.setHex(p.graniteJointColor);
    sand.baseColor.value.setHex(p.dgSandColor);
    sand.shadeColor.value.setHex(p.dgSandShadeColor);
    updateSierraUniforms(u, p);
  };
  applyTones();

  return {
    ...base,
    updateFromParams(): void {
      // the base re-reads terrainParams (the pirate palette) every frame;
      // granite goes back on top every frame for the same reason
      base.updateFromParams();
      applyTones();
    },
    dispose(): void {
      base.dispose();
      horizonTex?.dispose();
    },
  };
}

/**
 * Sierra ROCK material for the boulders (§T.112a item 2, research D9): the
 * pirate rock node graph with granite tints, the same joint/lichen/macro
 * overlay as the terrain's rock layer, and the island's horizon map. Same
 * handle shape as `createRockMaterial` so `createRocks` takes either.
 */
export function createSierraRockMaterial(
  p: SierraParams = sierraParams,
  opts: SierraMaterialOptions = {},
) {
  const uniforms = createRockUniforms();
  const u = createSierraUniforms(p);
  const nodes = buildRockNodes(uniforms, terrainParams.noiseOctaves);
  const material = new THREE.MeshStandardNodeMaterial();
  // a boulder is rock everywhere: the overlay gate is 1
  material.colorNode = graniteOverlay(nodes.color, uniforms.baseColor as AnyNode, float(1), u);
  // @band-limited-elsewhere: slope mask on the geometric normal — not a spatial edge
  const flatW = normalWorldGeometry.y.smoothstep(0.82, 0.97);
  material.roughnessNode = (nodes.roughness as AnyNode).mul(float(1).sub(flatW.mul(u.polishGloss)));
  material.metalness = 0;

  const horizonTex = opts.horizon ? createHorizonTextures(opts.horizon) : null;
  if (horizonTex) applyHorizon(material, horizonTex, uniforms.sunDirection, u);

  const applyTones = (): void => {
    uniforms.baseColor.value.setHex(p.graniteBaseColor);
    uniforms.topColor.value.setHex(p.graniteTopColor);
    uniforms.creviceColor.value.setHex(p.graniteJointColor);
    updateSierraUniforms(u, p);
  };
  applyTones();

  return {
    material,
    uniforms,
    updateFromParams(): void {
      updateRockUniforms(uniforms);
      applyTones();
    },
    dispose(): void {
      material.dispose();
      horizonTex?.dispose();
    },
  };
}

export type SierraRockMaterialHandle = ReturnType<typeof createSierraRockMaterial>;
