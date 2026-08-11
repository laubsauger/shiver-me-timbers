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
    lodSamplesFull: 12,
    lodSamplesCut: 6,
    /**
     * Normals are per-pixel, not per-vertex, so slope detail may outlive the
     * geometry: cascade normal fades use the same Nyquist gate stretched by
     * this factor.
     */
    normalDetailStretch: 3.0,

    // ── colour ──────────────────────────────────────────────────────────
    deepColor: '#093642',
    /** coast/shallows tint — mixed in by shallowTintStrength (seabed-depth
     *  input pending islands T20; keep 0 on open ocean) */
    shallowColor: '#1a8a8a',
    shallowTintStrength: 0.0,
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
    sssPower: 4.0,
    /** baseline crest glow independent of sun alignment — crests always read
     *  translucent (§V20), the backlight term only amplifies toward the sun */
    sssAmbient: 0.08,
    /** horizontal-displacement mask scale for the SSS side-of-wave isolation (§V.5) */
    sssChoppyScale: 0.9,
    /**
     * 0..1 how much of the ambient crest glow requires real sun backlighting.
     * The user's rule: on open ocean bright turquoise is only allowed where
     * sun comes through the water toward the viewer. 1 = fully sun-gated.
     */
    sssAmbientSunGate: 0.85,
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
    skyHorizonColor: '#a8d4e8',
    skyZenithColor: '#4694cc',
    /** fresnel sky-reflection blend cap — high = mirror sheen, low = body color */
    reflectionStrength: 0.13,
    /** re-saturation of the body colour under a white sky at grazing angles;
     *  0 = raw fresnel wash (reads gray/desaturated), 1 = full pigment */
    grazingSaturation: 0.55,
    /** stylized wrap lighting (material owns light — §V20 pigment look):
     *  brightness = floor + gain·max(0, N·L), tinted by sunTint */
    lightFloor: 0.62,
    lightGain: 0.45,
    sunTint: '#fff2dc',
    /** how much the sun shadow map darkens the water (0 = ignore shadows) */
    shadowStrength: 0.85,
    /** build the in-material sun-shadow sample at all (reload to apply) —
     *  kill switch for the shadow node, separate from shadowStrength which
     *  only scales an already-compiled sample */
    shadowsEnabled: true,

    // ── sparkle / glint train (§V20 "dense sun sparkle glints") ─────────
    sparkleStrength: 1.0,
    /** sparkle hash cells per meter — ~5cm glint cells; sub-cm reads as
     *  per-pixel starfield noise (user critique) */
    sparkleScale: 18.0,
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

    /** temporary direct-jacobian crest foam until T5 progressive blur lands */
    foamThreshold: 0.55,
    foamColor: '#eef6f2',

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
    /** refraction offset strength (screen-space) */
    refractionStrength: 0.06,
    /** water body tint applied to refracted scene */
    refractionTint: '#7fd4c9',

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
    sssStrength: { min: 0, max: 5, step: 0.05 },
    sssAmbient: { min: 0, max: 1, step: 0.01 },
    shallowTintStrength: { min: 0, max: 1, step: 0.01 },
    variationScale: { min: 100, max: 4000, step: 10 },
    variationStrength: { min: 0, max: 0.25, step: 0.005 },
    reflectionStrength: { min: 0, max: 1, step: 0.01 },
    grazingSaturation: { min: 0, max: 1, step: 0.01 },
    sssPower: { min: 0.5, max: 8, step: 0.1 },
    sssChoppyScale: { min: 0, max: 3, step: 0.05 },
    sssAmbientSunGate: { min: 0, max: 1, step: 0.01 },
    crestBandLow: { min: 0, max: 4, step: 0.05 },
    crestBandHigh: { min: 0.2, max: 6, step: 0.05 },
    bodyBandLow: { min: -4, max: 0, step: 0.05 },
    bodyBandHigh: { min: 0.2, max: 6, step: 0.05 },
    lightFloor: { min: 0, max: 1.5, step: 0.01 },
    lightGain: { min: 0, max: 2, step: 0.01 },
    shadowStrength: { min: 0, max: 1, step: 0.01 },
    sparkleStrength: { min: 0, max: 4, step: 0.05 },
    sparkleScale: { min: 2, max: 120, step: 1 },
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
    underWindowBrightness: { min: 0, max: 3, step: 0.01 },
    underWindowSoftness: { min: 0.01, max: 0.5, step: 0.01 },
  },
);
