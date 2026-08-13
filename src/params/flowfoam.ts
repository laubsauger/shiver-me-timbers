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
  /** far-tier decay half-life (s) — the long settle, minutes not seconds */
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
  /** 0 = no blur, 1 = full 3×3 gaussian per frame — partial blur keeps streaky structure */
  blurMix: number;
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
    farRegionSize: 640,
    farResolution: 256,
    farDecayHalfLife: 6,
    farStrength: 1.0,
    farEdgeFade: 0.45,
    farInject: 0.85,
    farBlendStart: 0.3,
    captureHeight: 50,
    depthThreshold: 0.35,
    maskFeather: 0.5,
    injectStrength: 0.03,
    decayHalfLife: 5,
    advectSpeed: 1.0,
    blurRadius: 1.0,
    blurMix: 0.35,
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
    // 1.8 → 1.4: the aft face is the half of the mound that overlaps the hull,
    // so it is pure "white around the ship" and none of the forward read. It
    // only has to reach the 1.6 m back to the stem; 1.4 × 3.2 = 4.5 m is still
    // ample, and it halves the strong-white area alongside the forebody
    // (measured 24 → 12 m² at 6 m/s). The crest dose is untouched — the
    // integral up to the crest comes only from the LEADING face.
    moundFill: 1.4,
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
    divSlope: 0.11,
    divDecay: 11,
    divSpread: 22,
    divOuterFade: 0.12,
    waveBandLow: 2.5,
    waveBandHigh: 6,
    moundSlope: 0.17,
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
    blurMix: { min: 0, max: 1, step: 0.05 },
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
    divSlope: { min: 0, max: 0.8, step: 0.005 },
    divDecay: { min: 0.5, max: 120, step: 0.5 },
    divSpread: { min: 1, max: 400, step: 1 },
    divOuterFade: { min: 0.01, max: 0.5, step: 0.01 },
    waveBandLow: { min: 1, max: 8, step: 0.1 },
    waveBandHigh: { min: 2, max: 20, step: 0.1 },
    moundSlope: { min: 0, max: 0.8, step: 0.005 },
  };
}
