/**
 * §T.103 — THE RADIO'S VOICE, on the audio graph that already exists.
 *
 * §V95: ONE IMPLEMENTATION PER UTILITY. There is no second AudioContext, no
 * second bus set and no second noise generator here. The static is
 * `whiteNoiseBuffer` (audio/ambience.ts) through `createLoopLayer`
 * (audio/layer.ts) — the same de-zippered gain/cutoff/rate layer the wind bed
 * runs on — into a `createPanner` (audio/emitters.ts) HRTF node on the
 * AMBIENCE bus. The fragments are `playSample` (audio/sampleShot.ts) into a
 * second panner at the same point on the MUSIC bus, which is the split §T.103
 * asks for. Everything this file adds is the wiring.
 *
 * WHERE IT SOUNDS FROM: the `emitter-radio` socket on `radio-set` — the
 * speaker grille — not `station-radio`, which is a spot on the cabin FLOOR
 * that the player kneels at (§T.123). A voice at the player's own knees is a
 * voice that does not move when he does, and the whole point of an HRTF node
 * here is that walking out of the cabin puts the radio behind you.
 *
 * DECISIONS ARE UPSTREAM. This file contains no thresholds and no curves: it
 * is handed a `RadioSnapshot` and it writes numbers onto nodes. That is what
 * lets `tests/radio.test.ts` drive the REAL adapter against a stub context and
 * assert the graph moved (§B100), rather than asserting a callback was
 * registered.
 */
import { radioParams } from '../params/radio';
import { whiteNoiseBuffer } from '../audio/ambience';
import { decodeAudio } from '../audio/assets';
import { createPanner, setPannerPosition } from '../audio/emitters';
import { createLoopLayer, type LoopLayer } from '../audio/layer';
import { playSample } from '../audio/sampleShot';
import { LOCK_CHIME, radioClips, RADIO_STATIONS, type RadioStationDef } from './stations';
import type { RadioSnapshot } from './index';

const NOISE_SEED = 0x4a1d1a1;
/** the layer's own approach constant: fast enough to hear a sweep, slow enough not to zipper */
const TAU = 0.06;

export interface RadioAudioInput {
  snapshot: RadioSnapshot;
  /** the speaker's world position (the `emitter-radio` socket) */
  world: readonly [number, number, number];
}

export interface RadioAudio {
  update(input: RadioAudioInput | null | undefined, dt: number): void;
  /** how many clips have decoded — the loader is fire-and-forget (§V28) */
  loaded(): number;
  dispose(): void;
}

export interface RadioBuses {
  ambience: AudioNode;
  music: AudioNode;
}

export function createRadioAudio(
  ctx: BaseAudioContext,
  buses: RadioBuses,
  defs: readonly RadioStationDef[] = RADIO_STATIONS,
): RadioAudio {
  // §B115/§V96 — the set's OWN reference distance. Both panners take it, so
  // the hiss and the voice fade together as the player walks out of the cabin
  // instead of following him around the raft at full gain.
  const ref = { refDistance: radioParams.speakerRefM };
  const hiss = createPanner(ctx, buses.ambience, ref);
  const voice = createPanner(ctx, buses.music, ref);
  const bed: LoopLayer = createLoopLayer(ctx, hiss, { seed: NOISE_SEED, lowpass: true });
  bed.start(whiteNoiseBuffer(ctx, NOISE_SEED));

  // the clip cache, keyed on the manifest's own url — §V87: a swap is a file
  // drop plus a manifest edit, and nothing here knows a teaching from a chime
  const clips = new Map<string, AudioBuffer>();
  let disposed = false;
  // …fetched only where there IS a fetch. Under plain node every one of these
  // resolves to null through a warning, which buries a test run in stack
  // traces for a degradation that is working as designed — `music.ts` guards
  // on `document` for the same reason.
  if (typeof window !== 'undefined') {
    for (const ref of radioClips(defs)) {
      void decodeAudio(ctx, ref.src).then((buf) => {
        if (buf !== null && !disposed) clips.set(ref.src, buf);
      });
    }
  }
  const at = (src: string | null): AudioBuffer | null => (src === null ? null : clips.get(src) ?? null);

  return {
    update(input: RadioAudioInput | null | undefined, dt: number): void {
      if (disposed) return;
      if (input === null || input === undefined) {
        bed.update({ gain: 0 }, Math.max(0, dt), TAU);
        return;
      }
      const s = input.snapshot;
      const w = input.world;
      // re-read the ref every frame, like the shared distance params: §V16
      // wants the speaker's reach on a slider, not in a rebuild
      const live = { refDistance: radioParams.speakerRefM };
      setPannerPosition(hiss, w[0], w[1], w[2], live);
      setPannerPosition(voice, w[0], w[1], w[2], live);
      bed.update(
        { gain: s.mix.staticGain, cutoffHz: s.mix.staticHz, rate: s.mix.staticRate },
        Math.max(0, dt),
        TAU,
      );
      if (s.chime) {
        const chime = at(LOCK_CHIME.src);
        if (chime !== null) playSample(ctx, voice, chime, { gain: 0.5, fadeIn: 0.005, fadeOut: 0.08 });
      }
      if (s.play !== null) {
        const def = defs.find((d) => d.id === s.play!.station);
        const list = def === undefined ? [] : (s.play.night ? def.night : def.fragments);
        const ref = list.length === 0 ? null : list[s.play.clip % list.length];
        const buf = at(ref === null ? null : ref.src);
        // the fragment arrives at the gain the SIGNAL allows, so a station held
        // badly is heard badly — "you hear words through noise" (design doc §05)
        if (buf !== null) {
          playSample(ctx, voice, buf, { gain: Math.max(0.02, s.mix.voiceGain), fadeIn: 0.02, fadeOut: 0.15 });
        }
      }
    },
    loaded(): number {
      return clips.size;
    },
    dispose(): void {
      disposed = true;
      bed.dispose();
      hiss.disconnect();
      voice.disconnect();
      clips.clear();
    },
  };
}
