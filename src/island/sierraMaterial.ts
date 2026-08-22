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
 * SHEETING BANDS ARE CONTOURS, NOT A RULED GRID (§T.122, research §2.2,
 * Martel). Sheets peel PARALLEL to the surface, so their traces on it are
 * contours of the form — closed shells round a whaleback. T112d built the
 * band coordinate as `localXZ · normalize(∇κ)`, and a dot product with a
 * PER-PIXEL direction is not the integral of that direction: its level sets
 * spiral, which is the whirlpool the R3 plan view caught. The coordinate is
 * now a genuine POTENTIAL whose gradient is the across-band axis:
 *
 *     Φ = (y + sheetBandWarp · κ / sheetBandConvexity) / sheetBandSpacing
 *
 * ∇Φ carries the fall line AND the curvature gradient (the two are collinear
 * and radial on a dome, which is why the bands close into rings there), the
 * spacing is metres of ELEVATION so the traces widen on a flat and tighten on
 * a face exactly as sheet outcrops do, and the warp bows them out over a
 * convex nose so they are never exact level sets. Gated to convex bedrock.
 *
 * JOINT SETS ARE PER-ISLAND AND PATCHY (§T.122). Two sets at fixed WORLD
 * azimuths, biting at half strength on every rock pixel, is one lattice laid
 * over the whole world — the graph paper R3 saw, on the boulders too. The
 * azimuths are now measured from the island's own seeded ice axis, the
 * coordinate is island-local, and the bite is gated on the joint-density
 * field (`jointCoverage`) so the sets show where the rock is actually jointed.
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
 * A FALLEN BLOCK IS NOT THE SLAB IT FELL FROM (§T.122). The boulders shade
 * through this same function at their island-local position, which is what
 * makes a rock carry the ground's history — and it also made talus read as
 * blisters of the ground, because it carried the ground's grus, litter and
 * lichen as well. `fresh` (1 on the instanced rocks, 0 on the terrain) strips
 * the cover layers off the block, thins the lichen a young surface has not
 * grown yet, and lifts it toward `rockFreshTint`, the colour of a fracture
 * face that has not weathered. Same granite, different age.
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
import { bandLimitedEdge, coordFilter, periodResolved } from '../ship/bandLimit';
import { reliefNormal } from '../ship/surfaceRelief';
import { sierraParams, type SierraParams } from '../params/sierra';
import { horizonNodes, type HorizonSource } from './horizonMap';
import {
  terrainInfoNodes,
  TerrainInfoChannels,
  type TerrainInfoNodes,
} from './terrainInfo';
// TYPE-ONLY, deliberately: sierraAtlas.ts imports `jointAxes`/`sheetPhase`
// from here at runtime, and a type import is erased, so the two do not cycle.
import type { SierraAtlas } from './sierraAtlas';

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

/**
 * The island's two joint-set axes, measured from ITS OWN seeded ice azimuth
 * (§T.122). Joint sets and the glacial axis are both structural, so tying
 * them together is not a cheat — and it stops every island in the world from
 * sharing one lattice.
 */
export function jointAxes(iceAzimuth: number): [[number, number], [number, number]] {
  const a = iceAzimuth + JOINT_AZIMUTH_A;
  const b = iceAzimuth + JOINT_AZIMUTH_B;
  return [
    [Math.cos(a), Math.sin(a)],
    [Math.cos(b), Math.sin(b)],
  ];
}

/** per-island sheet phase, so two islands do not band at the same metres */
export function sheetPhase(iceAzimuth: number): number {
  const t = ((iceAzimuth / (Math.PI * 2)) * 3) % 1;
  return t < 0 ? t + 1 : t;
}

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
    sheetBandWarp: uniform(p.sheetBandWarp),
    jointCoverage: uniform(p.jointCoverage),
    jointBaseBite: uniform(p.jointBaseBite),
    rockFreshCover: uniform(p.rockFreshCover),
    rockFreshLichen: uniform(p.rockFreshLichen),
    rockFreshStrength: uniform(p.rockFreshStrength),
    rockFreshTint: uniform(new THREE.Color(p.rockFreshTint)),
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
  u.sheetBandWarp.value = p.sheetBandWarp;
  u.jointCoverage.value = p.jointCoverage;
  u.jointBaseBite.value = p.jointBaseBite;
  u.rockFreshCover.value = p.rockFreshCover;
  u.rockFreshLichen.value = p.rockFreshLichen;
  u.rockFreshStrength.value = p.rockFreshStrength;
  u.rockFreshTint.value.setHex(p.rockFreshTint);
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

