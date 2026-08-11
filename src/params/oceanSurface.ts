/**
 * Ocean surface shading tunables (§V.5, §V.16, §V.20).
 * Color targets: docs/final-full-result.png — turquoise SSS through crests,
 * deep teal base, dense warm sparkle, soft foam.
 */
import { registerParams } from './registry';

export const oceanSurfaceParams = registerParams(
  'oceanSurface',
  {
    deepColor: '#0d3d4d',
    shallowColor: '#1a7f8a',
    sssColor: '#2ec4b6',
    sssStrength: 1.6,
    sssPower: 3.0,
    /** horizontal-displacement mask scale for the SSS side-of-wave isolation (§V.5) */
    sssChoppyScale: 0.9,
    skyHorizonColor: '#cfe8f0',
    skyZenithColor: '#5aa7d4',
    roughness: 0.16,
    /** analytic sun glint */
    sparkleStrength: 1.2,
    sparkleScale: 220.0,
    /** temporary direct-jacobian crest foam until T5 progressive blur lands */
    foamThreshold: 0.55,
    foamColor: '#eef6f2',
    /** displacement fade start/end (m) — hides far-field tiling (§V.19) */
    displacementFadeStart: 350,
    displacementFadeEnd: 900,
    normalFadeStart: 250,
    normalFadeEnd: 1200,
  },
  {
    sssStrength: { min: 0, max: 5, step: 0.05 },
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
  },
);
