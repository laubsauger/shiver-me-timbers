/**
 * Audio tunables (§V16: every tunable lives in a params module and appears in
 * Tweakpane; §V7 spirit: weather changes only scale params, never switch code
 * paths). Consumed by src/audio/*.
 *
 * Two generations live here on purpose:
 *  - the SAMPLE bed / emitter / trigger block drives the real recordings in
 *    assets/audio/sfx (primary path),
 *  - the synth block below it drives the procedural fallback that runs when a
 *    sample fails to load, plus cannon/hull-hit which have no sample yet.
 */
import { registerParams } from './registry';

export interface AudioParams {
  // ── sample ambience bed (ocean / wind / sailing loops, non-positional) ──
  /** crossfade time constant (s) for every bed layer gain — long = no pop */
  bedFadeTau: number;
  /** slow per-layer gain drift so the bed never reads as a short tape loop */
  bedDriftRateHz: number;
  /** 0..1 depth of that drift (0 = static layer gains) */
  bedDriftDepth: number;
  /** ocean-waves layer gain at the swell preset */
  oceanBedGain: number;
  /** wind layer gain at 0 wind and at windSpeedRef */
  windBedFloor: number;
  windBedGain: number;
  /** the cockpit recording was captured at 12 kn true wind — its neutral rate */
  windRefKnots: number;
  /** ± playbackRate applied across the wind range (pitch = perceived force) */
  windRateSpread: number;
  /** lowpass on the wind layer at 0 wind and at windSpeedRef (Hz) */
  windBedCutoffMinHz: number;
  windBedCutoffMaxHz: number;
  /** general sailing bed (rig + water + wind mix) gain and its speed ref */
  sailBedGain: number;
  sailBedSpeedRef: number;

  // ── positional emitters (PannerNode distance model) ──
  emitterRefDistance: number;
  emitterMaxDistance: number;
  emitterRolloff: number;
  /** ship-local emitter offsets (m): bow/stern along +z/-z, waterline y */
  bowEmitterZ: number;
  sternEmitterZ: number;
  waterlineY: number;
  /** ship-local z of the three mast emitters (galleon defaults) */
  foreMastEmitterZ: number;
  mainMastEmitterZ: number;
  rearMastEmitterZ: number;
  /** height (m) of the sail emitters above the waterline */
  sailEmitterY: number;

  // ── emitter loops keyed to ship state ──
  /** stern wake rush gain at wakeSpeedRef and above */
  wakeGain: number;
  wakeSpeedRef: number;
  /** bow water rush gain (same recording, own loop point) */
  bowRushGain: number;
  /** hull gurgle at the waterline: gain, speed ref, and its idle floor */
  gurgleGain: number;
  gurgleSpeedRef: number;
  gurgleFloor: number;
  /** rigging/hull creak loop gain and the roll+pitch rate (rad/s) that maxes it */
  creakLoopGain: number;
  creakMotionRef: number;
  /** creak loop floor so a becalmed ship still breathes */
  creakFloor: number;

  // ── event one-shots from samples ──
  /** bow splash slice: gain, slice length (s) and the window it is cut from */
  bowSplashGain: number;
  bowSplashSliceSec: number;
  bowSplashWindowSec: number;
  /** §V27 gates: immersion (m) on/off hysteresis + minimum speed (m/s) */
  bowSplashImmersionOn: number;
  bowSplashImmersionOff: number;
  bowSplashSpeedGate: number;
  /** seconds between bow splashes at most (anti machine-gun) */
  bowSplashCooldown: number;
  /** canvas snap: gain, luff on/off hysteresis, cooldown (s), rate jitter */
  sailSnapGain: number;
  sailSnapLuffOn: number;
  sailSnapLuffOff: number;
  sailSnapCooldown: number;
  sailSnapRateJitter: number;
  /** |Δ sailTrim| within one frame that counts as a sharp trim change */
  trimSnapDelta: number;
  /** sail deploy one-shot gain + the |Δ trim| that counts as a state change */
  sailDeployGain: number;
  sailDeployDelta: number;
  sailDeployCooldown: number;

