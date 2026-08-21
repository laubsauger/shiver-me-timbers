/**
 * Sierra terrain material (§T.99, §T.112a, §T.112d): granite with a history.
 *
 * WHAT IT IS NOW (T112d). Its OWN land surface — a height-blended layer
 * stack driven by the terrain-info texture (terrainInfo.ts) — composed over
 * the shared blend material's SHORE: the DG sand apron, the swash, the wet
 * band, water lighting and aerial perspective are the base's (§B67 lives on
 * the same node) and are untouched. Everything above the shore band is this
 * file's. `buildSierraSurface` is ONE function the terrain and the boulders
 * both call, so a rock carries exactly the masks and colours of the ground
 * it sits on (research D9).
 *
 * THE STACK (research §2.5, Far Cry 5 height blend). Five layers score
 * `mask + layerHeightAmp · height`, the winner and anything within
 * `layerBlendWidth` of it share the pixel:
 *   granite    the floor — bare bedrock everywhere the others do not claim
 *   polished   convex (κ > polishCurvature), gentle (< polishSlope), thin
 *              debris: the glacial crown; lighter, and it pulls roughness
 *   fractured  joint density high AND steep: the plucked lee, darker,
 *              rougher, and the joint sets bite hardest here
 *   grus       gentle ground, boosted by the debris channel (talus treads)
 *   litter     gentle AND moist (the under-canopy proxy until T112e hands
 *              over pine density), or the T112a 60 m macro stand field
 * On top, in order: sheeting bands (below), joints, lichen, the implied
 * trail, macro tone, elevation bands.
 *
 * SHEETING BANDS FOLLOW THE DOME (research §2.2, Martel). The world-space
 * stripe grid is gone: the band coordinate is the island-local position
 * projected on `sheetingDirection` = ∇κ from the info texture (leans to the
 * tighter axis of an elliptical dome, radial on a round one), with the
 * seeded ice axis as the fallback where ∇κ vanishes. Gated to convex bedrock.
 *
 * IMPLIED TRAIL (T112 decision): `pathDistance` < `pathWearWidth` fades the
 * surface toward a worn grus — one wide smoothstep across the whole width,
 * no ribbon edge — and the trail is absent when T112b's `hm.path` is
 * (distance encodes as +∞).
 *
 * VALUE GROUPING (T112 decision: stylised PBR first): the aerial node stays;
 * elevation bands tint the land in 3–4 height bands so a hillside reads as
 * one value block at distance (the Firewatch read), strength on a param.
 *
 * §V48 on every edge: joints and sheet risers are EDGES inside a repeat and
 * are band-limited on their own width (`bandLimitedEdge`); the fbm fields
 * are faded to their mean by `periodResolved`; every texture-driven mask is
 * a mipped sample (a filtered tier by construction); slope/curvature masks
 * are compares of non-periodic quantities. §V23/§V57: pure expression tree.
 *
 * Branching is BY ARCHETYPE FAMILY at the island (island.ts picks this
 * handle for sierra archetypes) — a pirate island renders exactly as before.
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  fract,
  mix,
  normalWorldGeometry,
  positionLocal,
  positionWorld,
  uniform,
  vec2,
} from 'three/tsl';
import {
  buildRockNodes,
  createRockUniforms,
  fbm2,
  terrainBlendMaterial,
  updateRockUniforms,
  type TerrainBlendMaterialHandle,
} from '../terrain';
import { swissTurbulence2 } from '../terrain/noise';
import { terrainParams } from '../params/terrain';
import { bandLimitedEdge, periodResolved } from '../ship/bandLimit';
import { reliefNormal } from '../ship/surfaceRelief';
import { sierraParams, type SierraParams } from '../params/sierra';
import { createHorizonTextures, horizonNodes, type HorizonMap, type HorizonTextures } from './horizonMap';
import {
  createTerrainInfoTexture,
  terrainInfoNodes,
  SHEET_DIR_FALLBACK,
  TerrainInfoChannels,
  type TerrainInfo,
  type TerrainInfoNodes,
  type TerrainInfoTexture,
} from './terrainInfo';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyNode = any;

/** the two joint sets: seeded-looking fixed azimuths, ~70° apart */
const JOINT_AZIMUTH_A = 0.35;
const JOINT_AZIMUTH_B = 1.58;
/** fbm octaves — build-time loop unroll, not a look knob */
const LICHEN_OCTAVES = 3;
const MACRO_OCTAVES = 2;
const GRAIN_OCTAVES = 2;
const JOINT_OCTAVES = 3;
/** per-layer share of the grain height field (granite, polished, fractured, grus, litter) */
const LAYER_HEIGHT_SHARE = [1, 0.5, 1, 0.7, 0.3];
/** granite's floor score — the others must beat this to claim the pixel */
const GRANITE_FLOOR = 0.3;
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
    // cover (T112a)
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
    // horizon (T112a)
    shadowSoftness: uniform(p.horizonShadowSoftness),
    shadowStrength: uniform(p.horizonShadowStrength),
    skyAoStrength: uniform(p.horizonSkyAoStrength),
    // ── T112d shading ──
    polishCurvature: uniform(p.polishCurvature),
    polishUp: uniform(Math.cos(p.polishSlope * DEG)),
    polishDebrisMax: uniform(p.polishDebrisMax),
    polishedColor: uniform(new THREE.Color(p.polishedColor)),
    fracturedJoint: uniform(p.fracturedJoint),
    fracturedUp: uniform(Math.cos(p.fracturedSlope * DEG)),
    fracturedColor: uniform(new THREE.Color(p.fracturedColor)),
    fracturedRoughness: uniform(p.fracturedRoughness),
    grusDebrisMin: uniform(p.grusDebrisMin),
    litterMoisture: uniform(p.litterMoisture),
    lichenAspect: uniform(new THREE.Vector2(Math.cos(p.lichenAspectAzimuth), Math.sin(p.lichenAspectAzimuth))),
    lichenAspectStrength: uniform(p.lichenAspectStrength),
    lichenShadeStrength: uniform(p.lichenShadeStrength),
    pathWearWidth: uniform(p.pathWearWidth),
    pathWearStrength: uniform(p.pathWearStrength),
    pathWornColor: uniform(new THREE.Color(p.pathWornColor)),
    sheetBandSpacing: uniform(p.sheetBandSpacing),
    sheetBandRiser: uniform(p.sheetBandRiser),
    sheetBandStrength: uniform(p.sheetBandStrength),
    sheetBandConvexity: uniform(p.sheetBandConvexity),
    sheetBandRelief: uniform(p.sheetBandRelief),
    layerBlendWidth: uniform(p.layerBlendWidth),
    layerHeightAmp: uniform(p.layerHeightAmp),
    bandLowHeight: uniform(p.bandLowHeight),
    bandMidHeight: uniform(p.bandMidHeight),
    bandHighHeight: uniform(p.bandHighHeight),
    bandWidth: uniform(p.bandWidth),
    bandLowTint: uniform(new THREE.Color(p.bandLowTint)),
    bandMidTint: uniform(new THREE.Color(p.bandMidTint)),
    bandHighTint: uniform(new THREE.Color(p.bandHighTint)),
    bandCrownTint: uniform(new THREE.Color(p.bandCrownTint)),
    bandStrength: uniform(p.bandStrength),
    jointScale: uniform(p.jointScale),
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
  u.polishCurvature.value = p.polishCurvature;
  u.polishUp.value = Math.cos(p.polishSlope * DEG);
  u.polishDebrisMax.value = p.polishDebrisMax;
  u.polishedColor.value.setHex(p.polishedColor);
  u.fracturedJoint.value = p.fracturedJoint;
  u.fracturedUp.value = Math.cos(p.fracturedSlope * DEG);
  u.fracturedColor.value.setHex(p.fracturedColor);
  u.fracturedRoughness.value = p.fracturedRoughness;
  u.grusDebrisMin.value = p.grusDebrisMin;
  u.litterMoisture.value = p.litterMoisture;
  u.lichenAspect.value.set(Math.cos(p.lichenAspectAzimuth), Math.sin(p.lichenAspectAzimuth));
  u.lichenAspectStrength.value = p.lichenAspectStrength;
  u.lichenShadeStrength.value = p.lichenShadeStrength;
  u.pathWearWidth.value = p.pathWearWidth;
  u.pathWearStrength.value = p.pathWearStrength;
  u.pathWornColor.value.setHex(p.pathWornColor);
  u.sheetBandSpacing.value = p.sheetBandSpacing;
  u.sheetBandRiser.value = p.sheetBandRiser;
  u.sheetBandStrength.value = p.sheetBandStrength;
  u.sheetBandConvexity.value = p.sheetBandConvexity;
  u.sheetBandRelief.value = p.sheetBandRelief;
  u.layerBlendWidth.value = p.layerBlendWidth;
  u.layerHeightAmp.value = p.layerHeightAmp;
  u.bandLowHeight.value = p.bandLowHeight;
  u.bandMidHeight.value = p.bandMidHeight;
  u.bandHighHeight.value = p.bandHighHeight;
  u.bandWidth.value = p.bandWidth;
  u.bandLowTint.value.setHex(p.bandLowTint);
  u.bandMidTint.value.setHex(p.bandMidTint);
  u.bandHighTint.value.setHex(p.bandHighTint);
  u.bandCrownTint.value.setHex(p.bandCrownTint);
  u.bandStrength.value = p.bandStrength;
  u.jointScale.value = p.jointScale;
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
 * The shader's sheeting axis — twin of `sheetingDirectionCpu`: ∇κ from the
 * info texture, the ice axis as a fallback so a flat field never normalises
 * a zero vector.
 */
