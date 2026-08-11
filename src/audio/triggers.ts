/**
 * Event gating for one-shots — pure state machines, no WebAudio.
 *
 * WHY this is its own module: a one-shot fired straight off a threshold
 * machine-guns. The bow immersion sensor crosses its threshold on every wave
 * face, sail luff jitters around its trigger point, trim moves a little every
 * frame the key is held. Hysteresis (separate on/off levels) + a cooldown +
 * per-fire jitter is the difference between "the bow slams into a wave" and a
 * buzzing stream of clicks. §V27's deck-water thinking, applied to audio.
 *
 * Configs are read through a getter on every step so Tweakpane edits to
 * params/audio.ts take effect live (§V16).
 */
import type { Rng } from '../state/rng';

export interface GateConfig {
  /** fire when the signal rises to/above this */
  on: number;
  /** re-arm only after the signal falls below this (must be ≤ on) */
  off: number;
  /** minimum seconds between two fires */
  cooldown: number;
  /** keep firing every cooldown while the signal stays above `on` */
  repeat?: boolean;
  /** ±fraction randomization of the cooldown, needs an rng (0 = exact) */
  jitter?: number;
}

export interface GatedTrigger {
  /**
   * @param value   sensor level (immersion m, luff 0..1, …)
   * @param dt      seconds since the last step
   * @param enabled external gate (speed gate, sails furled, …) — time still
   *                accumulates while disabled so re-entry is not penalized
   */
  step(value: number, dt: number, enabled?: boolean): boolean;
  reset(): void;
  /** seconds until the next fire is permitted (0 = ready) */
  cooldownRemaining(): number;
}

export function createGatedTrigger(config: () => GateConfig, rng?: Rng): GatedTrigger {
  let armed = true;
  let sinceFire = Number.POSITIVE_INFINITY;
  let gap = 0;

  const nextGap = (cfg: GateConfig): number => {
    const j = cfg.jitter ?? 0;
    if (j <= 0 || !rng) return cfg.cooldown;
    return Math.max(0.01, cfg.cooldown * (1 + j * (rng() * 2 - 1)));
  };

  return {
    step(value, dt, enabled = true) {
      const cfg = config();
      sinceFire += dt;
      if (!Number.isFinite(value)) return false;
      if (value < cfg.off) armed = true;
      if (!enabled) return false;
      if (sinceFire < gap) return false;
      if (value < cfg.on) return false;
      if (!armed && !cfg.repeat) return false;
      armed = false;
      sinceFire = 0;
      gap = nextGap(cfg);
      return true;
    },
    reset() {
      armed = true;
      sinceFire = Number.POSITIVE_INFINITY;
      gap = 0;
    },
    cooldownRemaining() {
      return Math.max(0, gap - sinceFire);
    },
  };
}

export interface DeltaConfig {
  /** |value − value at last fire| that counts as a change */
  delta: number;
  cooldown: number;
}

/**
 * Fires on a step change of a continuous control (sail trim). Returns +1 when
 * the value rose by `delta` (sail being set → deploy sound), -1 when it fell
 * (being furled → canvas snap), 0 for no event. Comparing against the value at
 * the LAST FIRE rather than the last frame means a slow continuous haul fires
 * once per `delta` of travel instead of once per frame.
 */
export interface DeltaTrigger {
  step(value: number, dt: number): -1 | 0 | 1;
  reset(value: number): void;
}

export function createDeltaTrigger(config: () => DeltaConfig, initial = 0): DeltaTrigger {
  let anchor = initial;
  let sinceFire = Number.POSITIVE_INFINITY;

  return {
    step(value, dt) {
      const cfg = config();
      sinceFire += dt;
      if (!Number.isFinite(value)) return 0;
      const diff = value - anchor;
      if (Math.abs(diff) < cfg.delta) return 0;
      if (sinceFire < cfg.cooldown) {
        // still inside the cooldown: track the value so the fire that finally
        // lands reflects where the control actually is now
        anchor = value;
        return 0;
      }
      anchor = value;
      sinceFire = 0;
      return diff > 0 ? 1 : -1;
    },
    reset(value) {
      anchor = value;
      sinceFire = Number.POSITIVE_INFINITY;
    },
  };
}
