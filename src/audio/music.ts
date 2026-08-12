/**
 * Music player — STREAMING, deliberately not the sample path.
 *
 *   <audio src=…> ─ MediaElementSource → deckGain ┐
 *   <audio src=…> ─ MediaElementSource → deckGain ┼→ duckGain → music bus
 *                                                  (analyser tap for the AGC)
 *
 * Tracks are minutes long and multi-MB, so they are NEVER fetched with
 * fetch()+decodeAudioData like the SFX are: an <audio> element streams by
 * construction, starts playing before the file is complete, keeps almost
 * nothing in memory and gets HTTP range requests for free. The tradeoff —
 * no sample-accurate scheduling — is fine for music and unacceptable for
 * canvas snaps, hence two separate paths.
 *
 * At most two elements exist, because a MediaElementSource can only be created
 * once per element: deck A plays, deck B holds the ONE prefetched next track.
 * Nothing is requested at import time or on the gesture unlock beyond starting
 * the first track, and zero tracks present is a normal silent state, not an
 * error path.
 */
import { audioParams as p } from '../params/audio';
import { discoverMusicTracks, type MusicState, type MusicTrackRef } from './musicAssets';
import {
  agcStep,
  createPlaylist,
  duckHit,
  gapFor,
  stepDuck,
  windowRms,
  type DuckState,
  type Playlist,
} from './musicPlaylist';
import { createRng } from '../state/rng';

export interface MusicInfo {
  /** tracks discovered in assets/audio/music (0 = none supplied yet) */
  tracks: number;
  /** id of the track currently playing, or null in a gap / with no tracks */
  current: string | null;
  state: MusicState;
  /** 0..1 — 1 = not ducked */
  duck: number;
}

export interface MusicPlayer {
  /** per frame; `state` selects the pool (tag seam — 'calm' until wired) */
  update(dt: number, state: MusicState): void;
  /** a combat event landed: duck the bus */
  duck(): void;
  info(): MusicInfo;
  dispose(): void;
}

interface Deck {
  el: HTMLAudioElement;
  gain: GainNode;
  track: MusicTrackRef | null;
  /** true once play() has actually been called for this track */
  playing: boolean;
}

const DEAD_PLAYER: MusicPlayer = {
  update: () => undefined,
  duck: () => undefined,
  info: () => ({ tracks: 0, current: null, state: 'calm', duck: 1 }),
  dispose: () => undefined,
};

export function createMusicPlayer(ctx: BaseAudioContext, out: AudioNode): MusicPlayer {
  // no DOM (tests/SSR) or an engine without media-element sources: stay silent
  const audioCtx = ctx as BaseAudioContext & {
    createMediaElementSource?: (el: HTMLMediaElement) => MediaElementAudioSourceNode;
  };
  if (typeof document === 'undefined' || !audioCtx.createMediaElementSource) return DEAD_PLAYER;

  const tracks = discoverMusicTracks();
  const playlist: Playlist = createPlaylist(tracks, createRng(0x3f0a11));

  const duckGain = ctx.createGain();
  duckGain.gain.value = 1;
  duckGain.connect(out);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  duckGain.connect(analyser); // tap only — analyser output goes nowhere
  const meter = new Float32Array(analyser.fftSize);

  const makeDeck = (): Deck => {
    const el = new Audio();
    el.preload = 'none'; // nothing is requested until a src is set
    el.crossOrigin = 'anonymous';
    const gain = ctx.createGain();
    gain.gain.value = 0;
    audioCtx.createMediaElementSource!(el).connect(gain);
    gain.connect(duckGain);
    el.addEventListener('error', () => {
      // a bad/missing file must cost one track, not the music system
      console.warn('[audio] music track failed, skipping:', el.src);
      el.removeAttribute('src');
    });
    return { el, gain, track: null, playing: false };
  };

  const decks: Deck[] = tracks.length > 0 ? [makeDeck(), makeDeck()] : [];
  let active = 0;
  let duck: DuckState = { level: 1, hold: 0 };
  let gap = Math.max(0, p.musicStartDelaySec); // never slam music at boot
  let trackGain = 1;
  let meterTimer = 0;

  const deck = (i: number): Deck => decks[i];
  const other = (): number => 1 - active;

  /** point a deck at a track and let the browser start buffering it */
  const arm = (d: Deck, track: MusicTrackRef): void => {
    d.track = track;
    d.playing = false;
    d.gain.gain.value = 0;
    d.el.preload = 'auto';
    d.el.src = track.url;
    d.el.load();
  };

  const start = (d: Deck): void => {
    if (!d.track) return;
    d.playing = true;
    void d.el.play().catch(() => {
      // autoplay still blocked (no gesture yet) — drop it and retry next gap
      d.playing = false;
      d.track = null;
    });
  };

  const fade = (d: Deck, target: number, dt: number): void => {
    const tau = Math.max(0.05, p.musicCrossfadeSec) * 0.5;
    const g = d.gain.gain;
    g.value += (target - g.value) * (1 - Math.exp(-dt / tau));
  };

  /** seconds left in a deck's track; Infinity while the duration is unknown */
  const remaining = (d: Deck): number => {
    const dur = d.el.duration;
    if (!Number.isFinite(dur) || dur <= 0) return Number.POSITIVE_INFINITY;
    return Math.max(0, dur - d.el.currentTime);
  };

  return {
    update(dt, state) {
      if (decks.length === 0) return; // no tracks supplied: nothing to do
      duck = stepDuck(duck, dt);
      duckGain.gain.value = duck.level;

      const cur = deck(active);
      const nxt = deck(other());

      // ── AGC: meter a few times a second, drift the playing deck's gain ──
      meterTimer -= dt;
      if (meterTimer <= 0 && cur.playing) {
        meterTimer = Math.max(0.05, p.musicAgcIntervalSec);
        analyser.getFloatTimeDomainData(meter);
        trackGain = agcStep(trackGain, windowRms(meter), p.musicAgcIntervalSec);
      }

      if (cur.playing && !cur.el.paused) {
        const left = remaining(cur);
        fade(cur, p.musicEnabled ? trackGain : 0, dt);
        // prefetch exactly ONE track ahead, and only near the end
        if (!nxt.track && left <= p.musicCrossfadeSec + p.musicPrefetchLeadSec) {
          const next = playlist.next(state);
          if (next) arm(nxt, next);
        }
        if (left <= p.musicCrossfadeSec) {
          if (gapFor(state) <= 0 && nxt.track) {
            start(nxt); // gapless-ish: crossfade straight into the next track
            active = other();
          }
          fade(cur, 0, dt);
        }
        if (cur.el.ended || left <= 0.05) {
          cur.el.removeAttribute('src');
          cur.track = null;
          cur.playing = false;
          gap = gapFor(state);
        }
        return;
      }

      // ── silence between tracks ──
      fade(cur, 0, dt);
      gap -= dt;
      if (gap > 0 || !p.musicEnabled) return;
      const track = cur.track ?? playlist.next(state);
      if (!track) {
        gap = gapFor(state); // nothing eligible — check again after a gap
        return;
      }
      if (cur.track !== track) arm(cur, track);
      start(cur);
      trackGain = 1;
    },

    duck() {
      duck = duckHit(duck);
    },

    info: () => ({
      tracks: playlist.size(),
      current: decks.length > 0 && decks[active].playing ? decks[active].track?.id ?? null : null,
      state: 'calm',
      duck: duck.level,
    }),

    dispose() {
      for (const d of decks) {
        d.el.pause();
        d.el.removeAttribute('src');
        d.gain.disconnect();
      }
      analyser.disconnect();
      duckGain.disconnect();
    },
  };
}
