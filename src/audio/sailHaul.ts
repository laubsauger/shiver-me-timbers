/**
 * Reefing / setting sail as a PROCESS, not an event.
 *
 * Men hauling on lines is sustained rhythmic effort: canvas rustling and
 * cracking as it gathers, then a bang when it is home. A single one-shot at a
 * threshold reads as a click, so this runs a little state machine off the
 * SAME continuous cloth scalar the rig animates with (ship/sailDynamics
 * `trimDropScale`) — audio and cloth then move together by construction:
 *
 *   rising edge  → 'open'     canvas running out / the first crack
 *   while moving → 'rustle'   short slices of the saildeploy recording, every
 *                             haulTickSec ± jitter, rotated across the masts
 *   settling     → 'terminal' the snap that says it is home
 *
 * Both directions sound (reefing IN and shaking OUT; direction only colours
 * the opening sound and the playback rate), and a non-animated one-frame jump
 * in `drop` still runs a full haulMinSec burst instead of one lonely click.
 *
 * The machine is pure and emits events — that is what makes the rhythm
 * testable without an AudioContext.
 */
import { audioParams as p } from '../params/audio';
import { playSample, sliceOffset } from './sampleShot';
import { createRng, type Rng } from '../state/rng';
import type { SampleName } from './assets';

export type HaulEventKind = 'open' | 'rustle' | 'terminal';

export interface HaulEvent {
  kind: HaulEventKind;
  /** +1 setting sail (drop rising), -1 reefing in */
  direction: number;
  gain: number;
  playbackRate: number;
}

export interface HaulMachine {
  /** @param drop 0..1 continuous canvas drop — 1 = full sail, 0 = furled */
  step(drop: number, dt: number, rng: Rng, emit: (e: HaulEvent) => void): void;
  active(): boolean;
}

export function createHaulMachine(): HaulMachine {
  let prev = Number.NaN;
  let remaining = 0;
  let direction = 0;
  let tick = 0;

  return {
    step(drop, dt, rng, emit) {
      if (!Number.isFinite(drop) || !(dt > 0)) return;
      if (!Number.isFinite(prev)) {
        prev = drop; // first frame: adopt, never haul on startup
        return;
      }
      const delta = drop - prev;
      prev = drop;
      const rate = Math.abs(delta) / Math.max(1e-4, dt);
      const wasIdle = remaining <= 0;

      if (rate >= p.haulRateOn) {
        direction = delta > 0 ? 1 : -1;
        remaining = Math.max(remaining, p.haulMinSec);
        if (wasIdle) {
          emit({
            kind: 'open',
            direction,
            gain: direction > 0 ? p.sailDeployGain : p.sailSnapGain,
            playbackRate: direction > 0 ? 1 : 0.85 + 0.2 * rng(),
          });
          tick = p.haulTickSec;
        }
      }
      if (remaining <= 0) return;

      remaining -= dt;
      tick -= dt;
      if (tick <= 0) {
        // reefing sounds heavier/rougher than shaking out
        const effort = Math.min(1, rate / Math.max(1e-3, p.haulRateFull));
        emit({
          kind: 'rustle',
          direction,
          gain: p.haulRustleGain * (0.5 + 0.5 * effort),
          playbackRate: (direction < 0 ? 0.85 : 1.05) * (1 + 0.12 * (rng() * 2 - 1)),
        });
        tick = Math.max(0.05, p.haulTickSec * (1 + p.haulTickJitter * (rng() * 2 - 1)));
      }
      if (remaining <= 0) {
        emit({
          kind: 'terminal',
          direction,
          gain: p.haulTerminalGain,
          playbackRate: 0.9 + 0.2 * rng(),
        });
        direction = 0;
      }
    },
    active: () => remaining > 0,
  };
}

export interface SailHaul {
  onSample(name: SampleName, buffer: AudioBuffer): void;
  update(drop: number, dt: number): void;
  active(): boolean;
}

/** the machine above, wired to the canvas samples and spread over the masts */
export function createSailHaul(
  ctx: BaseAudioContext,
  outs: AudioNode[],
  seed = 0x4a17,
): SailHaul {
  const rng: Rng = createRng(seed);
  const machine = createHaulMachine();
  let deploy: AudioBuffer | null = null;
  const snaps: AudioBuffer[] = [];
  /**
   * Sources the rustle ticks are cut from.
   *
   * This used to be the saildeploy recording alone, and a haul fires a rustle
   * every ~300 ms: random offsets into ONE ~2 s file is not variation, it is
   * the same file at a different phase, and it reads as such within a couple
   * of hauls. The generated canvas and rope-block takes give the slicer three
   * different recordings to draw from, which is what actually breaks it up.
   */
  const rustleBufs: AudioBuffer[] = [];

  const out = (): AudioNode => outs[Math.floor(rng() * outs.length) % outs.length];

  const snap = (gain: number, playbackRate: number): void => {
    if (snaps.length === 0) return;
    playSample(ctx, out(), snaps[Math.floor(rng() * snaps.length) % snaps.length], {
      gain,
      playbackRate,
    });
  };

  const play = (e: HaulEvent): void => {
    if (e.kind === 'open' && e.direction > 0 && deploy) {
      // canvas running out: the deploy recording from its head
      playSample(ctx, out(), deploy, { gain: e.gain, fadeOut: 0.15 });
      return;
    }
    if (e.kind === 'rustle' && rustleBufs.length > 0) {
      // cloth running through the blocks: a short window of one of the rustle
      // sources, chosen per tick so consecutive ticks are rarely the same take
      const buf = rustleBufs[Math.floor(rng() * rustleBufs.length) % rustleBufs.length];
      playSample(ctx, out(), buf, {
        gain: e.gain,
        offset: sliceOffset(rng, buf.duration, buf.duration, p.haulRustleSec),
        duration: p.haulRustleSec,
        playbackRate: e.playbackRate,
        fadeIn: 0.02,
        fadeOut: 0.08,
      });
      return;
    }
    snap(e.gain * (e.kind === 'rustle' ? 0.6 : 1), e.playbackRate);
  };

  return {
    onSample(name, buffer) {
      if (name === 'sailDeploy') {
        deploy = buffer;
        rustleBufs.push(buffer);
      } else if (name === 'canvasCrackA' || name === 'ropeBlock') {
        // sustained textures — canvasCrackA came back as continuous luffing
        // rather than a single crack, and rope through a block is continuous
        // by nature, so both belong here and not in the snap rotation
        rustleBufs.push(buffer);
      } else if (name === 'canvasSnapA' || name === 'canvasSnapB' || name === 'canvasCrackB') {
        snaps.push(buffer);
      }
    },
    update(drop, dt) {
      machine.step(drop, dt, rng, play);
    },
    active: () => machine.active(),
  };
}
