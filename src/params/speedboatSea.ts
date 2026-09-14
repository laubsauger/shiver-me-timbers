/**
 * THE SPEEDBOAT'S SEA-PHYSICS PARAMS (§T.181 S0 → params, §V16). The object BOTH the page mirror
 * (`buildSea` → `CpuOcean`, the player's sea) and the NPC fleet (`createNpcFleet`, each worker's
 * mirror) are built with — one object, so the two seas cannot be configured apart (§V110). The
 * fleet does not hold a copy it could drift on: every NPC kick writes this object's leaves into
 * the tick inputs (sim-worker `paramsVector`), so a panel move reaches the rivals on the same tick
 * it reaches the player.
 *
 * §V68/§V105: a mirror's Smith depth is the draft of the hulls it floats. The galleon default
 * (`hullDraft` 2.0 m) low-passes every wave a 12 m deep-V feels, so the draft is the deep-V's
 * own: keel depth at its measured rest pose (CG `restCgY` above the still water, keel `keelBodyY`
 * below the CG). Mirror resolution, update cadence and inverse-displacement iterations stay the
 * shared defaults (the sim-worker determinism suite ran on exactly these). Every galleon-hull key
 * rides along unused: the speedboat's forces are `HullWater`'s, not `stepShipBuoyancy`'s.
 *
 * The hull is a construction input (the draft is measured off it), so this registers when the
 * page builds it rather than at module load — the registry's re-register replaces the entry.
 */
import { registerParams, type ParamMeta } from './registry';
import { seaPhysicsParams, type SeaPhysicsParams } from './seaPhysics';

export const SPEEDBOAT_SEA_PARAMS_NAME = 'sea-physics-speedboat';

/** the keys the speedboat's mirror actually reads, with panel ranges */
export const speedboatSeaMeta: Partial<Record<keyof SeaPhysicsParams, ParamMeta>> = {
  hullDraft: { min: 0.05, max: 2, step: 0.01 },
  smithDepthScale: { min: 0, max: 2, step: 0.05 },
  updateEveryTicks: { min: 1, max: 10, step: 1 },
  inverseDisplacementIterations: { min: 0, max: 6, step: 1 },
};

/** the deep-V's rest draft: keel depth below the still water with the CG at `restCgY` */
export function speedboatDraft(hull: { readonly keelBodyY: number }, restCgY: number): number {
  const draft = -(restCgY + hull.keelBodyY);
  if (!(draft > 0 && draft < 2)) throw new Error(`speedboat sea params: implausible deep-V draft ${draft} m`);
  return draft;
}

/** pure: the shared sea-physics defaults with the speedboat's Smith draft (an independent copy) */
export function speedboatSea(base: SeaPhysicsParams, draft: number): SeaPhysicsParams {
  return { ...structuredClone(base), hullDraft: draft };
}

/** build and REGISTER the page's one speedboat sea-params object (the panel binds it live) */
export function registerSpeedboatSeaParams(hull: { readonly keelBodyY: number }, restCgY: number): SeaPhysicsParams {
  return registerParams(SPEEDBOAT_SEA_PARAMS_NAME, speedboatSea(seaPhysicsParams, speedboatDraft(hull, restCgY)), speedboatSeaMeta);
}

/**
 * THE SPEEDBOAT'S THREE SEAS (trailer review + playtest 2026-09-14, USER: "calibrate how hard a swell we present … the sea
 * has wider intervals between waves, more deep-ocean swell … in certain places maybe use lee"). docs/speedboat/sea-presets.md.
 *
 * WHY NOT THE WEATHER LADDER'S OWN SEAS. The race's "Working sea" was the ladder's `swell` rung: Hs 2.8 m of which 2.5 m
 * is an 11 m/s WIND sea peaking at λ 95 m / T 7.8 s — short, steep faces a 12 m hull meets once a second at 30 m/s and
 * stuffs into. The ladder's `calm` and `breeze` carry their swell on other bearings (0.62π, 1.15π), so the Tower Reach
 * lee (authored against 1.68π, circuit/towerReachLayout.ts) lands on the wrong water: on `calm` the start straight had
 * K = 1.00 and the exposed Stuff Run K = 0.30.
 *
 * WHAT THESE ARE. A weather rung for the SKY (clouds, haze, storminess) + the sea's spectrum keys overridden through
 * `weather.apply(name, { ocean })` (weather/applyPreset.ts): a swell on the course's bearing carries the sea (long and low
 * for calm/working, shorter for open),
 * a small wind sea rides on top, and the swell shadow does the rest — calm water in the island lees, the open swell
 * outside. Choppiness and foam bias stay the rung's (they are measured against each sea's own σ).
 */
export type SpeedboatSeaName = 'calm' | 'working' | 'open';
/** the swell bearing Tower Reach's sheltered/exposed sectors are measured on (tests pin it to the layout constant) */
export const SPEEDBOAT_SWELL_DIRECTION = Math.PI * 1.68;

export interface SpeedboatSeaPreset {
  /** weather ladder rung for the sky (weather/presets.ts) */
  weather: 'calm' | 'breeze' | 'swell';
  /** the sea's spectrum keys, over the rung's */
  ocean: { amplitude: number; windSpeed: number; swellPeriod: number; swellAmplitude: number; swellDirection: number };
}

export const SPEEDBOAT_SEAS: Readonly<Record<SpeedboatSeaName, Readonly<SpeedboatSeaPreset>>> = Object.freeze({
  /** bay glass with a breeze on it: a 12 s ground swell under a Beaufort-2 ripple — realised Hs ≈ 0.16 m */
  calm: { weather: 'calm', ocean: { amplitude: 0.15, windSpeed: 3, swellPeriod: 12, swellAmplitude: 0.04, swellDirection: SPEEDBOAT_SWELL_DIRECTION } },
  /** the default: a gentle 10 s swell (λ 156 m) under a light wind sea — realised Hs ≈ 0.5 m, she rides it (pitch std ≈ 0.5°) */
  working: { weather: 'breeze', ocean: { amplitude: 0.12, windSpeed: 4, swellPeriod: 10, swellAmplitude: 0.12, swellDirection: SPEEDBOAT_SWELL_DIRECTION } },
  /**
   * dramatic but rideable (trailer 14a–c jumps): an 8 s swell (λ 100 m) with a moderate wind sea — realised Hs ≈ 1.5 m.
   * Shorter than `working` on purpose: a 13 s swell at this height is too gentle a slope to launch her (0 % airborne at
   * 80 kn, measured); 8 s gives 3–5 % airborne into it at 60–80 kn and no bow under
   */
  open: { weather: 'swell', ocean: { amplitude: 0.12, windSpeed: 6.5, swellPeriod: 8, swellAmplitude: 0.36, swellDirection: SPEEDBOAT_SWELL_DIRECTION } },
});
