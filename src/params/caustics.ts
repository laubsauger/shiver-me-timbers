/**
 * Caustics + water-lighting tunables (§V.16, §V.34).
 *
 * Two families live here because they answer the same user complaint ("the
 * ship feels detached from the water") from the same inputs:
 *   1. caustics  — refracted/reflected sun-ray divergence off the live FFT
 *                  surface, cast onto hull, seabed and beach.
 *   2. water light — bounce fill, waterline wetness, submerged absorption.
 *
 * COLOUR AUTHORING CONTRACT (§V.31 / §B.9): `*Color` keys are hex sRGB and
 * MUST reach the GPU through `new THREE.Color(hex)` / `color(hex)`.
 * The `submergedAbsorption*` keys are NOT colours — they are extinction
 * coefficients in 1/m and go in as a raw Vector3 with no transfer function.
 */
import { registerParams } from './registry';

export interface CausticsParams {
  // ── caustic core ────────────────────────────────────────────────────
  /** master on/off — 0 compiles the nodes away to a constant (reload) */
  enabled: boolean;
  /**
   * refractive index of sea water; Snell eta = 1 / this (§V.34).
   * 1.33335 is the Na-D (589.3 nm) value from Daimon & Masumura, Appl. Opt.
   * 46, 3811 (2007) — so eta = 0.74999, i.e. 0.75 to five decimals.
   */
  waterIor: number;
  /**
   * finite-difference step (m) used to measure how fast the refracted ray
   * direction turns across the surface. This IS the caustic sharpness knob:
   * below ~1 texel of the finest cascade (22.7 m / 512 ≈ 0.044 m) the
   * difference only reads the bilinear interpolant and the pattern goes
   * blocky; large values low-pass the curvature and soften the web.
   */
  curvatureEpsilon: number;
  /**
   * epsilon growth per metre of receiver depth.
   *
   * PHYSICAL ANCHOR: the real regulariser for SUNLIT caustics is the solar
   * disc, not diffraction (Berry & Upstill, "Catastrophe Optics", §7.4). The
   * sun subtends 0.53°, refracted into water 0.53/1.333 = 0.40°, giving a
   * blur of tan(0.40°) ≈ 6.9 mm per metre of depth. The default here is
   * several times that: a deliberate stylisation, because at the true value
   * caustics stay razor-sharp far deeper than reads well at game resolution
   * and starts aliasing under camera motion.
   */
  curvatureEpsilonPerMeter: number;
  /**
   * fold softening σ. Intensity is 1/|det J| and det J legitimately crosses
   * zero at a caustic fold, so the raw reciprocal is +∞ exactly where it is
   * most wanted. We divide by sqrt(det² + σ²) instead: smooth, branch-free,
   * bounded by 1/σ (§V.28 — a hard clamp plateaus and aliases instead).
   */
  foldSoftness: number;
  /** σ growth per meter of depth — deep folds are broader and dimmer */
  foldSoftnessPerMeter: number;
  /** overall caustic gain applied to the bright lobe */
  strength: number;
  /**
   * ceiling on the bright lobe after a Reinhard roll-off (firefly guard).
   * Tuned for the HULL regime (0–2 m below the surface), which is far
   * shallower and steeper than a seabed at 8 m: at 0.65 m the depth
   * polynomial is still near det C ≈ 1, so the gain reaches its |detA|/σ
   * ceiling readily and this cap — not the physics — is what sets the
   * highlight. Lands as additive emissive on timber whose lit albedo is
   * ≈0.3 linear, so values above ~2 blow the hull out.
   */
  maxGain: number;
  /**
   * how much light the divergent regions between caustic filaments lose,
   * 0..1. MULTIPLICATIVE on albedo (§B.11) — 0.45 means the darkest
   * inter-filament shadow keeps 55% of the surface colour. It can never
   * subtract light, only withhold it.
   */
  darkStrength: number;
  /**
   * cap on lateral ray drift per metre of span (§B.11). Refraction is
   * physically bounded near 1.135 by Snell's window; REFLECTION is not, and
   * an ungated near-horizontal reflected ray is what produced the hull
   * speckle. Also bounds the finite difference that builds det M.
   */
  maxDrift: number;
  /**
   * final per-channel ceiling on the additive term before it reaches
   * `emissiveNode`. Pure backstop (§V.28): nothing downstream of emissive
   * will save a bad value, so the last thing this module does is clamp.
   */
  maxAddLight: number;
  /**
   * receivers shallower than this are treated as being this deep. Real
   * caustics vanish at zero depth (no focal length yet); the hull waterline
   * would therefore get nothing, so it borrows a little virtual depth.
   * Honest stylization — set 0 for physical behaviour.
   */
  minEffectiveDepth: number;
  /** caustics stop being computed past this receiver depth (m) */
  maxDepth: number;
  /** caustics fade out past this camera distance (m), gone at fadeEnd */
  fadeStart: number;
  fadeEnd: number;
  /**
   * caustic tint at the surface (sRGB hex). There is deliberately no second
   * "deep" colour: the caustic is attenuated per channel by the SAME
   * `submergedAbsorption*` extinction the hull uses, so it shifts toward
   * blue-green with depth for a physical reason rather than an art curve.
   *
   * CHROMATIC DISPERSION IS DELIBERATELY ABSENT. Water's Abbe number is 55.7
   * (Daimon 2007), giving a red↔blue ray split of 1.3 mm/m at a 10° sun and
   * 14 mm/m at 60° — at or below the 6.9 mm/m solar-disc blur across the
   * whole realistic range, and at the depths where it would resolve, red is
   * already gone (K_red ≈ 0.36 m⁻¹ leaves 2.7% at 10 m). The two effects
   * cancel; a dispersion term here would be manufacturing a fringe that is
   * not visible in the real world.
   */
  causticColor: string;
  /** back-project the receiver onto its true surface entry point (reload) */
  backprojectIterations: number;
  /**
   * half-width (m) of the crossfade between the above-water (reflected) and
   * below-water (refracted) caustic branches. Narrow bands draw a crisp line
   * along the hull where `minEffectiveDepth` kicks in; this smears it.
   */
  waterlineBlend: number;
  /**
   * softness (in N·S units) of the "sun is behind this wave face" gate. The
   * CPU reference in causticsMath uses the hard predicate cosI > 0; the
   * shader anti-aliases it over this width so wave faces turning away from
   * the sun do not shimmer a stair-stepped edge.
   */
  faceGateSoftness: number;

