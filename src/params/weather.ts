/**
 * Weather tunables (§V16: every tunable in a params module, on the panel).
 *
 * The preset VALUES themselves live in src/weather/presets.ts — they are data
 * patches over OTHER systems' params (§V7), not tunables of their own. This
 * module owns (a) how presets are applied and (b) the shape of the LOCALISED
 * storm field (§V46) that decides how strongly a preset applies AT A GIVEN
 * WORLD POSITION.
 *
 * §V46 in one line: presets stay the vocabulary, their strength becomes a
 * field over world XZ. Nothing here changes a code path — `cellIntensity: 0`
 * reproduces the old global behaviour exactly (the field returns the live
 * params everywhere), so the localised model is a continuous dial off the
 * shipped one, not a fork.
 */
import { registerParams, type ParamMeta } from './registry';

export interface WeatherParams {
  /**
   * seconds a preset change lerps its params over — storms roll in rather
   * than snap (§V7). 0 = instant.
   */
  transitionSeconds: number;
  /**
   * Number of discrete steps a preset transition moves LAYOUT params in
   * (`LAYOUT_KEYS` — the cloud silhouette/placement family). Those keys make
   * src/clouds regenerate its whole lobe set on any frame they change, so a
   * smooth lerp rebuilds ~400 lobes ~240 times over a 4 s transition. 12 steps
   * still reads as the sky reshaping continuously and costs 12 rebuilds.
   * 1 = snap at the end; raise it only if a transition looks stepped.
   */
  layoutLerpSteps: number;
  /**
   * master strength of the localised storm field, 0..1 (§V46).
   * 0 = field disabled: `weatherAt` returns the live (globally applied)
   * params at every position, i.e. exactly the pre-§V46 behaviour.
   */
  cellIntensity: number;
  /**
   * lattice spacing (m) of the storm-cell grid. One cell may live per lattice
   * square, so this is the mean cell-to-cell distance — how far you sail
   * between squalls. Weather systems are big: km scale, not hundreds of m,
   * or the ship crosses a whole storm in seconds.
   */
  cellSize: number;
  /**
   * mean storm-cell radius (m). HARD-CLAMPED to cellSize/2 by the sampler:
   * a cell wider than half its lattice square could reach outside the 3×3
   * neighbourhood the sampler visits, and would then pop in and out as the
   * query point crossed a lattice edge. Continuity is a contract, not a
   * tuning outcome — see `stormAt`.
   */
  cellRadius: number;
  /** 0..1 spread of per-cell radius around cellRadius (0 = all identical) */
  cellRadiusVariance: number;
  /** 0..1 how far a cell centre may wander inside its own lattice square */
  cellJitter: number;
  /**
   * 0..1 fraction of the cell radius that is soft rim. 0 = hard-edged disc
   * (visible seam), 1 = a peak with no plateau. The soft edge is what makes
   * sailing into a squall a transition rather than a switch (§V46).
   */
  cellEdgeSoftness: number;
  /** 0..1 fraction of lattice squares that actually host a storm cell */
  cellCoverage: number;
  /**
   * fraction of the live wind speed that storm cells travel at. Cells drift
   * DOWNWIND (§V46) — weather arrives from the windward horizon. Real squall
   * lines run a bit slower than the surface wind, hence < 1.
   */
  cellDrift: number;
  /**
   * seconds for a cell to complete one grow/decay cycle. 0 = cells never
   * change strength (drift only). Per-cell phase is hashed, so cells are
   * never all at full strength together (§B4: one shared phase = the whole
   * world pulsing in unison).
   */
  cellLifecycleSeconds: number;
  /** 0..1 how deep the lifecycle dips a cell (0 = off, 1 = down to nothing) */
  cellLifecycleDepth: number;
  /** storm strength at which rain starts, and at which it is at full density */
  rainThreshold: number;
  rainFull: number;
  /**
   * §V47 sun-anisotropic haze. `hazeAnisotropy` is the Henyey-Greenstein g:
   * 0 = isotropic (uniform grey soup, explicitly ⊥), → 1 = a tight lobe along
   * the sun vector. Hard-clamped below 1 by the math (the phase function's
   * denominator collapses at g = 1).
   */
  hazeAnisotropy: number;
  /**
   * Multipliers on the sky's haze density. AWAY from the sun the murk thickens
   * (> 1), ALONG the sun vector it thins (< 1) so a lit patch reads through it.
   * Both are MULTIPLIERS, never addends — attenuation expressed as a multiply
   * is the only form that cannot push a light slot negative (§V44).
   */
  hazeAwayMultiplier: number;
  hazeSunMultiplier: number;
  /**
   * 0..1 how much of the anisotropy applies at full storm. The effect is
   * scaled by local storm strength, so a clear day is not warped by it.
   */
  hazeStormWeight: number;
}

export const weatherParams: WeatherParams = registerParams(
  'weather',
  {
    transitionSeconds: 4,
    layoutLerpSteps: 12,
    cellIntensity: 1,
    // ≈2.6 km between cells, ≈1.0 km squalls: at 6 m/s the ship spends
    // roughly 3 minutes crossing one and a few minutes in the clear between,
    // and the far edge of a cell sits well inside the ~4.6 km sea rim (§V30)
    // so a storm is VISIBLE on the horizon before you are in it.
    cellSize: 2600,
    cellRadius: 1000,
    cellRadiusVariance: 0.5,
    cellJitter: 0.8,
    cellEdgeSoftness: 0.65,
    cellCoverage: 0.4,
    cellDrift: 0.6,
    cellLifecycleSeconds: 420,
    cellLifecycleDepth: 0.45,
    rainThreshold: 0.35,
    rainFull: 0.8,
    hazeAnisotropy: 0.55,
    hazeAwayMultiplier: 1.45,
    hazeSunMultiplier: 0.55,
    hazeStormWeight: 1,
  },
  weatherParamsMeta(),
);

function weatherParamsMeta(): Partial<Record<keyof WeatherParams, ParamMeta>> {
  return {
    transitionSeconds: { min: 0, max: 20, step: 0.1 },
    layoutLerpSteps: { min: 1, max: 60, step: 1 },
    cellIntensity: { min: 0, max: 1, step: 0.01 },
    cellSize: { min: 400, max: 12000, step: 50 },
    cellRadius: { min: 100, max: 6000, step: 25 },
    cellRadiusVariance: { min: 0, max: 1, step: 0.01 },
    cellJitter: { min: 0, max: 1, step: 0.01 },
    cellEdgeSoftness: { min: 0, max: 1, step: 0.01 },
    cellCoverage: { min: 0, max: 1, step: 0.01 },
    cellDrift: { min: 0, max: 2, step: 0.01 },
    cellLifecycleSeconds: { min: 0, max: 3600, step: 10 },
    cellLifecycleDepth: { min: 0, max: 1, step: 0.01 },
    rainThreshold: { min: 0, max: 1, step: 0.01 },
    rainFull: { min: 0, max: 1, step: 0.01 },
    hazeAnisotropy: { min: 0, max: 0.95, step: 0.01 },
    hazeAwayMultiplier: { min: 1, max: 3, step: 0.01 },
    hazeSunMultiplier: { min: 0.05, max: 1, step: 0.01 },
    hazeStormWeight: { min: 0, max: 1, step: 0.01 },
  };
}
