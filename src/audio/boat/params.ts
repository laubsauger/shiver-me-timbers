/**
 * §T.183 boat audio tunables (§V16: registered, so the debug panel binds them live). Voice tunables
 * are forwarded to the worklet whenever they change; the rest is read on the main thread.
 */
import { registerParams } from '../../params/registry';
import { DEFAULT_VOICE_TUNABLES, type VoiceTunables } from './protocol';

export interface BoatAudioParams extends VoiceTunables {
  /** boat bus level into sfx, before the bus compressor */
  busGain: number;
  /** T212 ambience output level into the engine's ambience bus (no compressor) */
  ambienceGain: number;
  /**
   * §V96 DISTANCE LAW, measured against the space the boats sound in (see docs/speedboat/audio.md):
   * gain = (ref / max(ref, d))^rolloff with NO max-distance clamp. ref ≈ the size of the source
   * (a triple outboard cluster is ~1 m across), rolloff 1 = spherical spreading.
   */
  refDistance: number;
  rolloff: number;
  /** gain 1 at this distance (the chase camera's distance to the engines), m */
  unityDistance: number;
  /** air absorption (ISO 9613-1, 20 °C / 70 % RH fit): α(f) ≈ 3.7·(f/1 kHz)^1.65 dB/km; scale > 1 exaggerates */
  airAbsorptionScale: number;
  /** a boat beyond this is not given a voice at all, m */
  cullDistance: number;
  /** doppler delay smoothing (two cascaded one-poles, each τ/2), s */
  dopplerTau: number;
  /** DelayNode ceiling, s (343 m/s × this = the farthest propagation delay rendered) */
  maxDelay: number;
  /** a challenger must be this many times more audible to steal a slot/tier (hysteresis) */
  stealRatio: number;
  /** slot steal: fade time before the switch, s */
  stealFade: number;
  /** full voices among NPCs */
  fullNpcVoices: number;
  /** slam Δv (m/s, slamImpulse / mass) mapped 0 → 1 */
  slamDvMin: number;
  slamDvFull: number;
  /** minimum time between slap events, s */
  slamCooldown: number;
  /** airborne this long before a touchdown counts as a landing, s */
  landingMinAir: number;
  /** landing strength: vertical speed at touchdown for full, m/s */
  landingVyFull: number;
  /** engine emitter height above the telemetry position when none is given, m */
  engineEmitterY: number;
  /** engine cluster along the hull's body z from the CG (bow is +z, so the transom is negative), m */
  engineOffsetZ: number;
}

export const boatAudioParams: BoatAudioParams = registerParams(
  'boatAudio',
  {
    ...DEFAULT_VOICE_TUNABLES,
    // T212: was 0.9. The water layer's +6 dB raised the planing / landing mix ~1 dB (harness renders); this holds it
    busGain: 0.8,
    ambienceGain: 1,
    refDistance: 1.0,
    rolloff: 1.0,
    unityDistance: 8,
    airAbsorptionScale: 1.0,
    cullDistance: 1500,
    dopplerTau: 0.05,
    maxDelay: 2.5,
    stealRatio: 1.26,
    stealFade: 0.04,
    fullNpcVoices: 3,
    slamDvMin: 0.04,
    slamDvFull: 1.5,
    slamCooldown: 0.09,
    landingMinAir: 0.25,
    landingVyFull: 7,
    engineEmitterY: 0.8,
    engineOffsetZ: -4.6,
  },
  {
    engineGain: { min: 0, max: 2, step: 0.01 },
    waterGain: { min: 0, max: 2, step: 0.01 },
    hissGain: { min: 0, max: 2, step: 0.01 },
    rushGain: { min: 0, max: 2, step: 0.01 },
    sprayGain: { min: 0, max: 2, step: 0.01 },
    howlGain: { min: 0, max: 2, step: 0.01 },
    slapGain: { min: 0, max: 3, step: 0.01 },
    landingGain: { min: 0, max: 3, step: 0.01 },
    popRate: { min: 0, max: 60, step: 1 },
    gearWhineGain: { min: 0, max: 0.1, step: 0.001 },
    lopeDepth: { min: 0, max: 2, step: 0.01 },
    muffleSpeedLo: { min: 0, max: 20, step: 0.5 },
    muffleSpeedHi: { min: 1, max: 40, step: 0.5 },
    speedRef: { min: 10, max: 60, step: 1 },
    busGain: { min: 0, max: 2, step: 0.01 },
    ambienceGain: { min: 0, max: 2, step: 0.01 },
    windGain: { min: 0, max: 3, step: 0.01 },
    lapGain: { min: 0, max: 3, step: 0.01 },
    passGain: { min: 0, max: 3, step: 0.01 },
    washGain: { min: 0, max: 3, step: 0.01 },
    birdGain: { min: 0, max: 3, step: 0.01 },
    refDistance: { min: 0.25, max: 20, step: 0.25 },
    rolloff: { min: 0.3, max: 2, step: 0.05 },
    unityDistance: { min: 1, max: 40, step: 0.5 },
    airAbsorptionScale: { min: 0, max: 5, step: 0.1 },
    cullDistance: { min: 100, max: 5000, step: 50 },
    dopplerTau: { min: 0.005, max: 0.3, step: 0.005 },
    maxDelay: { min: 0.5, max: 5, step: 0.1 },
    stealRatio: { min: 1, max: 3, step: 0.01 },
    stealFade: { min: 0.01, max: 0.3, step: 0.01 },
    fullNpcVoices: { min: 0, max: 7, step: 1 },
    slamDvMin: { min: 0, max: 1, step: 0.01 },
    slamDvFull: { min: 0.1, max: 6, step: 0.05 },
    slamCooldown: { min: 0, max: 0.5, step: 0.01 },
    landingMinAir: { min: 0.05, max: 2, step: 0.05 },
    landingVyFull: { min: 1, max: 20, step: 0.5 },
    engineEmitterY: { min: -1, max: 3, step: 0.05 },
    engineOffsetZ: { min: -8, max: 2, step: 0.1 },
  },
);
