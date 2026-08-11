/**
 * Ocean surface shading tunables (§V.5, §V.16, §V.20).
 * Color targets: docs/final-full-result.png — turquoise SSS through crests,
 * deep teal base, dense warm sparkle, soft foam.
 */
import { registerParams } from './registry';

export const oceanSurfaceParams = registerParams(
  'oceanSurface',
  {
    deepColor: '#093642',
    /** coast/shallows tint — mixed in by shallowTintStrength (seabed-depth
     *  input pending islands T20; keep 0 on open ocean) */
    shallowColor: '#1a8a8a',
    shallowTintStrength: 0.0,
    sssColor: '#32d0c0',
    sssStrength: 2.3,
    sssPower: 4.0,
    /** baseline crest glow independent of sun alignment — crests always read
     *  translucent (§V20), the backlight term only amplifies toward the sun */
    sssAmbient: 0.08,
    /** horizontal-displacement mask scale for the SSS side-of-wave isolation (§V.5) */
    sssChoppyScale: 0.9,
    skyHorizonColor: '#a8d4e8',
    skyZenithColor: '#4694cc',
    /** fresnel sky-reflection blend cap — high = mirror sheen, low = body color */
    reflectionStrength: 0.13,
    /** stylized wrap lighting (material owns light — §V20 pigment look):
     *  brightness = floor + gain·max(0, N·L), tinted by sunTint */
    lightFloor: 0.62,
    lightGain: 0.45,
    sunTint: '#fff2dc',
    /** analytic sun glint */
    sparkleStrength: 1.0,
    /** sparkle hash cells per meter — ~5cm glint cells; sub-cm reads as
     *  per-pixel starfield noise (user critique) */
    sparkleScale: 18.0,
    /** temporary direct-jacobian crest foam until T5 progressive blur lands */
    foamThreshold: 0.55,
    foamColor: '#eef6f2',
    /** displacement fade start/end (m) — hides far-field tiling (§V.19) */
    displacementFadeStart: 350,
    displacementFadeEnd: 900,
    normalFadeStart: 250,
    normalFadeEnd: 1200,
    /** §V.24 transparency: view-space absorption density per meter */
    absorptionDensity: 0.35,
    /** refraction offset strength (screen-space) */
    refractionStrength: 0.06,
    /** water body tint applied to refracted scene */
    refractionTint: '#7fd4c9',
  },
  {
    sssStrength: { min: 0, max: 5, step: 0.05 },
    sssAmbient: { min: 0, max: 1, step: 0.01 },
    shallowTintStrength: { min: 0, max: 1, step: 0.01 },
    reflectionStrength: { min: 0, max: 1, step: 0.01 },
    sssPower: { min: 0.5, max: 8, step: 0.1 },
    sssChoppyScale: { min: 0, max: 3, step: 0.05 },
    lightFloor: { min: 0, max: 1.5, step: 0.01 },
    lightGain: { min: 0, max: 2, step: 0.01 },
    sparkleStrength: { min: 0, max: 4, step: 0.05 },
    sparkleScale: { min: 2, max: 120, step: 1 },
    foamThreshold: { min: -1, max: 1.5, step: 0.01 },
    displacementFadeStart: { min: 50, max: 2000, step: 10 },
    displacementFadeEnd: { min: 100, max: 3000, step: 10 },
    normalFadeStart: { min: 50, max: 2000, step: 10 },
    normalFadeEnd: { min: 100, max: 3000, step: 10 },
    absorptionDensity: { min: 0.02, max: 2, step: 0.01 },
    refractionStrength: { min: 0, max: 0.3, step: 0.005 },
  },
);
