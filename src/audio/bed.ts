/**
 * Layered ambience bed (non-positional, ambience bus).
 *
 *   ocean-waves loop  → gain ×(weather × swell-LFO × drift) ─┐
 *   12kn cockpit wind → lowpass → gain ×(wind curve × drift) ─┼→ ambience bus
 *   sailing bed loop  → gain ×(ship speed × drift) ──────────┘
 *
 * The bed is state-driven, not a static loop: layer gains follow
 * wind.speed / weather / ship speed (mix.ts owns those curves), the ocean
 * layer breathes at the swell rate, and each layer additionally drifts on its
 * own slow LFO at a non-commensurate rate (0.83 / 1.0 / 1.31 × bedDriftRateHz,
 * same trick as the ocean cascade periods) so the combination never repeats on
 * an audible cycle. Layers start silent and are only ever approached — a layer
 * whose sample arrives mid-session fades in instead of popping.
 */
import { advanceLfo, lfoUnipolar } from './envelope';
import { audioParams as p } from '../params/audio';
import { bedTargets, driftFactor, weatherRateMult, type BedEnv } from './mix';
import { createLoopLayer, type LoopLayer } from './layer';
import type { SampleName } from './assets';

export interface AmbienceBed {
  /** hand a decoded sample in as it lands; unrelated names are ignored */
  onSample(name: SampleName, buffer: AudioBuffer): void;
  update(env: BedEnv, dt: number): void;
  /** true once at least one layer is playing */
  active(): boolean;
  dispose(): void;
}

/** drift rate multipliers — deliberately non-commensurate (§B4 spirit) */
const DRIFT_RATES = [0.83, 1.0, 1.31];

export function createBed(ctx: BaseAudioContext, out: AudioNode): AmbienceBed {
  const ocean = createLoopLayer(ctx, out, { seed: 0x0cea11 });
  const wind = createLoopLayer(ctx, out, { seed: 0x5eabee2, lowpass: true });
  const sailing = createLoopLayer(ctx, out, { seed: 0x5a11a1 });
  const layers: Record<string, LoopLayer> = { ocean, wind, sailing };

  // staggered initial phases: the three layers never peak together
  const drift = [0.0, 0.37, 0.71];
  let swellPhase = 0;

  return {
    onSample(name, buffer) {
      if (name === 'oceanWaves') ocean.start(buffer);
      else if (name === 'windCockpit') wind.start(buffer);
      else if (name === 'sailingBed') sailing.start(buffer);
    },
    update(env, dt) {
      const t = bedTargets(env, p);
      for (let i = 0; i < drift.length; i++) {
        drift[i] = advanceLfo(drift[i], p.bedDriftRateHz * DRIFT_RATES[i], dt);
      }
      // wave rhythm on the ocean layer — rate follows the weather preset
      swellPhase = advanceLfo(swellPhase, p.swellRateHz * weatherRateMult(env.weather, p), dt);
      const swell = 1 - p.swellDepth * 0.5 + p.swellDepth * 0.5 * lfoUnipolar(swellPhase);

      const tau = Math.max(0.05, p.bedFadeTau);
      ocean.update({ gain: t.ocean * swell * driftFactor(drift[0], p.bedDriftDepth) }, dt, tau);
      wind.update(
        {
          gain: t.wind * driftFactor(drift[1], p.bedDriftDepth),
          cutoffHz: t.windCutoffHz,
          rate: t.windRate,
        },
        dt,
        tau,
      );
      sailing.update({ gain: t.sailing * driftFactor(drift[2], p.bedDriftDepth) }, dt, tau);
    },
    active: () => ocean.started() || wind.started() || sailing.started(),
    dispose() {
      for (const layer of Object.values(layers)) layer.dispose();
    },
  };
}
