/**
 * §T.183 main-thread mixing decisions, pure (node-tested): telemetry types and packing, distance
 * law + air absorption (§V96), doppler delay tracking and AudioParam ramp timing, NPC voice
 * stealing/prioritisation, and slam/landing event detection. No WebAudio in this file.
 */
import { clamp, finite, smoothstep } from './dsp';
import { BI, BOAT_STRIDE, GOVERNORS, MAX_ENGINES, kindIndex } from './protocol';
import type { GovernorMode, VoiceKind } from './engineModel';
import type { BoatAudioParams } from './params';

export const SPEED_OF_SOUND = 343;

export type Vec3Like = ArrayLike<number>;

/**
 * One boat, one render frame. Field names follow `HullWater` so the player's wiring is a straight
 * copy (docs/speedboat/audio.md); the NPC worker path has only `propImmersion` and the pose, and
 * every per-drive field is optional for that reason.
 */
export interface BoatFrameTelemetry {
  /** stable per boat, ≥ 0 */
  id: number;
  isPlayer?: boolean;
  voice: VoiceKind;
  /** engines rendered (default: 3 for v8/twoStroke, 1 for turbine/electric) */
  engines?: number;
  /** CG world position, m */
  position: Vec3Like;
  /** CG world velocity, m/s (event detection + fallback advance; NEVER a pitch) */
  velocity: Vec3Like;
  /** world position of the engine cluster (e.g. mean of `hw.driveProp` + up); default: position + engineEmitterY */
  enginePosition?: Vec3Like;
  /** throttle as applied to the drives, −0.3..1 */
  throttle: number;
  governor?: GovernorMode;
  /** hullWater `driveAdvance` (m/s per drive) */
  driveAdvance?: ArrayLike<number>;
  /** hullWater `driveImmersion` (0..1 per drive) */
  driveImmersion?: ArrayLike<number>;
  /** hullWater `driveThrust` (N per drive, signed) */
  driveThrust?: ArrayLike<number>;
  /** sim-worker `PROP_IMMERSION` when per-drive data is not available */
  propImmersion?: number;
  /** hullWater `wettedArea`, m² (0 ⟹ airborne) */
  wettedArea: number;
  /** Σ hullWater `slamImpulse` over the sim ticks this frame covered, N·s */
  slamImpulse: number;
  /** boat mass, kg (default 5350) */
  mass?: number;
  /** 0..1 wake-crossing strength this frame, if the wake system reports one */
  wakeCrossing?: number;
  /** sim-published drive rpm, if any — overrides the audio rpm model (V77) */
  rpm?: ArrayLike<number>;
}

export const DEFAULT_BOAT_MASS = 5350;
/** planing wetted area that reads as "fully wet" for hiss, m² */
export const WET_AREA_REF = 6;
/** Σ|thrust| that reads as full prop wash (3 × ~15 kN static), N */
export const THRUST_REF = 45000;

export function defaultEngines(kind: VoiceKind): number {
  return kind === 'turbine' || kind === 'electric' ? 1 : 3;
}

// ───────────────────────────── distance ─────────────────────────────

/**
 * §V96: spherical spreading from the source's own size, no max-distance plateau. Unity gain sits at
 * `unityDistance` (the chase camera's distance to the engines), so the voices keep their mixed level
 * in the default view; closer than that (cockpit) is louder, clamped at `refDistance`.
 */
export function distanceGain(d: number, p: Pick<BoatAudioParams, 'refDistance' | 'rolloff' | 'unityDistance'>): number {
  const ref = Math.max(0.05, p.refDistance);
  const dd = Math.max(ref, finite(d, ref));
  return Math.pow(Math.max(ref, p.unityDistance) / dd, clamp(p.rolloff, 0.1, 4));
}

/**
 * Air absorption as a one-pole cutoff: the frequency whose ISO 9613-1 attenuation over d reaches
 * 3 dB. α(f) = 3.7·(f/1 kHz)^1.65 dB/km (20 °C, 70 % RH, fits 1–8 kHz) ⟹ f_c = 1 kHz·(810.8/(d·s))^(1/1.65).
 */
export function airAbsorptionCutoffHz(d: number, scale: number): number {
  const ds = Math.max(1e-3, finite(d, 0) * Math.max(0, scale));
  return clamp(1000 * Math.pow(810.8 / ds, 1 / 1.65), 500, 18000);
}

