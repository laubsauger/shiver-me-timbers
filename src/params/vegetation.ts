/**
 * Vegetation tunables (§V16: every tunable lives in a params module and
 * appears in Tweakpane — no magic constants in shaders). Consumed by
 * src/vegetation/* (T26): palm geometry proportions, wind sway/flutter
 * response, scatter distribution and palette. Geometry-shape values are read
 * at build time (deterministic per seed §V2-adjacent); sway/color values are
 * pushed into TSL uniforms every frame so panel tweaks are live.
 */
import { registerParams } from './registry';

export interface VegetationParams {
  /** default palm instance count when createPalms gets no count */
  count: number;

  // -- palm shape (read at geometry build time) ------------------------------
  heightMin: number;
  heightMax: number;
  trunkBend: number; // lateral crown offset (m) at trunk top
  trunkBaseRadius: number;
  trunkTopRadius: number;
  trunkSegments: number;
  trunkRadialSegments: number;
  frondsMin: number;
  frondsMax: number;
  frondLength: number;
  frondWidth: number;
  frondDroop: number; // quadratic tip drop (m) over frond length
  frondCrease: number; // V-fold depth as fraction of local half-width
  frondSegments: number;
  coconutChance: number; // 0..1 chance a palm grows a coconut cluster
  coconutRadius: number;
  /** windWeight baked at trunk top / frond root (tips always reach 1) */
  trunkTopWindWeight: number;

  // -- wind sway (live TSL uniforms) -----------------------------------------
  swayAmplitude: number; // trunk bend offset (m) at windWeight=1
  swaySpeed: number; // trunk sway frequency (rad/s)
  swayHarmonic: number; // secondary sine weight for organic motion
  swayHarmonicFreq: number; // secondary sine frequency ratio
  phaseCoupling: number; // how much phaseOffset desyncs the trunk sway
  flutterAmplitude: number; // frond flutter along normal (m)
  flutterFrequency: number; // flutter frequency (rad/s)

  // -- scatter distribution --------------------------------------------------
  clusterCount: number;
  ringInner: number;
  ringOuter: number;
  clusterSpread: number; // radial/tangential jitter inside a cluster (m)
  scaleMin: number;
  scaleMax: number;
  heightJitter: number; // extra ±y stretch on top of uniform scale
  leanMax: number; // max instance tilt (rad)

  // -- palette + shading (live TSL uniforms) ---------------------------------
  trunkColor: number;
  barkStripeColor: number;
  barkRingFrequency: number; // stripes along trunk v (0..1)
  barkStripeRatio: number; // 0..1 dark-stripe coverage per ring
  frondColorDark: number;
  frondColorLight: number;
  backlitColor: number;
  backlitStrength: number;
  coconutColor: number;
}

export const vegetationParams: VegetationParams = registerParams(
  'vegetation',
  {
    count: 24,
    heightMin: 5.5,
    heightMax: 9,
    trunkBend: 1.1,
    trunkBaseRadius: 0.3,
    trunkTopRadius: 0.16,
    trunkSegments: 20,
    trunkRadialSegments: 10,
    frondsMin: 6,
    frondsMax: 10,
    frondLength: 3.4,
    frondWidth: 0.8,
    frondDroop: 1.6,
    frondCrease: 0.45,
    frondSegments: 16,
    coconutChance: 0.75,
    coconutRadius: 0.17,
    trunkTopWindWeight: 0.35,
    swayAmplitude: 0.5,
    swaySpeed: 0.9,
    swayHarmonic: 0.4,
    swayHarmonicFreq: 0.37,
    phaseCoupling: 0.3,
    flutterAmplitude: 0.09,
    flutterFrequency: 4.5,
    clusterCount: 5,
    ringInner: 22,
    ringOuter: 48,
    clusterSpread: 6,
    scaleMin: 0.8,
    scaleMax: 1.25,
    heightJitter: 0.15,
    leanMax: 0.14,
    trunkColor: 0x9a744e,
    barkStripeColor: 0x74553a,
    barkRingFrequency: 14,
    barkStripeRatio: 0.42,
    frondColorDark: 0x2c7a35,
    frondColorLight: 0x86c94f,
    backlitColor: 0xa4de5e,
    backlitStrength: 0.55,
    coconutColor: 0x5d4630,
  },
  {
    count: { min: 0, max: 200, step: 1 },
    heightMin: { min: 2, max: 12, step: 0.1 },
    heightMax: { min: 2, max: 14, step: 0.1 },
    trunkBend: { min: 0, max: 3, step: 0.05 },
    trunkBaseRadius: { min: 0.1, max: 0.8, step: 0.01 },
    trunkTopRadius: { min: 0.05, max: 0.5, step: 0.01 },
    trunkSegments: { min: 4, max: 40, step: 1 },
    trunkRadialSegments: { min: 4, max: 16, step: 1 },
    frondsMin: { min: 3, max: 12, step: 1 },
    frondsMax: { min: 3, max: 14, step: 1 },
    frondLength: { min: 1, max: 6, step: 0.1 },
    frondWidth: { min: 0.2, max: 2, step: 0.05 },
    frondDroop: { min: 0, max: 4, step: 0.05 },
    frondCrease: { min: 0, max: 1, step: 0.01 },
    frondSegments: { min: 4, max: 32, step: 1 },
    coconutChance: { min: 0, max: 1, step: 0.05 },
    coconutRadius: { min: 0.05, max: 0.4, step: 0.01 },
    trunkTopWindWeight: { min: 0, max: 0.8, step: 0.01 },
    swayAmplitude: { min: 0, max: 2, step: 0.01 },
    swaySpeed: { min: 0, max: 4, step: 0.01 },
    swayHarmonic: { min: 0, max: 1, step: 0.01 },
    swayHarmonicFreq: { min: 0, max: 2, step: 0.01 },
    phaseCoupling: { min: 0, max: 1, step: 0.01 },
    flutterAmplitude: { min: 0, max: 0.5, step: 0.005 },
    flutterFrequency: { min: 0, max: 12, step: 0.1 },
    clusterCount: { min: 1, max: 12, step: 1 },
    ringInner: { min: 0, max: 200, step: 1 },
    ringOuter: { min: 0, max: 400, step: 1 },
    clusterSpread: { min: 0, max: 30, step: 0.5 },
    scaleMin: { min: 0.2, max: 2, step: 0.05 },
    scaleMax: { min: 0.2, max: 3, step: 0.05 },
    heightJitter: { min: 0, max: 0.5, step: 0.01 },
    leanMax: { min: 0, max: 0.5, step: 0.01 },
    barkRingFrequency: { min: 1, max: 40, step: 1 },
    barkStripeRatio: { min: 0, max: 1, step: 0.01 },
    backlitStrength: { min: 0, max: 2, step: 0.05 },
  },
);
