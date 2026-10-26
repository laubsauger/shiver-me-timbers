/**
 * Get the Drift, part B — the planet's life as states over act time (direction:
 * drift-narrative/get-the-drift/direction-part-b.md). Pure; the Earth shaders read these as uniforms.
 *
 *   timewave   soft fronts roll across the young planet from the limb toward the audience: fields, then
 *              forests; the ice settles
 *   lights     the Sun sets behind the limb (time-lapse); camps, villages, cities light up in place
 *   overshoot  the networks keep growing past the balance; the air browns; the ice shrinks
 *   flood      the sea rises over the low land; the coastal lights go out under it; we come down lower
 *   drift2     what floats gathers into spirals on the new sea (the debris fields — next build)
 */
import type { GetTheDriftParams } from '../../params/getTheDrift';
import { beatStarts } from './timeline';

export interface LifeState {
  /** 0..1 how far each time-wave front has travelled (from the limb toward the audience) */
  fields: number;
  forests: number;
  /** 0..1 ice caps: 1 = the young world's big caps, settling to ~0.6, shrinking in the overshoot */
  ice: number;
  /** 0..3 the lights: 0–1 sparks (camps), 1–2 clusters (villages), 2–3 networks (cities) */
  lights: number;
  /** 0..1 past the balance */
  overshoot: number;
  /** 0..1 how far the sea has risen (the shader maps it to an elevation) */
  sea: number;
  /** 0..1 the Sun's own day: 0 risen (dawn's end), 1 set behind the limb, back to 0 at the flood's dawn */
  dusk: number;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const smooth = (x: number): number => {
  const k = clamp01(x);
  return k * k * (3 - 2 * k);
};

export function lifeState(t: number, p: GetTheDriftParams): LifeState {
  const { starts } = beatStarts(p);
  const at = (b: 'timewave' | 'lights' | 'overshoot' | 'flood' | 'drift2'): number => clamp01((t - starts[b]) / Math.max(1e-6, p[b]));
  const wave = at('timewave');
  const lights = at('lights');
  const over = at('overshoot');
  const flood = at('flood');
  return {
    fields: smooth(wave / 0.6),
    forests: smooth((wave - 0.35) / 0.65),
    ice: 1 - 0.4 * smooth(wave) - 0.35 * smooth(over),
    // the Sun sets in the first third of the lights beat; the lights come up as it goes
    // the lights grow through the night and past the balance; the flood drowns and empties them
    lights: (3 * smooth((lights - 0.2) / 0.8) + 0.4 * smooth(over)) * (1 - smooth(flood / 0.8)),
    overshoot: smooth(over),
    sea: smooth(flood / 0.85),
    dusk: smooth(lights / 0.3) * (1 - smooth((flood - 0.55) / 0.45)),
  };
}
