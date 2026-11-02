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
 *
 * LIGHTS OUT (params lightsOut; the 2026-11-02 next-level review, move 2): the overshoot pushes on into the flood's
 * front (`overshoot` past 1), the front crosses the night side (`front`, lifeLayers.ts floodFront) and every light in
 * view is out in the score's dip; lamp.ts keeps one.
 */
import type { GetTheDriftParams } from '../../params/getTheDrift';
import { beatStarts } from './timeline';
import { FRONT_EDGE_DEG, frontArrival } from './lifeLayers';

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
  /** LIGHTS OUT: s since the flood's front left the far limb (−1e4 when Lights Out is off), the s it takes to cross
   * the view, and where it starts from (unit, the planet's frame: x lon 0, y lon 90°E, z north) */
  front: number;
  frontLen: number;
  frontOrigin: [number, number, number];
}

/** LIGHTS OUT: s the overshoot's push takes to come in, ending where the front reaches the dome's front edge
 * (FRONT_EDGE_DEG, ~238.5 s): the last cities to go are the ones still pushing */
const PUSH_S = 4;

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
  const lo = p.lightsOut > 0;
  const front = starts.flood + p.loFront;
  // (the push: the overshoot no longer eases out to its balance's end — it carries on into the front, by loPush more,
  // eased in over PUSH_S s up to where the front takes the near cities. The review's "the overshoot gets 3–4 s more push":
  // its default curve is all but flat from ~238 s, ~3 s before the flood; here it is still climbing when the water comes)
  const pushEnd = front + frontArrival(FRONT_EDGE_DEG, p.loFrontLen);
  const push = lo ? p.loPush * smooth((t - (pushEnd - PUSH_S)) / PUSH_S) : 0;
  const la = (p.loOriginLat * Math.PI) / 180;
  const lo2 = (p.loOriginLon * Math.PI) / 180;
  return {
    fields: smooth(wave / 0.6),
    forests: smooth((wave - 0.35) / 0.65),
    ice: 1 - 0.4 * smooth(wave) - 0.35 * smooth(over),
    // the Sun sets in the first third of the lights beat; the lights come up as it goes
    // the lights grow through the night and past the balance; the flood drowns the low ones (the shader)
    // and the rest falter
    // (from the first dusk: the Sun sets at 0.4 of the beat, the fires come up as it goes)
    lights: (3 * smooth((lights - 0.15) / 0.85) + 0.4 * smooth(over)) * (1 - 0.5 * smooth(flood / 0.8)),
    overshoot: smooth(over) + push,
    sea: smooth(flood / 0.85),
    // the flood begins in the night (the coastal lights go out as the water reaches them) and the dawn
    // comes early in it, to show the new sea
    dusk: smooth(lights / 0.5) * (1 - smooth(flood / 0.45)),
    front: lo ? t - front : -1e4,
    frontLen: p.loFrontLen,
    frontOrigin: [Math.cos(la) * Math.cos(lo2), Math.cos(la) * Math.sin(lo2), Math.sin(la)],
  };
}
