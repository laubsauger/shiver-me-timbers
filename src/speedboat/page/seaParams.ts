/**
 * The speedboat page's SEA-PHYSICS params (§T.181 S0): the object BOTH the page mirror
 * (`buildSea` → `CpuOcean`, the player's sea) and the NPC fleet (`createNpcFleet`, each worker's
 * mirror) are built with — one object, so the two seas cannot be configured apart (§V110).
 *
 * §V68/§V105-as-proposed: a mirror's Smith depth is the draft of the hulls it floats. The galleon
 * default (`hullDraft` 2.0 m) low-passes every wave a 12 m deep-V feels, so the draft is the
 * deep-V's own: keel depth at its measured rest pose (CG at `SPAWN_CG_Y`, keel `keelBodyY` below
 * the CG). Mirror resolution, update cadence and inverse-displacement iterations stay the shared
 * defaults (the sim-worker determinism suite ran on exactly these).
 *
 * OWNERSHIP NOTE: this belongs in `src/params/speedboat.ts` (S1 owner) with a registry entry for
 * the panel; it lives here only because S0 does not own `src/params`. Not registered, so the
 * debug panel cannot move it apart from the fleet's copy mid-race.
 */
import { seaPhysicsParams, type SeaPhysicsParams } from '../../params/seaPhysics';
import type { HullProxy } from '../hullMesh';
import { SPAWN_CG_Y } from './course';

export function speedboatSeaParams(hull: Pick<HullProxy, 'keelBodyY'>): SeaPhysicsParams {
  const draft = -(SPAWN_CG_Y + hull.keelBodyY);
  if (!(draft > 0 && draft < 2)) throw new Error(`speedboat sea params: implausible deep-V draft ${draft} m`);
  return { ...structuredClone(seaPhysicsParams), hullDraft: draft };
}