  // ── reflected caustics (above the waterline) ────────────────────────
  /** strength of the sun-off-wave light dancing on hull sides above water */
  reflectedStrength: number;
  /** reflected caustics fade over this height above the waterline (m) */
  reflectedHeightFalloff: number;
  /**
   * Hard ceiling on the reflected branch (m above the waterline). The
   * exponential falloff above only DECAYS — it never reaches zero, so without
   * this the sun-off-wave light climbs the topsides into the rig.
   */
  reflectedMaxHeight: number;
  /**
   * Receiver-normal cutoff for the reflected branch: n.y at and above which a
   * surface receives none of it. Sea-bounced light travels UPWARD, so a deck
   * (n.y = 1) cannot catch any while a vertical hull side (n.y = 0) catches it
   * square. 0 would clip flared topsides; much above ~0.5 lets the deck glow.
   */
  reflectedFaceLimit: number;

  // ── water bounce fill (the sea lighting the ship) ───────────────────
  /** upward fill from the sea onto everything above it (sRGB hex) */
  bounceColor: string;
  /**
   * 0..1 how far `bounceColor` is pulled toward the LIVE sea colour that
   * `skyPalette().ground` already computes. 1 = the hull's up-fill warms with
   * the sky, the fog and the ambient off the one shared weight (§T.39); 0 =
   * the authored hex, fixed, which is what it used to be and which stayed teal
   * through a full amber sunset.
   */
  bounceFollowSky: number;
  /**
   * ADDITIVE lift from the sea, in linear light (§B.12).
   *
   * Kept small on purpose. A bounce is diffuse reflection, so it scales with
   * the receiver's albedo — but this term lands on `emissiveNode`, which
   * does not. On the SHADOWED side of the hull, where the sun contributes
   * nothing, an additive teal at the old 0.42 was several times the residual
   * ambient and turned the topsides into a flat slab of sea colour. The
   * albedo-coupled part of the bounce is `bounceTint` below; this is only
   * the small part that legitimately lifts shadows.
   */
  bounceStrength: number;
  /**
   * MULTIPLICATIVE tint toward `bounceColor`, 0..1 — the albedo-coupled part
   * of the bounce. Bounded by construction, so it can tint timber toward the
   * sea without ever overwhelming it.
   *
   * DELIBERATELY SMALL, and not because of headroom (§B.16 second finding).
   * The sky rig ALREADY models sea bounce: sky/lighting.ts builds a
   * HemisphereLight whose ground half is `skyParams.groundBounceColor`
   * (#2e6d78, a saturated teal) at `ambientIntensity`. A HemisphereLight is
   * never shadowed, so on the shaded side — where the warm sun is blocked —
   * it is the dominant light, and it lands hardest on exactly the
   * downward-facing surfaces this term also targets. Two independent models
   * of one phenomenon is what made the topsides read as a slab of sea
   * colour. The hemisphere owns the FLAT ambient bounce; this term owns only
   * what the hemisphere cannot do — the near-water height falloff and the
   * caustic flicker. Raising it re-creates the double count.
   */
  bounceTint: number;
  /** height (m) over which the bounce fades out going up the rig */
  bounceHeightFalloff: number;
  /** bounce floor / sun-driven gain — the sea is only bright when lit */
  bounceSunFloor: number;
  bounceSunGain: number;
  /** how strongly the reflected caustic pattern modulates the bounce, 0..1 */
  bounceFlicker: number;

