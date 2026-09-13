/**
 * The speedboat page's SEA-PHYSICS params (§T.181 S0): the page-side adapter over
 * `params/speedboatSea.ts`, which owns the object, its derivation and its panel registration.
 * The one thing this page adds is its spawn height — the rest pose the draft is measured at is
 * the grid's (`course.ts SPAWN_CG_Y`), and `src/params` must not import a page.
 */
import { registerSpeedboatSeaParams } from '../../params/speedboatSea';
import type { SeaPhysicsParams } from '../../params/seaPhysics';
import type { HullProxy } from '../hullMesh';
import { SPAWN_CG_Y } from './course';

export function speedboatSeaParams(hull: Pick<HullProxy, 'keelBodyY'>): SeaPhysicsParams {
  return registerSpeedboatSeaParams(hull, SPAWN_CG_Y);
}
