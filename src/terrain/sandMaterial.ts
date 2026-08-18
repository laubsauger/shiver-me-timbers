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
  /**
   * §V.72 — THE DEPTH THIS SURFACE ITSELF DEFINES.
   *
   * This material IS the seabed, so the still-water column over the fragment
   * being shaded is exactly `-positionWorld.y`: not a resample of the baked
   * seabed field, not a second height function, the rendered position. That
   * makes it impossible for the sea level we derive from it to drift from the
   * ground we are painting it on — the failure mode `27a0795` fixed twice and
   * this is the third instance of.
   *
   * Handing it to `waterHeight` is what makes `seaY` the sea AS DRAWN rather
   * than the raw open-ocean spectrum. Without it the swell marched across dry
   * land at full amplitude (measured: up to 1.9 m of sea level over sand the
   * ocean was drawing flat), which painted the §V.34 absorption tint and the
   * caustics onto the beach and, half a cycle later, took the darkening off
   * genuinely submerged sand. Everything downstream of `seaY` inherits the
   * fix: the swash level and wet-sand memory (shoreRunup) stop walking inland,
   * and the shelf apron out to -45 m finally attenuates.
   *
   * On dry sand (y > 0) the depth clamps to 0, so every cascade's shoaling
   * factor is tanh(0) = 0 and `seaY` is exactly 0 — a beach above the
   * waterline can no longer be told it is underwater, by construction rather
   * than by a threshold.
   */
  const shoalDepth: any = positionWorld.y.negate().max(0);
  const seaY: any = active ? active.waterHeight(worldXZ, shoalDepth) : u.waterline;
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
  /** `terrainParams.underwaterRoughnessFloor` — see the roughness note below */
  roughFloor: any,
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
    /**
     * THE FLOOR IS LOAD-BEARING — it is the whole of the fix for "massive blue
     * reflection on the bottom of the sea from the sun" (backprop pending).
     * `w.roughnessScale` is a water-FILM gloss meant for a dry receiver, but
     * the sand branch has already crossfaded to `sandRoughnessWet` by the time
     * it arrives — `gloss` is 1 everywhere below the waterline — so the two
     * wetness models multiplied and drove the submerged shelf to 0.066, a
     * mirror the size of the seabed. `underwaterRoughnessFloor` carries the
     * measurement; `.mul(inWater)` rides the SAME ramp the multiplier does, so
     * the floor is exactly 0 above the waterline and cannot touch dry sand,
     * dry rock or ground cover.
     */
    roughness: base.roughness
      .mul(mix(float(1), w.roughnessScale, inWater))
      .max(roughFloor.mul(inWater)),
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
    sparkleCellPixels: uniform(p.sparkleCellPixels),
    sparkleMinCell: uniform(p.sparkleMinCell),
    sparkleRadiusPixels: uniform(p.sparkleRadiusPixels),
    sparkleResolveCells: uniform(p.sparkleResolveCells),
    sparkleCoverage: uniform(p.sparkleCoverage),
    sparklePower: uniform(p.sparklePower),
    sparkleStrength: uniform(p.sparkleStrength),
    roughnessDry: uniform(p.sandRoughnessDry),
    roughnessWet: uniform(p.sandRoughnessWet),
    underwaterRoughFloor: uniform(p.underwaterRoughnessFloor),
    rippleStrength: uniform(p.rippleStrength),
    rippleWavelength: uniform(p.rippleWavelength),
    rippleDepthFade: uniform(p.rippleDepthFade),
    /** unit vector ACROSS the crests — the direction the pattern repeats in */
    rippleDir: uniform(new THREE.Vector2(1, 0)),
    rippleWarp: uniform(p.rippleWarp),
    rippleWarpScale: uniform(p.rippleWarpScale),
    rippleContourWeight: uniform(p.rippleContourWeight),
    rippleContourSpacing: uniform(p.rippleContourSpacing),
    ripplePatchScale: uniform(p.ripplePatchScale),
    ripplePatchThreshold: uniform(p.ripplePatchThreshold),
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
  u.sparkleCellPixels.value = p.sparkleCellPixels;
  u.sparkleMinCell.value = p.sparkleMinCell;
  u.sparkleRadiusPixels.value = p.sparkleRadiusPixels;
  u.sparkleResolveCells.value = p.sparkleResolveCells;
  u.sparkleCoverage.value = p.sparkleCoverage;
  u.sparklePower.value = p.sparklePower;
  u.sparkleStrength.value = p.sparkleStrength;
  u.roughnessDry.value = p.sandRoughnessDry;
  u.roughnessWet.value = p.sandRoughnessWet;
  u.underwaterRoughFloor.value = p.underwaterRoughnessFloor;
  u.rippleStrength.value = p.rippleStrength;
  u.rippleWavelength.value = p.rippleWavelength;
  u.rippleDepthFade.value = p.rippleDepthFade;
  u.rippleWarp.value = p.rippleWarp;
  u.rippleWarpScale.value = p.rippleWarpScale;
  u.rippleContourWeight.value = p.rippleContourWeight;
  u.rippleContourSpacing.value = p.rippleContourSpacing;
  u.ripplePatchScale.value = p.ripplePatchScale;
  u.ripplePatchThreshold.value = p.ripplePatchThreshold;
  // crests run ALONG `rippleAngle`, so the repeat direction is its normal
  {
    const a = (p.rippleAngle * Math.PI) / 180;
    (u.rippleDir.value as THREE.Vector2).set(-Math.sin(a), Math.cos(a));
  }
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

  // WAVE-FORMED SAND RIPPLES — the submerged shelf's only structure, and the
  // answer to "the seafloor is so boring that we're not even noticing that
  // we're seeing down at it". A flat bottom under clear water looks exactly
  // like an opaque surface, so this is a TRANSPARENCY fix, not a detail pass.
  //
  // A 1-D wave: `dot(ground, rippleDir)` is distance ACROSS the crests, and
  // dividing by the wavelength makes `rippleCoord` count crests, so 1 unit = 1
  // period and `periodResolved` can be handed it directly. Keeping it a SCALAR
  // is deliberate — the pattern has one direction, so its filter width has one
  // component and the §V.48 gate is exact rather than a two-axis approximation.
  //
  // NOT the §50c3a76 lever arm. `rippleDir` and `rippleWavelength` are plain
  // uniforms, so this is strictly LINEAR in the world coordinate; the crest
  // wander is added AFTER the division as a bounded phase offset, never folded
  // into the scale. `worldPos * f(worldPos)` is the shape that put the foam's
  // sampling rate 856x out at this very lagoon, and a ripple field is exactly
  // where it would be written again.
  //
  // §V.48/§V.48b: a sine has no edge, so this is the fade-to-own-mean branch —
  // the mean of sin over a pixel spanning many crests is 0, i.e. the unmodulated
  // sand, which is what `periodResolved` fades to. At `rippleWavelength` 0.55 m
  // that engages around 25-30 m at grazing incidence, which is where a 0.55 m
  // feature genuinely stops being resolvable.
  //
  // NOT §B.43's mistake: the amplitude is faded on the ripple's OWN coordinate,
  // in the ripple's own units, rather than left world-locked with the gate
  // measured against something else.
  // ── §B.xx REGRESSION FIX: "perfectly regular shape and grid" ─────────────
  //
  // WHAT SHIPPED AND WHY IT WAS A GRID BY CONSTRUCTION. The field was ONE
  // sine, on ONE bearing, at ONE wavelength, over every island in the world,
  // with a single small bounded phase wobble on top. There is no parameter
  // setting of that expression that is not corduroy — the user's "perfectly
  // regular shape and grid … basically it just looks like a bug" is the exact
  // and inevitable output of a single grating.
  //
  // A SECOND DETUNED SINE IS NOT THE FIX (§B.4: two gratings still read as a
  // grid, just a moiré one). Three changes, and the first is the one that
  // matters:
  //
  //  (1) DOMAIN WARP THE PHASE. Real wave ripples have SINUOUS crests that
  //      BIFURCATE — a crest wanders, splits in two and rejoins — and that
  //      branching is the single most recognisable thing about a rippled bed.
  //      Branching is a phase DISLOCATION, and a dislocation appears exactly
  //      when the warp's own gradient can locally overcome the carrier's. The
  //      old `rippleBend` could not do it: at 0.18 wavelengths of offset over
  //      an 8 m noise it only ever nudged a straight line. Warping by ~0.9
  //      wavelengths over a noise a few wavelengths across does, and it costs
  //      one extra noise tap.
  //
  //  (2) THE CONTOUR TERM. Wave orbital motion refracts over bathymetry, so
  //      real ripple crests follow the depth contours near a shore instead of
  //      marching on one global bearing. The level sets of DEPTH are the
  //      contours, so adding depth (in its own vertical spacing) to the
  //      coordinate makes crests bend round the bay for free.
  //
  //  (3) PATCHINESS. Ripples die over coarse patches, rock and strong
  //      currents. A low-frequency mask takes the field out entirely in
  //      places, which is what stops any surviving regularity reading as a
  //      manufactured pattern.
  //
  // ── THE LEVER ARM, WHICH IS EXACTLY WHERE THIS WOULD GO WRONG ────────────
  // `50c3a76` put a sampling rate 856× out at this very lagoon by letting a
  // spatially varying quantity multiply an ABSOLUTE world coordinate. Every
  // term above is written to avoid that, and the discipline is worth stating
  // because "make the ripples follow the terrain" is a one-line change that
  // reintroduces it:
  //
  //   * THE OBVIOUS VERSION OF (2) IS THE TRAP. Rotating the repeat direction
  //     to follow the slope — `dot(ground, dirFromNormal(p))` — is literally
  //     `worldPos · f(worldPos)`. At the showcase island |ground| ≈ 912 m, so
  //     a 0.01 rad wobble in that direction is ~9 m of phase, i.e. six whole
  //     crests per metre of ground: the field would alias into noise, and it
  //     would do it ONLY away from the origin, where no unit test looks. So
  //     the contour term is ADDED as its own scalar (`depthBelow`, whose
  //     gradient is the bounded local slope) instead of being folded into the
  //     direction of an absolute coordinate.
  //   * The blend weight between the two is a UNIFORM, never a spatial field.
  //     A spatial blend would put `ground`'s 912 m magnitude back behind a
  //     varying multiplier and undo the whole argument.
  //   * The warp is added AFTER the division, in WAVELENGTHS, and is bounded.
  //     It moves the PHASE. It never touches the SCALE.
  //
  // Both contributions are therefore strictly linear-plus-bounded in the world
  // coordinate, and `periodResolved` below measures the finished coordinate's
  // real screen footprint (warp included), so the §V.48 gate stays exact.
  const rippleLinear = ground
    .dot(u.rippleDir)
    .div(u.rippleWavelength.max(1e-3));
  // depth in "crests per metre of depth" — level sets of this ARE the contours
  const rippleContour = sea.depthBelow.div(u.rippleContourSpacing.max(1e-3));
  const rippleCarrier = mix(rippleLinear, rippleContour, u.rippleContourWeight);
  // Domain warp, in wavelengths. Two octaves at different scales: the coarse
  // one bends the crest lines, the fine one is what actually pinches and
  // splits them. `rippleWarpScale` and `rippleWarpScale × lacunarity` are
  // plain uniforms on the absolute coordinate — linear, not a lever arm.
  const warpCoarse = valueNoise2(ground.mul(u.rippleWarpScale)).sub(0.5);
  const warpFine = valueNoise2(ground.mul(u.rippleWarpScale.mul(2.7)).add(vec2(19.3, 7.1)))
    .sub(0.5)
    .mul(0.55);
  const rippleWander = warpCoarse.add(warpFine).mul(u.rippleWarp);
  const rippleCoord = rippleCarrier.add(rippleWander);
  // §V.48: measured on the FINISHED coordinate, so the warp's own contribution
  // to the screen footprint is included rather than assumed away
  const rippleResolved = periodResolved(rippleCoord);
  // (3) patchiness: a low-frequency mask that removes the bedform entirely
  // over part of the floor. Smooth, no edge, mean-fading — the §V.48b branch,
  // and `periodResolved` on its own coordinate is that fade.
  const patchCoord = ground.mul(u.ripplePatchScale);
  const ripplePatch = mix(
    float(1),
    valueNoise2(patchCoord).smoothstep(u.ripplePatchThreshold, u.ripplePatchThreshold.add(0.22)),
    periodResolved(patchCoord),
  );
  // sharpened toward the crests: real ripples are round-crested and flat-
  // troughed, and the asymmetry is most of what makes them read as sand.
  // (`rippleWander` is already inside `rippleCoord` — it used to be added a
  // SECOND time here, which double-counted the phase offset against the
  // footprint `rippleResolved` was measured on.)
  const rippleWave = rippleCoord.mul(Math.PI * 2).sin();
  // Depth gates, both required. Below: ripples are cut by wave orbital motion
  // at the bed, which dies with depth, so a deep shelf is smooth. Above: they
  // are a SEABED feature and must not crawl up the dry beach.
  // §V23 decreasing ramp (e0 > e1): 1 at/below the shallow end, 0 by the fade.
  // @band-limited-elsewhere — these two gate on DEPTH, a monotone vertical
  // distance with no period, over 16 m and 0.35 m respectively. There is no
  // sub-pixel regime for them to alias in; the periodic term they multiply is
  // gated on its own coordinate by `rippleResolved` above, which is where the
  // §V.48 argument actually lives.
  const rippleDepth = sea.depthBelow.smoothstep(u.rippleDepthFade.max(1e-3), float(0));
  const rippleSubmerged = sea.depthBelow.smoothstep(float(0), float(0.35));
  const ripple = rippleWave
    .mul(u.rippleStrength)
    .mul(rippleResolved)
    .mul(ripplePatch)
    .mul(rippleDepth)
    .mul(rippleSubmerged);
  albedo = albedo.mul(ripple.add(1));

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

  /**
   * ── §B.43: THE SAND SPECKLE ────────────────────────────────────────────
   *
   * WHAT THE USER SEES: "a dense speckle of small bright dots" across the
   * whole beach. WHAT IT IS: `sparkleDensity` 6 is a WORLD-LOCKED 0.167 m
   * cell. From the deck at 30 m that is about ELEVEN PIXELS across — so every
   * glint is a fat blob, not a glint — and at 300 m it is a quarter of a pixel,
   * where the binary `step()` gate becomes a per-pixel coin flip and the whole
   * beach stipples. One world-locked cell size cannot be right at both ends,
   * and it was never right at either.
   *
   * The previous pass added `periodResolved` on the cell coordinate, which
   * correctly killed the FAR stipple by fading the amplitude to its own mean.
   * It could not touch the near end, because a 0.167 m cell being eleven
   * pixels wide is not an aliasing problem — the pattern is fully resolved and
   * simply authored at the wrong size. §B.43 is that remaining half, and the
   * fix is the model the ocean's sun glitter already runs (surfaceMaterial.ts,
   * `cellTarget`/`cellSize`/`disc`/`resolvable`), transliterated onto sand:
   *
   *  (a) SIZE THE CELL FROM THE PIXEL, NOT FROM THE WORLD. `cellTarget` is the
   *      pixel's own world footprint times the number of pixels a cell should
   *      span, so cells stay a fixed size ON SCREEN at every distance and
   *      every view angle. Quantising to octaves (`exp2(log2(·).floor())`)
   *      keeps the lattice world-locked inside a band, so the pattern does not
   *      boil as the camera moves.
   *
   *  (b) A GLINT IS A POINT, NOT A CELL. The old `step()` gate is on/off over
   *      a world-locked axis-aligned SQUARE — which is what "small bright
   *      dots" of a uniform size actually are. Hash the glint to a POSITION
   *      inside its cell and give it a radial falloff whose radius is a fixed
   *      FRACTION of the cell (§V.48b: a fixed PIXEL radius against an
   *      octave-quantised cell makes both `coverage` and `resolvable`
   *      discontinuous at every octave, which the ocean measured as a hard
   *      2.52× step in the term's own mean and a visible ring).
   *
   *  (c) RETIRE INTO ITS OWN MEAN. As the cell stops being able to hold a
   *      distinguishable point, both binary terms crossfade to their
   *      expectations — the disc to its coverage ½π(r/c)², the on/off hash to
   *      its probability (1 − thr). The two branches have EQUAL MEAN by
   *      construction, so the beach keeps its brightness and simply stops
   *      being made of dots instead of dimming.
   *
   * `sparkleDensity` therefore no longer means "cells per metre" — it is
   * replaced by `sparkleCellPixels` / `sparkleMinCell`, the same two numbers
   * the ocean carries, and the same defaults: cells target ~2.6 px at the top
   * of an octave falling to ~1.3 px at the bottom, which is the 1.3-2.6 the
   * model wants and roughly a fifth of what the beach was drawing.
   */
  // world size of one pixel, measured on the ground coordinate itself — the
  // same footprint every §V.48 gate in this file is measured against
  const pixWorld = ground.dFdx().abs().add(ground.dFdy().abs()).length().max(1e-5);
  const cellTarget = pixWorld.mul(u.sparkleCellPixels).max(u.sparkleMinCell);
  const cellSize = cellTarget.log2().floor().exp2().max(u.sparkleMinCell);
  const cellUv = ground.div(cellSize);
  const cell = cellUv.floor();
  // @band-limited-elsewhere — hash of an INTEGER cell index: constant within
  // a cell, so it has no gradient to alias. What can alias is the cell
  // LATTICE, and that is band-limited where it is built (`cellSize` from
  // `pixWorld`, above) and dissolved into its own mean by `resolvable` below.
  const sparkleHash = hash2(cell);
  const gate = step(u.sparkleCoverage.oneMinus(), sparkleHash);
  // cell size in pixels, and the glint radius as a FRACTION of it (§V.48b —
  // see the ocean's note: a constant pixel radius against an octave-quantised
  // cell reintroduces a discontinuity at every octave boundary)
  const cellPix = cellSize.div(pixWorld).max(0.25);
  const radPix = cellPix
    .mul(u.sparkleRadiusPixels.max(0.05).div(u.sparkleCellPixels.max(0.5)))
    .max(0.02);
  // @band-limited-elsewhere — hash of an integer lattice index, picks WHERE
  // the glint sits; its extent is `radPix`, sized in pixels against `pixWorld`
  const jx = hash2(cell.add(vec2(7.7, 3.1)));
  const jz = hash2(cell.add(vec2(1.3, 9.7)));
  // inset by its own radius so the disc can never be clipped by the cell
  // border, which would put the square lattice straight back
  const inset = radPix.div(cellPix).min(0.5);
  const jitter2 = vec2(jx, jz).mul(inset.mul(2).oneMinus()).add(inset);
  const distPix = cellUv.sub(cell).sub(jitter2).mul(cellPix).length();
  // smoothstep(e0,e1,x) with e0 > e1: 1 at the point, 0 at the radius (§V23).
  // Both operands are in PIXELS — this IS the band limit, not an edge needing
  // one.
  const disc = smoothstep(radPix, float(0), distPix);
  // the two means (c) crossfades to
  const coverage = radPix
    .mul(radPix)
    .mul(Math.PI * 0.5)
    .div(cellPix.mul(cellPix).max(1e-4))
    .clamp(0, 1);
  const onProb = u.sparkleCoverage.clamp(0, 1);
  // 0 while the cell is too small to hold a distinguishable point, 1 past
  // twice that. `cellPix` is cellSize/pixWorld, so this too is the limit
  // itself rather than something needing one.
  const resolvable = smoothstep(
    u.sparkleResolveCells,
    u.sparkleResolveCells.mul(2),
    cellPix.div(radPix.max(1e-4)),
  );
  const sparkleField = mix(onProb.mul(coverage), gate.mul(disc), resolvable);
  // the facet normal stays per-cell random, but it now modulates a POINT
  // rather than a whole square, and the whole term retires into its mean
  const jitter = vec3(
    hash2(cell.add(vec2(4.9, 6.3))).sub(0.5),
    hash2(cell.add(vec2(2.1, 8.4))).sub(0.5),
    hash2(cell.add(vec2(5.6, 0.9))).sub(0.5),
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
    .mul(sparkleField)
    .mul(u.sparkleStrength)
    .mul(wet.oneMinus());

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
  const lit = applyWaterLighting(
    nodes,
    nodes.depthBelow,
    uniforms.causticsBand,
    uniforms.underwaterRoughFloor,
  );
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
    sand.underwaterRoughFloor,
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
