/**
 * Ocean surface shading + LOD tunables (§V.5, §V.16, §V.20, §V.30).
 * Color targets: docs/final-full-result.png — turquoise SSS through crests,
 * deep teal base, dense warm sparkle, soft foam.
 *
 * COLOUR AUTHORING CONTRACT: hex strings are sRGB as picked off the
 * reference; THREE.Color converts them to the linear working space at the
 * uniform boundary, so what is written here is what should appear on screen.
 *
 * The `grid*` block is baked into geometry at construction — changing it
 * needs a page reload, unlike every other value here which is a live uniform.
 */
import { registerParams } from './registry';

export const oceanSurfaceParams = registerParams(
  'oceanSurface',
  {
    // ── geometry / LOD (§V30, reload to apply) ──────────────────────────
    /** cells per side of the warped clipmap grid (N² cells, one draw) */
    gridSegments: 512,
    /** vertex spacing directly under the camera (m) — grows ~2%/ring outward,
     *  i.e. ≈1 m at the ship, 2.6 m at 100 m, 40 m at 2 km, 90 m at the rim */
    gridCoreSpacing: 0.5,
    /** radius of the sea disc (m) — must stay inside the camera far plane */
    gridHorizonRadius: 4600,
    /** fraction of outer rings blended square→circle (circular rim) */
    gridRimRound: 0.3,
    /**
     * §V.30b RADIAL LOD — target SCREEN HEIGHT, in pixels, of one radial ring
     * step. This is the only number in the block that is not baked: it drives a
     * per-frame uniform, so it toggles live and 0 restores the pre-LOD mesh
     * bit-identically (the vertex stage `select`s on it — see
     * `radialLodXZNode`).
     *
     * WHY IT EXISTS. The clipmap equalises WORLD angular size (spacing/r
     * constant), but the screen sees a radial step through the grazing
     * compression f·h·Δr/r², one power of r more. Measured on the shipped grid
     * at a 12 m deck eye / 55° fov / 1440p: one ring is 0.59 px at 500 m,
     * 0.29 px at 1 km and 0.17 px at 2 km, against 6.4 px of TANGENTIAL detail
     * on the same triangle. Rings past ~1 km are 48% of all triangles and the
     * screen cannot resolve a single one of them radially — and the ocean is
     * ONE draw call costing 17–19 ms of a ~28 ms frame, which three rounds of
     * `onSubmittedWorkDone` legs pinned on PER-PRIMITIVE tiling work: not CPU
     * (main thread 44% idle), not vertex (0.48 ms, 4.7% of the mesh), not fill
     * (16× fewer pixels made it SLOWER, 10.31 → 14.39 ms).
     *
     * 1.0 = one radial step per pixel of screen height. Below ~0.5 the saving
     * mostly disappears (0.5 is one octave of stride less everywhere); above
     * ~1.5 the collapsed rings start to be resolvable and the far sea's
     * silhouette visibly loses its radial structure. It is a SCREEN quantity,
     * so it holds at every distance and every camera height by construction —
     * the height enters through the uniform, not through this number.
     *
     * It does NOT move the cascade Nyquist gates (`lodSamplesFull/Cut`), and
     * that is deliberate: those gate what the mesh can carry LATERALLY, the
     * angular density is untouched, and re-gating on the coarsened radial step
     * would delete displacement that is still fully resolvable across the
     * triangle. Zero displacement content moves when this is turned on.
     *
     * WHAT THE PIXEL TARGET IS NOT, and it cost a user report to learn: a
     * radial step being sub-pixel does NOT make collapsing it invisible. At a
     * grazing framing the geometry sets the INCIDENCE ANGLE, and the shading
     * footprint `pixWorld = fwidth(worldXZ)` goes as 1/sin(incidence). From a
     * 12 m eye at 1 km the plane's own grazing angle is 0.69°, while the sea's
     * slope RMS of 0.16 tilts real facets by ~9° — so a band the LOD has
     * flattened has a footprint several times larger than the same band with
     * its waves, and every §V.48/§V.48b fade that is gated on `pixWorld`
     * (normLod, the sparkle cell, the resolve crossfade) is crossed by the LOD
     * itself. Stepped, that is a hard tonal wall across the frame with paler,
     * flatter water beyond it (user, and `37513f4` for the same shape in the
     * sparkle mean). This is why the collapse is MORPHED (`radialLodMorph`) and
     * not switched, and why the honest setting for this number is the one that
     * is invisible in motion rather than the one the pixel algebra licenses.
     *
     * ── MEASURED TRADE CURVE ──────────────────────────────────────────────
     * Deck framing (12 m eye, ship + island + open sea, f6 "swell" preset),
     * interleaved A/B legs bracketed by `queue.onSubmittedWorkDone()`,
     * min-of-9. Control legs reproduced to within 0.2/255 per screen row.
     * "delta" is the largest row-mean luminance change against the LOD-off
     * control; "rows" is how many of the 856 screen rows move by more than
     * 3/255 (the eye's floor on a broad flat area):
     *
     *   pixels   ms/frame (min)  delta       rows   where
     *   0        26.62 (ref)     —           —      —
     *   0.125    25.37   −4.7%   1.3/255     0      INVISIBLE — shipped
     *   0.25     24.12   −9.4%   19/255      6      1.1–3.3 km, at the horizon
     *   0.5      22.86  −14.0%   24/255     19      reaches in to 365 m
     *   1.0      22.54  −15.2%   27/255     30+     the whole mid-field
     *
     * TWO THINGS THAT CURVE SAYS. The saving SATURATES by 0.5 — the first
     * octave of collapse is nearly all of it, so there is never a reason to run
     * this aggressive. And the visible cost has a CLIFF between 0.125 and 0.25
     * (1.3 → 19/255), because that is where the first collapsed ring enters the
     * band the horizon compresses into ~6 screen rows.
     *
     * Shipped at the invisible end: 0.125 is 1.3/255 — under the 0.2/255 × 6
     * reproducibility of the control legs by a factor that leaves no row of the
     * frame moving by an amount anyone can see — and it still takes 4.7% of the
     * frame off. The knob is live and one slider away in the oceanSurface panel
     * if the user wants to buy the other 9% and judge the horizon band
     * themselves; "no visible fidelity loss" was the standing bar and 19/255 on
     * the horizon is not that, so it is not the default.
     *
     * At 40 m, 120 m and 300 m of eye height the law disables itself
     * (measured: −0.5, −0.1, −0.1 /255 at 0.25), so nothing here is a
     * crow's-nest or free-camera regression at any setting.
     */
    radialLodPixels: 0.125,
    /**
     * FLOOR on the eye height (m) the law is evaluated at — and it is the §V.8
     * guard, not a nicety.
     *
     * kRadial = pixels/(f·h) blows up as the eye approaches the water, so an
     * eye at 1 m would start collapsing rings from 50 m out — inside the radius
     * `cpuOcean` (and therefore buoyancy, hull contact and the shore runup)
     * assumes it agrees with the drawn sea. At 4 m the first collapse is at
     * ~125 m whatever the camera does, which is 3× the ship and leaves the
     * mirror's whole domain on vertices the shader provably does not move.
     * Raising this only ever makes the LOD weaker.
     */
    radialLodMinEye: 4,
    /**
     * OCTAVES OF RADIUS over which a ring MORPHS onto its parent instead of
     * snapping to it — the fix for the wall, and the reason this is a clipmap
     * geomorph and not a switch.
     *
     * A ring's collapse is licensed when `fit = kRadial·r² / (stride·Δr_base)`
     * reaches 1. Stepping there is a discontinuity in what the surface can
     * REPRESENT — the band beyond is flat, the band before is not — and the
     * discontinuity lands on the shading, not just the silhouette (see
     * `radialLodPixels`). Instead the ring's effective index is interpolated
     * toward its parent's across `fit ∈ [2^-morph, 1]`, so the two densities
     * agree exactly at the boundary and the surface is continuous in r at every
     * level. `fit` grows roughly as r, so 1 octave is a transition band a
     * factor of two wide in DISTANCE — 350→700 m for the first level at a deck
     * eye, which is a gradient nobody can point at rather than a line.
     *
     * IT COSTS THE SAVING IT BUYS BACK IN SMOOTHNESS: a ring only becomes
     * zero-area at `fit ≥ 1`, so everything mid-morph is still drawn. Wider is
     * smoother and slower. 0 restores the stepped behaviour, i.e. the bug.
     */
    radialLodMorph: 1.0,
    /**
     * Cap on the collapse stride, as a power of two (4 ⟹ at most 16 rings
     * collapse onto one). BAKED INTO THE NODE GRAPH — it is the unrolled loop
     * count, so it needs a reload, unlike `radialLodPixels`.
     *
     * It also bounds the square→circle fold check: the rim blend moves by at
     * most `rimRound`-slope × stride/half per collapsed group while the ring
     * radius grows by e^{k·stride}, and at stride 16 that is 1.39× growth
     * against a 0.885× shape shrink — 1.23, still monotone. Past 5 the two
     * cross and outer rings can fold inside inner ones at the diagonals.
     */
    radialLodMaxLevel: 4,
    /**
     * Nyquist gate for cascade displacement: a cascade is at full strength
     * while its domain spans ≥ lodSamplesFull vertices and gone once it spans
     * ≤ lodSamplesCut. Because vertex spacing grows with distance (see
     * surfaceGeometry) this is a distance fade that RIDES the LOD — geometry
     * dies exactly where the triangles can no longer carry it (§V30).
     */
    lodSamplesFull: 9,
    lodSamplesCut: 4.5,
    /**
     * Normals are per-pixel, not per-vertex, so slope detail may outlive the
     * geometry: cascade normal fades use the same Nyquist gate stretched by
     * this factor.
     */
    normalDetailStretch: 3.0,
    /**
     * §V.48 filtered tier for the cascade NORMALS. The derivative textures are
     * compute-written StorageTextures and cannot carry a mip chain, so a
     * minified fetch is a point sample of a zero-mean slope field — per-pixel
     * noise, which the pow(N·H,180) glint then amplifies into the fibrous
     * golden hair covering the whole sea when zoomed out (user).
     *
     * These are FRACTIONS OF A CASCADE'S OWN SLOPE VARIANCE, not texel counts:
     * a cascade is at full strength while at least `Full` of its slope variance
     * is still resolvable at the pixel's footprint, and gone once less than
     * `Cut` is. The two footprints in metres are measured from the live
     * spectrum (oceanMath.slopeResolutionFootprint) and refreshed on every h0
     * rebuild, so weather presets and spectrum sliders move them for free.
     *
     * THEY REPLACE A TEXEL-COUNT PAIR (1.0 / 3.5 texels) THAT WAS RETIRING
     * RESOLVED DETAIL. Measured on the shipped swell sea: cascade 2's slope
     * lives at λ ≈ 2.4 m = 53 texels, so at the 3.5-texel footprint where it
     * was deleted it still carried 89% of its slope variance; the composite
     * shading slope RMS was 59% of near-field by 53 m, 31% by 130 m and zero
     * past 365 m against 40% still resolvable. That is the "too plasticky too
     * close by" report and half of the "greys out under sky reflection" one —
     * a flat sea has nothing to break up the mirror. A texel ratio also cannot
     * be shared: the same 0.95/0.20 pair lands at 2.5/50 texels on cascade 2
     * and 23/71 on cascade 1, which is why the footprints are measured per
     * cascade rather than converted by a constant (§V.59's tell).
     *
     * 0.95 / 0.20 puts the fade at ≈44 m → ≈207 m for cascade 2 and ≈480 m →
     * ≈960 m for cascade 0 at a follow-camera framing (14 m eye, 55° fov,
     * 1440p). Raising `Cut` retires earlier and flattens the mid-field again;
     * lowering it hands more sub-pixel slope to `specularAaStrength`.
     * NOT YET CONFIRMED IN-BROWSER (§V.22) — the numbers below are measured on
     * the spectrum, the look is not signed off.
     */
    normalKeepFull: 0.95,
    normalKeepCut: 0.2,

    // ── colour ──────────────────────────────────────────────────────────
    deepColor: '#093642',
    /** coast/shallows tint — mixed in by shallowTintStrength (seabed-depth
     *  input pending islands T20; keep 0 on open ocean) */
    shallowColor: '#1a8a8a',
    /**
     * §V24 shallows tint. Live now that islands ship a seabed field — the
     * factor is 0 in open water, so this only ever fires near a shore. This
     * is the LEGITIMATE bright-turquoise path (user: acceptable "on a shore")
     * as opposed to §B.12's sun-independent ambient glow.
     */
    shallowTintStrength: 0.6,
    /** water depth (m) at which the shallow tint is fully gone */
    shallowFullDepth: 18,
    /** world-space wavelength (m) of the largest body-variation octave */
    variationScale: 900,
    /**
     * ±brightness ripple on the body colour, NO hue shift (user rule): a
     * second tone at this scale reads as cow-pattern blotches on open ocean.
     * Keep it under ~0.08 — perceivable as a shape means too strong.
     */
    variationStrength: 0.05,
    sssColor: '#32d0c0',
    sssStrength: 2.3,
    /**
     * HARD CEILING on the backscatter lobe (§V.44 bounded at source). The lobe
     * is keyed on view·sun, so facing a low sun it covers the whole visible
     * sea at once. As an unbounded add it hit ~40x the lit body luminance in a
     * saturated cyan — rotating the camera restaged the scene. It is now a MIX
     * capped here, so the sea can take the scatter colour but never exceed it,
     * at ANY sun elevation. Raising this past ~0.6 re-opens that bug.
     */
    sssMaxMix: 0.45,
    /** brightness of the transmitted-light colour the lobe mixes toward */
    sssBrightness: 0.55,
    sssPower: 4.0,
    /** baseline crest glow independent of sun alignment — crests always read
     *  translucent (§V20), the backlight term only amplifies toward the sun */
    sssAmbient: 0.08,
    /** horizontal-displacement mask scale for the SSS side-of-wave isolation (§V.5) */
    sssChoppyScale: 0.9,

    // ── turbulent sub-noise on wave faces (user, SoT storm reference) ────
    /**
     * Churn perturbation added to the surface SLOPE, not the mesh: this
     * detail is far below vertex spacing (~1 m at the ship), so geometry
     * cannot carry it at any LOD — only the normal can. Six non-commensurate
     * animated wavelets, gated to wave FACES by local slope, because the
     * reference shows roughened flanks and comparatively calm troughs, and
     * phase-warped by the swell's own slope so they never read as a lattice
     * (see `microDetailWarp`).
     */
    microDetailStrength: 0.35,
    /** base wavelength (m) of the churn — the coarsest of the six wavelets */
    microDetailScale: 2.4,
    /** how fast the churn boils (rad/s on the base wavelet) */
    microDetailSpeed: 1.1,
    /** slope magnitude at which the churn reaches full strength */
    microDetailSlopeGate: 0.35,
    /**
     * PIXELS PER WAVELENGTH at which a churn wavelet is still at full
     * strength. It fades from here down to 2 (Nyquist, a math constant, not a
     * knob) measured against `fwidth(worldXZ)`.
     *
     * §V.48, tenth and eleventh occurrences, both in the one expression this
     * replaces (`microFade = lodWeight(microDetailScale, …)`):
     *
     *  - WRONG QUANTITY. `lodWeight` measures VERTEX spacing, `coreSpacing +
     *    k·camDist` — camera distance only. This is a fragment-stage
     *    procedural term and `pixWorld`'s own docstring, twelve lines above
     *    it, already warns that distance is not a substitute because a grazing
     *    view stretches the footprint by 1/sin(θ). The §T.39 sunset framing is
     *    grazing almost everywhere, which is where the user sees it.
     *  - WRONG FEATURE. It gated the whole four-wavelet stack against
     *    `microDetailScale` = 2.4 m. The wavelets run at frequency multipliers
     *    1.0 / 1.618 / 2.414 / 3.732, so the sharpest is λ = 0.643 m — and
     *    because slope goes as k, that wavelet carries 3.73× MORE SLOPE than
     *    the base it was being gated by. §V.48's own rule (measure against the
     *    sharpest FEATURE, never the REPEAT), and §B.20's caulk seam and
     *    §B.33's crackle octave for the third and fourth time.
     *
     * Measured on the shipped grid (coreSpacing 0.5, segments 512,
     * lodSamplesFull/Cut 9/4.5, normalDetailStretch 3.0 ⟹ spacing ≈ 0.5 +
     * 0.02·r): the old gate held full strength to ~15 m and reached zero at
     * ~55 m of CAMERA DISTANCE, while at a grazing framing the 0.643 m wavelet
     * is already sub-pixel around 40 m. Combined churn slope RMS at full gate
     * is ~0.21, about 12° of normal wobble — the fibrous foreground noise on
     * the wave flanks.
     *
     * 4 = two samples per half-wavelength. Below 3 the finest wavelet visibly
     * crawls; above ~6 the churn is thrown away while it is still resolvable
     * and the near sea reads flat, which is the failure the churn exists to
     * fix. What each wavelet loses is not discarded — it is handed to
     * `slopeVarianceAa` as roughness (§V.48b).
     */
    microDetailSamplesFull: 4,
    /**
     * METRES of phase warp per unit of swell slope. THE ANTI-LATTICE TERM, and
     * the only thing in this block that is structural rather than a fade.
     *
     * The churn is a sum of cosine PLANE WAVES, and one plane wave is an
     * infinite family of straight parallel stripes wherever it is evaluated.
     * Measured on the shipped build (top-down, calm, sim frozen, churn isolated
     * by differencing a churn-on and a churn-off render of the same tick): the
     * churn's own contribution carried spectral spikes 1220× and 308× above its
     * local background at λ 0.623 m / heading (−0.799,−0.602) and λ 0.978 m /
     * (0.707,−0.707) — the 3.732× and 2.414× wavelets exactly, 0.0° of
     * direction error. That is the "very regular grid" the user reported twice,
     * and neither the per-wavelet Nyquist gate nor `microReach` could touch it:
     * a fade shrinks the AREA a lattice covers, it does not stop it being one
     * (§B.33, where four foam lattices needed the same lesson).
     *
     * So the wavelets are evaluated at `worldXZ + warp·(noise + swellSlope)`
     * instead of at `worldXZ`. The coordinate their stripes are straight in is
     * itself bent by a field with no period, so the stripes wander instead of
     * running to infinity. See `microDetailWarpScale` for why the field's own
     * scale is the load-bearing part.
     *
     * WHAT SETS THE VALUE: phase excursion, not appearance. A warp of A metres
     * along a wavelet's own direction shifts its phase by 2π·A/λ, and ≳ 2 rad
     * on the SHARPEST wavelet is what turns a spike into a band. 1.0 m gives
     * 9.8 rad on the 0.643 m wavelet and 2.6 rad on the 2.4 m one — the fine
     * wavelets, which are the ones that were visible, get the most smear, which
     * is the right way round. 0 restores the lattice exactly, which is the A/B.
     *
     * IT IS ALSO A BAND-LIMIT INPUT, not free: the warped coordinate has
     * Jacobian I + ∇W, so it can locally COMPRESS a wavelength. The material
     * divides every wavelet's λ by (1 + |∇W|) before gating it, with |∇W|
     * computed from this value and `microDetailWarpScale` rather than baked —
     * raising either without that term would walk the churn straight back into
     * §V.48.
     */
    microDetailWarp: 1.0,
    /**
     * WORLD SCALE (m) of the anti-lattice warp field's coarsest octave.
     *
     * THE SCALE IS THE DESIGN, not a refinement of it. Measured: warping by the
     * swell slope alone — which lives at λ ≥ 8.3 m (§V.19) — moved the churn's
     * lattice spike from 344× to 287× above background, i.e. did nothing,
     * because over the 12 m patch being judged that field is a near-constant
     * TRANSLATION and translating a lattice leaves a lattice. A warp only smears
     * a spectral spike if it varies over a few wavelengths of what it bends, so
     * this must stay within roughly 3-10× the churn's own `microDetailScale`.
     * Much smaller and the warp becomes a second high-frequency term with its
     * own aliasing; much larger and it stops working at all.
     *
     * It is also the cheaper half of the band-limit trade. |∇W| goes as
     * warp/scale, so widening the field buys the same phase excursion for less
     * frequency compression: measured at equal warp = 1.0, scale 5 → residual
     * lattice 117 and a 0.363 squeeze on every wavelet's gate, scale 8 → 85 and
     * 0.446. 8 is that measurement, not a guess.
     */
    microDetailWarpScale: 8.0,
    /**
     * Floor of the ambient crest glow when NOTHING is backlighting it — i.e.
     * how much of the crest translucency is skylight rather than sun. 0 =
     * fully sun-gated (§B.12's fix), 1 = the sun-independent slug that caused
     * it. Kept low so flat light stays honest, but NOT zero: the SoT storm
     * reference shows crests lit through under a dark overcast sky.
     */
    sssSkylightFloor: 0.15,
    /**
     * Cap on the sea-state boost applied to that skylight floor. Taller seas
     * mean thinner, steeper, more translucent crests, so storm water reads
     * MORE luminous through the crests, not less (user, from the SoT storm
     * shot). 1 = no boost.
     */
    stormGlowMax: 2.2,
    /**
     * Reference RMS surface elevation (m) the boost is measured against —
     * the shipped swell sea. At or below this, storm terms are inert.
     */
    seaRmsReference: 0.7,
    /**
     * Crest band for the ambient glow, in units of RMS surface elevation σ
     * (NOT metres — an absolute gate changes meaning whenever the sea state
     * changes and repainted the ocean in turquoise blobs, §B). 1.6σ..2.6σ is
     * the top ~5%..0.5% of the surface: actual crest tops.
     */
    crestBandLow: 1.6,
    crestBandHigh: 2.6,
    /** body value lift band, also in σ — troughs darker, crests lighter */
    bodyBandLow: -1.7,
    bodyBandHigh: 2.3,
    /**
     * Authored sky gradient, horizon → zenith. NO LONGER the reflected sky:
     * that is `skyDomeColor(reflectionRay)` now, straight from the sky system
     * (see the skySunGlow note below). What is left for this pair is the
     * SNELL'S-WINDOW disc seen from UNDER the surface (§V.25) and the
     * fallback for a build with no sky wired. Their day-cycle colour comes
     * from the live haze below, so there is still no second set of sunset
     * constants to keep in sync.
     */
    skyHorizonColor: '#a8d4e8',
    skyZenithColor: '#4694cc',
    /**
     * 0..1 how strongly the reflected sky follows the LIVE sky. The ocean used
     * to reflect these constants while sky, fog and ambient all warmed off the
     * shared palette — a cold mint sea under a fully amber sunset sky. 1 =
     * fully unified through the whole day cycle.
     */
    skyFollowStrength: 1.0,
    /**
     * The haze colour the authored gradient above was picked against (the sky
     * rig's midday horizon blend). The live haze is divided by this to get a
     * day-cycle tint, so at midday the tint is 1 and the authored look is
     * untouched; at sunset it carries the same warm shift the sky took.
     */
    skyReferenceHaze: '#99def9',
    /**
     * Ceiling on that tint so a blown-out sky cannot blow out the water. 3.2
     * clears the measured sunset shift (#fdb669 / #99def9 needs 3.11 on red)
     * — at 2.5 the cap was binding and quietly under-warming the sea.
     */
    skyTintMax: 3.2,
    /**
     * Water's normal-incidence reflectance (Schlick R0). 0.02 is the real
     * value; the sea reflects ~2% looking straight down and ~100% at grazing.
     */
    fresnelR0: 0.02,
    /**
     * Artistic TRIM on that physical reflectance — not a cap. It was 0.13 used
     * as a hard cap, which meant the sea could never show more than 13% sky:
     * roughly right at midday from above, badly wrong at grazing, and a sunset
     * frame is entirely grazing. 1.0 = physically correct.
     */
    reflectionStrength: 1.0,
    /**
     * §V.56 lever 1 — re-saturation of the reflected sky toward the water's own
     * hue, RAMPED WITH DISTANCE (0 = raw Fresnel wash, reads grey; 1 = full
     * pigment). One constant could not serve both ends of the frame:
     *  - NEAR: 0.15. Close water shows its body through the surface (§V.24), so
     *    the pigment is there whatever the reflection does. This was cut from
     *    0.55 because the near sea read as over-saturated teal, and that
     *    complaint has not returned — so it stays low.
     *  - FAR: distant water is ENTIRELY grazing. Schlick → 1, nothing
     *    transmits, the pixel is nothing but reflected sky, and at 0.15 it
     *    greys out (user: "the water at distance still has a very high
     *    tendency to get grey and washed out"). 0.55 hands the pigment back
     *    exactly where there is no other source of it.
     * It is a HUMP, not a rising ramp: past `hazeStart` the term is scaled by
     * (1 − hazeT), because a pixel that has melted into the distance haze is
     * ATMOSPHERE and re-tinting it toward the sea's body colour is what made
     * the horizon "completely drown in solid turquoise" (user, 3rd report on
     * this axis). So the window this governs is roughly 150–900 m — the
     * mid-field — and it hands over to the sky beyond that.
     *
     * `Far` was 0.55 for one round and was cut to 0.28 because "the whole
     * distance band converged on ONE hue… a flat fill, not water" — AND THAT
     * VERDICT WAS REACHED AGAINST A SURFACE THAT NO LONGER EXISTS. Read the
     * reasoning it was written with: "everything that varies out there
     * (normals, sparkle, foam, the mirror) has already been faded out by
     * §V.48". That was literally true — the normal LOD deleted every cascade
     * by 365 m, so the far field had a measured slope RMS of EXACTLY ZERO and
     * re-saturating a perfect mirror could only ever produce a flat fill. With
     * the LOD measured against each band's own content instead of its texel
     * size, the same distances now carry 59% (300 m), 31% (500 m) and 28%
     * (700 m) of the sea's true slope RMS, so there is real variation for the
     * re-saturation to ride and the objection that killed 0.55 no longer
     * applies.
     *
     * 0.28 → 0.46. MEASURED on the neutral-overcast worst case, composite
     * chroma against a body chroma of 0.857:
     *     Far   300 m   400 m   700 m
     *     0.28  0.242   0.258   0.258      ← the user's "overpowered by sky"
     *     0.40  0.305   0.346   0.358
     *     0.46  ~0.33   ~0.38   ~0.40
     *     0.50  0.357   0.419   0.441
     * Deliberately short of the 0.55 that failed, because that failure was
     * about VARIATION and only some of the variation is back.
     *
     * WHY THIS LEVER AND NOT THE FLOOR BELOW: the floor is INERT out here.
     * Measured, raising `pigmentFloorChroma` 0.14 → 0.26 moves the 400 m
     * composite by 0.0001 — the pixel is at chroma 0.26, comfortably above the
     * floor, so the floor never fires. The sea is not grey by the metric; it
     * is 81% reflected sky BY WEIGHT (mean Fresnel 0.81 at 400 m, and only
     * 0.837 → 0.809 from restoring the geometry, because at a 2° grazing angle
     * Schlick has saturated and roughness adds VARIANCE without moving the
     * MEAN). That is why the geometry fix visibly fixed the structure and did
     * almost nothing to the tint: they are different quantities.
     * If the user's "overpowered" turns out to mean VALUE rather than hue, the
     * knob is `reflectionStrength` instead — measured 1.0 → 0.8 takes the same
     * 400 m composite to 0.331. NEEDS THE BROWSER to choose between them.
     * CPU transliteration: src/ocean/seaChroma.ts `grazingSaturationAt`.
     */
    grazingSaturation: 0.15,
    grazingSaturationFar: 0.46,
    grazingSaturationFullDist: 500,
    /**
     * §V.56 lever 2 — THE FLOOR ITSELF, and the material's one named
     * stylisation. Minimum HSV chroma ((max−min)/max) the composited water may
     * have; below it the pixel is pulled back toward the body hue, above it
     * nothing happens at all. Applied to the SUM of every term and gated by
     * (1 − foam), because breaking foam is allowed to read white — it is the
     * disturbed water between the caps that must not go grey.
     * 0 disables it entirely and hands the frame back to raw physics.
     * Also scaled by (1 − hazeT): a floor that fires on the horizon haze
     * repaints the whole band in the water's hue, which is half of the
     * "solid turquoise" report — warm low-chroma haze is a legitimately lit
     * ATMOSPHERE, not a grey wash. 0.22 was that mistake; at 0.14 it catches
     * only genuinely neutral pixels, which is all it was ever for.
     * Do not raise past ~0.35 or genuinely pale water (fog banks, thin
     * shallows over sand) starts reading as tinted. CPU pair:
     * seaChroma.pigmentFloor, swept in tests/ocean.test.ts "§V.56".
     */
    pigmentFloorChroma: 0.14,
    pigmentFloorStrength: 1.0,
    /**
     * Sun-elevation gate (sunDir.y) for every sun-driven water term. Below
     * `low` there is no direct sun at all; above `high` the terms are at full
     * strength. Keep `high` LOW — a horizon-kissing sunset is the money shot
     * (§T.39) and the old 0.02→0.06 ramp started fading the water's sun at
     * 3.4°, i.e. right where golden hour lives. 0.005→0.02 is 0.3°→1.1°.
     */
    sunHorizonFadeLow: 0.005,
    sunHorizonFadeHigh: 0.02,
    /**
     * Stylized lighting (§V20 — the material owns light, PBR washed the
     * pigment gray). TWO sources, deliberately separate:
     *   floor = SKYLIGHT: whole-dome, sky-coloured, shadow-independent
     *   gain  = SUNLIGHT: directional N·L, cut by the shadow map, sun-tinted
     * Both were sun-tinted before, which made water facing away from the sun
     * read as dim sunlight instead of sky-lit water.
     */
    lightFloor: 0.62,
    /** raised from 0.45: N·L contrast is what makes a sea look 3D and lit
     *  from ANY camera angle (user: rotating away looked like lights-out) */
    lightGain: 0.62,
    sunTint: '#fff2dc',
    /**
     * How far the skylight colour is pulled toward its own luminance before
     * being used as LIGHT. A sky colour picked to look right when painted is
     * not the colour that sky delivers (sky agent's ambient rework).
     */
    skylightDesaturation: 0.5,
    /**
     * Sunlight that entered the water, scattered, and left again — carried in
     * the water's own pigment (sssColor) and keyed to N·L ONLY, so it is
     * fully view-independent. This is the term that keeps the sea looking
     * sunlit when the camera turns away from the sun; the glint road stays
     * view-dependent and still vanishes, which is correct.
     */
    sunScatterStrength: 0.22,
    /** >1 tightens the scatter toward faces squarely facing the sun */
    sunScatterPower: 1.5,
    /**
     * REMOVED, deliberately — do not re-add here. The sky's halo AROUND the
     * sun used to be a second, ocean-owned lobe added on top of an
     * elevation-only reflected-sky ramp: it could only ever ADD warmth toward
     * the sun and never cool the anti-solar side, which is the user's "the
     * ocean takes on too much of the sunlight colour all around". The
     * reflected sky is now `skyDomeColor(reflectionRay)` from
     * src/sky/skyBackground.ts — the SAME function `scene.backgroundNode`
     * uses — so the halo, the horizon haze wedge and the golden-hour warmth
     * all arrive with their real azimuth, from one implementation. Its knobs
     * are `sunHazeStrength` / `horizonWarm*` in params/sky.ts.
     */
    /**
     * WATER-ONLY TRIM on the scene-wide shadow darkness, multiplied on top of
     * `skyParams.shadowIntensity` (§V.33 — that is the single owner now, and
     * the shared shadow node has already applied it by the time this sees it).
     * 1 = take the scene's shadow exactly as every other surface does.
     *
     * It was 0.85 while the rest of the scene ran at three's default 1.0, so a
     * ship shadow crossing the waterline stepped 15% lighter as it left the
     * beach — the seam this feature exists to make beautiful. The 0.85 moved to
     * skyParams and the water is unchanged; this stays as a trim because the
     * water is the one surface with a standing §V.20 look bar, but drive it
     * from 1 and only reach for it if the water specifically needs to differ.
     */
    shadowStrength: 1.0,
    /** build the in-material sun-shadow sample at all (reload to apply) —
     *  kill switch for the shadow node, separate from shadowStrength which
     *  only scales an already-compiled sample */
    shadowsEnabled: true,

    // ── sparkle / glint train (§V20 "dense sun sparkle glints") ─────────
    sparkleStrength: 1.0,
    /** sparkle hash cells per meter — legacy world-locked density, superseded
     *  by the angular sizing below (kept: other tuning refers to it) */
    sparkleScale: 18.0,
    /**
     * Sparkle cell size in PIXELS — the hash lattice is sized from the pixel's
     * own world footprint (`fwidth(worldXZ)`), so a cell stays this many
     * pixels across at every distance AND every view angle (§V.48). The
     * previous distance × view-angle estimate is only correct looking straight
     * down: at a grazing framing the footprint is stretched by 1/sin(grazing)
     * and the cells went sub-pixel again, which is the stipple the user still
     * saw from a low camera. Below ~2 the on/off threshold aliases; above ~4
     * the cells read as visible blocks.
     */
    sparkleCellPixels: 2.6,
    /** floor on cell size (m) — §V28, keeps the hash divisor away from zero */
    sparkleMinCell: 0.004,
    /**
     * Drawn radius of ONE glint, in pixels.
     *
     * §V.48b, and the user's "sparkles are little squares" report. The old
     * term lit the WHOLE HASH CELL — `smoothstep(thr, thr + 0.012, hash)` on
     * one hash per cell, a 0.012-wide transition on a uniform hash, i.e. a
     * binary on/off over a world-locked axis-aligned square. At the
     * `sparkleCellPixels` 2.6 target the octave quantisation puts the cell
     * anywhere in 1.3–2.6 px, so the artifact is a ~2 px axis-aligned white
     * block (the screenshot) at the coarse end and a PER-PIXEL RANDOM BINARY
     * FIELD at the fine end — carried by `normFade` all the way to 4.2 km,
     * which is a large share of the distance noise as well as the squares.
     * The two user reports are substantially one defect.
     *
     * A glint is a point, so it is now drawn as a point: hashed to a position
     * INSIDE its cell and given a radial falloff of this radius. Sized in
     * pixels against `pixWorld`, so it satisfies §V.48 by construction rather
     * than by a distance fade.
     *
     * ~0.8 keeps it round and just resolvable. Below ~0.5 it is a single pixel
     * again and aliases exactly as before; above ~1.5 the glints read as soft
     * blobs and the sun path loses its glitter.
     */
    sparkleRadiusPixels: 0.8,
    /**
     * Cell/radius ratio at which individual glints become DISTINGUISHABLE.
     * Below it the field fades to its own MEAN and above 2× it the glints are
     * drawn discretely; between, the two are crossfaded.
     *
     * This is §V.48b's second half and the half that is easy to omit. Placing
     * a round point instead of filling a square fixes the SHAPE, but a cell
     * that has shrunk to the size of its own glint is still a per-cell binary
     * lottery — the same coin flip in a different outline. So as the cell
     * stops being able to hold a distinguishable point, BOTH binary terms fade
     * to their expectations: the disc to its coverage (≈ ½πr²/c², the mean a
     * pixel should have seen) and the on/off hash to its probability (1 − thr).
     * Energy is preserved across the whole transition, so the sun path keeps
     * its brightness and simply stops being made of dots — detail is converted,
     * never removed.
     *
     * 2.0 with the shipped 1.3–2.6 px cells and 0.8 px radius puts the
     * crossfade right where the octave quantisation lands, which is what it is
     * for.
     */
    sparkleResolveCells: 2.0,
    /**
     * §V.48 specular antialiasing (Kaplanyan, "filtering distributions of
     * normals"). Scales the screen-space normal variance σ² that widens every
     * specular lobe. A pow(N·H, 180) lobe point-sampled on a normal field that
     * swings through many wave faces inside one pixel is a coin flip per pixel
     * and boils under motion — the noise the user reports when zoomed out.
     * Widening the lobe by σ² and rescaling its peak by p'/p conserves energy,
     * so the glint road survives at full brightness while the isolated
     * pixel-sized sparkles are spread back into the average they should have
     * been. Turning specular DOWN instead would flatten the whole sea.
     *
     * 2.2 → 0, AND THE REASON IS THAT IT IS NOT A VARIANCE. It was measured at
     * the §T.39 SUNSET framing only, where the sea is grazing almost
     * everywhere; at the user's tod 15.0 deck framing it is what turned the sun
     * into a sheet.
     *
     * `dFdx(N)` over a footprint spanning many wavelengths is a finite
     * difference that saturates at the full normal swing whatever the
     * footprint. `specularAaMax`'s own table below measures it at σ² =
     * 0.41–2.56, against a sea whose ENTIRE mean square slope is 0.0273 — 15
     * to 94× too large. Since §V.75 it feeds the sun's Beckmann lobe as σ², so
     * it pinned the lobe at the sea's total slope variance at every pixel,
     * INCLUDING the near field where the shading normal already carries every
     * one of those facets geometrically. The sea's slope was counted twice.
     *
     * MEASURED (lagoon, tod 15.0, camera 8 m looking down-sun, one frame,
     * this uniform the only thing moved) — road radiance by ground distance,
     * evaluated from the shipped expressions:
     *
     *   σ² pinned at 0.0273    8m 0.18  20m 0.18  50m 0.084  150m 0.050
     *                          300m 0.043  3km 0.037     ← never reaches zero
     *   σ² = Cox-Munk 0.003    8m 1.50  12m 0.27  20m 0.000  and beyond
     *
     * The pinned lobe is not a road: it is a flat 0.04–0.22 pedestal of
     * sunlight over the whole sea to the horizon, because Smith's 1/(N·V) grows
     * at grazing at nearly the rate Beckmann's exponential decays. An
     * angularly unselective sheen over everything IS "plastic", and laid over a
     * body measured at warmth (r−b)/max = −0.78 it reads as the bright blue
     * glare the user photographed. In the browser the same toggle turns the
     * pale wash into a compact bright glitter patch on a deep-teal sea.
     *
     * At 0 the lobe's σ² is exactly `slopeVarianceAa` × the spectral
     * `unresolvedVar` — the slope this pixel genuinely cannot resolve, which is
     * what a microfacet σ² is defined to be, and which §V.48b already computes
     * exactly from the Tessendorf spectrum at zero fetches.
     *
     * §Rule 8 — WHAT IS NOT VERIFIED. This estimator's original job was to stop
     * the lobe boiling under motion, and every capture behind this number is a
     * STILL. If the near-field glitter sizzles in motion, the answer is NOT to
     * put this back (it re-opens the sheet) but to widen `slopeVarianceAa` or
     * to give the churn its own analytic variance floor. The knob is left in
     * place, not deleted, so the old behaviour is one number away.
     */
    specularAaStrength: 0,
    /**
     * Cap on that variance (§V.44 bounded at source). Also the floor on lobe
     * width: p' ≥ p/(1 + p·max), so the horizon band cannot collapse to a
     * uniform sheen.
     *
     * 0.35 → 1.0. MEASURED: the cap, not the strength, is what limits the
     * correction, and it starts binding at a ~0.13 m footprint (≈50 m out at a
     * follow-camera framing) — so the AA gets WEAKER the further out you look,
     * which is backwards. Half-width of the old `pow(N·H, 180)` glint lobe, in
     * pixels, against the sea's measured curvature RMS of 1.66/m:
     *     footprint  raw    with cap 0.35   needed
     *       0.05 m   0.05   0.30 px         1 px  (σ² 0.12, cap not binding)
     *       0.15 m   0.02   0.71 px         1 px  (σ² 0.41, cap binding)
     *       0.50 m   0.00   0.26 px         1 px  (σ² 2.56, cap hard-binding)
     * i.e. every specular lobe on this surface is between 1/50 and 1/4 of a
     * pixel wide and the filter is capped before it can fix it. That is the
     * user's jagged crest highlights, and MSAA cannot see it — there is no
     * geometric edge, only a shading one.
     * 1.0 is a compromise, not the answer the maths gives (2.6 at 0.5 m): the
     * lobe is energy-conserving, so a bigger cap spreads the glint road into
     * the broad sheen it physically becomes at that footprint, and the road is
     * a hero feature (§T.39). NEEDS THE BROWSER to pick the final number —
     * this is one uniform and it moves live in the panel.
     */
    specularAaMax: 1.0,
    /**
     * Gain on the ANALYTIC sub-pixel slope variance — the §V.48b half that was
     * missing, and the reason the screen-space σ² above could never finish the
     * job however hard it was tuned.
     *
     * `normLod` fades each cascade's normals out where the spectrum says that
     * band has stopped being resolvable. Fading to zero is the correct MEAN (a
     * zero-mean slope field averages to flat) but the VARIANCE it removes was
     * simply discarded, so the far sea became a MIRROR rather than a rough
     * surface: the normLod docstring's own measurement is shading slope RMS
     * 59% at 53 m, 31% at 130 m and EXACTLY ZERO past 365 m — half a kilometre
     * of perfect mirror before the haze starts at 900 m. A mirror at grazing
     * incidence is maximally sensitive to whatever residual normal survives,
     * which is the "really really noisy in the distance" report arriving as an
     * absence of detail rather than an excess of it.
     *
     * `specularAaStrength` cannot see any of this. It estimates σ² from
     * `dFdx(normalWorld)`, i.e. from the normal that SURVIVED the LOD, so the
     * band the LOD already deleted is invisible to it BY CONSTRUCTION. The two
     * estimators are disjoint and are added, not blended.
     *
     * Reconstructed as Σ (1 − lod_i·normFade)·σ²_i from the cascades' own
     * binned slope spectrum (`OceanCascade.slopeVariance`), plus the churn
     * wavelets' own faded-out variance. Costs ZERO textures and ZERO samplers
     * (§V.40) — it is three scalar uniforms and a dot product — and it is an
     * exact spectral quantity rather than a one-sample screen estimate, so
     * unlike the dFdx term the widening it produces does not itself flicker.
     *
     * The user's constraint is the point of this parameter: the distant
     * structure they worked for is not blurred away, it is converted into lobe
     * WIDTH. Where slope goes sub-pixel the specular broadens instead of the
     * surface flattening, so the sea keeps reading as textured and stops
     * reading as a coin flip.
     *
     * 1.0 = take the spectrum at face value. NEEDS THE BROWSER for the final
     * number; the units match the dFdx term only to first order (for small
     * slopes δn ≈ δs), so this is the calibration knob between them. It shares
     * `specularAaMax` as its cap, so §V.44 boundedness is unchanged.
     */
    slopeVarianceAa: 1.0,
    /** specular tightness of an individual glint */
    sparklePower: 40,
    /** tightness of the glint-train footprint (the sun path on the water) */
    glintTrainPower: 24,
    /** hash-density thresholds outside / inside the sun path (1 = none) */
    sparkleDensityBase: 0.985,
    sparkleDensityTrain: 0.82,
    /**
     * §V.75 THE SUN'S REFLECTED RADIANCE, as a multiple of the energy-correct
     * value. 1.0 = physical: the glint lobe integrates to the sun's own
     * irradiance as this material already states it in its diffuse term
     * (`sunTint · lightGain`), spread by the Beckmann/Cox-Munk slope
     * distribution the sim measures. See the sun-glint block in
     * `surfaceMaterial.ts` for the derivation and for the measurement that
     * forced it.
     *
     * It was 0.55 against a lobe whose peak was ALSO divided by its own
     * widening factor (~180 at the sunset framing), so the sun's brightest
     * possible contribution to this water was 0.003 against a sky reflection of
     * ~0.1 — the sun was 4% of the sea's light and the sky 70%, measured, and
     * the sea came out 22% brighter facing AWAY from the sun. There is no
     * setting of a number like that which produces a golden cone; the lobe had
     * to become an energy, which is what this now scales.
     *
     * Turn it DOWN, never up, and only for look: above 1 the road is brighter
     * than the sun physically puts there.
     *
     * `glintRoadPower` was deleted with the same change. Lobe width is σ²'s
     * job — an independent exponent is how the road's shape and the sea's
     * actual roughness came to disagree in the first place, and re-adding one
     * re-opens exactly that.
     */
    // 0.75 (§B89): the user called the sun "pretty convincing… maybe a tad too
    // much on the rays on the water towards the sun". Measured on a 1080p
    // capture at tod 17.9: 8.0% of the road band clipped white (L>=250) against
    // 0.0% off-road on the same rows. The cause is §V92's representative-point
    // normalisation `srcEnergy`, which its own docstring measures at 1.4-3.5x
    // at 1-5 deg elevation — it over-delivers at exactly this hour. This scales
    // radiance only: lobe width, the apex bar and §T.110's behaviour are
    // untouched, which is what the user endorsed.
    glintRoadStrength: 0.75,
    /** sparkles fade out as the view leaves grazing angles (starfield guard):
     *  full below grazeFadeStart, gone above grazeFadeEnd (viewDir.y) */
    sparkleGrazeStart: 0.72,
    sparkleGrazeEnd: 0.95,

    /**
     * Far-field foam compositing cap. Foam detail itself is faded by the foam
     * system in crackle-feature widths; this is the compositing-side guard,
     * scaled by the SAME haze ramp, so the horizon band cannot composite to
     * pure white when a pixel covers thousands of foam texels at a grazing
     * angle. 1 = no damping.
     */
    foamFarDamp: 0.55,
    /** temporary direct-jacobian crest foam until T5 progressive blur lands */
    foamThreshold: 0.55,
    foamColor: '#eef6f2',
    /**
     * The WAKE's own foam colour — aerated water alongside a wooden hull, not a
     * breaking whitecap. Sharing `foamColor` was wrong twice over: a ship's
     * churned track is greener and much darker than sea-spray white, and at
     * luminance 0.905 the wake sat within a few percent of the bloom threshold
     * at every sky colour (measured: exposure 1.1 puts the scene-linear
     * crossing at 0.909 while the wake spans 0.63–1.18 depending on how the sky
     * rig has tinted the haze that frame). That is the mechanism behind
     * "depending on the sun angle it's too much" — which side of the bloom knee
     * the wake lands on was being decided by the sky.
     */
    wakeFoamColor: '#b9ccc4',
    /**
     * Optical depth of the wake's aerated layer. The wake mask was compositing
     * through a hard alpha, so every texel above the dissolve gate reached full
     * opacity and the whole track rendered as one flat sheet with holes punched
     * in it (docs/bugs/bug-wake-solid-white.png). Same defect the sim foam had
     * and the same cure: alpha = 1 − e^(−density·coverage) never saturates, so
     * coverage keeps modulating brightness all the way up instead of clipping.
     * ~1.6 puts full coverage at 0.80 alpha and half coverage at 0.55, i.e. a
     * real gradient across the range the wake actually occupies.
     */
    wakeFoamDepth: 1.6,
    /** how far foam takes the sky's colour — the reference's foam is warm
     *  cream, ours is authored cool near-white and reads wrong at sunset */
    foamSkyTint: 0.35,

    // ── distance haze (§V30: this replaces scene fog ON THE WATER) ──────
    /**
     * The water melts into haze between these radii (m).
     *
     * `hazeStart` 900 → 750 on the user's "we can bring in the start of the
     * haze a little bit earlier — the far view is great but it feels a little
     * bit excessive". A 17% earlier onset, deliberately small: this radius is
     * also where §V.56's `grazingSaturationFar` hump hands the far field over to
     * the sky (the re-saturation is scaled by 1 − hazeT), so moving it moves
     * where the sea stops taking its own pigment, and that lever cost two
     * rounds of "solid turquoise" to place.
     *
     * IT IS NOT COVER FOR §V.30b, and was checked rather than assumed: with the
     * radial LOD at 0.5 the far band's luminance change against LOD-off is
     * 24.3/255 at `hazeStart` 900 and 23.9/255 at 700 — i.e. haze moves the
     * seam by 2%, so it neither causes nor cures it. The two changes are
     * independent and this one is here because it was asked for.
     * NOT YET SIGNED OFF BY EYE (§V.22) — measured, not judged.
     */
    hazeStart: 750,
    hazeEnd: 4600,
    /** >1 keeps the mid-field clear and pushes the melt to the last stretch */
    hazeCurve: 1.7,
    /** haze cap at the rim — must be 1 or the disc edge shows against sky */
    hazeStrength: 1.0,
    /** 0..1 how much of the sun glint survives full haze */
    glintHazePenetration: 0.45,
    /** far cutoff for slope detail — beyond this the sea is glass under haze */
    normalFadeStart: 2200,
    normalFadeEnd: 4200,

    // ── §V.24 transparency ──────────────────────────────────────────────
    // §V.33 TRIPWIRE: `absorptionDensity` and `refractionTint` USED TO LIVE
    // HERE and are deliberately gone. §V.24's see-through path now reads the
    // per-channel Jerlov K_d from `causticsParams.submergedAbsorption{R,G,B}`,
    // which was already the single owner for the caustic, the submerged hull
    // and the underwater volume. The scalar density applied RED's coefficient
    // to blue and left the sea floor 12× too dark to see through its own
    // shallows; the flat teal tint was the depth-independent stand-in for the
    // curve that now does the job properly. There is one water — tune its
    // clarity in the CAUSTICS panel.
    /** refraction offset strength (screen-space) at full water thickness */
    refractionStrength: 0.06,
    /**
     * Water thickness (m) that earns the FULL refraction offset. Below it the
     * bend ramps to zero, so geometry touching the surface (hull at the
     * waterline, shoreline sand) is not smeared with pixels from the wrong
     * side of the water — a constant offset bends contact and deep seabed
     * equally hard, which read as a shimmering halo.
     */
    refractionDepthFull: 6,
    /**
     * §V.24 TRANSMISSION FLOOR. Fresnel splits energy between reflection and
     * transmission; it never deletes transmission. But a physical Schlick
     * weight (fresnelR0 above) reaches 1 at grazing incidence, and a mirror at
     * weight 1 erases the submerged geometry §V.24 requires to stay visible —
     * "opaque-wall water @ grazing/shallow view ⊥" is exactly that case, and
     * the reference the user linked states the rule as maintaining a
     * transmission channel REGARDLESS of incident angle.
     *
     * So the reflection weight is capped at 1 − this, but ONLY in proportion
     * to `seeThrough`, i.e. only where there is actually something submerged
     * behind the surface. Open water has nothing behind it (seeThrough → 0
     * through the Beer-Lambert term), so the grazing sunset sea keeps its full
     * physical mirror and the §T.39 look is untouched. 0 = pure Schlick (the
     * opaque wall returns); 0.45 = a submerged hull always keeps at least 45%
     * of the pixel.
     */
    transmissionFloor: 0.45,

    // ── underside (§V.24/§V.25: camera below the waterline) ─────────────
    /** total-internal-reflection ceiling colour seen outside Snell's window */
    underCeilingColor: '#0e5a5e',
    /**
     * ARTISTIC trim on the sky seen through Snell's window — and ONLY that.
     *
     * It used to be 1.15 and was carrying two jobs. The window drew a two-stop
     * elevation ramp with no n² radiance scaling anywhere in the tree, and 1.15
     * happened to land near the n² = 1.777 that was missing, so the CENTRE of
     * the window measured within 8% of correct while its rim was 3× too dark.
     * `WATER_RADIANCE_GAIN` in surfaceMaterial.ts now owns the physics, so this
     * is 1.0 = "the sky, as bright as the sky actually is from down here".
     */
    underWindowBrightness: 1.0,
    /** softness of the Snell window edge (cos units) */
    underWindowSoftness: 0.12,
  },
  {
    gridSegments: { min: 64, max: 1024, step: 64 },
    gridCoreSpacing: { min: 0.2, max: 4, step: 0.05 },
    gridHorizonRadius: { min: 500, max: 20000, step: 100 },
    gridRimRound: { min: 0, max: 1, step: 0.01 },
    radialLodPixels: { min: 0, max: 4, step: 0.05 },
    radialLodMinEye: { min: 1, max: 40, step: 0.5 },
    radialLodMorph: { min: 0, max: 4, step: 0.05 },
    radialLodMaxLevel: { min: 0, max: 5, step: 1 },
    lodSamplesFull: { min: 4, max: 32, step: 0.5 },
    lodSamplesCut: { min: 2, max: 24, step: 0.5 },
    normalDetailStretch: { min: 1, max: 8, step: 0.1 },
    normalKeepFull: { min: 0.5, max: 1, step: 0.01 },
    normalKeepCut: { min: 0, max: 0.9, step: 0.01 },
    sssStrength: { min: 0, max: 5, step: 0.05 },
    sssAmbient: { min: 0, max: 1, step: 0.01 },
    shallowTintStrength: { min: 0, max: 1, step: 0.01 },
    shallowFullDepth: { min: 1, max: 60, step: 0.5 },
    refractionDepthFull: { min: 0.2, max: 30, step: 0.1 },
    foamFarDamp: { min: 0, max: 1, step: 0.01 },
    variationScale: { min: 100, max: 4000, step: 10 },
    variationStrength: { min: 0, max: 0.25, step: 0.005 },
    reflectionStrength: { min: 0, max: 1, step: 0.01 },
    grazingSaturation: { min: 0, max: 1, step: 0.01 },
    grazingSaturationFar: { min: 0, max: 1, step: 0.01 },
    grazingSaturationFullDist: { min: 20, max: 4000, step: 10 },
    pigmentFloorChroma: { min: 0, max: 0.6, step: 0.01 },
    pigmentFloorStrength: { min: 0, max: 1, step: 0.01 },
    sssPower: { min: 0.5, max: 8, step: 0.1 },
    sssChoppyScale: { min: 0, max: 3, step: 0.05 },
    sssSkylightFloor: { min: 0, max: 1, step: 0.01 },
    stormGlowMax: { min: 1, max: 4, step: 0.05 },
    seaRmsReference: { min: 0.1, max: 5, step: 0.05 },
    microDetailStrength: { min: 0, max: 2, step: 0.01 },
    microDetailScale: { min: 0.3, max: 20, step: 0.1 },
    microDetailSpeed: { min: 0, max: 5, step: 0.05 },
    microDetailSlopeGate: { min: 0.02, max: 2, step: 0.01 },
    microDetailSamplesFull: { min: 2.5, max: 12, step: 0.1 },
    microDetailWarp: { min: 0, max: 3, step: 0.05 },
    microDetailWarpScale: { min: 1, max: 30, step: 0.5 },
    crestBandLow: { min: 0, max: 4, step: 0.05 },
    crestBandHigh: { min: 0.2, max: 6, step: 0.05 },
    bodyBandLow: { min: -4, max: 0, step: 0.05 },
    bodyBandHigh: { min: 0.2, max: 6, step: 0.05 },
    lightFloor: { min: 0, max: 1.5, step: 0.01 },
    lightGain: { min: 0, max: 2, step: 0.01 },
    skyFollowStrength: { min: 0, max: 1, step: 0.01 },
    skyTintMax: { min: 1, max: 6, step: 0.05 },
    sunHorizonFadeLow: { min: -0.05, max: 0.2, step: 0.001 },
    sunHorizonFadeHigh: { min: 0, max: 0.3, step: 0.001 },
    skylightDesaturation: { min: 0, max: 1, step: 0.01 },
    sunScatterStrength: { min: 0, max: 1.5, step: 0.01 },
    sunScatterPower: { min: 0.2, max: 8, step: 0.1 },
    shadowStrength: { min: 0, max: 1, step: 0.01 },
    sparkleStrength: { min: 0, max: 4, step: 0.05 },
    sparkleScale: { min: 2, max: 120, step: 1 },
    sparkleCellPixels: { min: 1, max: 8, step: 0.1 },
    sparkleMinCell: { min: 0.001, max: 0.5, step: 0.001 },
    sparkleRadiusPixels: { min: 0.3, max: 2.5, step: 0.05 },
    sparkleResolveCells: { min: 1, max: 6, step: 0.1 },
    specularAaStrength: { min: 0, max: 3, step: 0.01 },
    specularAaMax: { min: 0.01, max: 2, step: 0.01 },
    slopeVarianceAa: { min: 0, max: 4, step: 0.01 },
    sssMaxMix: { min: 0, max: 1, step: 0.01 },
    sssBrightness: { min: 0, max: 2, step: 0.01 },
    fresnelR0: { min: 0, max: 0.2, step: 0.005 },
    foamSkyTint: { min: 0, max: 1, step: 0.01 },
    wakeFoamDepth: { min: 0.2, max: 6, step: 0.05 },
    sparklePower: { min: 4, max: 256, step: 1 },
    glintTrainPower: { min: 1, max: 128, step: 1 },
    sparkleDensityBase: { min: 0.5, max: 1, step: 0.001 },
    sparkleDensityTrain: { min: 0.5, max: 1, step: 0.001 },
    glintRoadStrength: { min: 0, max: 3, step: 0.01 },
    sparkleGrazeStart: { min: 0, max: 1, step: 0.01 },
    sparkleGrazeEnd: { min: 0, max: 1.5, step: 0.01 },
    foamThreshold: { min: -1, max: 1.5, step: 0.01 },
    hazeStart: { min: 50, max: 8000, step: 10 },
    hazeEnd: { min: 200, max: 20000, step: 50 },
    hazeCurve: { min: 0.5, max: 4, step: 0.05 },
    hazeStrength: { min: 0, max: 1, step: 0.01 },
    glintHazePenetration: { min: 0, max: 1, step: 0.01 },
    normalFadeStart: { min: 50, max: 8000, step: 10 },
    normalFadeEnd: { min: 100, max: 20000, step: 50 },
    refractionStrength: { min: 0, max: 0.3, step: 0.005 },
    transmissionFloor: { min: 0, max: 0.9, step: 0.01 },
    underWindowBrightness: { min: 0, max: 3, step: 0.01 },
    underWindowSoftness: { min: 0.01, max: 0.5, step: 0.01 },
  },
);
