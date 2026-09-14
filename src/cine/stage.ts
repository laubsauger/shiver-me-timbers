/**
 * THE STAGE A SHOOT HAPPENS ON.
 *
 * The reference is open ocean and nothing else — no land at any bearing, no
 * second hull, no overlay. The first full take of the stern chase came back
 * with an island sitting on the horizon behind the ship, which is a headland
 * in a shot whose entire subject is emptiness.
 *
 * Hiding `archipelago.group` was the first fix and it is the wrong one: it
 * hides the LAND but leaves the SEABED, and the seabed is not decoration —
 * it shoals the wave spectrum through the fetch field, it grounds the hull,
 * and it tints the water through the caustics' open-depth. A shoot on a
 * hidden island is still a shoot in the shallows.
 *
 * So the stage is chosen at BUILD time instead: `createArchipelago` takes its
 * site list as a parameter, and an empty one is a world with no land in it at
 * all. `?cine=` (any value) selects it, the same way `?scene=combat` selects
 * the combat harness in combat/combatArena.ts.
 *
 * What still has to be a runtime toggle, and why it cannot be a build-time
 * one: the enemy hull is `state.ships[1]` and half the sim indexes her by
 * position in that array, so she is hidden and parked rather than never
 * spawned. See `setShooting` in main.ts.
 */

/** `?cine=record`, `?cine=play`, `?cine=D` — any of them wants open ocean */
export function cineStageRequested(search: string): boolean {
  const p = new URLSearchParams(search);
  return p.has('cine') || p.get('stage') === 'open-ocean';
}

/**
 * The archipelago patch for the open-ocean stage: no sites, therefore no
 * islands, no seabed relief and no shoaling anywhere in the world.
 */
export const OPEN_OCEAN_SITES: readonly never[] = [];
