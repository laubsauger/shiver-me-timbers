/**
 * AudioContext lifecycle + gain buses. Browsers block audio until a user
 * gesture, so the context is created lazily on the first resume() call;
 * attachGestureResume() wires a one-time pointerdown/keydown trigger.
 *
 * Bus graph (§I settings audio keys — master/sfx/ambience/music volumes):
 *
 *   [one-shots] → sfxGain ──────┐
 *   [ambience]  → ambienceGain ─┼→ masterGain → destination
 *   [music]     → musicGain ────┘
 *
 * Volumes are clamped to 0..1 and survive being set before the context
 * exists (applied on creation).
 */
import { clamp01 } from './envelope';

export interface Volumes {
  master: number;
  sfx: number;
  ambience: number;
  /** independent music bus — ducked under combat, see music.ts */
  music: number;
}

export interface EngineBuses {
  /** one-shots connect here */
  sfx: GainNode;
  /** looped beds connect here */
  ambience: GainNode;
  /** playlist tracks connect here (through the player's own duck gain) */
  music: GainNode;
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
    music: clamp01(initial?.music ?? 1),
  };
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let buses: EngineBuses | null = null;

  const applyVolumes = (): void => {
    if (!ctx || !master || !buses) return;
    master.gain.value = volumes.master;
    buses.sfx.gain.value = volumes.sfx;
    buses.ambience.gain.value = volumes.ambience;
    buses.music.gain.value = volumes.music;
  };

  return {
    getContext: () => ctx,
    getBuses: () => buses,
    async resume() {
      if (!ctx) {
        ctx = new AudioContext();
        master = ctx.createGain();
        master.connect(ctx.destination);
        buses = { sfx: ctx.createGain(), ambience: ctx.createGain(), music: ctx.createGain() };
        buses.sfx.connect(master);
        buses.ambience.connect(master);
        buses.music.connect(master);
        applyVolumes();
      }
      if (ctx.state !== 'running') await ctx.resume();
    },
    setVolumes(v) {
      if (v.master !== undefined) volumes.master = clamp01(v.master);
      if (v.sfx !== undefined) volumes.sfx = clamp01(v.sfx);
      if (v.ambience !== undefined) volumes.ambience = clamp01(v.ambience);
      if (v.music !== undefined) volumes.music = clamp01(v.music);
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
/**
 * Takes anything with a resume() — NOT necessarily the raw engine. The caller
 * must pass whichever resume actually builds the graph: resuming only the
 * AudioContext leaves the bed and emitters null, so update() sails past its
 * `ctx.state === 'running'` check and every layer is a no-op on a null object.
 * Silent, error-free, and indistinguishable from "audio is just quiet".
 */
export function attachGestureResume(
  engine: Pick<AudioEngine, 'resume'>,
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
