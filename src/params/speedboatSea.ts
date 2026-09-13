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
