/**
 * §V86 — THE RADIO IS A PURE FUNCTION OF (freq, heading, dist, night).
 *
 * NOTHING HERE IMPORTS THREE.JS OR WEBAUDIO, and nothing here holds a mutable
 * module variable. The tuner takes numbers and returns numbers; the lock takes
 * a state and returns the next one. That is what makes the property tests in
 * `tests/radio.test.ts` able to say anything at all — a cardioid that is only
 * observable as a gain node's `.value` is a cardioid nobody can assert is
 * monotone.
 *
 * THE MODEL (design doc §05, "Tuning"):
 *
 *   signal = clarity(Δf) × strength(distance, bearing − heading, night)
 *
 * `clarity` is a narrow window on how far the dial is off the station's
 * frequency: 1 dead on, 0 outside `channelWidth`. `strength` is a distance
 * falloff times a cardioid on the raft's heading, because the wire aerial runs
 * fore-and-aft along the mast — turning the raft toward a voice brings it up,
 * which is the "directional radio replaces a quest marker with a skill" line
 * in the design doc. Night multiplies the RANGE, not the gain, so a station
 * that was inaudible at dusk arrives at midnight.
 *
 * NaN-SAFETY IS A CONTRACT, ⊥ A COURTESY (§V28). The raft's position comes off
 * a buoyancy integrator and the heading off a quaternion; either can hand this
 * a NaN on a bad frame, and a NaN signal would poison the lock state
 * permanently — a `> threshold` comparison against NaN is false forever, so
 * the radio would go quiet and never come back with nothing in the log. Every
 * entry point sanitises, and every exit is finite.
 */
import { radioParams, type RadioParams } from '../params/radio';

/** a broadcasting station: a fixed frequency at a fixed place. Stations do not move. */
export interface RadioStation {
  id: string;
  freqMHz: number;
  /** world metres */
  x: number;
  z: number;
}

/** everything the tuner is allowed to know about the world */
export interface TunerInput {
  /** where the dial is, MHz */
  freqMHz: number;
  /** the raft, world metres */
  x: number;
  z: number;
  /** the raft's heading, radians, the same convention as `yawOf` (atan2(fwd.x, fwd.z)) */
  headingRad: number;
  night: boolean;
}

export interface StationSignal {
  id: string;
  /** 0..1 — how close the dial is */
  clarity: number;
  /** 0..1 — how well the aerial hears it from here, pointed this way */
  strength: number;
  /** clarity × strength */
  signal: number;
  /** metres */
  distance: number;
  /** world bearing to the station, radians, same convention as `headingRad` */
  bearingRad: number;
}

export interface TunerReading {
  /** the strongest station, or null when the band is empty */
  best: StationSignal | null;
  /** the best station's signal, 0 when there is none */
  signal: number;
  /** every station, in the manifest's order — the chart marks these */
  stations: StationSignal[];
}

