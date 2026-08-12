/**
 * Water-impact and timber events — everything the hull does discretely, as
 * opposed to the loops in shipAudio.ts.
 *
 *   splash : the bow burying, gated on immersion + speed (§V27)
 *   SLAM   : the bow coming DOWN on the sea — gated on burial RATE from the
 *            hullContact forward slices, i.e. the same sensor the bow spray
 *            and the deck-water injection read, so the bang lands with the
 *            visual by construction. Two voices: a wake slice for the sheet of
 *            water, plus the same slice slowed and lowpassed underneath it for
 *            weight — a slam without a body layer reads as a hiss, not a hit.
 *   groan  : a 2-3 s window cut out of the 3-minute wooden-ship loop, paced by
 *            how hard the hull is working. This is the audible wood: the loop
 *            in the bed gives continuous presence, these give events.
 *
 * Every trigger has hysteresis + a jittered cooldown; a seaway crosses these
 * thresholds constantly and an ungated version machine-guns.
 */
import { audioParams as p } from '../params/audio';
import { createGatedTrigger } from './triggers';
import { playSample, sliceOffset } from './sampleShot';
import { slamStrength, splashStrength } from './mix';
import { createRng, type Rng } from '../state/rng';
import type { SampleName } from './assets';

export interface HullEventInput {
  /** metres of bow below the surface */
  bowImmersion: number;
  /** ship horizontal speed m/s */
  speed: number;
  /** forward burial rate m/s (mix.slamSignal) */
  slamRate: number;
  /** 0..1 hull working (mix.hullWorking) */
  working: number;
  /** false = hull fully airborne; no water event can fire */
  inContact: boolean;
}

export interface HullEvents {
  onSample(name: SampleName, buffer: AudioBuffer): void;
  update(input: HullEventInput, dt: number): void;
  dispose(): void;
}

export function createHullEvents(
  ctx: BaseAudioContext,
  targets: { water: AudioNode; timber: AudioNode },
  seed = 0x51a11,
): HullEvents {
  // body layer of the slam: slowed + lowpassed under the splash
  const body = ctx.createBiquadFilter();
  body.type = 'lowpass';
  body.frequency.value = p.slamLowpassHz;
  body.connect(targets.water);

  const rng: Rng = createRng(seed);
  let wake: AudioBuffer | null = null;
  let timber: AudioBuffer | null = null;

  const splash = createGatedTrigger(
    () => ({
      on: p.bowSplashImmersionOn,
      off: p.bowSplashImmersionOff,
      cooldown: p.bowSplashCooldown,
      repeat: true,
      jitter: 0.25,
    }),
    rng,
  );
  const slam = createGatedTrigger(
    () => ({
      on: p.slamRateOn,
      off: p.slamRateOff,
      cooldown: p.slamCooldown,
      repeat: true,
      jitter: 0.3,
    }),
    rng,
  );
  const groan = createGatedTrigger(
    () => ({
      on: p.creakGroanOn,
      off: p.creakGroanOff,
      cooldown: p.creakGroanCooldown,
      repeat: true,
      jitter: p.creakGroanJitter,
    }),
    rng,
  );

  /** a creak groan cut from anywhere in the 3-minute loop, long fades */
  const playGroan = (gain: number): void => {
    if (!timber) return;
    playSample(ctx, targets.timber, timber, {
      gain,
      offset: sliceOffset(rng, timber.duration, timber.duration, p.creakGroanSliceSec),
      duration: p.creakGroanSliceSec,
      playbackRate: 0.92 + 0.16 * rng(),
      fadeIn: 0.35,
      fadeOut: 0.6,
    });
  };

  return {
    onSample(name, buffer) {
      if (name === 'wake') wake = buffer;
      else if (name === 'shipCreak') timber = buffer;
    },

    update(input, dt) {
      const fast = input.speed >= p.bowSplashSpeedGate;

      if (splash.step(input.bowImmersion, dt, input.inContact && fast) && wake) {
        playSample(ctx, targets.water, wake, {
          gain: p.bowSplashGain * splashStrength(input.bowImmersion, input.speed, p),
          offset: sliceOffset(rng, wake.duration, p.bowSplashWindowSec, p.bowSplashSliceSec),
          duration: p.bowSplashSliceSec,
          playbackRate: 0.9 + 0.3 * rng(),
          fadeIn: 0.01,
          fadeOut: 0.25,
        });
      }

      // slam: no speed gate — a ship lying to in a swell still slams
      if (slam.step(input.slamRate, dt, input.inContact) && wake) {
        const force = slamStrength(input.slamRate, p);
        const offset = sliceOffset(rng, wake.duration, p.bowSplashWindowSec, p.slamSliceSec);
        playSample(ctx, targets.water, wake, {
          gain: p.slamGain * force,
          offset,
          duration: p.slamSliceSec,
          playbackRate: 0.85 + 0.25 * rng(),
          fadeIn: 0.004, // sharp: this is an impact, not a swell
          fadeOut: 0.4,
        });
        body.frequency.value = p.slamLowpassHz;
        playSample(ctx, body, wake, {
          gain: p.slamBodyGain * force,
          offset,
          duration: p.slamSliceSec,
          playbackRate: p.slamBodyRate,
          fadeIn: 0.004,
          fadeOut: 0.5,
        });
        // the hull complains about the hit
        playGroan(p.slamCreakGain * force);
      }

      if (groan.step(input.working, dt)) {
        playGroan(p.creakGroanGain * (0.5 + 0.5 * input.working));
      }
    },

    dispose() {
      body.disconnect();
    },
  };
}