function sheetingDirection(info: TerrainInfoNodes, iceDir: AnyNode): AnyNode {
  return info.curvatureGradient.add(iceDir.mul(SHEET_DIR_FALLBACK)).normalize();
}

/**
 * Sheeting bands: 1 on a tread, dips toward 0 on a riser, band-limited on the
 * RISER's width (the feature, not the repeat — §V48). The coordinate is
 * island-local position along the sheeting axis, one unit per sheet.
 */
function sheetBands(localXZ: AnyNode, dir: AnyNode, u: SierraUniforms): AnyNode {
  const coord = localXZ.dot(dir).div(u.sheetBandSpacing.max(1e-3));
  // @band-limited-elsewhere: this fract is the INPUT to bandLimitedEdge below, which filters on the riser width
  const distance = fract(coord.add(0.5)).sub(0.5).abs();
  return bandLimitedEdge(distance, coord, u.sheetBandRiser.mul(0.5));
}

export interface SierraSurfaceInputs {
  /** the island's info texture reader, or null for the horizon-less handle (R0 path, tests) */
  info: TerrainInfoNodes | null;
  /** sky AO (1 open) from the horizon map, or 1 when unbound */
  skyAO: AnyNode;
  /** bare-granite colour (the rock layer's base colour uniform) */
  graniteGrey: AnyNode;
  /** island-local XZ (positionLocal for the terrain mesh and the instanced rocks) */
  localXZ: AnyNode;
  /** island-local joint-noise offset, the bake's `jointNoiseOffset` */
  jointOffset: AnyNode;
  /** unit ice-flow axis (island-local xz) — the sheeting fallback */
  iceDir: AnyNode;
  /** the surface's incoming roughness */
  roughness: AnyNode;
  u: SierraUniforms;
}

