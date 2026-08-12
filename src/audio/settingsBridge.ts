/**
 * Settings → audio buses (§I: master/sfx/ambience volumes persisted to
 * localStorage; §V21: settings survive reload).
 *
 * The store already owns clamping and persistence, so this is deliberately
 * one-way and tiny: push the stored volumes into the buses now, then again on
 * every change. Kept out of index.ts so main.ts's wiring is a single call and
 * the audio system itself never imports the UI at runtime (type-only import).
 */
import type { Volumes } from './engine';

export interface VolumeSink {
  setVolumes(v: Partial<Volumes>): void;
}

/**
 * Structural, and Partial on purpose: the settings screens gain a `music`
 * control independently of this file, and a store that does not carry a key
 * yet must simply leave that bus at its default rather than fail to compile.
 */
export interface SettingsSource {
  get(): { audio: Partial<Volumes> };
  subscribe(cb: (s: { audio: Partial<Volumes> }) => void): () => void;
}

/** applies current volumes immediately; returns an unsubscribe */
export function attachAudioSettings(audio: VolumeSink, settings: SettingsSource): () => void {
  audio.setVolumes(settings.get().audio);
  return settings.subscribe((s) => audio.setVolumes(s.audio));
}