/**
 * SCALAR screen footprint of a 2D FIELD coordinate — the wider of its two
 * axes, because the field is resolved only when BOTH are.
 *
 * WHY IT EXISTS, AND WHY IT IS THE §T.122 BUG (§B). `coordFilter` is
 * per-component: handed a vec2 it returns a vec2, so `periodResolved(vec2)`
 * returns a VEC2 fade instead of a float. `mix(float, float, vec2)` takes the
 * LONGEST input's type (three's MathNode.getInputType), so `macro`, `grain`
 * and every layer weight downstream of them became vec2 — and three's
 * NodeBuilder pads a vec2 into a vec3 as `vec3(v, 0.0)` (NodeBuilder.format),
 * so `layerColour.mul(weight)` MULTIPLIED THE WHOLE LAND ALBEDO'S BLUE BY
 * ZERO. Every landmass rendered as (r, g, 0): the flat chartreuse at 7.5/12
 * and the red-brown at 17.5 that R3-13 reported, on the boulders too, because
 * they share this function. The masks were separating the whole time; there
 * was no blue left for them to separate IN.
 */
function fieldFilter(coord: AnyNode): AnyNode {
  const f = coordFilter(coord);
  return f.x.max(f.y);
}

/** one joint set: 1 away from a joint, dips toward 0 on it, band-limited */
function jointSet(dir: AnyNode, localXZ: AnyNode, u: SierraUniforms): AnyNode {
  // the SMOOTH coordinate — one unit per joint — is what the filter measures.
  // ISLAND-LOCAL and on the island's own seeded axes (§T.122): world-space
  // sets at fixed azimuths are one lattice over the whole archipelago.
  const coord = localXZ.dot(dir).div(u.jointSpacing.max(1e-3));
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
  return mix(float(0.5), fbm2(coord, MACRO_OCTAVES), periodResolved(coord, fieldFilter(coord)));
}

/**
 * THE SHEETING POTENTIAL Φ — see the header. One unit per sheet, and its
 * GRADIENT is the across-band axis, so the bands are level sets of a real
 * scalar field and cannot spiral. CPU twin: `sheetBandCoordCpu`.
 */
function sheetBandCoord(height: AnyNode, curvature: AnyNode, phase: AnyNode, u: SierraUniforms): AnyNode {
  const warp = curvature.div(u.sheetBandConvexity.max(1e-4)).mul(u.sheetBandWarp);
  return height.add(warp).div(u.sheetBandSpacing.max(1e-3)).add(phase);
}

/**
 * Sheeting bands: 1 on a tread, dips toward 0 on a riser, band-limited on the
 * RISER's width (the feature, not the repeat — §V48).
 */
