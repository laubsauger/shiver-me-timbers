/**
 * Playlist selection, ducking and level-matching maths — pure, no WebAudio and
 * no DOM, so the behaviour is unit-testable headlessly (a playlist bug is
 * otherwise only findable by sitting and listening for ten minutes).
 *
 * Design bias, per the reference game: music is SITUATIONAL, not a jukebox.
 * Tracks are separated by a silence gap so the ambience bed and the sea are
 * what you normally hear.
 *
 * Tag-driven selection is a SEAM, and deliberately a BIAS rather than a
 * filter: every track always keeps a base weight, a matching tag only makes it
 * more likely. A hard filter on "combat" with no combat-tagged track in the
 * library gives silence; a bias degrades to "play something". `musicTagBias`
 * ships at 0 — pure shuffle, as asked — and turning tags on later is a slider,
 * not a rewrite.
 */
import { clamp01, expApproach } from './envelope';
import { audioParams as p } from '../params/audio';
import { SITUATION_TAGS, type MusicState, type MusicTrackRef } from './musicAssets';
import type { Weather } from './mix';
import type { Rng } from '../state/rng';

export interface MusicEnv {
  weather: Weather;
  /** metres to the nearest land; Infinity/undefined = open sea */
  landDistance?: number;
  /** > 0 while combat is still hot (the duck hold doubles as the timer) */
  combatHeat: number;
}

/**
 * Priority: guns beat weather beats landfall. Not wired to anything yet — the
 * caller passes `combatHeat` from the duck state and leaves the rest unset, so
 * this returns 'calm' until the inputs are connected.
 */
export function musicStateFor(env: MusicEnv): MusicState {
  if (env.combatHeat > 0) return 'combat';
  if (env.weather === 'storm') return 'storm';
  const d = env.landDistance;
  if (d !== undefined && Number.isFinite(d) && d <= p.musicLandRadius) return 'island';
  return 'calm';
}

/** silence between tracks, per situation — long calms, tight combat */
export function gapFor(state: MusicState): number {
  const gap =
    state === 'combat'
      ? p.musicGapCombatSec
      : state === 'storm'
        ? p.musicGapStormSec
        : state === 'island'
          ? p.musicGapIslandSec
          : p.musicGapCalmSec;
  return Math.max(0, gap);
}

/**
 * How strongly a track's tags suit a situation, 0..1. Unknown tags score 0 —
 * they cost the track nothing, they simply do not help yet.
 */
export function tagMatch(track: MusicTrackRef, state: MusicState): number {
  if (track.tags.length === 0) return 0;
  const wanted = SITUATION_TAGS[state];
  let hits = 0;
  for (const tag of track.tags) if (wanted.includes(tag)) hits++;
  return Math.min(1, hits / 2); // two matching tags = a full match
}

/** selection weight: always ≥ 1 so no track is ever excluded outright */
export function trackWeight(track: MusicTrackRef, state: MusicState): number {
  const bias = clamp01(p.musicTagBias);
  if (bias <= 0) return 1; // shuffle mode: every track equally likely
  return 1 + bias * Math.max(0, p.musicTagBoost) * tagMatch(track, state);
}

export interface Playlist {
  /** next track for this situation, or null when there are no tracks at all */
  next(state: MusicState): MusicTrackRef | null;
  /** how many tracks are PREFERRED in this situation (informational) */
  countFor(state: MusicState): number;
  size(): number;
}

/**
 * Every track is always eligible; tags only shift the odds. With no tracks at
 * all next() returns null forever and the player stays silent without
 * erroring — the zero-tracks state is normal, not a failure.
 */
export function createPlaylist(tracks: readonly MusicTrackRef[], rng: Rng): Playlist {
  const recent: string[] = [];
  let cursor = 0;

  /** weighted draw; falls back to a uniform draw if the weights vanish */
  const weightedPick = (pool: MusicTrackRef[], state: MusicState): MusicTrackRef => {
    let total = 0;
    for (const t of pool) total += trackWeight(t, state);
    if (!(total > 0)) return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
    let r = rng() * total;
    for (const t of pool) {
      r -= trackWeight(t, state);
      if (r <= 0) return t;
    }
    return pool[pool.length - 1];
  };

  return {
    size: () => tracks.length,
    countFor: (state) => tracks.filter((t) => tagMatch(t, state) > 0).length,
    next(state) {
      if (tracks.length === 0) return null;
      let pick: MusicTrackRef;
      if (p.musicShuffle) {
        // no-repeat window: never replay one of the last N unless the library
        // is too small to avoid it (a 2-track library would otherwise deadlock)
        const window = Math.min(Math.max(0, Math.floor(p.musicNoRepeat)), tracks.length - 1);
        const blocked = recent.slice(-window);
        const fresh = tracks.filter((t) => !blocked.includes(t.id));
        pick = weightedPick(fresh.length > 0 ? fresh : [...tracks], state);
      } else {
        pick = tracks[cursor % tracks.length];
        cursor++;
      }
      recent.push(pick.id);
      if (recent.length > 16) recent.shift();
      return pick;
    },
  };
}

export interface DuckState {
  /** 0..1 multiplier applied to the music bus */
  level: number;
  /** seconds of duck left to hold */
  hold: number;
}

/**
 * Combat ducking, applied to the BUS rather than the track: a streaming
 * <audio> element cannot be ramped sample-accurately, and ducking the whole
 * music bus is what is wanted anyway. Every combat event refreshes the hold;
 * the level falls fast and recovers slowly, because music sneaking back up
 * under a broadside is far more noticeable than it dropping.
 */
export function stepDuck(state: DuckState, dt: number): DuckState {
  const hold = Math.max(0, state.hold - dt);
  const target = hold > 0 ? clamp01(p.musicDuckLevel) : 1;
  const tau = target < state.level ? p.musicDuckAttack : p.musicDuckRelease;
  return { level: clamp01(expApproach(state.level, target, dt, Math.max(0.01, tau))), hold };
}

/** a combat event arrived: refresh the duck hold */
export function duckHit(state: DuckState): DuckState {
  return { level: state.level, hold: Math.max(state.hold, p.musicDuckHoldSec) };
}

/**
 * Slow automatic level match between tracks. Streaming rules out measuring a
 * file's loudness up front (there is no decoded buffer to scan), so instead the
 * playing signal is metered a few times a second and the track's gain drifts
 * toward the target. Slow and clamped on purpose: this must never audibly pump
 * inside a track, only stop a loud one from jumping out over a quiet one.
 */
export function agcStep(gain: number, rms: number, dt: number): number {
  if (!(rms > 1e-4)) return gain; // silence / a gap: hold, do not wind up
  const target = Math.min(p.musicGainMax, Math.max(p.musicGainMin, p.musicTargetRms / rms));
  return expApproach(gain, target, dt, Math.max(0.1, p.musicAgcTau));
}

/** RMS of an analyser's time-domain window */
export function windowRms(data: ArrayLike<number>): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (Number.isFinite(v)) {
      sum += v * v;
      n++;
    }
  }
  return n > 0 ? Math.sqrt(sum / n) : 0;
}
