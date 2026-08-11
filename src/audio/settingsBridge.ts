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
import type { AudioSettings } from '../ui/settingsStore';

export interface VolumeSink {
  setVolumes(v: Partial<Volumes>): void;
}

export interface SettingsSource {
  get(): { audio: AudioSettings };
  subscribe(cb: (s: { audio: AudioSettings }) => void): () => void;
}

/** applies current volumes immediately; returns an unsubscribe */
export function attachAudioSettings(audio: VolumeSink, settings: SettingsSource): () => void {
  audio.setVolumes(settings.get().audio);
  return settings.subscribe((s) => audio.setVolumes(s.audio));
}
