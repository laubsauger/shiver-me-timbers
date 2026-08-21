/**
 * Intersection/flow foam tunables (§V16: every tunable in a params module,
 * no shader magic constants). Consumed by src/flowfoam/* (§V10: depth-compare
 * intersection mask → world-space accumulation RT advected by a flow noise
 * map + blurred every frame — the Rare depth-trick, docs/handoff.md §4).
 *
 * `resolution` is a startup constant (texture allocation + dispatch size —
 * change requires recreating the system, like deckwater grid dims).
 * `regionSize` is live-tweakable but a change breaks world anchoring for one
 * frame (the sliding window rescales under existing foam).
 */
import { registerParams, type ParamMeta } from './registry';

export interface FlowFoamParams {
  /** side length (m) of the square top-down foam region following the ship */
  regionSize: number;
  /** foam RT resolution (texels per side, power of two — startup constant) */
  resolution: number;
  /** coarse far-tier region side length (m) — how far astern the trail survives */
  farRegionSize: number;
  /** far-tier resolution (texels per side, startup constant) */
  farResolution: number;
  /**
   * Far-tier decay half-life (s) — THE knob that decides how far astern the
   * trail survives, because past the near tier's 60 m this is the only tier
   * left. Distance is what the eye reads, and distance = speed × halfLife/ln2:
   * at 18 kt, 6 s put the half-brightness point 40 m astern and 22 s puts it
   * 205 m astern.
   *
   * It is NOT a brightness knob — `farInject` sets the level, this sets the
   * gradient — and the two must not be confused, because raising the level to
   * buy reach is what pins the trail above the ocean's dissolve gate and turns
   * it into a painted slab (see `farInject`).
   */
  farDecayHalfLife: number;
  /** far-tier radial edge fade, as a fraction of its half-size. Much wider than
   * the near tier's: it is the LAST thing before bare ocean, so its falloff has
   * to be long enough to read as dissipation rather than as a border */
  farEdgeFade: number;
  /** far-tier foam weight (0 disables the long trail entirely) */
  farStrength: number;
  /** fraction of the near region size at which the far tier starts fading in —
   * it must stay silent inside the near window or it paints over the detail */
  farBlendStart: number;
  /** far-tier injection scale — the aged remnant, NOT fresh foam. Accumulated
   * foam settles at rate x halfLife/ln2, so the long-decay tier needs a far
   * smaller rate or it pins to a solid white slab */
  farInject: number;
  /** injection ortho camera height above water (m); capture range = ±height */
  captureHeight: number;
  /** |scene depth − water depth| (m) below which a pixel counts as intersecting */
  depthThreshold: number;
  /** fraction of depthThreshold over which the mask feathers 1→0 (0..1] */
  maskFeather: number;
  /** foam added per second where the injection mask is 1 */
  injectStrength: number;
  /** seconds for advected foam to fade to half value (per-frame factor at §V2 tick) */
  decayHalfLife: number;
  /** multiplier on the flow vector when advecting (1 = flow speed in m/s) */
  advectSpeed: number;
  /** 3×3 blur tap offset in texels — spread speed of the progressive blur */
  blurRadius: number;
  /**
   * Foam diffusion as a WORLD rate: the gaussian σ in metres the trail spreads
   * after ONE second, so σ(t) = blurSpread·√t. The per-step 3×3 kernel weight
   * is solved from this, the tick's dt and the tier's texel — see
   * flowMath.blurMixForDt, which also records what this replaced.
   *
   * IT REPLACED A FIXED PER-FRAME `blurMix` 0.35, which was wrong twice. Once
   * per §V2: the blur ran once per RENDER frame while the decay beside it was
   * dt-scaled, so diffusion was proportional to frame rate — 13× more spread
   * per second at 60 fps than in the 4.6 fps session the wake was tuned in.
   * And once per §V.36: variance per step goes as texel², so one shared weight
   * diffused the 2.5 m far tier 114× faster in METRES than the 0.234 m near
   * tier, reaching σ = 33.7 m over the far tier's own mean visible lifetime.
   * That smear was wider than the bright core of the trail it was carrying,
   * and it is the missing term behind the standing discrepancy that every CPU
   * model in tests/flowfoam.test.ts — none of which diffuse — predicted several
   * times the coverage the GPU actually held.
   *
   * 0.76 IS THE NEAR TIER'S OLD BEHAVIOUR AT 60 fps, TO 0.1%, and that is why
   * it is 0.76: the near field is what the user sees around the hull, the
   * standing complaint about it is that it is too white, and this fix was not
   * allowed to brighten it. The far tier is where the 114× actually lands.
   */
  blurSpread: number;
  /** curl/eddy multiplier where foam = 1 — the trail churns, open ocean stays calm */
  wakeChurn: number;
  /** fraction of the region half-width over which sampled foam fades at the border */
  edgeFade: number;
  /** flow noise frequency (1/m) — lower = larger, lazier eddies */
  noiseScale: number;
  /** swirl speed contributed by the pseudo-curl field (m/s per unit gradient) */
  noiseStrength: number;
  /** scroll speed of the noise potential along the base flow direction (m/s) */
  noiseScrollSpeed: number;
  /** uniform downstream drift along the flow direction (m/s) */
  baseFlowSpeed: number;
  /** finite-difference offset (m) for the pseudo-curl gradient samples */
  curlStep: number;
  // --- wake track history (world-space memory: src/flowfoam/wakeTrack.ts) ---
  /** metres of travel between recorded cutwater samples — the trail's resolution */
  trackSpacing: number;
  /** heading change (deg) that also lays a sample — keeps hard turns curved, not faceted */
  trackTurn: number;
  /** distance (m) over which required sample spacing grows — dense at the hull,
   * sparse astern, so 48 samples reach hundreds of metres at zero GPU cost */
  trackCoarsen: number;
  /** track distance (m) inside which history is never thinned — the detail zone */
  trackCoarsenStart: number;
  /** seconds a track sample survives; with trackSpacing this sets trail length */
  trackLife: number;
  /** fraction of trackLife over which the oldest wake fades out (no eviction pop) */
  tailFade: number;
  /** feather distance (m) ahead of the cutwater over which wake is clipped to 0 */
  bowClip: number;
  /**
   * ONE scale on every TRAILING foam feature (cutwater core, Kelvin arms, hull
   * shoulder, stern churn, shed vortices) — deliberately not on the bow mound,
   * which is dosed on its own arithmetic (see `moundIntensity`).
   *
   * WHY IT EXISTS. The ocean's dissolve gate thresholds coverage per texel at
   * `residueKneeLow + U[0, erodeDepth]` = 0.005 + U[0, 0.22], so coverage ABOVE
   * ~0.23 survives everywhere and coverage below it survives in proportion.
   * That gate is the only thing giving the wake interior any spatial structure,
   * and the trail was sitting entirely above it: measured on the centreline at
   * 6 m/s, coverage ran 0.79 at 5 m astern, 0.56 at 20 m, 0.34 at 80 m — every
   * one of them past the top of the gate, so all of them rendered at full
   * survival and the wake read as one flat sheet with breakup HOLES punched in
   * it rather than as water thinning behind the hull (docs/bugs/
   * bug-wake-solid-white.png; user: "too solid white… should only do that on
   * the leading edges, not just stay constantly solid").
   *
   * Scaling the trail so the profile STRADDLES the gate is what turns that
   * single sheet into a gradient: the leading edges stay above it and read
   * bright, the interior falls through it and thins. Same lesson as
   * `moundIntensity` ("aim for the middle of the gate, not the top"), and the
   * same lesson the sim foam learned in its two-clock split — the lever was
   * attenuating the residue, not brightening the breaker.
   */
  trailInject: number;

