/**
 * Pure mixing curves — sim state → layer gains / filter cutoffs / playback
 * rates. NO WebAudio, NO three.js: this is the whole "what should be audible
 * right now" decision, so it is unit-testable under plain node
 * (tests/audio.test.ts) and cheap enough to run every render frame (§V17).
 *
 * §V3: everything here READS sim values, never writes them. §V7: weather only
 * scales multipliers — calm|swell|storm walk the same code path.
 */
import { clamp01, lerp, lfoUnipolar } from './envelope';
import type { AudioParams } from '../params/audio';
import type { WeatherPresetName } from '../weather/presets';

/**
 * Type-only, so this file keeps its "no deps but envelope + params" promise
 * and stays runnable under plain node. It is the weather preset ladder itself
 * (src/weather/presets.ts) rather than a copy of three of its names — a copy
 * would let a new rung arrive with no audio at all and nothing would say so.
 */
export type Weather = WeatherPresetName;

/**
 * The ladder collapsed onto the three multiplier SETS the audio params carry
 * (`calm*`, `swell*`, `storm*`). Audio's weather response is genuinely
 * three-valued today; the ladder is seven-valued, so something has to map, and
 * an exhaustive `Record<Weather, …>` is the mapping that CANNOT silently miss
 * a rung — add one to the presets and this fails to compile instead of quietly
 * falling through to the swell bed (§V.62).
 *
 * The bands are by sea state, not by name: `glass` sits with `calm`, `breeze`
 * with the default `swell`, and everything from `squall` (Beaufort 7) up gets
 * the storm bed. The finer-grained answer is to drive the beds off the §V.46
 * `storm` scalar, which is already continuous and already sampled at the ship
 * — that is an audio change, not a preset one, and it is not attempted here.
 */
export const WEATHER_BAND: Readonly<
  Record<Weather, 'calm' | 'swell' | 'storm'>
> = {
  glass: 'calm',
  calm: 'calm',
  breeze: 'swell',
  swell: 'swell',
  squall: 'storm',
  gale: 'storm',
  storm: 'storm',
};

const MS_PER_KNOT = 0.514444;

/** x/ref clamped to 0..1 with a floored divisor (§V28) */
export function unit(x: number, ref: number): number {
  if (!Number.isFinite(x)) return 0;
  return clamp01(x / Math.max(1e-3, ref));
}

