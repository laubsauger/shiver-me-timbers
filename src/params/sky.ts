/**
 * Sky + lighting tunables (§V16: every tunable lives in a params module and
 * appears in Tweakpane; no shader magic constants). Consumed by src/sky/*.
 *
 * COLOUR AUTHORING CONTRACT: every hex here is an sRGB colour picked against
 * docs/final-full-result.png. The sky modules convert sRGB → linear working
 * space at the uniform boundary (Color.setRGB(..., SRGBColorSpace)). Feeding
 * raw sRGB numbers into a linear pipeline is what made the whole sky read as
 * washed-out white (§B9) — the values below are what you should SEE on
 * screen, not what the shader multiplies.
 */
import { registerParams } from './registry';

export interface SkyParams {
  /** simulated hour 0..24 — drives sun direction and every light ramp */
  timeOfDay: number;
  /** observer latitude in degrees; tropics keep the noon sun near zenith */
  latitude: number;
  /** deep blue straight up */
  zenithColor: number;
  /** blue of the main sky body (~20-40° above the horizon) */
  midColor: number;
  /** horizon haze band color (pale cyan-white in the reference shots) */
  horizonColor: number;
  /** 0..1 how completely the haze band takes over at eye level */
  hazeStrength: number;
  /** vertical thickness of the haze band (viewDir.y units, exp decay) */
  hazeFalloff: number;
  /** extra haze lift on the sun's side of the sky (forward scattering) */
  sunHazeStrength: number;
  /** warm tint blended into the haze around the sun's side */
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
  /** HDR multiplier on the disc — >1 clips it to white so it reads as a sun */
  sunDiscIntensity: number;
  /** tight glow hugging the disc: exponent shapes it, strength scales it */
  sunGlowPower: number;
  sunGlowStrength: number;
  /** wide atmospheric halo around the sun (low power = very broad) */
  sunHaloPower: number;
  sunHaloStrength: number;
  /** shape of the mid→zenith gradient (higher = blue stays low longer) */
  gradientCurve: number;
  /** DirectionalLight peak intensity and its distance from origin (m) */
  sunIntensity: number;
  sunDistance: number;
  /**
   * Sun shadow map. `shadowNormalBias` is in WORLD METRES along the receiver
   * normal, so it deletes the contact shadow of any object thinner than
   * itself — keep it under the smallest caster that matters (deck rail posts
   * are 0.09 m) and near one shadow texel, which is 2*extent/mapSize.
   * `shadowExtent` is the ortho half-width: shrinking it sharpens fixtures
   * but CLIPS long shadows — a 40 m mast at a 20° sun throws ~110 m, so an
   * extent below ~70 truncates the ship's shadow on the water.
   * `shadowMapSize` is read once at construction (reload to change).
   */
  shadowNormalBias: number;
  shadowBias: number;
  shadowExtent: number;
  shadowMapSize: number;
  /** hemisphere ambient peak intensity */
  ambientIntensity: number;
  /** hemisphere ground bounce color (warm sea/sand reflection) */
  groundBounceColor: number;
  /**
   * Scene fog range (m) — atmospheric distance haze, NOT a view-distance cap
   * (§V30). The OCEAN no longer uses scene fog (its material sets
   * fog = false and runs its own 900→4600 m haze on a 1.7 curve, copying
   * scene.fog.color as the target), so this range now governs OBJECTS only:
   * ship, islands, spray. It must fade them at a rate close to the water's
   * curve or an island reads sharper or softer than the sea it sits in.
   * The water curve is smoothstep(900, 4600, d)^1.7 — Hermite, so it stays
   * clear to ~2 km then steepens hard; a linear ramp matched at mid-field
   * (1200/6500) falls 0.35 behind AT THE RIM, which is a dark island against
   * near-white sea exactly where it shows. 1800/4900 tracks within 0.12
   * everywhere and saturates just before the 4600 m sea rim, so geometry
   * melts where the water does. Move these whenever the rim moves.
   * scene.fog.color stays load-bearing regardless: the water copies it as
   * its own haze target, so deleting the fog costs the sea its day tint.
   */
  fogNear: number;
  fogFar: number;
  /** tone mapping exposure applied via configureRenderer */
  exposure: number;
}