  // --- bow mound: the displacement bow wave, FORWARD of the stem ---
  /**
   * Bow mound foam per second per m/s — the water shoved ahead of the stem.
   *
   * THIS IS A RATE AND THE EYE SEES A DOSE. Accumulated coverage at the crest
   * is the time integral of the rate as the mound sweeps over a texel, and it
   * works out to exactly `moundIntensity · sf(v) · moundThick / 2` — the ship's
   * SPEED CANCELS (a faster hull deposits proportionally more per second over
   * proportionally less time). Measured at the shipped 0.06/1.4: 0.042 at the
   * crest and 0.045-0.046 at every speed from 4 to 8 m/s, against an ocean
   * dissolve threshold of `residueKneeLow + U[0, erodeDepth]` = 0.005 + U[0,
   * 0.22] (foam/foamShading.foamDetailMask). ~7% of texels survived, so the
   * water ahead of the bow was blank however hard the ship was driven — the
   * second half of "the bow wake is still disappearing", after the emitter was
   * moved out of the hull (main.ts `stemZ`).
   *
   * Retuned against that arithmetic, not by eye. Paid mostly in THICKNESS — a
   * broader leading face buys dose without a hotter peak, and the standing
   * complaint about this sea's foam is that it is too bright and too blobby,
   * never too dim.
   *
   * AIM FOR THE MIDDLE OF THE GATE, NOT THE TOP. The dissolve threshold is
   * UNIFORM on [0.005, 0.225], so the dose does not just have to clear it — it
   * decides what FRACTION of texels survive, which is the difference between
   * aerated water and a painted slab. A dose past 0.225 saturates that
   * fraction at 1 and the mound goes solid; the first retune did exactly that
   * (0.257) and drew "the water is still getting too white all around the
   * ship". A dose near the MIDDLE leaves the mound broken up, which is both
   * what it should look like and what the noise-free mound cannot get any
   * other way — it deliberately skips `wakeBreakup`, so this gate is its only
   * source of texture.
   */
  moundIntensity: number;
  /** metres AHEAD of the stem where the mound crest peaks (must be > 0: it leads) */
  moundLead: number;
  /** crest aft-sweep per metre outboard — how the mound peels into the V arms */
  moundSweep: number;
  /** outboard half-extent (m) of the mound before it hands over to the arms */
  moundSpan: number;
  /**
   * Fore-aft thickness (m) of the mound's leading face. Carries the dose (see
   * `moundIntensity`) AND the ridge's own width — slickInjection.bowSlopeNode
   * shapes the surface as −2u·e^(−u²) with u = dc/moundThick, so at a fixed
   * `moundSlope` a thicker face is a physically TALLER mound, which is what a
   * 38 m hull at Froude 0.3 actually pushes.
   */
  moundThick: number;
  /**
   * Aft thickness as a multiple of moundThick. It exists to fill the gap back
   * to the hull so nothing forward of the stem reads undisturbed — with the
   * emitter finally AT the waterline stem (main.ts `stemZ`) that gap is a
   * couple of metres, not the 3.5 m of hull the mound used to be buried in, so
   * this no longer has to reach as far aft.
   */
  moundFill: number;
  /** seconds for the mound to build/subside toward the hull's speed (inertia) */
  moundLag: number;