  // ── luff estimate (audio-side, mirrors ship/sailDynamics conventions) ──
  /** wind speed (m/s) at which cloth shakes at full force */
  luffWindRef: number;
  /** yaw rate (rad/s) contribution to shaking */
  luffTurnGain: number;

  // ── procedural fallback / no-sample one-shots ──
  // ── ocean ambience bed (brown-ish noise → lowpass → LFO swell) ──
  /** bed output gain 0..1 before the ambience bus */
  oceanGain: number;
  /** lowpass cutoff shaping the noise into a distant-surf rumble (Hz) */
  oceanLowpassHz: number;
  /** leaky-integrator coefficient for the brown-ish noise color (0=white) */
  oceanNoiseLeak: number;
  /** wave-rhythm amplitude swell rate (Hz, ~0.1 = one swell per 10s) */
  swellRateHz: number;
  /** 0..1 how deep the swell modulates the bed (0 = constant) */
  swellDepth: number;

  // ── wind layer (white noise → bandpass, follows windSpeed) ──
  /** wind layer gain at full windSpeedRef */
  windGainMax: number;
  /** bandpass center at 0 m/s and at windSpeedRef m/s */
  windCutoffMinHz: number;
  windCutoffMaxHz: number;
  /** bandpass resonance — higher = whistlier */
  windQ: number;
  /** wind speed (m/s) mapped to full-scale wind layer */
  windSpeedRef: number;
  /** smoothing time constant (s) for wind/weather follow */
  ambienceTau: number;

  // ── weather multipliers (calm|swell|storm pick one of each, §V7) ──
  calmGainMult: number;
  swellGainMult: number;
  stormGainMult: number;
  calmSwellRateMult: number;
  swellSwellRateMult: number;
  stormSwellRateMult: number;

  // ── one-shot: cannon boom ──
  cannonDuration: number;
  cannonLowpassStartHz: number;
  cannonLowpassEndHz: number;
  cannonNoiseGain: number;
  cannonSubHz: number;
  cannonSubGain: number;

  // ── one-shot: splash ──
  splashAttack: number;
  splashRelease: number;
  splashBandHz: number;
  splashQ: number;
  splashGain: number;

  // ── one-shot: creak (resonant saw pitch-bend, seeded random) ──
  creakBaseHz: number;
  /** end pitch = start pitch × this ratio (bend downward < 1) */
  creakBendRatio: number;
  /** ± random pitch spread in cents around creakBaseHz */
  creakSpreadCents: number;
  creakDuration: number;
  creakQ: number;
  creakGain: number;

  // ── one-shot: hull hit (thud) ──
  hullHitHz: number;
  hullHitDuration: number;
  hullHitGain: number;
}

