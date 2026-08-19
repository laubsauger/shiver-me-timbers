/**
 * Discrete combat/destruction events (T16/T17/§V14) — one entry point that
 * combat can fire without knowing anything about the audio graph.
 *
 * Everything positional gets its own throwaway PannerNode: these are rare,
 * short events (a broadside, a hit, a mast going over), so a per-event panner
 * costs less than a pool and cannot leak a stuck voice. Nodes disconnect
 * themselves once the sound has run.
 *
 * Sources: the loud, fixed-shape events (cannon report, splintering wood, a
 * ball hitting the sea, a mast letting go, a shot passing overhead) play
 * GENERATED samples in round-robin pools — see assets/audio/CREDITS.md. Each
 * pool degrades on its own: no samples decoded means cannon falls back to the
 * procedural `cannonBoom`, splinters to the canvas snap, and the rest to
 * silence, which is what they did before the samples existed. The hull hit
 * stays procedural because it is genuinely good (three layers, see oneshots),
 * and timber aftermath (sink groan, the tail under a mast break) stays a slow
 * slice of the wooden-ship loop.
 *
 * WHY POOLS. `cannonBoom` has no randomization of any kind, so before this
 * every gun of every broadside played the byte-identical waveform. The SIM
 * already spaces the guns out — combatSystem queues them with `rippleDelay`
 * 0.13 s ± `rippleJitter`, drained across frames, after the user reported
 * "they shoot at the perfect identical same time" — so the volley was never
 * one slab of sound in time. What it was, was the same recording eight times
 * in a row, which the ear identifies as a loop just as fast. Round-robin takes
 * with pitch jitter are the fix for that, and they are the point of this file.
 *
 * WHY STAGGER AS WELL. Narrower than the pools, and a no-op most of the time:
 * consecutive guns of a ripple land ~130 ms apart, further apart than
 * `cannonBurstSec`, so the stagger does not engage. It exists for the case the
 * drain loop in combatSystem explicitly calls out — "several guns come due
 * inside one tick" — which happens on a frame hitch, with `rippleDelay` tuned
 * to 0, or when two ships' guns come due together. In those frames the shots
 * would start on the same sample, and identical-onset shots sum in phase into
 * one louder gun instead of several.
 */
import { audioParams as p } from '../params/audio';
import { cannonBoom, hullHit } from './oneshots';
import { createPanner, setPannerPosition } from './emitters';
import {
  createVariationPicker,
  nextStagger,
  playSample,
  sliceOffset,
  NO_STAGGER,
  type StaggerState,
} from './sampleShot';
import { clamp01 } from './envelope';
import { createRng, type Rng } from '../state/rng';
import type { SampleName } from './assets';

export type CombatEventKind =
  | 'cannonFire'
  | 'ballHit'
  | 'ballSplash'
  | 'ballWhoosh'
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

/** the shape `planWhooshes` needs off a projectile — SimState.ProjectileState fits */
export interface WhooshCandidate {
  id: number;
  position: ArrayLike<number>;
  /** index of the ship that fired it; your own guns must not whoosh at you */
  owner: number;
}

/**
 * Which balls in flight should sound a pass-by this frame.
 *
 * A ball is inside the radius for many consecutive frames, so the whole
 * problem is firing exactly ONCE per ball — hence `fired`, which this also
 * prunes to the balls still in flight so a long session cannot grow it
 * without bound. Pure apart from that set, so the once-per-ball property is
 * testable with no AudioContext and no combat sim (§Rule 6, planCreak
 * convention).
 *
 * Lives here rather than in combat because "when does a sound trigger" is the
 * same job audio/triggers.ts already does for splashes, slams and groans.
 *
 * @param fired MUTATED: ids already whooshed. Pass the same set every frame.
 */