  // --- bow: cutwater core + Kelvin arms ---
  /** bow wake V half-angle (deg) — 19.47 is the physical Kelvin angle */
  kelvinAngle: number;
  /** Kelvin arm foam injected per second per m/s of ship speed */
  bowIntensity: number;
  /** arm half-width (m) at the stem */
  armWidth: number;
  /** extra arm half-width per metre of track distance — the V thickens as it trails */
  armWidthGrowth: number;
  /** hard cap (m) on arm half-width — stops the V swelling into a blob far astern */
  armWidthMax: number;
  /** aft features may not spread past this fraction of the Kelvin half-width */
  aftSpreadCap: number;

  // --- hull shoulder: water the forebody shoulders aside ("plowing") ---
  /** shoulder foam per second per m/s — the displaced water along the hull sides */
  shoulderIntensity: number;
  /** forebody length (m of track) over which the shoulder runs before the arms take over */
  shoulderLength: number;
  /** metres the shoulder is pressed OUT beyond the hull side by the end of the forebody */
  shoulderPush: number;
  /** shoulder half-width (m) */
  shoulderWidth: number;
  /** track distance (m) over which the wetted half-beam opens from the stem */
  shoulderEntry: number;
  /** extra arm intensity multiplier at the hull (0 = flat) — "heaving water out" read */
  hullBoost: number;
  /** track distance (m) over which hullBoost fades to 0 */
  hullBoostDist: number;
  /** e-folding time (s) of bow-feature dissipation — exp(-age/τ), a true
   * decaying gradient rather than a flat-then-cliff "lifetime" */
  bowDecay: number;
  /** cutwater core foam per second per m/s — the stem tearing the surface open */
  cutIntensity: number;
  /** cutwater core half-width (m) */
  cutWidth: number;
  /** track distance (m) over which the cutwater core fades */
  cutLength: number;

  // --- aft: transom churn + shed vortex pair ---
  /** stern churn foam injected per second per m/s of ship speed */
  sternIntensity: number;
  /** stern churn half-width as a multiple of ship beam (≈1 → width ≈ beam) */
  sternWidth: number;
  /** fraction of the turbulent core width remaining at drift speed — the
   * Kelvin envelope is speed-independent, the bright core is not */
  sternWidthSlow: number;
  /** turbulent lateral spread of the stern churn (m/s of water age) */
  sternSpread: number;
  /** e-folding time (s) of stern-churn dissipation, measured from the transom */
  sternDecay: number;
  /** track distance (m) aft of the transom over which the aft features fade IN */
  sternOnset: number;
  /** shed vortex foam per second per m/s — the aft's distinguishing feature */
  vortexIntensity: number;
  /** vortex lobe offset from the centreline, × beam half-width */
  vortexOffset: number;
  /** outboard drift of the vortex lobes (m/s of water age) */
  vortexSpread: number;
  /** vortex lobe half-width (m) */
  vortexWidth: number;
  /** metres of track between shed puffs — port/starboard alternate (von Kármán) */
  vortexSpacing: number;
  /** e-folding time (s) of shed-vortex dissipation */
  vortexDecay: number;

