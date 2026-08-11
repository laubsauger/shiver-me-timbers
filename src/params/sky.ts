/**
 * Sky + lighting tunables (§V16: every tunable lives in a params module and
 * appears in Tweakpane; no shader magic constants). Consumed by src/sky/*.
 * Colors are hex numbers so the debug panel can bind them directly; the sky
 * modules convert to linear ramps at update time.
 */
import { registerParams } from './registry';

export interface SkyParams {
  /** simulated hour 0..24 — drives sun direction and every light ramp */
  timeOfDay: number;
  /** observer latitude in degrees; tropics keep the noon sun near zenith */
  latitude: number;
  /** sky dome sphere radius (m) — must stay inside the camera far plane */
  domeRadius: number;
  /** zenith blue at full day */
  zenithColor: number;
  /** horizon haze band color (milky blue-white in the reference shots) */
  horizonColor: number;
  /** 0..1 how strongly the haze band washes out the horizon */
  hazeStrength: number;
  /** vertical falloff of the haze band (viewDir.y units, exp decay) */
  hazeFalloff: number;
  /** warm tint blended into the haze around the sun's side of the sky */
  horizonWarmColor: number;
  /** 0..1 peak warm-tint amount (scaled up as the sun drops) */
  horizonWarmStrength: number;
  /** sun light color at the horizon (warm) and at noon (white-gold) */
  sunColorLow: number;
  sunColorNoon: number;
  /** zenith tint multiplier endpoints for the night→day ramp */
  nightTint: number;
  /** analytic sun disc angular radius (degrees) and its soft edge (degrees) */
  sunDiscSize: number;
  sunDiscSoftness: number;
  /** additive glow around the disc: exponent shapes it, strength scales it */
  sunGlowPower: number;
  sunGlowStrength: number;
  /** shape of the horizon→zenith gradient (higher = blue reaches lower) */
  gradientCurve: number;
  /** DirectionalLight peak intensity and its distance from origin (m) */
  sunIntensity: number;
  sunDistance: number;
  /** hemisphere ambient peak intensity */
  ambientIntensity: number;
  /** hemisphere ground bounce color (warm sea/sand reflection) */
  groundBounceColor: number;
  /** tone mapping exposure applied via configureRenderer */
  exposure: number;
}

export const skyParams: SkyParams = registerParams(
  'sky',
  {
    timeOfDay: 10.5,
    latitude: 15,
    domeRadius: 4200,
    zenithColor: 0x3d8fd6,
    horizonColor: 0xd6ecf5,
    hazeStrength: 0.9,
    hazeFalloff: 0.22,
    horizonWarmColor: 0xffe0b0,
    horizonWarmStrength: 0.35,
    sunColorLow: 0xff9440,
    sunColorNoon: 0xfff3da,
    nightTint: 0x16263e,
    sunDiscSize: 1.6,
    sunDiscSoftness: 0.7,
    sunGlowPower: 14,
    sunGlowStrength: 0.55,
    gradientCurve: 0.65,
    sunIntensity: 3.2,
    sunDistance: 1200,
    ambientIntensity: 0.85,
    groundBounceColor: 0x2e6d78,
    exposure: 1.15,
  },
  {
    timeOfDay: { min: 0, max: 24, step: 0.05 },
    latitude: { min: -60, max: 60, step: 1 },
    hazeStrength: { min: 0, max: 1, step: 0.01 },
    hazeFalloff: { min: 0.02, max: 1, step: 0.01 },
    horizonWarmStrength: { min: 0, max: 1, step: 0.01 },
    sunDiscSize: { min: 0.2, max: 6, step: 0.05 },
    sunDiscSoftness: { min: 0.05, max: 3, step: 0.05 },
    sunGlowPower: { min: 1, max: 64, step: 0.5 },
    sunGlowStrength: { min: 0, max: 2, step: 0.01 },
    gradientCurve: { min: 0.2, max: 2, step: 0.01 },
    sunIntensity: { min: 0, max: 8, step: 0.05 },
    sunDistance: { min: 100, max: 4000, step: 10 },
    ambientIntensity: { min: 0, max: 3, step: 0.01 },
    exposure: { min: 0.3, max: 3, step: 0.01 },
  },
);
