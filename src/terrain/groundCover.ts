/**
 * Ground cover — the green mass of an island (T27/§V43), TSL only.
 *
 * THE DEFECT THIS CLOSES. `terrainBlendMaterial` had two materials and one
 * axis: sand where `normal.y` beat `slopeThreshold` (0.72 = 44°), rock
 * elsewhere. Measured over the shipping heightmaps, mean terrain slope is
 * 19-23°, so sand took 82-98% of every island's land area — a single pale tan
 * albedo from the waterline to the summit. That is what "the islands look
 * totally silly / a brown lump" is: not the geometry (the archetypes give five
 * different silhouettes), the ALBEDO. There was no green anywhere on an island
 * except the palm fronds, and palms are culled past `lodPalmCull`.
 *
 * Every island reference in docs/ is banded by ELEVATION: a narrow bright sand
 * skirt at the water, a green vegetated mass above it, bare rock where it is
 * too steep to hold anything. So sand becomes a shore band rather than the
 * default, and this supplies the mass in between.
 *
 * COST. Zero texture bindings (§V40 — the sampler wall is at 16 and the ocean
 * stage has none spare): the elevation axis is `positionWorld.y` against the
 * `waterline` uniform the swash already binds, and the clump variation is the
 * same analytic `fbm2` the sand and rock layers already use.
 *
 * §V.48. The clump noise is coarse by design (`vegScale` 0.055 = an 18 m base
 * wavelength, ~9 m finest octave at 2 octaves) and the FIRST version of this
 * file argued that made a band limit unnecessary. It does not: at 4 km and 10×
 * grazing one pixel spans 20 m, so the clumps are sub-pixel there, and
 * "coarse" is a params value anyone can change. It is band-limited like
 * everything else — see `clumpResolved` below.
 *
 * §V23: functional mix/smoothstep only. §V28: every divisor floored.
 */
import * as THREE from 'three/webgpu';
import { float, mix, normalWorld, positionWorld, uniform } from 'three/tsl';
import { terrainParams } from '../params/terrain';
import { fbm2 } from './noise';
// §V.48 — one band-limit implementation project-wide (src/ship for historical
// reasons, §B.20 was found on the hull; the maths carries nothing ship-specific)
import { periodResolved } from '../ship/bandLimit';

/** Live GPU uniforms mirroring the ground-cover section of terrainParams. */
export function createCoverUniforms() {
  const p = terrainParams;
  return {
    baseColor: uniform(new THREE.Color(p.vegBaseColor)),
    shadeColor: uniform(new THREE.Color(p.vegShadeColor)),
    dryColor: uniform(new THREE.Color(p.vegDryColor)),
    scale: uniform(p.vegScale),
    dryStrength: uniform(p.vegDryStrength),
    slopeThreshold: uniform(p.vegSlopeThreshold),
    roughness: uniform(p.vegRoughness),
    shoreHeight: uniform(p.shoreBandHeight),
    shoreFade: uniform(p.shoreBandFade),
  };
}

export type CoverUniforms = ReturnType<typeof createCoverUniforms>;