  /** ship speed (m/s) below which no wake is injected (feathers over 1× more) */
  speedThreshold: number;
  /** speed (m/s) at which the bow wake is fully developed — arm intensity
   * scales with smoothstep(speedThreshold, fullWakeSpeed, speed); slow drift
   * shows only faint stern churn, no V */
  fullWakeSpeed: number;
  /** world-space frequency (1/m) of the wake breakup noise */
  wakeNoiseScale: number;
  /** smoothstep half-band around 0.5 thresholding the breakup noise — small = hard gaps, large = soft mottle */
  wakeNoiseContrast: number;
  /** 0 = solid painted bands, 1 = fully gappy/broken foam patches */
  wakeBreakup: number;
  /** age (s) over which breakup gaps smooth away — turbulence coarsens as it
   * decays, so old wake should be a soft wash, not high-frequency stipple */
  breakupSmoothAge: number;

  // --- SLICK: the wake's effect on the WATER, not on its colour -------------
  // Turbulence and surfactant in a ship's track kill the short capillary waves,
  // leaving a smooth glassy lane astern that reads as a darker, more
  // mirror-like stripe. src/flowfoam/slickMath.ts owns the model; the ocean
  // material consumes it as a MULTIPLIER on its fine slope terms.
  /** lane coverage added per second at full speed (settles at rate x
   * slickHalfLife/ln2 — the same accumulation arithmetic as the foam) */
  slickIntensity: number;
  /** lane half-width at the stem, x hull half-beam */
  slickWidth: number;
  /** turbulent widening of the lane (m per second of water age) */
  slickSpread: number;
  /** the lane may not exceed halfBeam + this x the Kelvin half-width — one
   * wake, one envelope, so the slick can never fan out wider than the foam */
  slickSpreadCap: number;
  /** e-folding time (s) of the lane's INJECTION with water age. SHORT on
   * purpose: turbulence is GENERATED in the first seconds behind the hull, and
   * slickHalfLife then carries the persistence. Making both long instead pins
   * the whole lane at coverage 1 (the AccumProfile.wakeScale trap: a source
   * settles at rate x halfLife/ln2, which was 8.4 before this was measured) and
   * the lane becomes a formless slab with no gradient at all */
  slickDecay: number;
  /** fraction of the lane half-width that is soft shoulder (0 = hard edge).
   * The lane must be smooth: it multiplies a slope the ocean differentiates in
   * screen space, so any sharp/stippled structure returns amplified (§V49) */
  slickEdge: number;
  /** seconds for accumulated slick to halve. Deliberately MUCH longer than
   * decayHalfLife — a real slick outlives the whitewater that made it */
  slickHalfLife: number;
  /** max suppression of the fine ripple inside a fully slicked lane (0..1).
   * 1 would make the lane a perfect mirror; real tracks keep some texture */
  slickDamp: number;
  /** pixels per SMALLEST WRITTEN FEATURE below which the wake's slick and
   * slope read at full strength (§V48). Not pixels per texel: the yardstick is
   * `texel × waveBandLow`, the finest thing the injector is allowed to write
   * (src/flowfoam/index.ts) — keying it to the storage grid instead retired the
   * whole field ~2.5× too early, which is §B.20 */
  slickBandFull: number;
  /** pixels per smallest written feature at which it has faded to nothing —
   * past this the unmipped StorageTexture is being point-sampled and would
   * alias INTO the surface normal (§V49) */
  slickBandCut: number;

  // --- transverse Kelvin waves (inside the V, crests across the track) ------
  /** peak world surface SLOPE added by the transverse crests. Slope, not
   * height: the ocean owns displacement, this only shades */
  transSlope: number;
  /** e-folding time (s) of the transverse crests with water age */
  transDecay: number;
  /** track distance (m) over which the crest amplitude falls like 1/sqrt —
   * the wave energy spreads over a widening front */
  transSpread: number;
  /** fraction of the Kelvin half-width inside which the crests are at full
   * amplitude; they fade to 0 at the wedge boundary */
  transInner: number;
  /**
   * MINIMUM width of the transverse train's lateral feather, as a fraction of
   * the transverse wavelength λ = 2πv²/g. The envelope's gradient is then
   * ≤ transSlope·1.5/(2π·transFeather) — 1.5× the crest slope at 0.16 — so the
   * wedge edge cannot be steeper than the wave inside it (§T.78: the
   * "chunky, sharp-edged" bow wave was a feather 0.088·d wide carrying 0.5 m).
   * `transInner` still sets the feather where the wedge is wide enough for a
   * bigger one.
   */
  transFeather: number;

