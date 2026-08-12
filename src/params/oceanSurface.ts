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
     * §V.48 filtered tier for the cascade NORMALS, measured in "how many of
     * this cascade's texels does one pixel cover". The derivative textures are
     * compute-written StorageTextures and cannot carry a mip chain, so a
     * minified fetch is a point sample of a zero-mean slope field — per-pixel
     * noise, which the pow(N·H,180) glint then amplifies into the fibrous
     * golden hair covering the whole sea when zoomed out (user).
     * Full strength while a pixel covers ≤ `Full` texels, gone by `Cut`. The
     * next coarser cascade, still resolved, carries the large-scale shading —
     * the cascade pyramid IS the mip chain here.
     *
     * Tuned in-browser at the §T.39 sunset framing: 0.65/2.2 killed the noise
     * completely but took the mid-field with it — the sea went to smooth mush
     * and the glint road washed out, because a pixel covers ~2 texels of even
     * the 420 m cascade by 200 m out. 1.0/3.5 keeps the wave texture and
     * leaves the residual highlight chatter to `specularAaStrength`, which is
     * the term that is actually supposed to handle it.
     */
    normalTexelFull: 1.0,
    normalTexelCut: 3.5,

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
     * cannot carry it at any LOD — only the normal can. Four non-commensurate
     * animated wavelets, gated to wave FACES by local slope, because the
     * reference shows roughened flanks and comparatively calm troughs.
     */
    microDetailStrength: 0.35,
    /** base wavelength (m) of the churn — the coarsest of the four wavelets */
    microDetailScale: 2.4,
    /** how fast the churn boils (rad/s on the base wavelet) */
    microDetailSpeed: 1.1,
    /** slope magnitude at which the churn reaches full strength */
    microDetailSlopeGate: 0.35,
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
     * The ramp reaches `Far` at `FullDist` metres. Beyond ~900 m the distance
     * haze takes over anyway (hazeStart), so the window this actually governs
     * is roughly 150–900 m — the mid-field the user is describing.
     * CPU transliteration: src/ocean/seaChroma.ts `grazingSaturationAt`.
     */
    grazingSaturation: 0.15,
    grazingSaturationFar: 0.55,
    grazingSaturationFullDist: 500,
    /**
     * §V.56 lever 2 — THE FLOOR ITSELF, and the material's one named
     * stylisation. Minimum HSV chroma ((max−min)/max) the composited water may
     * have; below it the pixel is pulled back toward the body hue, above it
     * nothing happens at all. Applied to the SUM of every term and gated by
     * (1 − foam), because breaking foam is allowed to read white — it is the
     * disturbed water between the caps that must not go grey.
     * 0 disables it entirely and hands the frame back to raw physics.
     * Do not raise past ~0.35 or genuinely pale water (fog banks, thin
     * shallows over sand) starts reading as tinted. CPU pair:
     * seaChroma.pigmentFloor, swept in tests/ocean.test.ts "§V.56".
     */
    pigmentFloorChroma: 0.22,
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
    /** how much the sun shadow map darkens the water (0 = ignore shadows) */
    shadowStrength: 0.85,
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
     * §V.48 specular antialiasing (Kaplanyan, "filtering distributions of
     * normals"). Scales the screen-space normal variance σ² that widens every
     * specular lobe. A pow(N·H, 180) lobe point-sampled on a normal field that
     * swings through many wave faces inside one pixel is a coin flip per pixel
     * and boils under motion — the noise the user reports when zoomed out.
     * Widening the lobe by σ² and rescaling its peak by p'/p conserves energy,
     * so the glint road survives at full brightness while the isolated
     * pixel-sized sparkles are spread back into the average they should have
     * been. Turning specular DOWN instead would flatten the whole sea. 0 = off.
     * 2.2 measured in-browser at the §T.39 sunset framing: below ~1 the
     * near-field still reads as fibrous golden hair, and the sea is grazing
     * almost everywhere in that shot, so the variance it has to swallow is
     * large.
     */
    specularAaStrength: 2.2,
    /**
     * Cap on that variance (§V.44 bounded at source). Also the floor on lobe
     * width: p' ≥ p/(1 + p·max), so the horizon band cannot collapse to a
     * uniform sheen.
     */
    specularAaMax: 0.35,
    /** specular tightness of an individual glint */
    sparklePower: 40,
    /** tightness of the glint-train footprint (the sun path on the water) */
    glintTrainPower: 24,
    /** hash-density thresholds outside / inside the sun path (1 = none) */
    sparkleDensityBase: 0.985,
    sparkleDensityTrain: 0.82,
    /** broad specular sheen along the sun path — the readable "sun road" */
    glintRoadStrength: 0.55,
    glintRoadPower: 180,
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
     * INTERIM crest foam (NOT §T.5 — no temporal decay, no trailing streaks).
     * σ-relative band (§V.36) so the numbers keep meaning "crest tops" when
     * the spectrum moves. 1.9σ..2.7σ is the top ~2.9%..0.35% of the surface.
     * Narrowed and raised from 1.5..2.4 after the user called the result "too
     * thick, too big, too chunky" at the default swell preset.
     */
    crestFoamBandLow: 1.9,
    crestFoamBandHigh: 2.7,
    /**
     * Opacity of the PATCH BODY, not of foam in general. Foam that is not
     * actively breaking is thin and translucent — it takes the water and sky
     * under it. At 0.55 the body composited to ~0.5 alpha of a near-white and
     * read as "a milk cut" (user). Only `crestFoamEdgeStrength` is allowed
     * near opaque.
     */
    crestFoamStrength: 0.34,
    /** only the steep faces foam — flat crest tops do not break */
    crestFoamSlopeGate: 0.3,
    /**
     * Break-up field (§V.48 band-limited). Coverage is multiplied by a
     * world-locked 2-octave noise gate, because a smooth threshold on the
     * smooth σ/slope fields produces a connected CONTOUR — one unbroken ribbon
     * per crest line, which is the "too long / too regular" complaint. Scale
     * is the coarse octave's wavelength in metres; the fine octave is 0.34× it.
     */
    crestFoamPatchScale: 13,
    /**
     * Gate on that field. The window is deliberately narrow and high: it is
     * what turns "most crests foam a bit" into "a few crests foam", which is
     * the user's low end — "in some little spots here and there".
     */
    crestFoamPatchLow: 0.46,
    crestFoamPatchHigh: 0.72,
    /**
     * Breaking edge (docs/ref-storm-whitecaps.png: a bright lip at the break).
     * Width in σ ABOVE crestFoamBandHigh over which the edge reaches full
     * strength, and its opacity — the one place foam may read white.
     */
    crestFoamEdgeWidth: 0.35,
    crestFoamEdgeStrength: 0.85,
    /** how far foam takes the sky's colour — the reference's foam is warm
     *  cream, ours is authored cool near-white and reads wrong at sunset */
    foamSkyTint: 0.35,

    // ── distance haze (§V30: this replaces scene fog ON THE WATER) ──────
    /** the water melts into haze between these radii (m) */
    hazeStart: 900,
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

    /** §V.24 transparency: view-space absorption density per meter */
    absorptionDensity: 0.35,
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
    /** water body tint applied to refracted scene */
    refractionTint: '#7fd4c9',
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
    /** brightness of the sky disc inside Snell's window */
    underWindowBrightness: 1.15,
    /** softness of the Snell window edge (cos units) */
    underWindowSoftness: 0.12,
  },
  {
    gridSegments: { min: 64, max: 1024, step: 64 },
    gridCoreSpacing: { min: 0.2, max: 4, step: 0.05 },
    gridHorizonRadius: { min: 500, max: 20000, step: 100 },
    gridRimRound: { min: 0, max: 1, step: 0.01 },
    lodSamplesFull: { min: 4, max: 32, step: 0.5 },
    lodSamplesCut: { min: 2, max: 24, step: 0.5 },
    normalDetailStretch: { min: 1, max: 8, step: 0.1 },
    normalTexelFull: { min: 0.1, max: 4, step: 0.05 },
    normalTexelCut: { min: 0.2, max: 8, step: 0.05 },
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
    specularAaStrength: { min: 0, max: 3, step: 0.01 },
    specularAaMax: { min: 0.01, max: 2, step: 0.01 },
    sssMaxMix: { min: 0, max: 1, step: 0.01 },
    sssBrightness: { min: 0, max: 2, step: 0.01 },
    fresnelR0: { min: 0, max: 0.2, step: 0.005 },
    crestFoamBandLow: { min: 0, max: 4, step: 0.05 },
    crestFoamBandHigh: { min: 0.2, max: 6, step: 0.05 },
    crestFoamStrength: { min: 0, max: 1, step: 0.01 },
    crestFoamSlopeGate: { min: 0.02, max: 1.5, step: 0.01 },
    crestFoamPatchScale: { min: 1, max: 80, step: 0.5 },
    crestFoamPatchLow: { min: 0, max: 1, step: 0.01 },
    crestFoamPatchHigh: { min: 0, max: 1, step: 0.01 },
    crestFoamEdgeWidth: { min: 0.05, max: 2, step: 0.05 },
    crestFoamEdgeStrength: { min: 0, max: 1, step: 0.01 },
    foamSkyTint: { min: 0, max: 1, step: 0.01 },
    sparklePower: { min: 4, max: 256, step: 1 },
    glintTrainPower: { min: 1, max: 128, step: 1 },
    sparkleDensityBase: { min: 0.5, max: 1, step: 0.001 },
    sparkleDensityTrain: { min: 0.5, max: 1, step: 0.001 },
    glintRoadStrength: { min: 0, max: 3, step: 0.01 },
    glintRoadPower: { min: 8, max: 2048, step: 4 },
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
    absorptionDensity: { min: 0.02, max: 2, step: 0.01 },
    refractionStrength: { min: 0, max: 0.3, step: 0.005 },
    transmissionFloor: { min: 0, max: 0.9, step: 0.01 },
    underWindowBrightness: { min: 0, max: 3, step: 0.01 },
    underWindowSoftness: { min: 0.01, max: 0.5, step: 0.01 },
  },
);
