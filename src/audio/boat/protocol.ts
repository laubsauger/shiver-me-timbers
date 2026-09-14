/**
 * §T.183 main thread ⟷ boat worklet protocol, and the shared per-boat laws both sides read.
 * One file so the packer (boatAudio.ts) and the unpacker (synthCore.ts) cannot disagree on an
 * offset (V77). Pure: imported by the worklet bundle and by node tests.
 */
import { clamp, finite, smoothstep } from './dsp';
import { VOICE_KINDS, type GovernorMode, type VoiceKind } from './engineModel';

export const WORKLET_NAME = 'boat-audio';

/** outputs of the one AudioWorkletNode: player engine, player water, then NPC slots */
export const PLAYER_ENGINE_SLOT = 0;
export const PLAYER_WATER_SLOT = 1;
export const NPC_SLOTS = 7;
export const SLOT_COUNT = 2 + NPC_SLOTS;
/**
 * Cine SFX stems: after the slots, one WATER-ONLY output per NPC slot (the NPC slot outputs mix engine + water; the
 * player's two slots are already split). Silent until the page asks for stems (`{ t: 'stems', on: true }`), and never
 * part of the game mix: the slot outputs are sample-identical with stems on or off (tests/boatAudioSynth).
 */
export const STEM_WATER_OUTPUT0 = SLOT_COUNT;
export const OUTPUT_COUNT = SLOT_COUNT + NPC_SLOTS;
/** engines rendered per boat (triple outboards); turbine/electric boats use 1 */
export const MAX_ENGINES = 3;

/** per-boat input record */
export const BI = {
  ID: 0,
  KIND: 1,
  ENGINES: 2,
  THROTTLE: 3,
  GOVERNOR: 4,
  ADVANCE: 5, // ×3
  IMMERSION: 8, // ×3
  HAS_OVERRIDE: 11,
  RPM_OVERRIDE: 12, // ×3
  SPEED: 15,
  WET: 16,
  THRUST: 17,
  SLAM: 18,
  LANDING: 19,
  WAKE: 20,
  SEED: 21,
} as const;
export const BOAT_STRIDE = 22;

/** per-slot mix record */
export const SI = {
  BOAT: 0,
  FULL: 1,
  GAIN: 2,
  AIR_HZ: 3,
  MASK: 4,
} as const;
export const SLOT_STRIDE = 5;

export const LAYER_ENGINE = 1;
export const LAYER_WATER = 2;

/** per-boat report record (worklet → main, ~15 Hz) */
export const RI = { ID: 0, RPM: 1, CUT: 4, OVERRUN: 7, LOAD: 10 } as const;
export const REPORT_STRIDE = 13;

export const GOVERNORS: readonly GovernorMode[] = ['off', 'air', 'full'];

export function kindIndex(k: VoiceKind): number {
  const i = VOICE_KINDS.indexOf(k);
  return i < 0 ? 0 : i;
}
export function kindOf(i: number): VoiceKind {
  return VOICE_KINDS[clamp(Math.round(finite(i)), 0, VOICE_KINDS.length - 1)];
}
export function governorOf(i: number): GovernorMode {
  return GOVERNORS[clamp(Math.round(finite(i)), 0, GOVERNORS.length - 1)];
}

/** voice tunables the worklet needs; the main thread re-sends them when the params object changes (§V16) */
export interface VoiceTunables {
  engineGain: number;
  waterGain: number;
  hissGain: number;
  rushGain: number;
  sprayGain: number;
  howlGain: number;
  slapGain: number;
  landingGain: number;
  /** overrun pops per second at the start of a lift */
  popRate: number;
  gearWhineGain: number;
  /** idle cam lope depth, 0..1 */
  lopeDepth: number;
  /** muffled (through-hub) exhaust fades out between these advance speeds, m/s */
  muffleSpeedLo: number;
  muffleSpeedHi: number;
  /** planing hiss / spray reference speed, m/s */
  speedRef: number;
}

export const DEFAULT_VOICE_TUNABLES: Readonly<VoiceTunables> = Object.freeze({
  engineGain: 0.55,
  waterGain: 0.6,
  hissGain: 0.55,
  rushGain: 0.7,
  sprayGain: 0.5,
  howlGain: 0.35,
  slapGain: 1.0,
  landingGain: 1.2,
  popRate: 16,
  gearWhineGain: 0.018,
  lopeDepth: 1,
  muffleSpeedLo: 4,
  muffleSpeedHi: 14,
  speedRef: 42,
});

/**
 * UNDERWATER EXHAUST (design doc §7 "burble underwater at idle"). An outboard exhausts through the
 * prop hub: submerged and slow ⟹ the bank pulses reach the ear through water and hull (low, bubbly);
 * on the plane the hub runs in the cavity behind the transom and the bark comes out in air. Load
 * blows some of it through even at low speed. Speed shapes the TIMBRE here, never the pitch (V112).
 */
export function muffleAmount(immersion: number, advance: number, load: number, t: VoiceTunables): number {
  const wet = smoothstep(0.35, 0.9, finite(immersion, 1));
  const slow = 1 - smoothstep(t.muffleSpeedLo, Math.max(t.muffleSpeedLo + 0.1, t.muffleSpeedHi), finite(advance));
  return clamp(wet * slow * (1 - 0.35 * clamp(finite(load), 0, 1)), 0, 1);
}