export const audioParams: AudioParams = registerParams(
  'audio',
  {
    bedFadeTau: 1.6,
    bedDriftRateHz: 0.017,
    bedDriftDepth: 0.22,
    oceanBedGain: 0.75,
    windBedFloor: 0.1,
    windBedGain: 0.7,
    windRefKnots: 12,
    windRateSpread: 0.22,
    windBedCutoffMinHz: 700,
    windBedCutoffMaxHz: 9000,
    sailBedGain: 0.4,
    sailBedSpeedRef: 6,
    emitterRefDistance: 10,
    emitterMaxDistance: 350,
    emitterRolloff: 1.1,
    bowEmitterZ: 17,
    sternEmitterZ: -17,
    waterlineY: 0,
    foreMastEmitterZ: 10,
    mainMastEmitterZ: 0.5,
    rearMastEmitterZ: -10.5,
    sailEmitterY: 12,
    wakeGain: 0.8,
    wakeSpeedRef: 7,
    bowRushGain: 0.55,
    gurgleGain: 0.6,
    gurgleSpeedRef: 5,
    gurgleFloor: 0.25,
    creakLoopGain: 0.5,
    creakMotionRef: 0.35,
    creakFloor: 0.12,
    bowSplashGain: 0.85,
    bowSplashSliceSec: 1.1,
    bowSplashWindowSec: 40,
    bowSplashImmersionOn: 0.35,
    bowSplashImmersionOff: 0.12,
    bowSplashSpeedGate: 1.5,
    bowSplashCooldown: 0.7,
    sailSnapGain: 0.7,
    sailSnapLuffOn: 0.45,
    sailSnapLuffOff: 0.25,
    sailSnapCooldown: 1.1,
    sailSnapRateJitter: 0.18,
    trimSnapDelta: 0.06,
    sailDeployGain: 0.8,
    sailDeployDelta: 0.25,
    sailDeployCooldown: 2.5,
    luffWindRef: 9,
    luffTurnGain: 1.6,
    oceanGain: 0.5,
    oceanLowpassHz: 420,
    oceanNoiseLeak: 0.02,
    swellRateHz: 0.11,
    swellDepth: 0.55,
    windGainMax: 0.6,
    windCutoffMinHz: 260,
    windCutoffMaxHz: 1400,
    windQ: 0.9,
    windSpeedRef: 24,
    ambienceTau: 0.6,
    calmGainMult: 0.55,
    swellGainMult: 1.0,
    stormGainMult: 1.7,
    calmSwellRateMult: 0.7,
    swellSwellRateMult: 1.0,
    stormSwellRateMult: 1.8,
    cannonDuration: 1.2,
    cannonLowpassStartHz: 6000,
    cannonLowpassEndHz: 120,
    cannonNoiseGain: 0.9,
    cannonSubHz: 48,
    cannonSubGain: 0.9,
    splashAttack: 0.008,
    splashRelease: 0.35,
    splashBandHz: 900,
    splashQ: 1.2,
    splashGain: 0.6,
    creakBaseHz: 180,
    creakBendRatio: 0.7,
    creakSpreadCents: 300,
    creakDuration: 0.45,
    creakQ: 8,
    creakGain: 0.45,
    hullHitHz: 80,
    hullHitDuration: 0.28,
    hullHitGain: 0.8,
  },
  {
    bedFadeTau: { min: 0.1, max: 8, step: 0.1 },
    bedDriftRateHz: { min: 0.002, max: 0.2, step: 0.001 },
    bedDriftDepth: { min: 0, max: 1, step: 0.01 },
    oceanBedGain: { min: 0, max: 2, step: 0.01 },
    windBedFloor: { min: 0, max: 1, step: 0.01 },
    windBedGain: { min: 0, max: 2, step: 0.01 },
    windRefKnots: { min: 1, max: 40, step: 0.5 },
    windRateSpread: { min: 0, max: 0.5, step: 0.01 },
    windBedCutoffMinHz: { min: 100, max: 4000, step: 50 },
    windBedCutoffMaxHz: { min: 1000, max: 20000, step: 100 },
    sailBedGain: { min: 0, max: 2, step: 0.01 },
    sailBedSpeedRef: { min: 0.5, max: 20, step: 0.5 },
    emitterRefDistance: { min: 1, max: 60, step: 1 },
    emitterMaxDistance: { min: 50, max: 2000, step: 10 },
    emitterRolloff: { min: 0.1, max: 4, step: 0.05 },
    bowEmitterZ: { min: 0, max: 40, step: 0.5 },
    sternEmitterZ: { min: -40, max: 0, step: 0.5 },
    waterlineY: { min: -5, max: 5, step: 0.1 },
    foreMastEmitterZ: { min: -30, max: 30, step: 0.5 },
    mainMastEmitterZ: { min: -30, max: 30, step: 0.5 },
    rearMastEmitterZ: { min: -30, max: 30, step: 0.5 },
    sailEmitterY: { min: 0, max: 40, step: 0.5 },
    wakeGain: { min: 0, max: 2, step: 0.01 },
    wakeSpeedRef: { min: 0.5, max: 20, step: 0.5 },
    bowRushGain: { min: 0, max: 2, step: 0.01 },
    gurgleGain: { min: 0, max: 2, step: 0.01 },
    gurgleSpeedRef: { min: 0.5, max: 20, step: 0.5 },
    gurgleFloor: { min: 0, max: 1, step: 0.01 },
    creakLoopGain: { min: 0, max: 2, step: 0.01 },
    creakMotionRef: { min: 0.02, max: 2, step: 0.01 },
    creakFloor: { min: 0, max: 1, step: 0.01 },
    bowSplashGain: { min: 0, max: 2, step: 0.01 },
    bowSplashSliceSec: { min: 0.2, max: 4, step: 0.05 },
    bowSplashWindowSec: { min: 1, max: 60, step: 1 },
    bowSplashImmersionOn: { min: 0.02, max: 3, step: 0.01 },
    bowSplashImmersionOff: { min: 0, max: 3, step: 0.01 },
    bowSplashSpeedGate: { min: 0, max: 10, step: 0.1 },
    bowSplashCooldown: { min: 0.05, max: 5, step: 0.05 },
    sailSnapGain: { min: 0, max: 2, step: 0.01 },
    sailSnapLuffOn: { min: 0.05, max: 1.4, step: 0.01 },
    sailSnapLuffOff: { min: 0, max: 1.4, step: 0.01 },
    sailSnapCooldown: { min: 0.1, max: 8, step: 0.1 },
    sailSnapRateJitter: { min: 0, max: 0.6, step: 0.01 },
    trimSnapDelta: { min: 0.005, max: 0.5, step: 0.005 },
    sailDeployGain: { min: 0, max: 2, step: 0.01 },
    sailDeployDelta: { min: 0.05, max: 1, step: 0.01 },
    sailDeployCooldown: { min: 0.2, max: 10, step: 0.1 },
    luffWindRef: { min: 1, max: 40, step: 0.5 },
    luffTurnGain: { min: 0, max: 6, step: 0.1 },
    oceanGain: { min: 0, max: 1, step: 0.01 },
    oceanLowpassHz: { min: 80, max: 2000, step: 10 },
    oceanNoiseLeak: { min: 0.001, max: 0.2, step: 0.001 },
    swellRateHz: { min: 0.02, max: 1, step: 0.01 },
    swellDepth: { min: 0, max: 1, step: 0.01 },
    windGainMax: { min: 0, max: 1, step: 0.01 },
    windCutoffMinHz: { min: 50, max: 2000, step: 10 },
    windCutoffMaxHz: { min: 200, max: 6000, step: 10 },
    windQ: { min: 0.1, max: 10, step: 0.1 },
    windSpeedRef: { min: 1, max: 60, step: 1 },
    ambienceTau: { min: 0.05, max: 3, step: 0.05 },
    calmGainMult: { min: 0, max: 3, step: 0.05 },
    swellGainMult: { min: 0, max: 3, step: 0.05 },
    stormGainMult: { min: 0, max: 3, step: 0.05 },
    calmSwellRateMult: { min: 0.1, max: 4, step: 0.1 },
    swellSwellRateMult: { min: 0.1, max: 4, step: 0.1 },
    stormSwellRateMult: { min: 0.1, max: 4, step: 0.1 },
    cannonDuration: { min: 0.2, max: 3, step: 0.05 },
    cannonLowpassStartHz: { min: 500, max: 12000, step: 100 },
    cannonLowpassEndHz: { min: 40, max: 1000, step: 10 },
    cannonNoiseGain: { min: 0, max: 1, step: 0.01 },
    cannonSubHz: { min: 20, max: 120, step: 1 },
    cannonSubGain: { min: 0, max: 1, step: 0.01 },
    splashAttack: { min: 0.001, max: 0.1, step: 0.001 },
    splashRelease: { min: 0.05, max: 2, step: 0.01 },
    splashBandHz: { min: 200, max: 4000, step: 10 },
    splashQ: { min: 0.1, max: 10, step: 0.1 },
    splashGain: { min: 0, max: 1, step: 0.01 },
    creakBaseHz: { min: 40, max: 800, step: 5 },
    creakBendRatio: { min: 0.3, max: 2, step: 0.05 },
    creakSpreadCents: { min: 0, max: 1200, step: 10 },
    creakDuration: { min: 0.1, max: 2, step: 0.05 },
    creakQ: { min: 1, max: 30, step: 0.5 },
    creakGain: { min: 0, max: 1, step: 0.01 },
    hullHitHz: { min: 30, max: 300, step: 5 },
    hullHitDuration: { min: 0.05, max: 1, step: 0.01 },
    hullHitGain: { min: 0, max: 1, step: 0.01 },
  },
);
