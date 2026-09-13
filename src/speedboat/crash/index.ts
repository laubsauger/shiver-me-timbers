/**
 * SPEEDBOAT CRASHES, DAMAGE, RESPAWN (§T.188). See docs/speedboat/crash.md.
 *
 * Per boat, FIXED tick, after its physics step:
 *   measureCrashSensors(state, { bowDeck, wettedArea, waterHeightAt, contactDeltaV, contactSource }, sensors)
 *   stepCrashMachine(machine, { dt, state, sensors, contactPoint, contactOther, overlapsBoat, autoReset, resetRequested }, deps, events)
 *   → machine.out.{throttleScale, steerScale, ghost, fade}, machine.damage.zones, events
 * Collisions themselves (before the step) live in src/sea-physics/boatCollide.ts.
 */
import type { CollisionHull } from '../../sea-physics/boatCollide';
import type { DamageGeometry } from './damage';

export * from './damage';
export * from './detect';
export * from './machine';
export * from './sensors';
export * from './teleport';

/** zone lines from the collision hull: bow = forward 30%, stern = aft 20% (gearcases included), cockpit = above the deck */
export function damageGeometryFor(hull: Readonly<CollisionHull>): DamageGeometry {
  const span = hull.zMax - hull.zMin;
  return { bowZ: hull.zMin + 0.7 * span, sternZ: hull.zMin + 0.2 * span, deckY: hull.bowDeck[1] };
}