export interface SierraSurface {
  albedo: AnyNode;
  roughness: AnyNode;
  /** the sheeting relief height (m) — `reliefNormal` input for the terrain */
  relief: AnyNode;
  /** 1 on bare bedrock (polished + fractured + granite), 0 on grus/litter */
  rockness: AnyNode;
}

/**
 * THE LAND SURFACE. Shared by the terrain (above the shore band) and the
 * boulders (everywhere), see the header.
 */
export function buildSierraSurface(inp: SierraSurfaceInputs): SierraSurface {
  const { info, u } = inp;
  const up = normalWorldGeometry.y;
  const nxz = normalWorldGeometry.xz;

  // ── the eight channels, four from the texture and four derived ──────────
  const curvature: AnyNode = info ? info.curvature : float(0);
  const moisture: AnyNode = info ? info.moisture : float(0);
  const pathDistance: AnyNode = info ? info.pathDistance : float(TerrainInfoChannels.encode.pathDistanceMetres);
  const debris: AnyNode = info ? info.debris : float(0);
  const jointCoord = inp.localXZ.mul(u.jointScale).add(inp.jointOffset);
  const jointDensity = swissTurbulence2(jointCoord, JOINT_OCTAVES);

  // ── layer masks: compares of non-periodic quantities (slope on the
  //    geometric normal, curvature/moisture/debris from a mipped texture)
  // @band-limited-elsewhere: slope mask on the geometric normal; width = bare..grus slope band
  const flatW = up.smoothstep(u.bareUp, u.grusUp.max(u.bareUp.add(1e-3)));
  const halfPolish = u.polishCurvature.mul(0.5);
  // @band-limited-elsewhere: curvature from the mipped info texture, half-threshold wide; slope on the geometric normal
  const polishW = curvature
    .smoothstep(halfPolish, u.polishCurvature.add(halfPolish))
    // @band-limited-elsewhere: slope mask on the geometric normal (0.08 wide in normal.y) and debris from the mipped info texture
    .mul(up.smoothstep(u.polishUp.sub(0.06), u.polishUp.add(0.02)))
    .mul(debris.smoothstep(u.polishDebrisMax.mul(0.5), u.polishDebrisMax).oneMinus());
  // @band-limited-elsewhere: joint density is a swiss-turbulence field (3 octaves at jointScale, 50 m): no edge; slope on the geometric normal
  const fracturedW = jointDensity
    .smoothstep(u.fracturedJoint.sub(0.1), u.fracturedJoint.add(0.1))
    .mul(up.smoothstep(u.fracturedUp.sub(0.1), u.fracturedUp.add(0.1)).oneMinus());
  // @band-limited-elsewhere: debris from the mipped info texture, half-threshold wide
  const debrisW = debris.smoothstep(u.grusDebrisMin.mul(0.5), u.grusDebrisMin);
  const grusW = flatW.mul(debrisW.mul(0.5).add(0.5));
  const macro = macroField(u);
  const litterEdge = u.litterCoverage.oneMinus();
  // @band-limited-elsewhere: threshold on macroField, which periodResolved fades to its mean; 0.2-wide in a 60 m field
  const macroLitter = macro.smoothstep(litterEdge.sub(0.1), litterEdge.add(0.1));
  // @band-limited-elsewhere: moisture from the mipped info texture, 0.2 wide
  const moistLitter = moisture.smoothstep(u.litterMoisture.sub(0.1), u.litterMoisture.add(0.1));
  const litterW = macroLitter.max(moistLitter).mul(u.litterStrength).mul(flatW);

  // ── height blend (Far Cry 5): score = mask + amp · layer height ───────────
  const grainCoord = positionWorld.xz.mul(u.grainScale);
  const grain = mix(float(0.5), fbm2(grainCoord, GRAIN_OCTAVES), periodResolved(grainCoord));
  const masks = [float(GRANITE_FLOOR), polishW, fracturedW, grusW, litterW];
  const scores = masks.map((m, i) => m.add(grain.mul(u.layerHeightAmp).mul(LAYER_HEIGHT_SHARE[i])));
  let top: AnyNode = scores[0];
  for (let i = 1; i < scores.length; i++) top = top.max(scores[i]);
  const width = u.layerBlendWidth.max(1e-3);
  const weights = scores.map((s) => s.sub(top).add(width).div(width).clamp(0, 1));
  let sum: AnyNode = float(0);
  for (const w of weights) sum = sum.add(w);
  const norm = weights.map((w) => w.div(sum.max(1e-3)));

  const grus = u.grusColor.mul(float(1).add(grain.sub(0.5).mul(u.grainStrength).mul(2)));
  const colours = [inp.graniteGrey, u.polishedColor, u.fracturedColor, grus, u.litterColor];
  let albedo: AnyNode = colours[0].mul(norm[0]);
  for (let i = 1; i < colours.length; i++) albedo = albedo.add(colours[i].mul(norm[i]));
  const rockness = norm[0].add(norm[1]).add(norm[2]);

  // ── sheeting bands along the curvature axis, on convex bedrock ───────────
  // @band-limited-elsewhere: convexity gate on the mipped curvature texture; no period
  const convexW = curvature.smoothstep(float(0), u.sheetBandConvexity.max(1e-4)).mul(rockness);
  const bands = info ? sheetBands(inp.localXZ, sheetingDirection(info, inp.iceDir), u) : float(1);
  const riser = bands.oneMinus().mul(convexW);
  albedo = albedo.mul(float(1).sub(riser.mul(u.sheetBandStrength)));
  const relief = riser.mul(u.sheetBandRelief).negate();

  // ── joints: two sets multiply; they bite hardest on the fractured layer ──
  const joints = jointSet(JOINT_AZIMUTH_A, u).mul(jointSet(JOINT_AZIMUTH_B, u));
  const jointBite = u.jointStrength.mul(norm[2].add(0.5)).mul(rockness);
  albedo = albedo.mul(float(1).sub(joints.oneMinus().mul(jointBite)));

  // ── lichen: a low-frequency field thresholded around a coverage that
  //    grows on the shaded aspect and under a closed sky ─────────────────────
  const facing = nxz.dot(u.lichenAspect).mul(0.5).add(0.5); // 1 facing the shaded azimuth
  const coverage = u.lichenCoverage
    .mul(float(1).sub(u.lichenAspectStrength).add(u.lichenAspectStrength.mul(facing).mul(2)))
    .add(inp.skyAO.oneMinus().mul(u.lichenShadeStrength))
    .clamp(0, 1);
  const lichenCoord = positionWorld.xz.mul(u.lichenScale);
  const lichenField = fbm2(lichenCoord, LICHEN_OCTAVES);
  const edge = coverage.oneMinus();
  const lichenRaw = lichenField.smoothstep(edge.sub(0.08), edge.add(0.08));
  const lichenMask = mix(coverage, lichenRaw, periodResolved(lichenCoord)).mul(u.lichenStrength).mul(rockness);
  albedo = mix(albedo, u.lichenColor, lichenMask);

  // ── the implied trail: one wide fade across the whole wear width, the
  //    macro field breathing the edge so it never reads as a ribbon ────────
  // @band-limited-elsewhere: path distance from the mipped info texture; the transition IS the full wear width (≥ 6 m)
  const wearW = pathDistance
    .smoothstep(float(0), u.pathWearWidth.max(0.5).mul(macro.mul(0.6).add(0.7)))
    .oneMinus()
    .mul(u.pathWearStrength)
    .mul(flatW);
  albedo = mix(albedo, u.pathWornColor.mul(float(1).add(grain.sub(0.5).mul(u.grainStrength))), wearW);

  // ── macro tone: the same 60 m field the litter reads, so a dark hillside
  //    is dark in its rock and its grus alike ────────────────────────────────
  albedo = albedo.mul(float(1).add(macro.sub(0.5).mul(u.macroVariation).mul(2)));

  // ── elevation bands: 3–4 value blocks by height (Firewatch read) ─────────
  const y = positionWorld.y;
  const bw = u.bandWidth.max(0.5);
  // @band-limited-elsewhere: elevation bands on world height, each `bandWidth` metres wide — not a spatial period
  const toMid = y.smoothstep(u.bandLowHeight.sub(bw), u.bandLowHeight.add(bw));
  const toHigh = y.smoothstep(u.bandMidHeight.sub(bw), u.bandMidHeight.add(bw));
  // @band-limited-elsewhere: same elevation band rule as the two above
  const toCrown = y.smoothstep(u.bandHighHeight.sub(bw), u.bandHighHeight.add(bw));
  let tint: AnyNode = mix(u.bandLowTint, u.bandMidTint, toMid);
  tint = mix(tint, u.bandHighTint, toHigh);
  tint = mix(tint, u.bandCrownTint, toCrown);
  albedo = albedo.mul(mix(float(1), tint, u.bandStrength));

  // ── roughness: the polish pulls it down, the fractured layer pushes it up ─
  let roughness: AnyNode = mix(inp.roughness, u.fracturedRoughness, norm[2]);
  roughness = roughness.mul(float(1).sub(norm[1].mul(u.polishGloss)));

  return { albedo, roughness, relief, rockness };
}