// ───────────────────────────── doppler ─────────────────────────────

/**
 * Propagation delay for a moving source. Reading x(t − τ) with τ = d/c gives a pitch ratio 1 − ḋ/c,
 * which is the MOVING-LISTENER formula; a moving source needs the retarded distance,
 * τ = d/(c + ḋ), whose slope ḋ/(c + ḋ) gives exactly c/(c + ḋ): ×1.132 approaching at 40 m/s,
 * ×0.896 receding. Two cascaded one-poles keep the slope continuous (a single one-pole re-targeted
 * every frame has a slope that jumps by dt/τ at each frame ⟹ audible 60 Hz FM).
 */
export class DopplerTrack {
  delay = 0;
  private stage = 0;
  private lastDist = 0;
  private rate = 0;
  private lastTarget = 0;
  private primed = false;
  reset(distance: number, maxDelay: number): void {
    const d = Math.max(0, finite(distance));
    this.delay = this.stage = this.lastTarget = Math.min(maxDelay, d / SPEED_OF_SOUND);
    this.lastDist = d;
    this.rate = 0;
    this.primed = true;
  }
  step(distance: number, dt: number, tau: number, maxDelay: number): number {
    const d = Math.max(0, finite(distance));
    if (!this.primed || !(dt > 0)) {
      if (!this.primed) this.reset(d, maxDelay);
      return this.delay;
    }
    const instRate = clamp((d - this.lastDist) / dt, -0.5 * SPEED_OF_SOUND, SPEED_OF_SOUND);
    this.lastDist = d;
    this.rate += (instRate - this.rate) * (1 - Math.exp(-dt / 0.06));
    const target = Math.min(maxDelay, d / (SPEED_OF_SOUND + this.rate));
    // RAMP-INVARIANT one-poles: the input is treated as linear across the frame, not held. A held
    // (zero-order) input makes the lag depend on dt, so ±30 % frame jitter became ±1.7 % pitch wobble.
    const tc = Math.max(1e-3, tau * 0.5);
    const e = Math.exp(-dt / tc);
    const ramp = 1 - (tc / dt) * (1 - e);
    const s0 = this.stage;
    this.stage = e * s0 + (1 - e) * this.lastTarget + (target - this.lastTarget) * ramp;
    this.delay = e * this.delay + (1 - e) * s0 + (this.stage - s0) * ramp;
    this.lastTarget = target;
    return this.delay;
  }
}

/**
 * When to place this frame's `linearRampToValueAtTime` event. Event spacing follows the RENDER dt
 * (the clock the positions were sampled on), so a constant-velocity pass-by is a straight line in
 * the automation; a 5 % pull toward `ctxTime + lookahead` absorbs drift between the two clocks.
 */
export class RampClock {
  private t = -1;
  next(ctxTime: number, dt: number, lookahead = 0.03): number {
    const want = ctxTime + lookahead;
    if (this.t < 0 || Math.abs(this.t + dt - want) > 0.1) this.t = want;
    else this.t = this.t + dt + 0.05 * (want - (this.t + dt));
    if (this.t <= ctxTime + 0.002) this.t = ctxTime + 0.002;
    return this.t;
  }
}

// ───────────────────────────── voices ─────────────────────────────

export interface VoiceCandidate {
  id: number;
  /** audibility: distance gain × activity */
  score: number;
  /** propagation delay the slot's DelayNode will hold, s */
  delay: number;
}

export type SlotPhase = 'idle' | 'playing' | 'fadeOut' | 'wait';

export interface NpcSlot {
  /** the boat the worklet renders on this slot (−1 none) */
  boat: number;
  /** the boat queued to take over after the fade (−1 = go idle) */
  next: number;
  phase: SlotPhase;
  timer: number;
  full: boolean;
  /** true on the frame the boat changed: the DelayNode must be set instantly, not ramped */
  switched: boolean;
}

export function createNpcSlots(n: number): NpcSlot[] {
  return Array.from({ length: n }, () => ({ boat: -1, next: -1, phase: 'idle' as SlotPhase, timer: 0, full: false, switched: false }));
}

/**
 * Voice stealing with hysteresis. A slot changes boat only through fade → switch → wait-for-the-
 * propagation-delay → play, so the post-delay gain is 0 while the DelayNode's buffer still holds the
 * previous boat's sound (a switch without the wait replays the old boat for up to `delay` seconds).
 * Full voices go to the `fullNpcVoices` most audible playing slots, again with hysteresis.
 */
