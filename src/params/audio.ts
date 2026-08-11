/**
 * Audio synth tunables (§V16: every tunable lives in a params module and
 * appears in Tweakpane; §V7 spirit: weather changes only scale params, never
 * switch code paths). Consumed by src/audio/*. Zero audio assets — all sound
 * is synthesized from these numbers.
 */
import { registerParams } from './registry';

export interface AudioParams {
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
