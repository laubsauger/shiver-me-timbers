/**
 * AudioContext lifecycle + gain buses. Browsers block audio until a user
 * gesture, so the context is created lazily on the first resume() call;
 * attachGestureResume() wires a one-time pointerdown/keydown trigger.
 *
 * Bus graph (§I settings audio keys — master/sfx/ambience volumes):
 *
 *   [one-shots] → sfxGain ──────┐
 *                               ├→ masterGain → destination
 *   [ambience]  → ambienceGain ─┘
 *
 * Volumes are clamped to 0..1 and survive being set before the context
 * exists (applied on creation).
 */
import { clamp01 } from './envelope';

export interface Volumes {
  master: number;
  sfx: number;
  ambience: number;
}

export interface EngineBuses {
  /** one-shots connect here */
  sfx: GainNode;
  /** looped beds connect here */
  ambience: GainNode;
}

export interface AudioEngine {
  /** null until the first resume() */
  getContext(): AudioContext | null;
  getBuses(): EngineBuses | null;
  /** lazily create the AudioContext (first call) and resume it */
  resume(): Promise<void>;
  setVolumes(v: Partial<Volumes>): void;
  /** current (clamped) volume settings — works before the context exists */
  getVolumes(): Volumes;
  dispose(): void;
}

export function createEngine(initial?: Partial<Volumes>): AudioEngine {
  const volumes: Volumes = {
    master: clamp01(initial?.master ?? 1),
    sfx: clamp01(initial?.sfx ?? 1),
    ambience: clamp01(initial?.ambience ?? 1),
  };
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let buses: EngineBuses | null = null;

  const applyVolumes = (): void => {
    if (!ctx || !master || !buses) return;
    master.gain.value = volumes.master;
    buses.sfx.gain.value = volumes.sfx;
    buses.ambience.gain.value = volumes.ambience;
  };

  return {
    getContext: () => ctx,
    getBuses: () => buses,
    async resume() {
      if (!ctx) {
        ctx = new AudioContext();
        master = ctx.createGain();
        master.connect(ctx.destination);
        buses = { sfx: ctx.createGain(), ambience: ctx.createGain() };
        buses.sfx.connect(master);
        buses.ambience.connect(master);
        applyVolumes();
      }
      if (ctx.state !== 'running') await ctx.resume();
    },
    setVolumes(v) {
      if (v.master !== undefined) volumes.master = clamp01(v.master);
      if (v.sfx !== undefined) volumes.sfx = clamp01(v.sfx);
      if (v.ambience !== undefined) volumes.ambience = clamp01(v.ambience);
      applyVolumes();
    },
    getVolumes: () => ({ ...volumes }),
    dispose() {
      if (ctx) void ctx.close();
      ctx = null;
      master = null;
      buses = null;
    },
  };
}

/**
 * One-time gesture unlock: first pointerdown or keydown anywhere calls
 * engine.resume(), then both listeners detach. Returns a cancel function
 * (also idempotent if the gesture already fired).
 */
export function attachGestureResume(
  engine: AudioEngine,
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> = window,
): () => void {
  const onGesture = (): void => {
    detach();
    void engine.resume();
  };
  const detach = (): void => {
    target.removeEventListener('pointerdown', onGesture);
    target.removeEventListener('keydown', onGesture);
  };
  target.addEventListener('pointerdown', onGesture);
  target.addEventListener('keydown', onGesture);
  return detach;
}
