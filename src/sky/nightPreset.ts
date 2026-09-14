/**
 * MOONLIT NIGHT PRESET (§T.209) — a named set of `skyParams` writes, nothing else. Every night look (moon disc and
 * phase, moonlight key, stars, dark-blue ambient floor, night fog) is the sky system's own: `keyLight` resolves it from
 * `timeOfDay` + `moonPhase`, so this file only chooses the numbers and remembers what it overwrote.
 *
 * THE MOON. User review of the first trailer night: the half moon read "wonky, cut in half" and the moon "a bit
 * intense, overpowering", its road "big white polygons". So:
 *  - phase 0.38 = a waxing gibbous, 86% lit; at 02:00 it is 17° up in the west, low enough to lay a long road
 *    (measured with `keyLight`: sun −57°, moon 17.1°, az −1.56);
 *  - a soft terminator (0.22 of the radius), limb darkening, a little earthshine and the near-side maria
 *    (params/sky.ts moon surface; all 0 outside this preset, so raft/pirate moons are unchanged);
 *  - `moonIntensity` 0.3: a gibbous delivers 0.695 of a full moon (MOON_SURGE), so the key is 0.21 and the road
 *    radiance 0.061 of noon — moodier than the half-moon pass (0.32 / 0.094) the review called overpowering;
 *  - `moonRoadRadiusDeg` 0.35: the road's source is the moon, not the sun's 2.6° disc + glare, so each facet mirrors a
 *    small source — fine glitter instead of broad saturated plateaus;
 *  - glow 0.9 → 0.45 and disc 2.2 → 0.95: at 2.2 the bloomed disc clipped to a flat white coin, hiding the
 *    terminator and the maria (a soft halo that does not blow out the frame).
 *
 * ADDITIVE: nothing in the raft or pirate modes calls this; their day/night is untouched.
 */
import type { SkyParams } from '../params/sky';

export const MOONLIT_NIGHT = Object.freeze({
  timeOfDay: 2,
  moonPhase: 0.38,
  moonIntensity: 0.3,
  moonTerminatorSoftness: 0.22,
  moonLimbDarkening: 0.6,
  moonEarthshine: 0.05,
  moonMaria: 0.8,
  moonRoadRadiusDeg: 0.35,
  moonGlowStrength: 0.45,
  moonDiscIntensity: 0.95,
} satisfies Partial<SkyParams>);

export type NightPresetKeys = keyof typeof MOONLIT_NIGHT;
const KEYS = Object.keys(MOONLIT_NIGHT) as NightPresetKeys[];

let saved: Pick<SkyParams, NightPresetKeys> | null = null;

/**
 * on: write MOONLIT_NIGHT into `p`, remembering the values it replaced (once — a second `on` keeps the first snapshot).
 * off: put those values back; a no-op when the preset is not applied. Deterministic, no clock.
 */
export function applyNightPreset(on: boolean, p: Pick<SkyParams, NightPresetKeys>): void {
  if (on) {
    if (!saved) {
      const snap = {} as Pick<SkyParams, NightPresetKeys>;
      for (const k of KEYS) snap[k] = p[k];
      saved = snap;
    }
    for (const k of KEYS) p[k] = MOONLIT_NIGHT[k];
    return;
  }
  if (!saved) return;
  for (const k of KEYS) p[k] = saved[k];
  saved = null;
}

export function nightPresetApplied(): boolean {
  return saved !== null;
}