function sheetBands(coord: AnyNode, u: SierraUniforms): AnyNode {
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
  /** the island's two joint-set axes, seeded off its ice azimuth */
  jointDirA: AnyNode;
  jointDirB: AnyNode;
  /** per-island phase (sheets) so two islands do not band at the same metres */
  bandPhase: AnyNode;
  /** the surface's incoming roughness */
  roughness: AnyNode;
  /** 1 on a fallen block (the instanced rocks), 0 on the terrain — see header */
  fresh?: AnyNode;
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
  const fresh: AnyNode = inp.fresh ?? float(0);
  /** how much of a cover layer survives on this surface (0 on a fallen block) */
  const covered = float(1).sub(fresh.mul(u.rockFreshCover));

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
  const grusW = flatW.mul(debrisW.mul(0.5).add(0.5)).mul(covered);
  const macro = macroField(u);
  const litterEdge = u.litterCoverage.oneMinus();
  // @band-limited-elsewhere: threshold on macroField, which periodResolved fades to its mean; 0.2-wide in a 60 m field
  const macroLitter = macro.smoothstep(litterEdge.sub(0.1), litterEdge.add(0.1));
  // @band-limited-elsewhere: moisture from the mipped info texture, 0.2 wide
  const moistLitter = moisture.smoothstep(u.litterMoisture.sub(0.1), u.litterMoisture.add(0.1));
  const litterW = macroLitter.max(moistLitter).mul(u.litterStrength).mul(flatW).mul(covered);

  // ── height blend (Far Cry 5): score = mask + amp · layer height ───────────
  const grainCoord = positionWorld.xz.mul(u.grainScale);
  const grain = mix(float(0.5), fbm2(grainCoord, GRAIN_OCTAVES), periodResolved(grainCoord, fieldFilter(grainCoord)));
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

  // ── sheeting: contours of Φ (see header), on convex bedrock ──────────────
  // @band-limited-elsewhere: convexity gate on the mipped curvature texture; no period
  const convexW = curvature.smoothstep(float(0), u.sheetBandConvexity.max(1e-4)).mul(rockness);
  const bands = info
    ? sheetBands(sheetBandCoord(positionWorld.y, curvature, inp.bandPhase, u), u)
    : float(1);
  const riser = bands.oneMinus().mul(convexW);
  albedo = albedo.mul(float(1).sub(riser.mul(u.sheetBandStrength)));
  const relief = riser.mul(u.sheetBandRelief).negate();

  // ── joints: two sets multiply. They bite hardest on the fractured layer,
  //    and only where the joint-density field says the rock IS jointed — a
  //    flat bite on every rock pixel is a lattice over the whole island ─────
  const joints = jointSet(inp.jointDirA, inp.localXZ, u).mul(jointSet(inp.jointDirB, inp.localXZ, u));
  // @band-limited-elsewhere: joint density is a swiss-turbulence field (3 octaves at jointScale, 50 m): no edge, no period
  const jointPatch = jointDensity.smoothstep(u.jointCoverage.sub(0.15), u.jointCoverage.add(0.15));
  const jointBite = u.jointStrength
    .mul(norm[2].mul(float(1).sub(u.jointBaseBite)).add(u.jointBaseBite))
    .mul(rockness)
    .mul(jointPatch);
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
  const lichenMask = mix(coverage, lichenRaw, periodResolved(lichenCoord, fieldFilter(lichenCoord)))
    .mul(u.lichenStrength)
    .mul(rockness)
    // a block that has fallen has not had time to grow the slab's lichen
    .mul(float(1).sub(fresh.mul(u.rockFreshLichen)));
  albedo = mix(albedo, u.lichenColor, lichenMask);

  // ── the implied trail: one wide fade across the whole wear width, the
  //    macro field breathing the edge so it never reads as a ribbon ────────
  // @band-limited-elsewhere: path distance from the mipped info texture; the transition IS the full wear width (≥ 6 m)
  const wearW = pathDistance
    .smoothstep(float(0), u.pathWearWidth.max(0.5).mul(macro.mul(0.6).add(0.7)))
    .oneMinus()
    .mul(u.pathWearStrength)
    .mul(flatW)
    .mul(covered);
  albedo = mix(albedo, u.pathWornColor.mul(float(1).add(grain.sub(0.5).mul(u.grainStrength))), wearW);

  // ── a fresh fracture face: cleaner and lighter than the weathered slab ───
  albedo = mix(albedo, u.rockFreshTint, fresh.mul(u.rockFreshStrength));

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

// ── CPU TRANSLITERATION (§V80, §T.122) ────────────────────────────────────
//
// The pair to `buildSierraSurface`, the way `bandLimitedEdgeValue` pairs with
// `bandLimitedEdge` and `sheetingDirectionCpu` with the shader's axis. It
// exists because the ONLY thing that can be asserted about a layered material
// without a renderer is its arithmetic, and the §T.122 defect (every layer
// weight silently becoming a vec2, so the albedo's blue was multiplied by
// zero) is precisely the class of thing a node-graph shape test cannot see.
// Evaluated at ZERO filter width — the close read, where every band limit
// resolves to 1. Keep in step with the node graph above.

const LINEAR_CACHE = new Map<number, [number, number, number]>();
/** hex (sRGB, the param convention) → linear working-space RGB, as `THREE.Color` uploads it */
export function sierraLinear(hex: number): [number, number, number] {
  let v = LINEAR_CACHE.get(hex);
  if (!v) {
    const c = new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
    v = [c.r, c.g, c.b];
    LINEAR_CACHE.set(hex, v);
  }
  return v;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
function smooth(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / Math.max(e1 - e0, 1e-9));
  return t * t * (3 - 2 * t);
}
/** triangle-wave distance to the nearest repeat, one unit per period */
function toEdge(coord: number): number {
  return Math.abs((((coord + 0.5) % 1) + 1) % 1 - 0.5);
}
type Rgb3 = [number, number, number];
const scale = (c: Rgb3, s: number): Rgb3 => [c[0] * s, c[1] * s, c[2] * s];
const blend = (a: Rgb3, b: Rgb3, t: number): Rgb3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** CPU twin of `sheetBandCoord` — Φ, one unit per sheet */
export function sheetBandCoordCpu(
  height: number,
  curvature: number,
  phase: number,
  p: SierraParams = sierraParams,
): number {
  const warp = (curvature / Math.max(p.sheetBandConvexity, 1e-4)) * p.sheetBandWarp;
  return (height + warp) / Math.max(p.sheetBandSpacing, 1e-3) + phase;
}

/** everything one point needs to resolve; the caller supplies the fields it already has */
export interface SierraPointCpu {
  /** island-local x, z — the joint sets and the info texture read here */
  local: [number, number];
  /** world x, z — the macro / grain / lichen fields are world-space */
  world: [number, number];
  /** world height (m) */
  height: number;
  /** geometric normal (world) */
  normal: [number, number, number];
  /** signed mean curvature, 1/m, + convex (decoded) */
  curvature: number;
  /** 0..1 */
  moisture: number;
  /** metres to the route centreline */
  pathDistance: number;
  /** talus thickness, m */
  debris: number;
  /** sky AO, 1 open */
  skyAO: number;
  /** the joint-density field at this point (`swissTurbulence2Cpu`, 3 octaves) */
  jointDensity: number;
  /** the 60 m macro field, the grain field and the lichen field (`fbm2Cpu`) */
  macro: number;
  grain: number;
  lichenField: number;
  /** the island's seeded ice azimuth */
  iceAzimuth: number;
  /** 1 on a fallen block, 0 on the terrain */
  fresh?: number;
  /** bare-granite linear RGB; defaults to `graniteBaseColor` */
  granite?: Rgb3;
}

export interface SierraSurfaceCpu {
  /** the five normalised layer weights, in `LAYER_NAMES` order */
  weights: number[];
  /** index of the layer that claims the pixel */
  winner: number;
  albedo: Rgb3;
  rockness: number;
  lichen: number;
  wear: number;
  riser: number;
  bandCoord: number;
}

/** the five layers, in score/weight order */
export const LAYER_NAMES = ['granite', 'polished', 'fractured', 'grus', 'litter'] as const;

export function sierraSurfaceCpu(pt: SierraPointCpu, p: SierraParams = sierraParams): SierraSurfaceCpu {
  const up = pt.normal[1];
  const fresh = pt.fresh ?? 0;
  const covered = 1 - fresh * p.rockFreshCover;

  const flatW = smooth(Math.cos(p.coverBareSlope * DEG), Math.max(Math.cos(p.coverGrusSlope * DEG), Math.cos(p.coverBareSlope * DEG) + 1e-3), up);
  const halfPolish = p.polishCurvature * 0.5;
  const polishUp = Math.cos(p.polishSlope * DEG);
  const polishW =
    smooth(halfPolish, p.polishCurvature + halfPolish, pt.curvature) *
    smooth(polishUp - 0.06, polishUp + 0.02, up) *
    (1 - smooth(p.polishDebrisMax * 0.5, p.polishDebrisMax, pt.debris));
  const fracturedUp = Math.cos(p.fracturedSlope * DEG);
  const fracturedW =
    smooth(p.fracturedJoint - 0.1, p.fracturedJoint + 0.1, pt.jointDensity) *
    (1 - smooth(fracturedUp - 0.1, fracturedUp + 0.1, up));
  const debrisW = smooth(p.grusDebrisMin * 0.5, p.grusDebrisMin, pt.debris);
  const grusW = flatW * (debrisW * 0.5 + 0.5) * covered;
  const litterEdge = 1 - p.litterCoverage;
  const litterW =
    Math.max(
      smooth(litterEdge - 0.1, litterEdge + 0.1, pt.macro),
      smooth(p.litterMoisture - 0.1, p.litterMoisture + 0.1, pt.moisture),
    ) *
    p.litterStrength *
    flatW *
    covered;

  const masks = [GRANITE_FLOOR, polishW, fracturedW, grusW, litterW];
  const scores = masks.map((m, i) => m + pt.grain * p.layerHeightAmp * LAYER_HEIGHT_SHARE[i]);
  const top = Math.max(...scores);
  const width = Math.max(p.layerBlendWidth, 1e-3);
  const raw = scores.map((s) => clamp01((s - top + width) / width));
  const sum = raw.reduce((a, b) => a + b, 0);
  const weights = raw.map((w) => w / Math.max(sum, 1e-3));

  const grus = scale(sierraLinear(p.grusColor), 1 + (pt.grain - 0.5) * p.coverGrainStrength * 2);
  const colours: Rgb3[] = [
    pt.granite ?? sierraLinear(p.graniteBaseColor),
    sierraLinear(p.polishedColor),
    sierraLinear(p.fracturedColor),
    grus,
    sierraLinear(p.litterColor),
  ];
  let albedo: Rgb3 = [0, 0, 0];
  for (let i = 0; i < 5; i++) {
    albedo[0] += colours[i][0] * weights[i];
    albedo[1] += colours[i][1] * weights[i];
    albedo[2] += colours[i][2] * weights[i];
  }
  const rockness = weights[0] + weights[1] + weights[2];

  const convexW = smooth(0, Math.max(p.sheetBandConvexity, 1e-4), pt.curvature) * rockness;
  const bandCoord = sheetBandCoordCpu(pt.height, pt.curvature, sheetPhase(pt.iceAzimuth), p);
  const riser = (1 - smooth(0, Math.max(p.sheetBandRiser * 0.5, 1e-4), toEdge(bandCoord))) * convexW;
  albedo = scale(albedo, 1 - riser * p.sheetBandStrength);

  const [dirA, dirB] = jointAxes(pt.iceAzimuth);
  const set = (d: [number, number]): number => {
    const coord = (pt.local[0] * d[0] + pt.local[1] * d[1]) / Math.max(p.jointSpacing, 1e-3);
    const feature = p.jointWidth / Math.max(p.jointSpacing, 1e-3);
    return 1 - (1 - smooth(0, Math.max(feature, 1e-4), toEdge(coord)));
  };
  const joints = set(dirA) * set(dirB);
  const jointPatch = smooth(p.jointCoverage - 0.15, p.jointCoverage + 0.15, pt.jointDensity);
  const jointBite = p.jointStrength * (weights[2] * (1 - p.jointBaseBite) + p.jointBaseBite) * rockness * jointPatch;
  albedo = scale(albedo, 1 - (1 - joints) * jointBite);

  const facing = (pt.normal[0] * Math.cos(p.lichenAspectAzimuth) + pt.normal[2] * Math.sin(p.lichenAspectAzimuth)) * 0.5 + 0.5;
  const coverage = clamp01(
    p.lichenCoverage * (1 - p.lichenAspectStrength + p.lichenAspectStrength * facing * 2) +
      (1 - pt.skyAO) * p.lichenShadeStrength,
  );
  const lichen =
    smooth(1 - coverage - 0.08, 1 - coverage + 0.08, pt.lichenField) *
    p.lichenStrength *
    rockness *
    (1 - fresh * p.rockFreshLichen);
  albedo = blend(albedo, sierraLinear(p.lichenColor), lichen);

  const wear =
    (1 - smooth(0, Math.max(p.pathWearWidth, 0.5) * (pt.macro * 0.6 + 0.7), pt.pathDistance)) *
    p.pathWearStrength *
    flatW *
    covered;
  albedo = blend(albedo, scale(sierraLinear(p.pathWornColor), 1 + (pt.grain - 0.5) * p.coverGrainStrength), wear);
  albedo = blend(albedo, sierraLinear(p.rockFreshTint), fresh * p.rockFreshStrength);
  albedo = scale(albedo, 1 + (pt.macro - 0.5) * p.coverMacroVariation * 2);

  const bw = Math.max(p.bandWidth, 0.5);
  let tint = blend(sierraLinear(p.bandLowTint), sierraLinear(p.bandMidTint), smooth(p.bandLowHeight - bw, p.bandLowHeight + bw, pt.height));
  tint = blend(tint, sierraLinear(p.bandHighTint), smooth(p.bandMidHeight - bw, p.bandMidHeight + bw, pt.height));
  tint = blend(tint, sierraLinear(p.bandCrownTint), smooth(p.bandHighHeight - bw, p.bandHighHeight + bw, pt.height));
  const t = p.bandStrength;
  albedo = [
    albedo[0] * (1 + (tint[0] - 1) * t),
    albedo[1] * (1 + (tint[1] - 1) * t),
    albedo[2] * (1 + (tint[2] - 1) * t),
  ];

  let winner = 0;
  for (let i = 1; i < 5; i++) if (scores[i] > scores[winner]) winner = i;
  return { weights, winner, albedo, rockness, lichen, wear, riser, bandCoord };
}

/** sky AO → aoNode, sun self-shadow → receivedShadowNode (§T.112a item 4) */
function applyHorizon(
  material: THREE.MeshStandardNodeMaterial,
  src: HorizonSource,
  sunDir: AnyNode,
  u: SierraUniforms,
): AnyNode {
  const h = horizonNodes(src, sunDir, u.shadowSoftness);
  material.aoNode = mix(float(1), h.skyAO, u.skyAoStrength);
  const sunTerm = mix(float(1), h.sunVisibility, u.shadowStrength);
  material.receivedShadowNode = Fn(([shadow]: [AnyNode]) => shadow.mul(sunTerm)) as any;
  return h.skyAO;
}

export interface SierraMaterialOptions {
  /**
   * §T.132: the shared island atlas. Present ⇒ the material reads every
   * per-island field (horizon planes, terrain info) out of an array-texture
   * LAYER named by an object-group uniform, so ONE material draws every sierra
   * island. Absent ⇒ the horizon-less, info-less handle (tests, the R0 path).
   *
   * There is deliberately no "just this one island's textures" option any
   * more. That was the shape that produced six materials, six programs and
   * 21 s of codegen for six islands under a comment claiming they shared.
   */
  atlas?: SierraAtlas;
}

interface IslandBindings {
  horizon: HorizonSource | null;
  infoNodes: TerrainInfoNodes | null;
  jointOffset: AnyNode;
  jointDirA: AnyNode;
  jointDirB: AnyNode;
  bandPhase: AnyNode;
}

function bindIsland(opts: SierraMaterialOptions): IslandBindings {
  const atlas = opts.atlas;
  if (!atlas) {
    return {
      horizon: null,
      infoNodes: null,
      jointOffset: vec2(0, 0),
      jointDirA: vec2(Math.cos(JOINT_AZIMUTH_A), Math.sin(JOINT_AZIMUTH_A)),
      jointDirB: vec2(Math.cos(JOINT_AZIMUTH_B), Math.sin(JOINT_AZIMUTH_B)),
      bandPhase: float(0),
    };
  }
  const u = atlas.uniforms;
  // `.depth()` wants an integer index; the uniform stays a float so the object
  // group packs as one scalar block (three has no int object-group path here)
  const layer = u.layer.toInt();
  return {
    horizon: { planes: atlas.horizon, layer, radius: u.radius },
    infoNodes: terrainInfoNodes(
      { texture: atlas.info, layer, radius: u.radius, texel: atlas.texel, cell: atlas.cell },
      positionLocal.xz,
    ),
    jointOffset: u.jointOffset,
    jointDirA: u.jointDirA,
    jointDirB: u.jointDirB,
    bandPhase: u.bandPhase,
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
  const skyAO = bound.horizon ? applyHorizon(material, bound.horizon, rock.sunDirection, u) : float(1);
  const surface = buildSierraSurface({
    info: bound.infoNodes,
    skyAO,
    graniteGrey: rock.baseColor as AnyNode,
    localXZ: positionLocal.xz,
    jointOffset: bound.jointOffset,
    jointDirA: bound.jointDirA,
    jointDirB: bound.jointDirB,
    bandPhase: bound.bandPhase,
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
  const skyAO = bound.horizon ? applyHorizon(material, bound.horizon, uniforms.sunDirection, u) : float(1);
  const surface = buildSierraSurface({
    info: bound.infoNodes,
    skyAO,
    // the boulder's own banded/crevice colour stands in for flat granite,
    // so the sculpted look of the pirate rock survives under the sierra masks
    graniteGrey: nodes.color,
    localXZ: positionLocal.xz,
    jointOffset: bound.jointOffset,
    jointDirA: bound.jointDirA,
    jointDirB: bound.jointDirB,
    bandPhase: bound.bandPhase,
    roughness: nodes.roughness as AnyNode,
    // every instance here is a block that has fallen or been plucked out
    fresh: float(1),
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
    },
  };
}

export type SierraRockMaterialHandle = ReturnType<typeof createSierraRockMaterial>;