/** sky AO → aoNode, sun self-shadow → receivedShadowNode (§T.112a item 4) */
function applyHorizon(
  material: THREE.MeshStandardNodeMaterial,
  tex: HorizonTextures,
  sunDir: AnyNode,
  u: SierraUniforms,
): AnyNode {
  const h = horizonNodes(tex, sunDir, u.shadowSoftness);
  material.aoNode = mix(float(1), h.skyAO, u.skyAoStrength);
  const sunTerm = mix(float(1), h.sunVisibility, u.shadowStrength);
  material.receivedShadowNode = Fn(([shadow]: [AnyNode]) => shadow.mul(sunTerm)) as any;
  return h.skyAO;
}

export interface SierraMaterialOptions {
  /** baked horizon map for THIS island; omit for a horizon-less shared handle */
  horizon?: HorizonMap;
  /** baked terrain info for THIS island (T112d); omit with `horizon` for the R0 path */
  info?: TerrainInfo;
  /** unit ice-flow azimuth (rad) — `hm.sierra.iceAzimuth`; the sheeting fallback axis */
  iceAzimuth?: number;
}

interface IslandBindings {
  horizonTex: HorizonTextures | null;
  infoTex: TerrainInfoTexture | null;
  infoNodes: TerrainInfoNodes | null;
  jointOffset: AnyNode;
  iceDir: AnyNode;
  dispose(): void;
}

