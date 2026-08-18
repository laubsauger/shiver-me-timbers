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
   * Number of discrete steps a preset transition moves SPECTRUM params in
   * (`SPECTRUM_KEYS` — amplitude, windSpeed and the three swell keys). Exactly
   * the same mechanism as `layoutLerpSteps` above, one system over, and it is
   * the more expensive of the two by an order of magnitude.
   *
   * Moving any of those five changes `spectrumSignature`, which re-cuts h0 on
   * the GPU **and** on the §V.8 CPU mirror — ~490 ms of main-thread work at
   * 512², or ~139 ms with the fused spectrum pass (ddd2d77). Lerped smoothly,
   * a 4 s transition moves all five on 241 of 300 ticks, and the ocean's
   * arm-once rate limit (`OceanSimulation.update`, one rebuild per 16 ticks on
   * a continuously-moving input) then fires **16 rebuilds and discards 15 of
   * them**: measured 8140 ms of stall before the fused pass and 2221 ms after,
   * worst tick 599 → 222 ms. That is two thirds of the transition spent frozen,
   * and it is the reported performance problem.
   *
   * Quantised, the signature genuinely goes quiet BETWEEN steps, so the rate
   * limit fires once per step crossed, independent of `transitionSeconds`.
   *
   * MEASURED HEADLESS on this machine — a real `applyWeatherPreset('storm')`
   * over 4 s at 60 Hz, with the ocean's own arm-once rate limit replayed over
   * the per-tick signature, and the per-rebuild cost timed directly
   * (`generateSpectrumData` × 3 cascades = 96.6 ms, `new CpuOcean` = 98.3 ms,
   * so 195 ms of main-thread work per rebuild):
   *
   *   steps    ticks the spectrum moves    rebuilds    total stall
   *   smooth              239 / 299             15        2924 ms
   *     12                 12                   12        2339 ms
   *      6                  6                    6        1170 ms
   *      4                  4                    4         780 ms
   *      3                  3                    3         585 ms   ← shipped
   *      2                  2                    2         390 ms
   *      1                  1                    1         195 ms
   *
   * WHY 3, and the trade stated so it can be re-taken. It is a 5× cut and it
   * keeps "storms roll in" legible: three visible steps over four seconds,
   * about one every 1.3 s, each roughly half a metre of Hs between adjacent
   * ladder rungs, under a sky and a haze that go on lerping smoothly around
   * them and hold the eye. 1 is the cheapest honest setting and snaps the sea
   * once at the midpoint. 12 — the layout value — puts the stall straight back.
   *
   * WHAT THIS DOES NOT FIX, said plainly: the WORST TICK is 195 ms at every
   * row of that table, because one rebuild still lands inside one frame. This
   * knob reduces how OFTEN the cost is paid, not how much it costs at once.
   * The other half is amortising a rebuild across ticks (row slices), which is
   * a different change in different files (src/ocean, src/sea-physics).
   *
   * THE SETTINGS SCREEN'S WEATHER ROW PAYS NONE OF THIS. It writes the ocean
   * half of the preset into the settings store first, so the transition finds
   * every spectrum lane already at target and moves none of them: one rebuild
   * for the store write, zero for the lerp. The debug panel's dropdown is the
   * path that still lerps the sea, and it is the one this number is for.
   */
  spectrumLerpSteps: number;
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
    spectrumLerpSteps: 3,
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
    spectrumLerpSteps: { min: 1, max: 60, step: 1 },
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