export function planWhooshes(
  balls: readonly WhooshCandidate[],
  listener: ArrayLike<number>,
  fired: Set<number>,
  radius: number,
  selfIndex: number,
): WhooshCandidate[] {
  const live = new Set<number>();
  const out: WhooshCandidate[] = [];
  const r = Math.max(0, radius);
  for (const ball of balls) {
    live.add(ball.id);
    if (ball.owner === selfIndex || fired.has(ball.id)) continue;
    const dx = ball.position[0] - listener[0];
    const dy = ball.position[1] - listener[1];
    const dz = ball.position[2] - listener[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (!Number.isFinite(d2) || d2 > r * r) continue;
    fired.add(ball.id);
    out.push(ball);
  }
  // a ball that has splashed or expired is gone; forget it so the set tracks
  // flight rather than accumulating every shot ever fired
  for (const id of fired) if (!live.has(id)) fired.delete(id);
  return out;
}

type PoolName = 'cannon' | 'splinter' | 'ballSplash' | 'whoosh';

/** which decoded samples feed which round-robin pool */
export const POOLS: Record<PoolName, readonly SampleName[]> = {
  cannon: ['cannonFireA', 'cannonFireB', 'cannonFireC'],
  // THREE takes, like the cannon, and for a sharper reason than the cannon's.
  // This pool is drawn by BOTH `ballHit` (every ball that touches a hull) and
  // `splinter` (every breach), so a broadside that connects can pull from it
  // half a dozen times inside a second — it is the most-fired pool in the game
  // and it was the shallowest. Two takes rotating that fast is heard as one
  // sound repeating, and a sound the ear has filed as a loop stops registering
  // as an impact at all.
  splinter: ['woodSplinterA', 'woodSplinterB', 'woodSplinterC'],
  ballSplash: ['ballSplashA', 'ballSplashB'],
  whoosh: ['ballWhooshA', 'ballWhooshB'],
};

export function createEventPlayer(ctx: BaseAudioContext, sfx: GainNode): EventPlayer {
  const rng: Rng = createRng(0xba7711e);
  const live = new Set<PannerNode>();
  let wake: AudioBuffer | null = null;
  let timber: AudioBuffer | null = null;
  let snap: AudioBuffer | null = null;
  let mastCrack: AudioBuffer | null = null;

  /**
   * A pool holds only what has actually decoded, appended as it arrives, so
   * there are never holes to read past. The pickers rotate over the LIVE
   * length, so a take landing mid-session widens the rotation immediately.
   */
  const pools: Record<PoolName, AudioBuffer[]> = {
    cannon: [],
    splinter: [],
    ballSplash: [],
    whoosh: [],
  };
  const pick = {
    // the cannon gets its own tighter pitch spread: see cannonVariationCents
    cannon: createVariationPicker(() => pools.cannon.length, rng, p.cannonVariationCents),
    splinter: createVariationPicker(() => pools.splinter.length, rng, p.sampleVariationCents),
    ballSplash: createVariationPicker(() => pools.ballSplash.length, rng, p.sampleVariationCents),
    whoosh: createVariationPicker(() => pools.whoosh.length, rng, p.sampleVariationCents),
  };
  let stagger: StaggerState = NO_STAGGER;

  /**
   * Play one take from a pool. Returns false when the pool is empty so the
   * caller can fall back — the failure-swallowing contract: a missing file
   * costs you the upgrade, never the event.
   */
  const fromPool = (
    name: PoolName,
    out: AudioNode,
    gain: number,
    delay = 0,
  ): boolean => {
    const pool = pools[name];
    const v = pick[name]();
    const buffer = v.index >= 0 ? pool[v.index] : undefined;
    if (!buffer) return false;
    playSample(ctx, out, buffer, { gain, playbackRate: v.playbackRate, delay, fadeOut: 0.05 });
    return true;
  };

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
      else if (name === 'mastBreakCrack') mastCrack = buffer;
      else {
        for (const pool of Object.keys(POOLS) as PoolName[]) {
          if (POOLS[pool].includes(name)) pools[pool].push(buffer);
        }
      }
    },

    play(event) {
      const force = clamp01(event.intensity ?? 1);
      const out = target(event.world);
      switch (event.kind) {
        case 'cannonFire': {
          // stagger BEFORE the pool check: the procedural fallback needs
          // spreading just as badly as the samples do
          stagger = nextStagger(
            stagger,
            ctx.currentTime,
            p.cannonStaggerSec,
            p.cannonStaggerMaxSec,
            p.cannonBurstSec,
          );
          const delay = stagger.delay;
          if (!fromPool('cannon', out, p.cannonSampleGain * (0.6 + 0.4 * force), delay)) {
            cannonBoom(ctx, out, delay);
          }
          break;
        }
        case 'ballHit':
          // the synth hit is the impact; the splinter is the timber failing
          // after it. Sampled wood replaces the canvas snap that used to stand
          // in for it — a dropcloth pitched up 1.7× is not oak letting go.
          hullHit(ctx, out);
          if (!fromPool('splinter', out, p.splinterGain * force) && snap) {
            playSample(ctx, out, snap, {
              gain: p.splinterGain * force,
              playbackRate: p.splinterRateUp,
            });
          }
          break;
        case 'ballSplash':
          if (!fromPool('ballSplash', out, p.ballSplashGain * (0.4 + 0.6 * force)) && wake) {
            // fallback: a window of the wake rush. It has no plunge transient,
            // which is why the sampled version exists.
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
        case 'ballWhoosh':
          // no fallback: before these samples a shot in flight was silent, and
          // there is no synth stand-in worth the code
          fromPool('whoosh', out, p.ballWhooshGain * (0.4 + 0.6 * force));
          break;
        case 'splinter':
          if (!fromPool('splinter', out, p.splinterGain * force) && snap) {
            playSample(ctx, out, snap, {
              gain: p.splinterGain * force,
              playbackRate: p.splinterRateUp * (0.9 + 0.2 * rng()),
            });
          }
          break;
        case 'mastBreak':
          // the crack itself, then the ship's own timber underneath as the
          // aftermath — which is all the slowed loop slice was ever good for
          if (mastCrack) {
            playSample(ctx, out, mastCrack, {
              gain: p.mastBreakSampleGain * (0.5 + 0.5 * force),
              fadeOut: 0.2,
            });
          } else {
            hullHit(ctx, out);
          }
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