function bindIsland(opts: SierraMaterialOptions): IslandBindings {
  const horizonTex = opts.horizon ? createHorizonTextures(opts.horizon) : null;
  const infoTex = opts.info ? createTerrainInfoTexture(opts.info) : null;
  const infoNodes = infoTex ? terrainInfoNodes(infoTex, positionLocal.xz) : null;
  const [ox, oz] = opts.info?.jointNoiseOffset ?? [0, 0];
  const az = opts.iceAzimuth ?? 0;
  return {
    horizonTex,
    infoTex,
    infoNodes,
    jointOffset: vec2(ox, oz),
    iceDir: vec2(Math.cos(az), Math.sin(az)),
    dispose(): void {
      horizonTex?.dispose();
      infoTex?.dispose();
    },
  };
}

/**
 * Granite land on the shared blend material's shore. Returns the SAME handle
 * shape so island.ts can hand it to `createIslandMesh` in place of the plain
 * one.
 */
export function createSierraTerrainMaterial(
  p: SierraParams = sierraParams,
  opts: SierraMaterialOptions = {},
): TerrainBlendMaterialHandle {
  const base = terrainBlendMaterial();
  const u = createSierraUniforms(p);
  const material = base.material;
  const { rock, sand, cover } = base.uniforms;
  const bound = bindIsland(opts);

  // the base's own shore rule (the live swash height is the base's; on a
  // 12 m DG apron the metre of difference is inside the sand anyway):
  // 0 in the sand skirt at the water, 1 on the land above it
  const heightAbove = positionWorld.y.sub(sand.waterline);
  // @band-limited-elsewhere: elevation band on world height (shoreHeight..+shoreFade), the base's own shore rule
  const landW = heightAbove.smoothstep(cover.shoreHeight, cover.shoreHeight.add(cover.shoreFade.max(1e-3)));

  const lit = material.colorNode as AnyNode;
  const rough = material.roughnessNode as AnyNode;
  if (!lit || !rough) throw new Error('createSierraTerrainMaterial: blend material has no colour/roughness node'); // §Rule 8
  const skyAO = bound.horizonTex ? applyHorizon(material, bound.horizonTex, rock.sunDirection, u) : float(1);
  const surface = buildSierraSurface({
    info: bound.infoNodes,
    skyAO,
    graniteGrey: rock.baseColor as AnyNode,
    localXZ: positionLocal.xz,
    jointOffset: bound.jointOffset,
    iceDir: bound.iceDir,
    roughness: rough,
    u,
  });
  material.colorNode = mix(lit, surface.albedo, landW);
  material.roughnessNode = mix(rough, surface.roughness, landW);
  // the sand bedform's shading normal is identity on land, so the sheeting
  // relief (already band-limited: it differentiates `bandLimitedEdge`) can
  // take over there without the two fighting
  const baseNormal = material.normalNode as AnyNode;
  if (bound.infoNodes && baseNormal) {
    material.normalNode = mix(baseNormal, reliefNormal(surface.relief, float(1)), landW).normalize();
  }

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
      bound.dispose();
    },
  };
}

