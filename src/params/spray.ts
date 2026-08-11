/**
 * Crest spray particle tunables (§V16). Consumed by src/foam/spray.ts —
 * GPU spray bursting off breaking crests (§V6 jacobian trigger, §V7 storms
 * spray harder because the threshold tracks oceanParams.jacobianFoamBias).
 */
import { registerParams, type ParamMeta } from './registry';

export interface SprayParams {
  /** particle pool size (build-time: changing requires recreating the sim) */
  count: number;
  /** added to oceanParams.jacobianFoamBias — spray needs deeper folds than foam */
  sprayBiasOffset: number;
  /** upward launch speed scale (m/s) at respawn */
  launchSpeed: number;
  /** horizontal jitter as a fraction of launchSpeed */
  lateralSpread: number;
  /** fraction of the wind vector carried into launch velocity */
  windCarry: number;
  /** downward acceleration (m/s²) */
  gravity: number;
  /** exponential air-drag rate per second */
  drag: number;
  /** particle lifetime (s) */
  life: number;
  /** sprite size at birth (m) */
  sizeMin: number;
  /** sprite size at end of life (m) — puffs expand as they disperse */
  sizeMax: number;
  /** peak sprite opacity */
  opacity: number;
  /** side length (m) of the respawn-candidate square around the spray center */
  spawnExtent: number;
  /** bow-spray pool size (build-time: changing requires recreating the sim) */
  bowCount: number;
  /** bow particles released per second while the burst gate is open */
  bowBurstRate: number;
  /** outboard launch spread as a fraction of ship speed */
  bowLaunchSpread: number;
  /** fraction of ship velocity kept — spray arcs backward relative to ship */
  bowForwardKeep: number;
  /** bow submersion (m) below which no burst fires */
  bowImmersionThreshold: number;
  /** ship speed (m/s) below which no burst fires */
  bowSpeedThreshold: number;
}

export const sprayParams: SprayParams = registerParams(
  'spray',
  {
    count: 4096,
    sprayBiasOffset: -0.1,
    launchSpeed: 4.0,
    lateralSpread: 0.4,
    windCarry: 0.6,
    gravity: 9.8,
    drag: 0.6,
    life: 1.4,
    sizeMin: 0.2,
    sizeMax: 0.6,
    opacity: 0.6,
    spawnExtent: 140,
    bowCount: 1024,
    bowBurstRate: 600,
    bowLaunchSpread: 0.6,
    bowForwardKeep: 0.3,
    bowImmersionThreshold: 0.15,
    bowSpeedThreshold: 1.5,
  },
  sprayParamsMeta(),
);

function sprayParamsMeta(): Partial<Record<keyof SprayParams, ParamMeta>> {
  return {
    count: { min: 256, max: 16384, step: 256 },
    sprayBiasOffset: { min: -1, max: 0.5, step: 0.01 },
    launchSpeed: { min: 0, max: 15, step: 0.1 },
    lateralSpread: { min: 0, max: 1, step: 0.01 },
    windCarry: { min: 0, max: 2, step: 0.01 },
    gravity: { min: 0, max: 30, step: 0.1 },
    drag: { min: 0, max: 5, step: 0.01 },
    life: { min: 0.1, max: 5, step: 0.05 },
    sizeMin: { min: 0.05, max: 2, step: 0.05 },
    sizeMax: { min: 0.05, max: 3, step: 0.05 },
    opacity: { min: 0, max: 1, step: 0.01 },
    spawnExtent: { min: 20, max: 500, step: 5 },
    bowCount: { min: 128, max: 4096, step: 128 },
    bowBurstRate: { min: 0, max: 5000, step: 10 },
    bowLaunchSpread: { min: 0, max: 2, step: 0.01 },
    bowForwardKeep: { min: 0, max: 1, step: 0.01 },
    bowImmersionThreshold: { min: 0, max: 2, step: 0.01 },
    bowSpeedThreshold: { min: 0, max: 10, step: 0.1 },
  };
}