/** Copy current terrainParams values into the uniforms (call on change). */
export function updateCoverUniforms(u: CoverUniforms): void {
  const p = terrainParams;
  u.baseColor.value.setHex(p.vegBaseColor);
  u.shadeColor.value.setHex(p.vegShadeColor);
  u.dryColor.value.setHex(p.vegDryColor);
  u.scale.value = p.vegScale;
  u.dryStrength.value = p.vegDryStrength;
  u.slopeThreshold.value = p.vegSlopeThreshold;
  u.roughness.value = p.vegRoughness;
  u.shoreHeight.value = p.shoreBandHeight;
  u.shoreFade.value = p.shoreBandFade;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyNode = any;

export interface CoverNodes {
  /** cover albedo */
  color: AnyNode;
  roughness: AnyNode;
  /**
   * 1 in the sand skirt at the water, 0 up on the vegetated ground. This is
   * the weight the blend material hands to sand, and the one that must also
   * gate the sand SPARKLE — glitter on a hillside reads as fireflies.
   */
  shoreWeight: AnyNode;
}

/**
 * Build the cover layer.
 *
 * @param u           cover uniforms
 * @param heightAbove metres above the LIVE water surface (the sand material
 *                    already derives this; it is passed in rather than
 *                    recomputed so the two can never disagree about where the
 *                    sea is, the same reason the swash shares `waterline`)
 * @param sunDir      world sun direction uniform (pointing AT the sun)
 * @param octaves     build-time fbm octave count
 */
export function buildCoverNodes(
  u: CoverUniforms,
  heightAbove: AnyNode,
  sunDir: AnyNode,
  octaves: number,
): CoverNodes {
  const p = terrainParams;

  // canopy clumps: stands of green with darker hollows between them. Two
  // octaves is enough — this is a MASS, and the silhouette work (palms,
  // headlands) supplies the detail that reads up close.
  //
  // §V.48: this is coarse (18 m base, ~9 m finest octave at the default
  // `vegScale`) but "coarse" is not "exempt" — at 4 km and 10× grazing a
  // pixel spans 20 m and the clumps ARE sub-pixel. It is a smooth term with
  // no edge, so it takes the `periodResolved` branch: fade the variation to
  // its own mean (the mid green) rather than widening anything. Costs one
  // fwidth and closes the argument instead of relying on the frequency
  // staying low, which is a params value anyone can raise.
  const clumpCoord = positionWorld.xz.mul(u.scale.mul(p.noiseLacunarity));
  const clumpResolved = periodResolved(clumpCoord);
  const clumpRaw = fbm2(
    positionWorld.xz.mul(u.scale),
    Math.min(octaves, 2),
    p.noiseLacunarity,
    p.noiseGain,
  );
  // 0.5 is fbm2's mean, so this is the colour the pixel should average to
  const clump = mix(float(0.5), clumpRaw, clumpResolved);
  let albedo: AnyNode = mix(u.shadeColor, u.baseColor, clump);

  // sun-bleached scrub on the brightest stands, so the mass is not one green
  const dry = clump.smoothstep(0.62, 0.9).mul(u.dryStrength);
  albedo = mix(albedo, u.dryColor, dry);

  // canopy catches light on upward faces and goes deep in the folds. Small on
  // purpose: this multiplies an albedo, and §V31b says an albedo multiply is a
  // LINEAR-space operation — a big factor here would read as a second light.
  const up = normalWorld.y.clamp(0, 1);
  const sunCatch = normalWorld.dot(sunDir).clamp(0, 1).mul(0.5).add(0.5);
  albedo = albedo.mul(mix(float(0.72), float(1.06), up.mul(sunCatch)));

  // §V23 chained form, receiver is heightAbove: 0 at the waterline, 1 a fade
  // above the shore band. oneMinus() → 1 in the sand skirt, 0 on the cover.
  const shoreWeight = heightAbove
    .smoothstep(u.shoreHeight, u.shoreHeight.add(u.shoreFade.max(1e-3)))
    .oneMinus();

  return { color: albedo, roughness: u.roughness, shoreWeight };
}

/**
 * Gentle-ground weight at the COVER's slope threshold — stricter than sand's,
 * because scree and blown sand hold on a slope a canopy does not. Shares the
 * caller's already-jittered `up` so the two thresholds cannot drift apart or
 * differentiate the noise twice.
 */
export function coverSlopeWeight(u: CoverUniforms, jitteredUp: AnyNode, blendWidth: AnyNode): AnyNode {
  return jitteredUp.smoothstep(
    u.slopeThreshold.sub(blendWidth.max(1e-3)),
    u.slopeThreshold.add(blendWidth.max(1e-3)),
  );
}