export function assignNpcSlots(
  slots: NpcSlot[],
  candidates: readonly VoiceCandidate[],
  dt: number,
  p: Pick<BoatAudioParams, 'stealRatio' | 'stealFade' | 'fullNpcVoices'>,
): void {
  const byId = new Map<number, VoiceCandidate>();
  for (const c of candidates) byId.set(c.id, c);
  const sorted = [...candidates].sort((a, b) => b.score - a.score || a.id - b.id);
  const wanted = sorted.slice(0, slots.length);
  const wantedIds = new Set(wanted.map((c) => c.id));
  const claimed = (id: number): boolean => slots.some((s) => (s.phase !== 'idle' && s.boat === id && s.phase !== 'fadeOut') || s.next === id);
  const scoreOf = (id: number): number => byId.get(id)?.score ?? 0;

  for (const s of slots) s.switched = false;

  // a boat that is gone or no longer audible enough to be wanted fades out
  for (const s of slots) {
    if ((s.phase === 'playing' || s.phase === 'wait') && !byId.has(s.boat)) {
      s.phase = 'fadeOut';
      s.next = -1;
      s.timer = p.stealFade;
    }
  }
  for (const c of wanted) {
    if (claimed(c.id)) continue;
    const free = slots.find((s) => s.phase === 'idle');
    if (free) {
      free.boat = c.id;
      free.next = -1;
      free.phase = 'wait';
      free.timer = c.delay;
      free.switched = true;
      continue;
    }
    // steal the least audible playing slot that is not wanted, or clearly weaker
    let victim: NpcSlot | null = null;
    for (const s of slots) {
      if (s.phase !== 'playing') continue;
      const weaker = !wantedIds.has(s.boat) || scoreOf(s.boat) * p.stealRatio < c.score;
      if (!weaker) continue;
      if (!victim || scoreOf(s.boat) < scoreOf(victim.boat)) victim = s;
    }
    if (victim && scoreOf(victim.boat) * p.stealRatio < c.score) {
      victim.phase = 'fadeOut';
      victim.next = c.id;
      victim.timer = p.stealFade;
    }
  }
  for (const s of slots) {
    if (s.phase === 'fadeOut') {
      s.timer -= dt;
      if (s.timer <= 0) {
        if (s.next >= 0 && byId.has(s.next)) {
          s.boat = s.next;
          s.phase = 'wait';
          s.timer = byId.get(s.next)!.delay;
          s.switched = true;
        } else {
          s.boat = -1;
          s.phase = 'idle';
          s.full = false;
        }
        s.next = -1;
      }
    } else if (s.phase === 'wait') {
      s.timer -= dt;
      if (s.timer <= 0) s.phase = 'playing';
    }
  }
  // tiers
  const live = slots.filter((s) => s.boat >= 0 && s.phase !== 'idle').sort((a, b) => scoreOf(b.boat) - scoreOf(a.boat));
  const k = clamp(Math.round(p.fullNpcVoices), 0, slots.length);
  const top = new Set(live.slice(0, k));
  for (const s of live) {
    if (top.has(s) === s.full) continue;
    if (!s.full) {
      // promote only if the weakest current full voice is clearly quieter (or there is room)
      const fulls = live.filter((x) => x.full);
      if (fulls.length < k) s.full = true;
      else {
        const weakest = fulls.reduce((a, b) => (scoreOf(a.boat) < scoreOf(b.boat) ? a : b));
        if (scoreOf(weakest.boat) * p.stealRatio < scoreOf(s.boat)) {
          weakest.full = false;
          s.full = true;
        }
      }
    }
  }
  for (const s of slots) if (s.boat < 0) s.full = false;
}

// ───────────────────────────── events ─────────────────────────────

export interface BoatEvents {
  slam: number;
  landing: number;
  wake: number;
  airborne: boolean;
}

