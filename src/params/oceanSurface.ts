/**
 * Ocean surface shading tunables (§V.5, §V.16, §V.20).
 * Color targets: docs/final-full-result.png — turquoise SSS through crests,
 * deep teal base, dense warm sparkle, soft foam.
 */
import { registerParams } from './registry';

export const oceanSurfaceParams = registerParams(
  'oceanSurface',
  {
    deepColor: '#0a3d45',
    shallowColor: '#178c8d',
    sssColor: '#32d0c0',
    sssStrength: 1.7,
    sssPower: 4.0,
    /** horizontal-displacement mask scale for the SSS side-of-wave isolation (§V.5) */
    sssChoppyScale: 0.9,
    skyHorizonColor: '#a8d4e8',
    skyZenithColor: '#4694cc',
    /** fresnel sky-reflection blend cap — high = mirror sheen, low = body color */
    reflectionStrength: 0.18,
    roughness: 0.3,
    /** analytic sun glint */
    sparkleStrength: 1.6,
    sparkleScale: 220.0,
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
    reflectionStrength: { min: 0, max: 1, step: 0.01 },
    sssPower: { min: 0.5, max: 8, step: 0.1 },
    sssChoppyScale: { min: 0, max: 3, step: 0.05 },
    roughness: { min: 0.01, max: 1, step: 0.01 },
    sparkleStrength: { min: 0, max: 4, step: 0.05 },
    sparkleScale: { min: 10, max: 600, step: 5 },
    foamThreshold: { min: -1, max: 1.5, step: 0.01 },
    displacementFadeStart: { min: 50, max: 2000, step: 10 },
    displacementFadeEnd: { min: 100, max: 3000, step: 10 },
    normalFadeStart: { min: 50, max: 2000, step: 10 },
    normalFadeEnd: { min: 100, max: 3000, step: 10 },
    absorptionDensity: { min: 0.02, max: 2, step: 0.01 },
    refractionStrength: { min: 0, max: 0.3, step: 0.005 },
  },
);
