/**
 * Discrete combat/destruction events (T16/T17/§V14) — one entry point that
 * combat can fire without knowing anything about the audio graph.
 *
 * Everything positional gets its own throwaway PannerNode: these are rare,
 * short events (a broadside, a hit, a mast going over), so a per-event panner
 * costs less than a pool and cannot leak a stuck voice. Nodes disconnect
 * themselves once the sound has run.
 *
 * Sources: cannon and hull-hit stay procedural (no sample for them), while
 * ball splashes reuse the wake recording and timber events (mast break, sink)
 * are slow, low slices of the wooden-ship loop — the same slice machinery the
 * hull groans use.
 */
import { audioParams as p } from '../params/audio';
import { cannonBoom, hullHit } from './oneshots';
import { createPanner, setPannerPosition } from './emitters';
import { playSample, sliceOffset } from './sampleShot';
import { clamp01 } from './envelope';
import { createRng, type Rng } from '../state/rng';
import type { SampleName } from './assets';

export type CombatEventKind =
  | 'cannonFire'
  | 'ballHit'
  | 'ballSplash'
  | 'splinter'
  | 'mastBreak'
  | 'sinkGroan';

export interface CombatEvent {
  kind: CombatEventKind;
  /** world position — omit for a non-positional (dry, centred) event */
  world?: ArrayLike<number>;
  /** 0..1 strength: charge, impact speed, how big the piece was. Default 1 */
  intensity?: number;
}

export interface EventPlayer {
  onSample(name: SampleName, buffer: AudioBuffer): void;
  play(event: CombatEvent): void;
  dispose(): void;
}

/** longest any one event can run — when its panner is torn down */
const EVENT_LIFETIME_S = 6;

export function createEventPlayer(ctx: BaseAudioContext, sfx: GainNode): EventPlayer {
  const rng: Rng = createRng(0xba7711e);
  const live = new Set<PannerNode>();
  let wake: AudioBuffer | null = null;
  let timber: AudioBuffer | null = null;
  let snap: AudioBuffer | null = null;

  /** positional target for one event, or the dry bus when no position given */
  const target = (world: ArrayLike<number> | undefined): AudioNode => {
    if (!world || world.length < 3) return sfx;
    const panner = createPanner(ctx, sfx);
    setPannerPosition(panner, world[0], world[1], world[2]);
    live.add(panner);
    if (typeof setTimeout === 'function') {
      setTimeout(() => {
        panner.disconnect();
        live.delete(panner);
      }, EVENT_LIFETIME_S * 1000);
    }
    return panner;
  };

  /** slow, low slice of the wooden-ship loop = timber under load */
  const timberSlice = (out: AudioNode, gain: number, rate: number, seconds: number): void => {
    if (!timber) return;
    playSample(ctx, out, timber, {
      gain,
      offset: sliceOffset(rng, timber.duration, timber.duration, seconds),
      duration: seconds,
      playbackRate: rate,
      fadeIn: 0.05,
      fadeOut: 0.8,
    });
  };

  return {
    onSample(name, buffer) {
      if (name === 'wake') wake = buffer;
      else if (name === 'shipCreak') timber = buffer;
      else if (name === 'canvasSnapA') snap = buffer;
    },

    play(event) {
      const force = clamp01(event.intensity ?? 1);
      const out = target(event.world);
      switch (event.kind) {
        case 'cannonFire':
          cannonBoom(ctx, out);
          break;
        case 'ballHit':
          hullHit(ctx, out);
          if (snap) {
            playSample(ctx, out, snap, {
              gain: p.splinterGain * force,
              playbackRate: p.splinterRateUp,
            });
          }
          break;
        case 'ballSplash':
          if (wake) {
            playSample(ctx, out, wake, {
              gain: p.ballSplashGain * (0.4 + 0.6 * force),
              offset: sliceOffset(rng, wake.duration, p.bowSplashWindowSec, p.slamSliceSec),
              duration: p.slamSliceSec,
              playbackRate: 0.8 + 0.3 * rng(),
              fadeIn: 0.004,
              fadeOut: 0.35,
            });
          }
          break;
        case 'splinter':
          if (snap) {
            playSample(ctx, out, snap, {
              gain: p.splinterGain * force,
              playbackRate: p.splinterRateUp * (0.9 + 0.2 * rng()),
            });
          }
          break;
        case 'mastBreak':
          hullHit(ctx, out);
          timberSlice(out, p.mastBreakGain * (0.5 + 0.5 * force), 0.6, 2.5);
          break;
        case 'sinkGroan':
          timberSlice(out, p.sinkGroanGain * (0.5 + 0.5 * force), 0.55, 4);
          break;
      }
    },

    dispose() {
      for (const panner of live) panner.disconnect();
      live.clear();
    },
  };
}