/** smoothstep 0..1 — used wherever a linear ramp would read as a switch */
export function smooth01(x: number): number {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

/** §V7: the preset only picks a multiplier, never a different code path */
export function weatherMult(weather: Weather, p: AudioParams): number {
  const band = WEATHER_BAND[weather] ?? 'swell';
  return band === 'calm' ? p.calmGainMult : band === 'storm' ? p.stormGainMult : p.swellGainMult;
}

export function weatherRateMult(weather: Weather, p: AudioParams): number {
  const band = WEATHER_BAND[weather] ?? 'swell';
  return band === 'calm'
    ? p.calmSwellRateMult
    : band === 'storm'
      ? p.stormSwellRateMult
      : p.swellSwellRateMult;
}

export interface BedEnv {
  /** m/s, from SimState.wind.speed */
  windSpeed: number;
  weather: Weather;
  /** ship horizontal speed m/s (0 when there is no ship yet) */
  shipSpeed: number;
  /** 0..1 hull working (hullWorking) — drives the wooden creak layer */
  working?: number;
}

export interface BedTargets {
  /** linear gains for the three looping ambience layers */
  ocean: number;
  wind: number;
  sailing: number;
  /** wooden hull creak, non-positional: the ship is AROUND the listener */
  creak: number;
  /** playbackRate for the wind layer — the recording's own 12 kn is 1.0 */
  windRate: number;
  /** lowpass cutoff (Hz) on the wind layer: light air is dull, gale is bright */
  windCutoffHz: number;
}

/**
 * Bed layer mix. The wind recording has a known capture wind speed
 * (windRefKnots), so mapping SimState wind onto it is a real anchor rather
 * than a guess: at the reference speed it plays at rate 1.0, and it is
 * pitched/filtered up or down from there.
 */
export function bedTargets(env: BedEnv, p: AudioParams): BedTargets {
  const w = unit(env.windSpeed, p.windSpeedRef);
  const gain = weatherMult(env.weather, p);
  const refMs = Math.max(0.5, p.windRefKnots * MS_PER_KNOT);
  const rateDev = Math.max(-1, Math.min(1, (env.windSpeed - refMs) / refMs));
  return {
    ocean: p.oceanBedGain * gain,
    wind: (p.windBedFloor + (p.windBedGain - p.windBedFloor) * smooth01(w)) * gain,
    // the general sailing bed comes up when the ship is actually moving
    sailing: p.sailBedGain * smooth01(unit(env.shipSpeed, p.sailBedSpeedRef)) * gain,
    // creak never goes to zero: a wooden ship at sea always works a little
    creak: p.creakBedGain * (p.creakFloor + (1 - p.creakFloor) * clamp01(env.working ?? 0)),
    windRate: 1 + p.windRateSpread * rateDev,
    windCutoffHz: lerp(p.windBedCutoffMinHz, p.windBedCutoffMaxHz, smooth01(w)),
  };
}

/**
 * Slow per-layer gain drift. Each layer gets its own phase (see bed.ts), so
 * the layers breathe against each other and the bed never lands back on the
 * same combination — the "don't let it feel like a 10 s tape" requirement.
 * Returns a multiplier in [1-depth, 1].
 */
export function driftFactor(phase: number, depth: number): number {
  return 1 - depth + depth * lfoUnipolar(phase);
}

export interface ShipAudioEnv {
  /** horizontal speed m/s */
  speed: number;
  /** 0..1 hull working (hullWorking) — rotation AND the sea running the planks */
  working: number;
}

export interface EmitterTargets {
  wake: number;
  bowRush: number;
  gurgle: number;
  creak: number;
}

/**
 * Positional loop gains. Wake/bow rush scale super-linearly with speed (water
 * noise grows faster than velocity), gurgle and creak keep a floor so a
 * drifting hull still sounds alive.
 */
export function emitterTargets(env: ShipAudioEnv, p: AudioParams): EmitterTargets {
  const s = unit(env.speed, p.wakeSpeedRef);
  const g = unit(env.speed, p.gurgleSpeedRef);
  const m = clamp01(env.working);
  return {
    wake: p.wakeGain * s * s,
    bowRush: p.bowRushGain * s * s,
    gurgle: p.gurgleGain * (p.gurgleFloor + (1 - p.gurgleFloor) * g),
    creak: p.creakLoopGain * (p.creakFloor + (1 - p.creakFloor) * m),
  };
}

/**
 * Live hull-contact sensor, structurally typed so main.ts can hand over
 * `hullContact` (sea-physics) unadapted and src/audio takes no dependency on
 * that module. Arrays are REUSED every tick by the producer — read, never
 * retain.
 */
export interface ContactInput {
  cutwater: { inContact: boolean; world: Vec3Like; depth: number; rate: number };
  /** per z slice, bow-most first */
  sliceDepth: ArrayLike<number>;
  sliceRate: ArrayLike<number>;
  wetFraction: number;
}

export type Vec3Like = ArrayLike<number>;

/**
 * How hard the hull is WORKING, 0..1 — the thing a wooden ship creaks about.
 * Two independent sources, whichever is larger: the ship's own angular rates
 * (roll/pitch) and how fast the sea is running up and down the planking
 * (mean |slice burial rate|). The second one matters because the hull keeps
 * working in a seaway even when the buoyancy solver has been damped down to a
 * calm ride — creak keyed to roll rate alone goes silent on a calm ship.
 */
export function hullWorking(
  rollRate: number,
  pitchRate: number,
  contact: ContactInput | null | undefined,
  p: AudioParams,
): number {
  const rot = unit(Math.abs(rollRate) + Math.abs(pitchRate), p.creakMotionRef);
  let sea = 0;
  if (contact) {
    const n = contact.sliceRate.length;
    let sum = 0;
    let wet = 0;
    for (let i = 0; i < n; i++) {
      if (contact.sliceDepth[i] <= 0) continue;
      const r = contact.sliceRate[i];
      if (Number.isFinite(r)) sum += Math.abs(r);
      wet++;
    }
    if (wet > 0) sea = unit(sum / wet, p.creakSeaRateRef);
  }
  return clamp01(Math.max(rot, sea));
}

/**
 * Slam signal (m/s): the fastest burial rate among the FORWARD slices — the
 * bow coming down onto the sea after a crest. Aft slices are excluded because
 * the run aft buries smoothly at speed and would hold the signal permanently
 * high. Same sensor the bow spray and the deck-water injection read, so the
 * bang lands in sync with the visuals by construction (§V27).
 */
export function slamSignal(contact: ContactInput | null | undefined, p: AudioParams): number {
  if (!contact) return 0;
  const n = contact.sliceRate.length;
  const forward = Math.max(1, Math.ceil(n * clamp01(p.slamStationFrac)));
  let best = 0;
  for (let i = 0; i < forward && i < n; i++) {
    if (contact.sliceDepth[i] <= 0) continue;
    const r = contact.sliceRate[i];
    if (Number.isFinite(r) && r > best) best = r;
  }
  const cut = contact.cutwater.inContact ? contact.cutwater.rate : 0;
  return Math.max(best, Number.isFinite(cut) ? cut : 0);
}

/** impact velocity → 0..1 loudness, with a floor so a light slap still lands */
export function slamStrength(rate: number, p: AudioParams): number {
  return clamp01(0.3 + 0.7 * smooth01(unit(rate, p.slamRateFull)));
}

export interface LuffInput {
  /** ship world forward (x, z) — +z convention of sailing/shipKinematics */
  forwardX: number;
  forwardZ: number;
  /** direction the wind blows TOWARD, radians (SimState.wind.direction) */
  windDirection: number;
  windSpeed: number;
  /** yaw rate rad/s */
  yawRate: number;
  /** 0..1, 0 = furled */
  trim: number;
}

/**
 * Audio-side luff estimate: how hard the canvas is shaking, 0..1. Mirrors the
 * conventions of ship/sailDynamics (wind vector = (sin d, cos d), along = +1
 * running, -1 in irons) but is deliberately its own copy — src/audio must not
 * depend on the sail material's per-object uniform path to decide when to
 * fire a snap. Furled sails never luff.
 */
export function luffEstimate(input: LuffInput, p: AudioParams): number {
  const len = Math.max(1e-4, Math.hypot(input.forwardX, input.forwardZ));
  const wx = Math.sin(input.windDirection);
  const wz = Math.cos(input.windDirection);
  const along = Math.max(-1, Math.min(1, (input.forwardX * wx + input.forwardZ * wz) / len));
  const press = Math.min(1, unit(input.windSpeed, p.luffWindRef));
  const notDrawing = 1 - smooth01((along - 0.02) / 0.5);
  const turning = Math.min(0.6, Math.abs(input.yawRate) * p.luffTurnGain * 0.6);
  return clamp01((notDrawing * press + turning) * clamp01(input.trim));
}

/**
 * Bow splash loudness once a splash is allowed to fire (§V27 thinking: the
 * gate is immersion + speed, the LEVEL is how deep and how fast).
 */
export function splashStrength(immersion: number, speed: number, p: AudioParams): number {
  const depth = smooth01(unit(immersion, p.bowSplashImmersionOn * 3));
  const fast = smooth01(unit(speed, p.wakeSpeedRef));
  return clamp01(0.35 + 0.65 * depth * (0.4 + 0.6 * fast));
}