export class BoatEventDetector {
  private airTime = 0;
  private cool = 0;
  private vy = 0;
  readonly out: BoatEvents = { slam: 0, landing: 0, wake: 0, airborne: false };
  step(tel: BoatFrameTelemetry, dt: number, p: Pick<BoatAudioParams, 'slamDvMin' | 'slamDvFull' | 'slamCooldown' | 'landingMinAir' | 'landingVyFull'>): BoatEvents {
    const o = this.out;
    o.slam = o.landing = 0;
    o.wake = clamp(finite(tel.wakeCrossing ?? 0), 0, 1.5);
    const h = Math.max(0, finite(dt));
    this.cool -= h;
    const airborne = !(finite(tel.wettedArea) > 1e-3);
    o.airborne = airborne;
    if (airborne) {
      this.airTime += h;
      this.vy = finite(tel.velocity[1]);
    } else {
      if (this.airTime >= p.landingMinAir) {
        o.landing = clamp(0.2 + (0.8 * Math.max(0, -this.vy)) / Math.max(0.1, p.landingVyFull), 0.2, 1.5);
        this.cool = p.slamCooldown;
      }
      this.airTime = 0;
    }
    const dv = Math.abs(finite(tel.slamImpulse)) / Math.max(100, finite(tel.mass ?? DEFAULT_BOAT_MASS, DEFAULT_BOAT_MASS));
    if (o.landing === 0 && dv > p.slamDvMin && this.cool <= 0) {
      o.slam = 0.15 + 0.85 * Math.pow(smoothstep(p.slamDvMin, Math.max(p.slamDvMin + 1e-3, p.slamDvFull), dv), 0.7);
      this.cool = p.slamCooldown;
    }
    return o;
  }
}

// ───────────────────────────── packing ─────────────────────────────

function at(a: ArrayLike<number> | undefined, i: number, fallback: number): number {
  if (!a || a.length === 0) return fallback;
  return finite(a[Math.min(i, a.length - 1)], fallback);
}

/** horizontal speed along the ground, m/s — fallback prop advance only when the sim has no drive data */
export function horizontalSpeed(v: Vec3Like): number {
  return Math.hypot(finite(v[0]), finite(v[2]));
}

export function packBoat(tel: BoatFrameTelemetry, ev: BoatEvents, out: Float32Array, index: number, seed: number): void {
  const o = index * BOAT_STRIDE;
  const engines = clamp(Math.round(finite(tel.engines ?? defaultEngines(tel.voice), 3)), 1, MAX_ENGINES);
  const speed = Math.hypot(finite(tel.velocity[0]), finite(tel.velocity[1]), finite(tel.velocity[2]));
  const hSpeed = horizontalSpeed(tel.velocity);
  out[o + BI.ID] = tel.id;
  out[o + BI.KIND] = kindIndex(tel.voice);
  out[o + BI.ENGINES] = engines;
  out[o + BI.THROTTLE] = clamp(finite(tel.throttle), -1, 1);
  out[o + BI.GOVERNOR] = Math.max(0, GOVERNORS.indexOf(tel.governor ?? 'off'));
  const immDefault = clamp(finite(tel.propImmersion ?? 1, 1), 0, 1);
  let thrust = 0;
  for (let e = 0; e < MAX_ENGINES; e++) {
    out[o + BI.ADVANCE + e] = clamp(at(tel.driveAdvance, e, hSpeed), 0, 80);
    out[o + BI.IMMERSION + e] = clamp(at(tel.driveImmersion, e, immDefault), 0, 1);
    out[o + BI.RPM_OVERRIDE + e] = clamp(at(tel.rpm, e, 0), 0, 20000);
  }
  if (tel.driveThrust && tel.driveThrust.length > 0) {
    for (let e = 0; e < tel.driveThrust.length; e++) thrust += Math.abs(finite(tel.driveThrust[e]));
    thrust /= THRUST_REF;
  } else {
    thrust = Math.abs(finite(tel.throttle)) * immDefault;
  }
  out[o + BI.HAS_OVERRIDE] = tel.rpm && tel.rpm.length > 0 ? 1 : 0;
  out[o + BI.SPEED] = clamp(speed, 0, 120);
  out[o + BI.WET] = clamp(finite(tel.wettedArea) / WET_AREA_REF, 0, 1);
  out[o + BI.THRUST] = clamp(thrust, 0, 2);
  out[o + BI.SLAM] = ev.slam;
  out[o + BI.LANDING] = ev.landing;
  out[o + BI.WAKE] = ev.wake;
  out[o + BI.SEED] = seed;
}

/** a boat's audibility for prioritisation: distance law × how hard it is working */
export function audibility(gain: number, throttle: number): number {
  return gain * (0.45 + 0.55 * clamp(Math.abs(finite(throttle)), 0, 1));
}
