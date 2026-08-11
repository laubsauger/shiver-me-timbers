/**
 * Procedural audio system facade (T21). main.ts creates one AudioSystem and
 * calls update() every render frame with {windSpeed: state.wind.speed,
 * weather: state.weather} pulled from SimState — audio only READS sim data,
 * never writes it (§V3 one-way flow). Everything is synthesized at runtime:
 * zero audio asset files. Volume keys match §I settings (master/sfx/
 * ambience) so the settings store can call setVolumes directly.
 *
 * Browsers gate audio behind a user gesture: createAudio() auto-attaches a
 * one-time pointerdown/keydown unlock; play()/update() are safe no-ops until
 * the context is running.
 */
import { createAmbience, type Ambience, type AmbienceEnv } from './ambience';
import { attachGestureResume, createEngine, type Volumes } from './engine';
import { cannonBoom, creak, hullHit, splash } from './oneshots';
import { createRng, type Rng } from '../state/rng';

export type { AmbienceEnv } from './ambience';
export type { Volumes } from './engine';

export type OneShotName = 'cannonBoom' | 'splash' | 'creak' | 'hullHit';

export interface PlayOpts {
  /** seeded rng for randomized one-shots (creak); defaults to an internal seeded stream */
  rng?: Rng;
}

export interface AudioSystem {
  /** create/resume the AudioContext (also fired by the auto gesture unlock) */
  resume(): Promise<void>;
  /** call once per frame with wind/weather read from SimState */
  update(env: AmbienceEnv, dt: number): void;
  play(name: OneShotName, opts?: PlayOpts): void;
  setVolumes(v: Partial<Volumes>): void;
  dispose(): void;
}

const DEFAULT_RNG_SEED = 0xc0ffee;

export function createAudio(initialVolumes?: Partial<Volumes>): AudioSystem {
  const engine = createEngine(initialVolumes);
  let ambience: Ambience | null = null;
  const fallbackRng = createRng(DEFAULT_RNG_SEED);
  const detachGesture =
    typeof window !== 'undefined' ? attachGestureResume(engine) : () => undefined;

  const resume = async (): Promise<void> => {
    await engine.resume();
    const ctx = engine.getContext();
    const buses = engine.getBuses();
    if (!ambience && ctx && buses) ambience = createAmbience(ctx, buses.ambience);
  };

  return {
    resume,
    update(env, dt) {
      ambience?.update(env, dt);
    },
    play(name, opts) {
      const ctx = engine.getContext();
      const buses = engine.getBuses();
      if (!ctx || !buses || ctx.state !== 'running') return; // pre-gesture: no-op
      switch (name) {
        case 'cannonBoom':
          cannonBoom(ctx, buses.sfx);
          break;
        case 'splash':
          splash(ctx, buses.sfx);
          break;
        case 'creak':
          creak(ctx, buses.sfx, opts?.rng ?? fallbackRng);
          break;
        case 'hullHit':
          hullHit(ctx, buses.sfx);
          break;
      }
    },
    setVolumes(v) {
      engine.setVolumes(v);
    },
    dispose() {
      detachGesture();
      ambience?.dispose();
      ambience = null;
      engine.dispose();
    },
  };
}
