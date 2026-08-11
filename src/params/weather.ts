/**
 * Weather-transition tunables (§V16: every tunable in a params module, on
 * the panel). The preset VALUES themselves live in src/weather/presets.ts —
 * they are data patches over OTHER systems' params (§V7), not tunables of
 * their own. This module only owns how presets are applied.
 */
import { registerParams, type ParamMeta } from './registry';

export interface WeatherParams {
  /**
   * seconds a preset change lerps its params over — storms roll in rather
   * than snap (§V7). 0 = instant.
   */
  transitionSeconds: number;
}

export const weatherParams: WeatherParams = registerParams(
  'weather',
  { transitionSeconds: 4 },
  weatherParamsMeta(),
);

function weatherParamsMeta(): Partial<Record<keyof WeatherParams, ParamMeta>> {
  return { transitionSeconds: { min: 0, max: 20, step: 0.1 } };
}