/**
 * Sierra ROCK material for the boulders (§T.112a item 2, research D9): the
 * pirate rock node graph with granite tints, THE SAME SURFACE as the terrain
 * (masks, colours, info texture read at the instance's island-local
 * position), and the island's horizon map. Same handle shape as
 * `createRockMaterial` so `createRocks` takes either.
 */
export function createSierraRockMaterial(
  p: SierraParams = sierraParams,
  opts: SierraMaterialOptions = {},
) {
  const uniforms = createRockUniforms();
  const u = createSierraUniforms(p);
  const nodes = buildRockNodes(uniforms, terrainParams.noiseOctaves);
  const material = new THREE.MeshStandardNodeMaterial();
  const bound = bindIsland(opts);
  const skyAO = bound.horizonTex ? applyHorizon(material, bound.horizonTex, uniforms.sunDirection, u) : float(1);
  const surface = buildSierraSurface({
    info: bound.infoNodes,
    skyAO,
    // the boulder's own banded/crevice colour stands in for flat granite,
    // so the sculpted look of the pirate rock survives under the sierra masks
    graniteGrey: nodes.color,
    localXZ: positionLocal.xz,
    jointOffset: bound.jointOffset,
    iceDir: bound.iceDir,
    roughness: nodes.roughness as AnyNode,
    u,
  });
  material.colorNode = surface.albedo;
  material.roughnessNode = surface.roughness;
  material.metalness = 0;

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
      bound.dispose();
    },
  };
}

export type SierraRockMaterialHandle = ReturnType<typeof createSierraRockMaterial>;