  // ── waterline wetness ───────────────────────────────────────────────
  /** metres ABOVE the waterline still read as wet (spray/lapping band) */
  wetBandAbove: number;
  /** metres below the line over which wetness reaches full */
  wetBandBelow: number;
  /** multiplicative albedo tint at full wet — darkens and warms (sRGB hex) */
  wetTintColor: string;
  /** roughness multiplier at full wet (§V.9 wet-deck convention: smoother) */
  wetRoughness: number;
  /**
   * bump/normal-relief multiplier at full wet. Water pools in the grain and
   * fills it, so wet timber reads flatter as well as glossier. Multiplies
   * whatever relief the hull material builds — it never replaces it.
   */
  wetReliefFlatten: number;
  /**
   * metres of wet height lost per second once the sea stops reaching a spot.
   * This is what makes the boundary read as "where the water lapped" rather
   * than a painted stripe: hull exposed by a passing trough stays dark and
   * dries from the top down (§V.9 vocabulary — evaporation per frame).
   * Only active with a HullWetline feed; see caustics/hullWetline.ts.
   */
  wetDryRate: number;
  /**
   * capillary rise (m): the band reads wet slightly ABOVE the highest recent
   * contact, because timber wicks. Also covers spray the sim never simulates.
   */
  wetRise: number;
  /** stations per side of the hull in the wetline memory (reload to apply) */
  wetStations: number;
  /**
   * half-width (m) of the port↔starboard crossfade at the keel. The two
   * wetline rows are blended by sliding the texture's v coordinate, so this
   * stays C0 — §V.38: the hull material differentiates its height field in
   * screen space and a hard seam here spikes to a one-pixel line.
   */
  wetSideBlend: number;

  // ── submerged absorption ────────────────────────────────────────────
  /**
   * Diffuse attenuation K_d in 1/m per channel — red dies ~19× faster than
   * blue, which is what actually reads as "underwater". Bracketed by Jerlov
   * water types I–IB from Solonenko & Mobley, Appl. Opt. 54(17):5392 (2015):
   * clearest ocean is (0.357, 0.060, 0.019) at 650/550/450 nm. Applied to
   * both the submerged hull tint AND the caustic itself.
   *
   * NOT a colour: these are physical coefficients and must NOT get an sRGB
   * transfer function (§V.31 applies to `*Color` keys only).
   */
  submergedAbsorptionR: number;
  submergedAbsorptionG: number;
  submergedAbsorptionB: number;
  /**
   * multiplier on the absorption path length. The receiver only knows its
   * own depth, but light also travels back to the eye through water, so the
   * honest path is longer than `depth`.
   */
  submergedPathScale: number;
}