export const skyParams: SkyParams = registerParams(
  'sky',
  {
    // afternoon sun ~22° up: high enough for a bright blue sky, low enough
    // that the disc sits in frame and throws a glint path across the water
    timeOfDay: 16.4,
    latitude: 15,
    // Sampled from docs/final-full-result.png: horizon band (219,236,240),
    // sky body at ~20° (105,165,201), extrapolated zenith (47,127,196).
    // These hexes are PRE-COMPENSATED for ACESFilmic @ exposure 1.1, which
    // lifts and desaturates everything it touches — feed it the reference
    // values literally and the horizon lands on neutral grey and the blues
    // go milky (that plus §B9 is the "blown out white" report). Authored
    // deeper/more saturated, they tonemap ONTO the reference numbers.
    zenithColor: 0x336cb1, // → (44,120,192) on screen
    midColor: 0x558fbe, //    → (105,165,201)
    horizonColor: 0xa1e7ff, // → (196,222,228): pale, still cyan, not white
    hazeStrength: 0.9,
    hazeFalloff: 0.18,
    sunHazeStrength: 0.3,
    horizonWarmColor: 0xffbe83,
    horizonWarmStrength: 0.45,
    sunColorLow: 0xff9440,
    sunColorNoon: 0xfff3da,
    nightTint: 0x16263e,
    sunDiscSize: 1.1,
    sunDiscSoftness: 0.35,
    sunDiscIntensity: 14,
    sunGlowPower: 240,
    sunGlowStrength: 1.2,
    sunHaloPower: 6,
    sunHaloStrength: 0.16,
    gradientCurve: 1.5,
    sunIntensity: 3.4,
    sunDistance: 1200,
    shadowNormalBias: 0.04,
    shadowBias: -0.0004,
    shadowExtent: 80,
    shadowMapSize: 2048,
    ambientIntensity: 0.85,
    groundBounceColor: 0x2e6d78,
    fogNear: 1800,
    fogFar: 4900,
    exposure: 1.1,
  },
  {
    timeOfDay: { min: 0, max: 24, step: 0.05 },
    latitude: { min: -60, max: 60, step: 1 },
    hazeStrength: { min: 0, max: 1, step: 0.01 },
    hazeFalloff: { min: 0.02, max: 1, step: 0.01 },
    sunHazeStrength: { min: 0, max: 1, step: 0.01 },
    horizonWarmStrength: { min: 0, max: 1, step: 0.01 },
    sunDiscSize: { min: 0.2, max: 6, step: 0.05 },
    sunDiscSoftness: { min: 0.05, max: 3, step: 0.05 },
    sunDiscIntensity: { min: 1, max: 40, step: 0.5 },
    sunGlowPower: { min: 1, max: 600, step: 1 },
    sunGlowStrength: { min: 0, max: 4, step: 0.01 },
    sunHaloPower: { min: 1, max: 32, step: 0.5 },
    sunHaloStrength: { min: 0, max: 1, step: 0.01 },
    gradientCurve: { min: 0.2, max: 4, step: 0.01 },
    sunIntensity: { min: 0, max: 8, step: 0.05 },
    sunDistance: { min: 100, max: 4000, step: 10 },
    shadowNormalBias: { min: 0, max: 0.5, step: 0.005 },
    shadowBias: { min: -0.005, max: 0, step: 0.0001 },
    shadowExtent: { min: 20, max: 200, step: 5 },
    shadowMapSize: { min: 1024, max: 4096, step: 1024 },
    ambientIntensity: { min: 0, max: 3, step: 0.01 },
    fogNear: { min: 0, max: 8000, step: 10 },
    fogFar: { min: 200, max: 30000, step: 50 },
    exposure: { min: 0.3, max: 3, step: 0.01 },
  },
);