  // --- divergent (cusp) crests: THE BOW WAVE ------------------------------
  // The second Kelvin wave system — short, steep crests fanning off the stem at
  // 54.74° to the track, filling the water ahead of and beside the bow. This is
  // what a viewer reads as "the ship is pushing water"; the transverse train
  // above runs across the track BEHIND her and cannot stand in for it.
  /** peak world surface SLOPE of the divergent crests. Steeper than the
   * transverse train because the waves themselves are (shorter for the same
   * energy) — this is the feature the eye reads as a bow wave */
  divSlope: number;
  /** e-folding time (s) of the divergent crests. SHORTER than transDecay:
   * short waves dissipate faster, which is why the feathered V is a near-field
   * feature while the transverse train runs on astern */
  divDecay: number;
  /** track distance (m) over which divergent amplitude falls like 1/sqrt */
  divSpread: number;
  /** extra fade band OUTSIDE the cusp line, as a fraction of the Kelvin
   * half-width — the wedge boundary is a real physical edge, but a hard step
   * in a field that ends up differentiated is a 1-px line (§V38) */
  divOuterFade: number;

  // --- band-limit for BOTH periodic wave systems (§V48) ---------------------
  /** texels per wavelength below which a wave train's amplitude is 0. The
   * divergent branch's wavelength runs to ZERO on the centreline, so this gate
   * is what makes that singularity harmless — it fades the amplitude to its own
   * mean (zero) exactly where the field stops being representable */
  waveBandLow: number;
  /** texels per wavelength at which it is at full amplitude */
  waveBandHigh: number;

  // --- shed eddies as SURFACE: the vortex street, deforming instead of painting
  /**
   * Peak world SLOPE of one shed eddy. User: the wake "needs another level of
   * influence on our water shader so that it actually disturbs the surface…
   * eddy currents and swirls, but not in a super high-frequency noise way,
   * something rather more realistic, bigger swirls".
   *
   * THIS CONNECTS AN EXISTING FEATURE RATHER THAN ADDING ONE. The shed vortex
   * street was already modelled — a von Kármán pair alternating port/starboard
   * π out of phase, shed at the transom corners, `vortexSpacing` metres apart —
   * and it was thrown at the ALBEDO only. Measured before this landed: the
   * `.ba` slope channel carried the bow-mound ridge and the two Kelvin trains
   * and nothing else, i.e. three regular parallel-crested wave trains, while
   * every turbulent feature in the model was paint on an undisturbed surface.
   * That is why no amount of tuning made the wake "disturb" anything.
   *
   * The scale therefore comes from the hull, not from a texture: `vortexSpacing`
   * is 11 m against an 8.5 m beam. There is deliberately no fbm here — swirls
   * this size ARE the answer to "not high-frequency noise".
   */
  eddySlope: number;
  /**
   * Eddy core radius, × the hull's half-beam (§V.66 — a feature scaled by its
   * own dimension, so a different hull gets proportionate eddies for free).
   * The core is a Gaussian surface dimple; its slope peaks at 0.707 radii out.
   */
  eddyRadius: number;

  // --- bow mound as SURFACE, not foam ---------------------------------------
  /** peak world SLOPE of the displacement bow wave — the water heaped ahead of
   * the stem. `moundIntensity` paints the foam on it; this is the mound
   * itself, and without it there is nothing to paint on. Rides the same lagged
   * `moundLag` speed, so it builds and subsides with the hull */
  moundSlope: number;
}