export const causticsParams: CausticsParams = registerParams('caustics', {
  enabled: true,
  waterIor: 1.33335,
  curvatureEpsilon: 0.32,
  // ≈5× the 6.9 mm/m solar-disc blur — see the field comment above
  curvatureEpsilonPerMeter: 0.035,
  foldSoftness: 0.16,
  foldSoftnessPerMeter: 0.045,
  strength: 0.6,
  maxGain: 1.15,
  darkStrength: 0.45,
  maxDrift: 2.5,
  maxAddLight: 1.5,
  minEffectiveDepth: 0.65,
  maxDepth: 22,
  fadeStart: 180,
  fadeEnd: 340,
  causticColor: '#ffffff',
  backprojectIterations: 1,
  waterlineBlend: 0.3,
  faceGateSoftness: 0.06,

  /**
   * 0.35 → 0.12, A/B'd on screen (user: "the caustics are like too crazy").
   * The height ceiling and the receiver-facing gate below both did their job —
   * nothing reaches the deck or climbs past the rail — but a VERTICAL hull side
   * has n.y ≈ 0, so it passes the facing gate at FULL strength, which is
   * correct physics and was simply too much of it. At 0.35 the topsides carried
   * blazing turquoise-white streaks; at 0.12 they read as wet timber with light
   * moving on it. Zeroing this branch entirely leaves the hull clean and the
   * waterline caustics intact, which is how the A/B was attributed.
   */
  reflectedStrength: 0.12,
  reflectedHeightFalloff: 4.5,
  // just above the galleon's waist rail: high enough to keep the wet topside
  // sparkle the branch is for, low enough that nothing reaches the sterncastle
  reflectedMaxHeight: 2.4,
  reflectedFaceLimit: 0.35,

  // between the ocean's deepColor (#093642) and sssColor (#32d0c0): the sea
  // seen from a hull is body pigment lifted by scattered sun, not either end
  bounceColor: '#2a9a9c',
  bounceFollowSky: 1,
  bounceStrength: 0.06,
  // 0.3 → 0.12: the sky hemisphere already supplies the flat sea bounce
  bounceTint: 0.12,
  bounceHeightFalloff: 7.0,
  bounceSunFloor: 0.25,
  bounceSunGain: 0.85,
  bounceFlicker: 0.7,

  wetBandAbove: 0.55,
  wetBandBelow: 0.25,
  wetTintColor: '#8c7f6e',
  wetRoughness: 0.22,
  wetReliefFlatten: 0.45,
  wetDryRate: 0.22,
  wetRise: 0.18,
  wetStations: 24,
  wetSideBlend: 0.6,

  // Jerlov I–IB (clear tropical), nudged off pure I toward the coastal water
  // an island demo actually sits in
  submergedAbsorptionR: 0.36,
  submergedAbsorptionG: 0.08,
  submergedAbsorptionB: 0.03,
  // 1.8 → 1.4: still > 1 (light also travels back to the eye through water)
  // but 1.8 pushed a hull 2 m down to red = 27% of blue, which reads as the
  // same teal slab by a different route (§B.16)
  submergedPathScale: 1.4,
}, causticsParamsMeta());

function causticsParamsMeta() {
  return {
    waterIor: { min: 1.0, max: 1.8, step: 0.001 },
    curvatureEpsilon: { min: 0.02, max: 2, step: 0.01 },
    curvatureEpsilonPerMeter: { min: 0, max: 0.4, step: 0.005 },
    foldSoftness: { min: 0.01, max: 1, step: 0.005 },
    foldSoftnessPerMeter: { min: 0, max: 0.4, step: 0.005 },
    strength: { min: 0, max: 6, step: 0.05 },
    maxGain: { min: 0.2, max: 12, step: 0.1 },
    darkStrength: { min: 0, max: 1, step: 0.01 },
    maxDrift: { min: 0.2, max: 20, step: 0.1 },
    maxAddLight: { min: 0, max: 8, step: 0.05 },
    minEffectiveDepth: { min: 0, max: 4, step: 0.05 },
    maxDepth: { min: 1, max: 60, step: 0.5 },
    fadeStart: { min: 10, max: 2000, step: 10 },
    fadeEnd: { min: 20, max: 4000, step: 10 },
    backprojectIterations: { min: 0, max: 1, step: 1 },
    waterlineBlend: { min: 0.02, max: 2, step: 0.01 },
    faceGateSoftness: { min: 0.005, max: 0.5, step: 0.005 },
    reflectedStrength: { min: 0, max: 3, step: 0.01 },
    reflectedHeightFalloff: { min: 0.2, max: 30, step: 0.1 },
    reflectedMaxHeight: { min: 0.5, max: 40, step: 0.5 },
    reflectedFaceLimit: { min: 0.02, max: 1, step: 0.01 },
    bounceStrength: { min: 0, max: 3, step: 0.01 },
    bounceFollowSky: { min: 0, max: 1, step: 0.01 },
    bounceTint: { min: 0, max: 1, step: 0.01 },
    bounceHeightFalloff: { min: 0.5, max: 40, step: 0.5 },
    bounceSunFloor: { min: 0, max: 1, step: 0.01 },
    bounceSunGain: { min: 0, max: 3, step: 0.01 },
    bounceFlicker: { min: 0, max: 1, step: 0.01 },
    wetBandAbove: { min: 0, max: 3, step: 0.01 },
    wetBandBelow: { min: 0.01, max: 3, step: 0.01 },
    wetRoughness: { min: 0.02, max: 1, step: 0.01 },
    wetReliefFlatten: { min: 0, max: 1, step: 0.01 },
    wetDryRate: { min: 0.005, max: 2, step: 0.005 },
    wetRise: { min: 0, max: 1.5, step: 0.01 },
    wetStations: { min: 4, max: 128, step: 1 },
    wetSideBlend: { min: 0.05, max: 5, step: 0.05 },
    submergedAbsorptionR: { min: 0, max: 2, step: 0.01 },
    submergedAbsorptionG: { min: 0, max: 2, step: 0.01 },
    submergedAbsorptionB: { min: 0, max: 2, step: 0.01 },
    submergedPathScale: { min: 0.2, max: 6, step: 0.05 },
  };
}
