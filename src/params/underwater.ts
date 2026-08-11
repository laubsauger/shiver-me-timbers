/**
 * Underwater camera-mode tunables (§V16: every tunable in a params module,
 * bound to Tweakpane; §V25: submerged grade + waterline crossing look).
 * Consumed by src/underwater/*. Colors are hex numbers for direct panel
 * binding; the underwater modules convert to linear at update time.
 */
import { registerParams } from './registry';

export interface UnderwaterParams {
  /** exp fog density per meter of view distance while submerged */
  fogDensity: number;
  /** fog color just under the surface (turquoise, ref: SoT underwater) */
  fogColorShallow: number;
  /** fog color at depth (deep teal) */
  fogColorDeep: number;
  /** camera depth (m below surface) at which fog color is fully deep */
  fogDepthRange: number;
  /** 0..1 how strongly the blue-green grade tints the submerged image */
  gradeStrength: number;
  /** blue-green multiply tint of the grade */
  gradeTint: number;
  /** 0..1 desaturation amount at full submersion */
  desaturation: number;
  /** screen-space wobble amplitude in UV units (keep tiny) */
  wobbleAmp: number;
  /** wobble spatial frequency across the screen */
  wobbleFreq: number;
  /** wobble time speed (rad/s) */
  wobbleSpeed: number;
  /** god-ray additive intensity (0 disables) */
  rayIntensity: number;
  /** god-ray sample taps — read once at pipeline build (shader loop bound) */
  rayTaps: number;
  /** per-tap weight decay for the radial streaks */
  rayDecay: number;
  /** luminance threshold for the bright mask feeding the streaks */
  rayThreshold: number;
  /** how far toward the sun each streak reaches (0..1 of screen) */
  rayLength: number;
  /** screen-UV radius around the sun beyond which rays fade to zero */
  rayFalloff: number;
  /** total vertical hysteresis band around the waterline (m) — inside it
   *  mode stays 'crossing' so wave chop cannot strobe above/below */
  hysteresisBand: number;
  /** max |Δblend| per 60Hz tick — caps fade speed, guarantees no pop (V25) */
  maxBlendStep: number;
  /** meniscus band half-thickness in screen-UV units */
  meniscusThickness: number;
  /** meniscus strip brightness multiplier */
  meniscusBrightness: number;
  /** droplet streak strength above the waterline while crossing */
  streakStrength: number;
  /** droplet streak columns across the screen */
  streakDensity: number;
  /** how far above the waterline streaks reach (screen-UV units) */
  streakLength: number;
  /** vignette darkening at screen edges when submerged (0..1) */
  vignetteStrength: number;
  /** extra vignette per meter of camera depth */
  vignetteDepthScale: number;
  /** how many CPU-sampled waterline height columns across the screen */
  waterlineSamples: number;
}

export const underwaterParams: UnderwaterParams = registerParams(
  'underwater',
  {
    fogDensity: 0.045,
    fogColorShallow: 0x2e8f86,
    fogColorDeep: 0x0b3d43,
    fogDepthRange: 25,
    gradeStrength: 0.55,
    gradeTint: 0x9fd8cf,
    desaturation: 0.35,
    wobbleAmp: 0.0035,
    wobbleFreq: 9,
    wobbleSpeed: 1.4,
    rayIntensity: 0.5,
    rayTaps: 12,
    rayDecay: 0.86,
    rayThreshold: 0.55,
    rayLength: 0.55,
    rayFalloff: 0.9,
    hysteresisBand: 0.5,
    maxBlendStep: 0.08,
    meniscusThickness: 0.012,
    meniscusBrightness: 1.6,
    streakStrength: 0.35,
    streakDensity: 90,
    streakLength: 0.08,
    vignetteStrength: 0.35,
    vignetteDepthScale: 0.01,
    waterlineSamples: 16,
  },
  {
    fogDensity: { min: 0, max: 0.4, step: 0.001 },
    fogDepthRange: { min: 1, max: 100, step: 1 },
    gradeStrength: { min: 0, max: 1, step: 0.01 },
    desaturation: { min: 0, max: 1, step: 0.01 },
    wobbleAmp: { min: 0, max: 0.02, step: 0.0005 },
    wobbleFreq: { min: 1, max: 40, step: 0.5 },
    wobbleSpeed: { min: 0, max: 8, step: 0.05 },
    rayIntensity: { min: 0, max: 2, step: 0.01 },
    rayTaps: { min: 4, max: 32, step: 1 },
    rayDecay: { min: 0.5, max: 0.99, step: 0.01 },
    rayThreshold: { min: 0, max: 1, step: 0.01 },
    rayLength: { min: 0.05, max: 1, step: 0.01 },
    rayFalloff: { min: 0.1, max: 2, step: 0.01 },
    hysteresisBand: { min: 0.05, max: 3, step: 0.05 },
    maxBlendStep: { min: 0.005, max: 1, step: 0.005 },
    meniscusThickness: { min: 0.002, max: 0.05, step: 0.001 },
    meniscusBrightness: { min: 0, max: 4, step: 0.05 },
    streakStrength: { min: 0, max: 1, step: 0.01 },
    streakDensity: { min: 10, max: 300, step: 1 },
    streakLength: { min: 0.01, max: 0.3, step: 0.005 },
    vignetteStrength: { min: 0, max: 1, step: 0.01 },
    vignetteDepthScale: { min: 0, max: 0.1, step: 0.001 },
    waterlineSamples: { min: 4, max: 64, step: 1 },
  },
);