export const flowFoamParams: FlowFoamParams = registerParams(
  'flowfoam',
  {
    regionSize: 120,
    resolution: 512,
    // Stays 640, and both ways of "sharpening" the far tier were tried and
    // rejected, so they are recorded here rather than re-attempted:
    //   460 m (1.8 m/texel) — the far tier's radial edge fade is a FRACTION of
    //     its half-size (farEdgeFade 0.45), so shrinking the region drags the
    //     fade inward with it: measured trail level at 200 m astern collapsed
    //     from 0.278 to 0.061. Reach is this tier's whole job.
    //   res 512 (0.9 m/texel) — breaks the §V48 invariant that justifies
    //     `useDetail: false` here (at 0.9 m it could hold the transverse
    //     crests), and the material reads .ba from the NEAR tier only, so the
    //     4× compute would feed a channel nothing consumes.
    farRegionSize: 640,
    farResolution: 256,
    // 6 → 12. Paired with farInject 0.85 → 0.6 below; the two move together.
    // This is the knob that decides REACH: measured trail level 200 m astern
    // goes 0.102 → 0.183, and the half-brightness point at 18 kt moves from
    // 40 m to 80 m astern.
    //
    // It is capped at 12 by the tier crossover, not by taste. The two regions
    // hand over at ~40-50 m, and a far tier that outlives the near one is
    // BRIGHTER than it there, so the trail re-brightens as it recedes —
    // "NO HARD CUT" in tests/flowfoam.test.ts pins that, correctly: a wake that
    // gets whiter further astern is a worse artefact than a shorter one.
    // Everything past 12 fails it at every farInject that also clears the
    // brightness-match check.
    farDecayHalfLife: 12,
    farStrength: 1.0,
    farEdgeFade: 0.45,
    // 0.85 → 0.6, DOWN, and that is not a typo: the far tier now lives twice
    // as long, so the same rate would settle it ~2× higher and it would
    // out-shine the near tier at the crossover (see farDecayHalfLife). Reach
    // comes from the half-life; this only sets the level, and the two must not
    // be confused. Raising this to buy reach is the documented way to pin the
    // wake into a painted slab: tried at 1.5 and 2.2 and the far field settled
    // at 0.29-0.33 everywhere, past the TOP of the ocean's dissolve gate
    // (0.005 + U[0, 0.22]) where every texel survives — the same failure
    // `trailInject` and `moundIntensity` were both retuned for.
    farInject: 0.6,
    farBlendStart: 0.3,
    captureHeight: 50,
    depthThreshold: 0.35,
    maskFeather: 0.5,
    injectStrength: 0.03,
    /*
     * STAYS 5, and that is a constraint finding rather than a preference.
     *
     * This is the wake's real limiter — the far tier only inherits it — and
     * raising it IS visibly better in isolation: at 11 s the measured trail at
     * 200 m astern went 0.102 → 0.290 in the accumulation model, nearly 3×.
     * But it is pinned from both sides at once:
     *   - raise it alone and the trail's interior stops falling through the
     *     ocean's dissolve gate ("STRADDLES the dissolve gate": coverage at
     *     80 m went 0.348 against a 0.225 ceiling), so the wake goes back to
     *     being one painted sheet — the bug-wake-solid-white failure;
     *   - scale `trailInject` down to compensate and the far tier scales down
     *     with it, giving the reach straight back.
     * Searched all four knobs (decayHalfLife × trailInject × farDecayHalfLife ×
     * farInject, 3600 combinations) against every invariant in
     * tests/flowfoam.test.ts simultaneously: the best legal cell reaches 0.238
     * at 200 m and needs `g80` within 0.4% of the ceiling, which is not a
     * margin worth shipping. The best cell with real margin is the pair below.
     */
    decayHalfLife: 5,
    advectSpeed: 1.0,
    blurRadius: 1.0,
    // σ metres after 1 s. Solves to mix 0.350 on the near tier at 60 fps —
    // i.e. exactly what shipped — and to 0.0031 on the far tier, which is the
    // 114× grid error coming out. See the interface doc.
    blurSpread: 0.76,
    wakeChurn: 1.8,
    edgeFade: 0.16,
    noiseScale: 0.12,
    noiseStrength: 8.0,
    noiseScrollSpeed: 0.4,
    baseFlowSpeed: 0.8,
    curlStep: 1.2,
    trackSpacing: 2.2,
    trackTurn: 6,
    trackCoarsen: 20,
    trackCoarsenStart: 30,
    trackLife: 200,
    tailFade: 0.35,
    bowClip: 0.8,
    // 0.45: takes the centreline profile from 0.79/0.56/0.34 (all saturated) to
    // 0.36/0.25/0.15 — the leading edge still clears the gate outright, the
    // interior lands inside it and varies
    trailInject: 0.45,
    // dose = intensity · thickness / 2 (see moundIntensity): 0.10 · 3.2 / 2 =
    // 0.16 at the crest, against a 0.005 + U[0, 0.22] dissolve gate.
    // 0.06 → 0.15 → 0.10. The first move fixed an invisible mound (dose 0.042,
    // 7% of texels surviving) and overshot: 0.15 put the dose at 0.257, which
    // is past the TOP of the gate, so every texel survived and the mound
    // rendered as an unbroken slab (user: "the water is still getting too white
    // all around the ship"). 0.10 lands at 0.171 — comfortably visible, but
    // 30% of texels still torn out, so it reads as aerated water rather than
    // paint. It also drops BELOW the floor at 3 m/s, which is correct: a
    // drifting hull should not throw a bow wave.
    moundIntensity: 0.1,
    moundLead: 1.6,
    moundSweep: 0.9,
    moundSpan: 5.0,
    moundThick: 3.2,
    // 3.0 → 1.8 → 1.4 → 1.0, i.e. a SYMMETRIC ridge. The asymmetric aft face
    // existed to paper over the gap between the crest and a hull the emitter
    // was buried 3.5 m inside; with the emitter at the true stem that gap is
    // 1.6 m and the crest's own leading face already covers it. Everything the
    // fill still added landed alongside the forebody, which is the region the
    // user photographed as solid white. The crest dose is untouched either way
    // — the integral up to the crest comes only from the LEADING face.
    moundFill: 1.0,
    moundLag: 1.1,
    kelvinAngle: 19.47,
    bowIntensity: 0.14,
    armWidth: 0.9,
    armWidthGrowth: 0.02,
    armWidthMax: 2.6,
    aftSpreadCap: 0.22,
    shoulderIntensity: 0.05,
    shoulderLength: 14,
    shoulderPush: 2.0,
    shoulderWidth: 1.3,
    shoulderEntry: 8,
    hullBoost: 1.6,
    hullBoostDist: 14,
    bowDecay: 16,
    cutIntensity: 0.13,
    cutWidth: 1.1,
    cutLength: 7,
    sternIntensity: 0.016,
    sternWidth: 0.9,
    sternWidthSlow: 0.35,
    sternSpread: 0.09,
    sternDecay: 13,
    sternOnset: 3,
    vortexIntensity: 0.033,
    vortexOffset: 1.15,
    vortexSpread: 0.05,
    vortexWidth: 1.3,
    vortexSpacing: 11,
    vortexDecay: 15,
    speedThreshold: 0.5,
    fullWakeSpeed: 5.0,
    wakeNoiseScale: 0.3,
    wakeNoiseContrast: 0.18,
    wakeBreakup: 0.55,
    breakupSmoothAge: 12,
    slickIntensity: 0.2,
    slickWidth: 1.6,
    slickSpread: 0.16,
    slickSpreadCap: 0.55,
    slickDecay: 6,
    slickEdge: 0.55,
    slickHalfLife: 50,
    slickDamp: 0.8,
    slickBandFull: 1.0,
    slickBandCut: 3.0,
    transSlope: 0.06,
    transDecay: 26,
    transSpread: 40,
    transInner: 0.75,
    transFeather: 0.16,
    divSlope: 0.11,
    divDecay: 11,
    divSpread: 22,
    divOuterFade: 0.12,
    waveBandLow: 2.5,
    waveBandHigh: 6,
    moundSlope: 0.17,
    // 0.09 = 66% of the sea's own rms slope (measured 0.1373): clearly present
    // in the specular without out-shouting the swell the eddies ride on
    eddySlope: 0.09,
    // 0.9 x half-beam = 3.8 m cores on the galleon — metres, as asked, and an
    // order of magnitude above the 0.234 m texel, so §V.48 never engages
    eddyRadius: 0.9,
  },
  flowFoamParamsMeta(),
);

