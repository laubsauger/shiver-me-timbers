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
  /**
   * Depth (m) at which the sea's OWN curvature first folds a sun ray — the
   * anchor for the only mechanism in this module that makes the caustic
   * PATTERN, and not merely its fold width, change with depth.
   *
   * DERIVED, NOT PICKED. A wave of wavenumber k and amplitude a is a lens
   * focusing at d = 1/((1 − 1/n)·a·k²); for a random surface the same formula
   * reads on the RMS Laplacian σ_∇²h, giving
   *
   *     foldDepth = 1 / ((1 − 1/n) · σ_∇²h),   1 − 1/n = 0.2500 at n = 1.33335
   *
   * Measured on the live spectrum by integrating k⁴·S(k) over all three
   * cascades: σ_∇²h = 1.659 1/m ⟹ 2.41 m. It came out identical to four
   * significant figures at wind 6, 11 and 16 m/s, because the moment is
   * dominated by the saturated high-k tail rather than by the wind sea — which
   * is why a constant here is a measurement and not a fit (§B.12's rule). It
   * DOES scale with `oceanParams.resolution`, since a coarser grid simply has
   * no sharp ripples to fold; tests/caustics.test.ts re-derives it from the
   * live spectrum and fails if the ocean moves out from under it.
   *
   * `causticDefocus` turns it into the 0..1 weight both consumers ride, and
   * that weight is EXACTLY ZERO shallower than this, so everything from the
   * hull waterline down to 2.41 m evaluates the shipped expression — bit-exact
   * for the two stencil blends, and one ULP short of it for the response
   * exponent, because WGSL's `pow(x, 1.0)` is exp2(log2(x)) rather than the
   * identity. See causticsNode's `defocus`.
   */
  foldDepth: number;
  /**
   * Exponent the bright lobe's response reaches once the receiver is far past
   * `foldDepth` (1 = the shipped linear response, and what is still used
   * shallower than foldDepth).
   *
   * THE FOURTH REPORT OF "TOO MUCH CAUSTIC ON THE FLOOR" WAS A COVERAGE
   * PROBLEM, NOT A BRIGHTNESS ONE, and no amplitude knob in this file can
   * reach it: `bright` = max(gain − 1, 0) turns on wherever |det M| < |det A|
   * — most of the receiver — and is a smooth monotone map of |det M| over that
   * whole range, so sweeping `strength` only fades the web uniformly. Measured
   * on the shipped build at 5 m, sun 43°, 22% of the seabed sat above a
   * quarter of the frame's peak.
   *
   * lit^p has its fixed point at lit = 1 and leaves the Reinhard cap alone, so
   * the peak — the `strength × maxGain` = 0.66 ledger below — does not move; it
   * only collapses the mid-tone hump. Measured on a modelled transect of the
   * live spectrum at the shipped 2.5, against the shipped build, sun 43°
   * (coverage = fraction above a quarter of the frame's peak):
   *
   *            coverage        peak         pattern λ
   *   d = 3 m  14.0% → 5.8%   1.71 → 2.04   2.23 → 2.35 m
   *   d = 5 m  21.9% → 4.8%   1.26 → 1.66   2.36 → 3.21 m
   *   d = 8 m  25.3% → 5.8%   0.80 → 0.74   2.26 → 3.96 m
   *
   * That is "more defined edges … more height" as a consequence of
   * concentrating the same energy, not as a second brightness knob — and the
   * pattern wavelength column is the low-pass half of the same weight doing the
   * "way too fine grained" half of the complaint.
   */
  foldExponent: number;
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
  /**
   * 0..1 how far the caustic's colour AND brightness are handed over to THE KEY
   * LIGHT the sky rig actually publishes (`sunLight.color` / `.intensity`).
   *
   * A caustic is refracted SUNLIGHT, so its colour and its level are properties
   * of the key, not authored constants — but `causticColor` above was the whole
   * story, which meant the ship's sides carried noon-bright cream caustics at
   * midnight (user: "having like a late night super bright and intense caustics
   * visible on the ship sides doesn't really make sense"). That is §B.41 exactly
   * — the glint road multiplied by a hardcoded cream — in a second file.
   *
   * 1 = the caustic is the key's own colour, scaled by the key's own level
   * relative to `skyParams.sunIntensity`, so it is unchanged at noon, deep
   * orange and half as bright at sunset, ~9.5% as bright and blue under a full
   * moon, and gone under a new one. 0 = the authored hex at full strength
   * forever, which is what it used to be. The level can only ever DIM (§V.44).
   *
   * The key is READ, never re-derived: sky/lighting.ts owns it and moonCycle.ts
   * re-aims it, so the moon is free. Deriving it a second time from
   * skyPalette()/sunElevation() is the §V.33/§V.51 single-owner failure that
   * `bounceFollowSky` below exists because of.
   */
  causticFollowKey: number;
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
  /**
   * 0..1 how much of the physical cos(incidence) between the REFLECTED RAY and
   * the receiver's own normal the above-water branch obeys. 1 = the full
   * cosine, 0 = the ungated behaviour this branch shipped with.
   *
   * `reflectedFaceLimit` above is a function of n.y ALONE, so it only ever asks
   * "is this surface pointing up". A hull curving round the bow holds n.y = 0
   * through the whole sweep and passes that gate at 1.000 for every azimuth,
   * while the projected pattern stretches by 1/|cos(incidence)| behind it —
   * measured 1.4x facing a 45 deg sun square, 2.8x at 45 deg off it, and past
   * 2x over the ENTIRE vertical hull once the sun clears 60 deg. That is the
   * user's "due to the curvature they become very distorted at the furthest out
   * of the water"; a pattern stretched more than ~2x has stopped reading as
   * caustics.
   *
   * This is not a tuned falloff. It is the cosine every irradiance calculation
   * carries, and its absence meant a noon sun — whose sea-reflected light
   * travels straight UP past a vertical topside — lit that topside at full
   * strength. Expect the effect to concentrate at low sun, which is both
   * correct and where it looks best.
   */
  reflectedIncidence: number;
  /**
   * 0..1 how far the ABOVE-water half of the waterline crossfade is shrunk by
   * the receiver's own slope. 1 = scaled by the normal's horizontal component,
   * 0 = the fixed vertical band it used to be.
   *
   * `waterlineBlend` is one constant setting two physically independent reaches
   * (§V.52): on a hull 0.8 m of height is 0.8 m of surface, on a beach it is
   * 0.8/slope metres of DRY SAND — 6 m at 1:10, 24 m at 1:40. The shore has no
   * reflected branch at all (terrain calls with `mode: 'below'`), so none of
   * the `reflected*` bounds apply to it and its reach was never tuned. At 1 a
   * vertical side keeps the full band bit-for-bit and a flat beach takes it to
   * zero, which bounds the shore in its own dimension (§V.66) without touching
   * the hull crossfade the user signed off.
   */
  waterlineSlopeBound: number;

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
  /**
   * 0.035 -> 0.07. THE BLUR BARELY MOVED WITH DEPTH, AND THAT IS HALF OF "IT
   * LOOKS LIKE A WATER TEXTURE ON THE FLOOR".
   *
   * Measured on the shipped pair: eps(1 m) = 0.355 m, eps(10 m) = 0.670 m — the
   * caustic is only 1.9x softer ten metres down than one metre down, where the
   * solar disc says 10x (6.94 mm per metre of depth, the anchor in the field
   * comment above). 90% of the regulariser at 1 m and 48% at 10 m is the
   * DEPTH-INDEPENDENT constant, so a seabed at 2 m and one at 9 m are drawn at
   * almost the same sharpness, which is exactly what a projected decal does and
   * what focused light does not.
   *
   * Doubling only the per-metre term takes the spread to 2.7x and leaves the
   * constant alone, so depth 0 — the hull waterline regime the user signed off —
   * is bit-identical. It is still ~10x the physical blur at 10 m; going the rest
   * of the way is the stylisation the field comment defends, not a bug.
   *
   * THIS DOES NOT FIX THE PATTERN'S SPATIAL FREQUENCY, and it cannot: `eps` only
   * low-passes the finite difference that builds B = dw/du. The CONSTANT term of
   * det M(d) is det C = det(A + w(x)g), built from the RAW per-pixel slope at the
   * entry point, and at seabed depths det C dominates. So the caustic still
   * traces every ripple the finest cascade resolves, at every depth. Fixing that
   * needs the entry-point SLOPE low-passed too (the mean of the three taps
   * causticsNode already makes is free and grows with depth), which is a change
   * in causticsNode.ts, not here.
   */
  curvatureEpsilonPerMeter: 0.07,
  foldSoftness: 0.16,
  foldSoftnessPerMeter: 0.045,
  /**
   * 2.41 m — 1/((1 − 1/n)·σ_∇²h) with σ_∇²h = 1.659 1/m measured over the three
   * cascades. See the interface doc; tests/caustics.test.ts re-derives it.
   *
   * THIS IS THE NUMBER THE PARAGRAPH UNDER `curvatureEpsilonPerMeter` SAID WAS
   * MISSING. `eps` low-passes only the finite difference that builds B = ∂w/∂u;
   * det M(d)'s other two coefficients are built from the RAW per-texel slope,
   * so the pattern traced every ripple the finest cascade resolves at EVERY
   * depth. Measured on the shipped build (sun 43°, showcase lagoon spectrum),
   * the energy-weighted wavelength of the receiver pattern was 2.74 m at 1 m
   * depth and 2.26 m at 8 m — it got FINER going deeper, where focused light
   * gets coarser. That is what "it looks like a water texture on the floor"
   * means, and it is a frequency fault, not an amplitude one.
   */
  foldDepth: 2.41,
  /**
   * 2.5, A/B'd on screen against 1 (off), 2 and 3 at a 6.9 m seabed, sun 43 deg,
   * sim frozen. At 1 the floor is the wall-to-wall lacework the user reported;
   * at 2 the grain is gone and coarse loops remain; at 3 the deeper half of the
   * frame goes nearly featureless, which reads as "the caustics were deleted"
   * rather than as focused light. 2.5 keeps the fold set and the dark water
   * between it. It is a slider, and the two ends are both defensible looks.
   */
  foldExponent: 2.5,
  /**
   * strength 0.6 -> 0.32 and maxGain 1.15 -> 3.0, TOGETHER (user: "opacity and
   * brightness including variations of both, so it's less uniform").
   *
   * maxGain's own doc above says it: "this cap - not the physics - is what sets
   * the highlight". At 1.15 the Reinhard roll-off was compressing nearly every
   * filament onto the same value, so the caustic arrived as one flat white
   * intensity. The VARIATION the user wants already exists in |det J| - the
   * cap was clipping it off. Raising the ceiling lets the physics set the
   * highlight again and `strength` drops to keep peak brightness where it was,
   * so this trades uniform-and-bright for varied-at-the-same-peak.
   *
   * 0.32 -> 0.22, BECAUSE THE PARAGRAPH ABOVE DID NOT DO WHAT IT SAYS. The peak
   * additive term is `strength x maxGain`: it was 0.6 x 1.15 = 0.69 and became
   * 0.32 x 3.0 = 0.96, so "strength drops to keep peak brightness where it was"
   * raised the peak 39% instead of holding it. The user asked for VARIATION and
   * was also given brightness, then reported the brightness back ("in general
   * they're still a little bit too bright and too opaque of some sorts").
   * 0.22 x 3.0 = 0.66 restores the stated intent and keeps every bit of the
   * variation, since maxGain is untouched.
   *
   * SCALE: this lands as additive emissive on timber whose lit albedo is ~0.3
   * linear (see maxGain's own note), so even at 0.66 a fold peak is ~2x the
   * surface's own value - which is what "opaque" means here. The blend mode is
   * not the problem: `waterLighting.ts` adds it to emissiveNode, which is
   * correct for a light pattern. The amplitude is. If it still reads hot with
   * the key modulation in, this is the slider - not the compositing.
   *
   * 0.22 -> 0.11 WITH maxGain 3.0 -> 6.0, and this time the peak really is held:
   * strength x maxGain = 0.66 before and 0.66 after (the paragraph above records
   * the last attempt at this trade raising it 39% instead, so the arithmetic is
   * spelled out rather than asserted).
   *
   * FOURTH REPORT OF THE SAME THING (user: "we are overdoing the caustics on the
   * floor hard - they are super exaggerated ... it looks like a water texture on
   * the floor"). Matched-frame A/B over the showcase lagoon at 2-4 m, sun 43 deg,
   * bloom off, sim paused: with `strength` at 0 the floor is plain sand; at 0.22
   * it carries a dense high-contrast web over essentially ITS WHOLE AREA. The
   * web is the caustic - that part of the report is exactly right.
   *
   * WHAT MOVED AND WHAT DID NOT. Reinhard at cap C maps lit -> lit/(1+lit/C), so
   * raising C while dropping `strength` proportionally leaves the fold peaks
   * untouched and pulls the MID-TONES down: at gain 1.5 the term goes 0.094 ->
   * 0.051, a 46% cut, while a fold at the |detA|/sigma ceiling lands where it
   * always did. That is the right shape for this complaint, because the mid-tones
   * ARE the "texture" and the folds are the caustic.
   *
   * IT IS A MITIGATION, NOT A FIX, AND THE MEASUREMENT SAYS SO. Sweeping
   * `strength` from 0.22 down to 0.055 (maxGain 12) on the frozen frame only
   * fades the web uniformly - it never breaks into filaments with dim water
   * between them. Coverage is structural: `bright` = max(gain-1, 0) turns on
   * wherever |det M| < sqrt(detA^2 - sigma^2), i.e. |det M| < 0.97 at 2 m, which
   * is most of the surface, and it is a smooth monotone map of |det M| over that
   * whole range. A real caustic puts its energy on the fold SET. No value of any
   * knob in this file changes that; it needs a super-linear response (bright ~
   * (gain-1)^p) and a caustic that MODULATES the transmitted sun instead of
   * adding to an already fully lit seabed. Both live in causticsNode.ts.
   */
  strength: 0.11,
  maxGain: 6.0,
  darkStrength: 0.45,
  maxDrift: 2.5,
  maxAddLight: 1.5,
  minEffectiveDepth: 0.65,
  maxDepth: 22,
  fadeStart: 180,
  fadeEnd: 340,
  /**
   * Was pure #ffffff, which is what made the caustics read as bleached decals
   * rather than as focused sunlight. A caustic IS the sun, concentrated - so it
   * carries the sun's own colour, and at golden hour that is emphatically not
   * white. Warm off-white here; the per-channel Beer-Lambert extinction above
   * still shifts it blue-green with depth, so the two ends stay physical.
   */
  causticColor: '#ffe9d2',
  causticFollowKey: 1,
  backprojectIterations: 1,
  /**
   * 0.3 -> 0.8 (user: "blending of the caustics above and below"). This is the
   * half-width of the crossfade between the reflected (above-water) and
   * refracted (below-water) branches, and at 0.3 m the two met in a visible
   * seam along the hull - two different-looking effects butted together rather
   * than one effect crossing a waterline. A real waterline is not a line: the
   * hull is wet above it and the surface is broken below it.
   */
  waterlineBlend: 0.8,
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
  /**
   * falloff 4.5 -> 1.0 and maxHeight 2.4 -> 1.6, and the FALLOFF is the fix.
   *
   * THIRD REPORT OF "TOO HIGH", and the first two moved the ceiling alone. That
   * could not work, because at a 4.5 m falloff the exponential only decays to
   * 0.587 across the ENTIRE 2.4 m window — the ceiling smoothstep was the only
   * shape in the profile. Measured: >=72% of full strength all the way up to
   * 1.44 m, half-strength at 1.76 m, 5% at 2.23 m. So the band was a PLATEAU
   * with a cut at the top, and lowering the cut just moved a hard edge down a
   * still-uniformly-bright wall. That is why two rounds of "bring the number
   * down" did not read as a change.
   *
   * At falloff 1.0 the exponential is the shape again: half-strength at 0.69 m,
   * 5% at 1.36 m, zero at 1.6 m. Peak AT the waterline is untouched, so the wet
   * topside sparkle this branch exists for survives intact and only the climb
   * up the topsides goes.
   *
   * NOTE THE REFERENCE MOVES. `depth` is measured from the LIVE FFT surface, so
   * this is height above the local instantaneous wave, not above mean sea
   * level: in a swell the visible reach is this plus the local crest. Correct
   * for a reflected ray, and worth knowing before reading a screenshot.
   */
  reflectedHeightFalloff: 1.0,
  reflectedMaxHeight: 1.6,
  reflectedFaceLimit: 0.35,
  reflectedIncidence: 1,
  waterlineSlopeBound: 1,

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
    foldDepth: { min: 0.2, max: 20, step: 0.05 },
    foldExponent: { min: 1, max: 6, step: 0.05 },
    strength: { min: 0, max: 6, step: 0.05 },
    maxGain: { min: 0.2, max: 12, step: 0.1 },
    darkStrength: { min: 0, max: 1, step: 0.01 },
    maxDrift: { min: 0.2, max: 20, step: 0.1 },
    maxAddLight: { min: 0, max: 8, step: 0.05 },
    minEffectiveDepth: { min: 0, max: 4, step: 0.05 },
    maxDepth: { min: 1, max: 60, step: 0.5 },
    fadeStart: { min: 10, max: 2000, step: 10 },
    fadeEnd: { min: 20, max: 4000, step: 10 },
    causticFollowKey: { min: 0, max: 1, step: 0.01 },
    backprojectIterations: { min: 0, max: 1, step: 1 },
    waterlineBlend: { min: 0.02, max: 2, step: 0.01 },
    faceGateSoftness: { min: 0.005, max: 0.5, step: 0.005 },
    reflectedStrength: { min: 0, max: 3, step: 0.01 },
    reflectedHeightFalloff: { min: 0.2, max: 30, step: 0.1 },
    reflectedMaxHeight: { min: 0.5, max: 40, step: 0.5 },
    reflectedFaceLimit: { min: 0.02, max: 1, step: 0.01 },
    reflectedIncidence: { min: 0, max: 1, step: 0.01 },
    waterlineSlopeBound: { min: 0, max: 1, step: 0.01 },
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