/** finite or the fallback: the one gate every public entry point runs (§V28) */
function num(v: number, fallback = 0): number {
  return Number.isFinite(v) ? v : fallback;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * The dial's 0..1 channel as a frequency. This is the ONE place the hold-turn
 * station's scalar becomes a physical quantity, so the prompt's readout
 * (`raftPrompt`) and the tuner cannot disagree about what "0.5" means.
 */
export function dialFrequency(channel: number, p: RadioParams = radioParams): number {
  const lo = num(p.bandLowMHz);
  const hi = num(p.bandHighMHz, lo + 1);
  return lo + clamp01(num(channel)) * (hi - lo);
}

/** …and back, so a station's frequency can be shown as a place on the dial */
export function frequencyChannel(freqMHz: number, p: RadioParams = radioParams): number {
  const lo = num(p.bandLowMHz);
  const hi = num(p.bandHighMHz, lo + 1);
  const span = hi - lo;
  return Math.abs(span) < 1e-9 ? 0 : clamp01((num(freqMHz, lo) - lo) / span);
}

/**
 * THE TUNING WINDOW. 1 at Δf = 0, falling to exactly 0 at `channelWidth` and
 * staying there — a station you have drifted off is GONE, not quiet, which is
 * what makes finding one feel like finding one.
 *
 * Strictly decreasing in |Δf| inside the window (the raised cosine is, and
 * raising it to a positive power preserves that), which is the property
 * `tests/radio.test.ts` pins rather than the exact curve (§V80).
 */
export function clarityOf(deltaMHz: number, p: RadioParams = radioParams): number {
  const w = Math.max(1e-6, num(p.channelWidth, 0.05));
  const d = Math.abs(num(deltaMHz, Infinity));
  if (!(d < w)) return 0;
  const hump = 0.5 + 0.5 * Math.cos((Math.PI * d) / w);
  return clamp01(Math.pow(hump, Math.max(0.05, num(p.channelShape, 1))));
}

/** how far this radio hears tonight, in metres of half-signal distance (§V86: night ×2) */
export function halfRange(night: boolean, p: RadioParams = radioParams): number {
  const base = Math.max(1, num(p.halfRangeM, 1000));
  return night ? base * Math.max(1, num(p.nightRangeMult, 2)) : base;
}

/**
 * DISTANCE FALLOFF. `1 / (1 + (d/half)²)` — half-signal at `half`, smooth
 * everywhere, never negative, and asymptotically inverse-square, which is what
 * a far-field radio actually does. Strictly decreasing in d for d ≥ 0.
 */
export function falloff(distanceM: number, night: boolean, p: RadioParams = radioParams): number {
  const d = Math.max(0, num(distanceM, Infinity));
  if (!Number.isFinite(d)) return 0;
  const r = d / halfRange(night, p);
  return 1 / (1 + r * r);
}

/**
 * THE AERIAL'S CARDIOID. `rel` is the station's bearing MINUS the raft's
 * heading, so 0 means dead ahead. Depth 0 is omnidirectional; depth 1 is a
 * true null astern.
 *
 * Monotone non-increasing in |rel| over [0, π], which is the property that
 * makes turning toward a voice a SKILL rather than a coin flip, and it is what
 * the test asserts — swinging the raft from astern to ahead must never make a
 * station quieter at any step (§V80: assert the property, not the cosine).
 */
export function cardioid(relRad: number, p: RadioParams = radioParams): number {
  const depth = clamp01(num(p.cardioidDepth, 0.5));
  const rel = num(relRad);
  return clamp01(1 - depth * 0.5 * (1 - Math.cos(rel)));
}

/** the world bearing from the raft to a point, in `headingRad`'s convention */
export function bearingTo(fromX: number, fromZ: number, toX: number, toZ: number): number {
  return Math.atan2(num(toX) - num(fromX), num(toZ) - num(fromZ));
}

/** wrap to (−π, π] so |rel| is a real angular difference */
export function wrapAngle(a: number): number {
  const x = num(a);
  const t = ((x + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  return t - Math.PI;
}

/** one station, heard from one place, pointed one way, at one hour */
export function stationSignal(
  station: RadioStation,
  input: TunerInput,
  p: RadioParams = radioParams,
): StationSignal {
  const dx = num(station.x) - num(input.x);
  const dz = num(station.z) - num(input.z);
  const distance = Math.hypot(dx, dz);
  const bearingRad = Math.atan2(dx, dz);
  const rel = wrapAngle(bearingRad - num(input.headingRad));
  const clarity = clarityOf(num(input.freqMHz, -1e9) - num(station.freqMHz, 1e9), p);
  const strength = clamp01(falloff(distance, input.night === true, p) * cardioid(rel, p));
  return { id: station.id, clarity, strength, signal: clamp01(clarity * strength), distance, bearingRad };
}

/** the whole band, read at once. Deterministic: same inputs, same numbers, no clock. */
export function readTuner(
  stations: readonly RadioStation[],
  input: TunerInput,
  p: RadioParams = radioParams,
): TunerReading {
  const out: StationSignal[] = [];
  let best: StationSignal | null = null;
  for (const s of stations) {
    const sig = stationSignal(s, input, p);
    out.push(sig);
    if (best === null || sig.signal > best.signal) best = sig;
  }
  return { best, signal: best === null ? 0 : best.signal, stations: out };
}

/**
 * THE LOCK, with dwell and hysteresis (§V86).
 *
 * Held as an explicit value the caller owns, so the whole behaviour is a pure
 * step function and a test can drive a hundred seconds of it in a loop without
 * a frame, a clock or a mock. `dwell` counts UP while the candidate holds above
 * `lockThreshold`; at `lockDwellSec` it becomes `locked`. It releases only when
 * the signal falls below `lockThreshold − lockHysteresis`, which is what stops
 * a station on the edge from chattering the chime on and off every frame.
 */
export interface LockState {
  /** the station currently accumulating dwell, if any */
  candidate: string | null;
  /** seconds the candidate has held above the threshold */
  dwell: number;
  /** the station that is locked, if any */
  locked: string | null;
}

export const NO_LOCK: LockState = { candidate: null, dwell: 0, locked: null };

/** what changed on this step — the caller turns these into a chime and a marker */
export interface LockStep {
  state: LockState;
  /** the station that locked ON this step (⊥ "is locked"), or null */
  gained: string | null;
  /** the station that let go on this step, or null */
  lost: string | null;
}

export function stepLock(
  state: LockState,
  best: StationSignal | null,
  dt: number,
  p: RadioParams = radioParams,
): LockStep {
  const step = Math.max(0, num(dt));
  const theta = clamp01(num(p.lockThreshold, 0.3));
  const release = Math.max(0, theta - Math.max(0, num(p.lockHysteresis, 0)));
  const dwellNeeded = Math.max(0, num(p.lockDwellSec, 2));
  const id = best === null ? null : best.id;
  const signal = best === null ? 0 : num(best.signal);

  // ALREADY LOCKED: it is the locked station's OWN signal that holds it, so a
  // second station rising nearby cannot steal the lock without the first
  // falling through the release floor first.
  if (state.locked !== null) {
    const held = id === state.locked ? signal : 0;
    if (held < release) {
      return { state: { candidate: null, dwell: 0, locked: null }, gained: null, lost: state.locked };
    }
    return { state, gained: null, lost: null };
  }

  if (id === null || signal < theta) {
    return {
      state: state.candidate === null && state.dwell === 0 ? state : { candidate: null, dwell: 0, locked: null },
      gained: null,
      lost: null,
    };
  }
  const dwell = (state.candidate === id ? state.dwell : 0) + step;
  if (dwell >= dwellNeeded) {
    return { state: { candidate: id, dwell, locked: id }, gained: id, lost: null };
  }
  return { state: { candidate: id, dwell, locked: null }, gained: null, lost: null };
}