function flowFoamParamsMeta(): Partial<Record<keyof FlowFoamParams, ParamMeta>> {
  return {
    regionSize: { min: 30, max: 500, step: 5 },
    farRegionSize: { min: 120, max: 2000, step: 20 },
    farDecayHalfLife: { min: 1, max: 300, step: 1 },
    farStrength: { min: 0, max: 1, step: 0.05 },
    farEdgeFade: { min: 0.05, max: 0.8, step: 0.01 },
    farInject: { min: 0, max: 3, step: 0.01 },
    farBlendStart: { min: 0.05, max: 0.45, step: 0.01 },
    captureHeight: { min: 5, max: 200, step: 1 },
    depthThreshold: { min: 0.05, max: 3, step: 0.05 },
    maskFeather: { min: 0.05, max: 1, step: 0.05 },
    injectStrength: { min: 0, max: 2, step: 0.005 },
    decayHalfLife: { min: 0.05, max: 120, step: 0.05 },
    advectSpeed: { min: 0, max: 4, step: 0.05 },
    blurRadius: { min: 0, max: 4, step: 0.25 },
    blurSpread: { min: 0, max: 4, step: 0.02 },
    wakeChurn: { min: 0, max: 8, step: 0.1 },
    edgeFade: { min: 0.01, max: 0.45, step: 0.01 },
    noiseScale: { min: 0.005, max: 0.5, step: 0.005 },
    noiseStrength: { min: 0, max: 12, step: 0.1 },
    noiseScrollSpeed: { min: 0, max: 4, step: 0.05 },
    baseFlowSpeed: { min: 0, max: 6, step: 0.05 },
    curlStep: { min: 0.1, max: 8, step: 0.1 },
    trackSpacing: { min: 0.5, max: 10, step: 0.1 },
    trackTurn: { min: 1, max: 45, step: 0.5 },
    trackCoarsen: { min: 5, max: 400, step: 5 },
    trackCoarsenStart: { min: 5, max: 200, step: 1 },
    trackLife: { min: 1, max: 600, step: 1 },
    tailFade: { min: 0.05, max: 0.9, step: 0.05 },
    bowClip: { min: 0.1, max: 8, step: 0.1 },
    trailInject: { min: 0, max: 2, step: 0.05 },
    moundIntensity: { min: 0, max: 5, step: 0.05 },
    moundLead: { min: 0.1, max: 10, step: 0.1 },
    moundSweep: { min: 0, max: 4, step: 0.05 },
    moundSpan: { min: 0.5, max: 20, step: 0.25 },
    moundThick: { min: 0.2, max: 8, step: 0.1 },
    moundFill: { min: 1, max: 8, step: 0.1 },
    moundLag: { min: 0.05, max: 6, step: 0.05 },
    kelvinAngle: { min: 5, max: 45, step: 0.01 },
    bowIntensity: { min: 0, max: 5, step: 0.05 },
    armWidth: { min: 0.1, max: 10, step: 0.1 },
    armWidthGrowth: { min: 0, max: 0.5, step: 0.005 },
    armWidthMax: { min: 0.5, max: 30, step: 0.5 },
    aftSpreadCap: { min: 0.1, max: 2, step: 0.05 },
    shoulderIntensity: { min: 0, max: 6, step: 0.05 },
    shoulderLength: { min: 2, max: 60, step: 0.5 },
    shoulderPush: { min: 0, max: 12, step: 0.1 },
    shoulderWidth: { min: 0.2, max: 8, step: 0.1 },
    shoulderEntry: { min: 0.5, max: 40, step: 0.5 },
    hullBoost: { min: 0, max: 8, step: 0.1 },
    hullBoostDist: { min: 1, max: 60, step: 1 },
    bowDecay: { min: 0.5, max: 120, step: 0.5 },
    cutIntensity: { min: 0, max: 8, step: 0.05 },
    cutWidth: { min: 0.1, max: 8, step: 0.1 },
    cutLength: { min: 0.5, max: 40, step: 0.5 },
    sternIntensity: { min: 0, max: 0.5, step: 0.002 },
    sternWidth: { min: 0.2, max: 4, step: 0.05 },
    sternWidthSlow: { min: 0.05, max: 1, step: 0.05 },
    sternSpread: { min: 0, max: 4, step: 0.05 },
    sternDecay: { min: 0.5, max: 120, step: 0.5 },
    sternOnset: { min: 0.5, max: 20, step: 0.5 },
    vortexIntensity: { min: 0, max: 0.5, step: 0.002 },
    vortexOffset: { min: 0.2, max: 4, step: 0.05 },
    vortexSpread: { min: 0, max: 3, step: 0.02 },
    vortexWidth: { min: 0.2, max: 6, step: 0.1 },
    vortexSpacing: { min: 2, max: 60, step: 0.5 },
    vortexDecay: { min: 0.5, max: 120, step: 0.5 },
    speedThreshold: { min: 0, max: 5, step: 0.05 },
    fullWakeSpeed: { min: 1, max: 15, step: 0.25 },
    wakeNoiseScale: { min: 0.02, max: 2, step: 0.01 },
    wakeNoiseContrast: { min: 0.02, max: 0.5, step: 0.01 },
    wakeBreakup: { min: 0, max: 1, step: 0.05 },
    breakupSmoothAge: { min: 1, max: 90, step: 1 },
    slickIntensity: { min: 0, max: 3, step: 0.01 },
    slickWidth: { min: 0.5, max: 8, step: 0.1 },
    slickSpread: { min: 0, max: 2, step: 0.01 },
    slickSpreadCap: { min: 0.05, max: 2, step: 0.05 },
    slickDecay: { min: 1, max: 240, step: 1 },
    slickEdge: { min: 0.05, max: 1, step: 0.05 },
    slickHalfLife: { min: 1, max: 300, step: 1 },
    slickDamp: { min: 0, max: 1, step: 0.05 },
    slickBandFull: { min: 0.1, max: 4, step: 0.05 },
    slickBandCut: { min: 0.2, max: 12, step: 0.1 },
    transSlope: { min: 0, max: 0.6, step: 0.005 },
    transDecay: { min: 1, max: 240, step: 1 },
    transSpread: { min: 1, max: 400, step: 1 },
    transInner: { min: 0.05, max: 1, step: 0.05 },
    transFeather: { min: 0, max: 0.5, step: 0.01 },
    divSlope: { min: 0, max: 0.8, step: 0.005 },
    divDecay: { min: 0.5, max: 120, step: 0.5 },
    divSpread: { min: 1, max: 400, step: 1 },
    divOuterFade: { min: 0.01, max: 0.5, step: 0.01 },
    waveBandLow: { min: 1, max: 8, step: 0.1 },
    waveBandHigh: { min: 2, max: 20, step: 0.1 },
    moundSlope: { min: 0, max: 0.8, step: 0.005 },
    eddySlope: { min: 0, max: 0.5, step: 0.005 },
    eddyRadius: { min: 0.2, max: 4, step: 0.05 },
  };
}
