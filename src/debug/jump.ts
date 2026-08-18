/**
 * DEV JUMP (§T.52) — put the ship somewhere worth looking at, instantly.
 *
 * The showcase lagoon is 900 m from spawn. Sailing there to check a shoreline
 * is a minute each way, every iteration, for every agent and every screenshot,
 * so the venue is only useful with a way to arrive at it.
 *
 * WHY THIS IS NOT A TWEAKPANE CONTROL. `debug/panel.ts` builds its folders by
 * calling `addBinding` over the primitive keys of a params object — there is no
 * button, and no change-callback path from a binding back to game code. A
 * `jump: false` boolean in a params module would render as a checkbox that
 * flips a value nothing reads: §V.62's exact shape, and this project has
 * shipped twelve of those. So the jump is a KEY plus a console handle, and the
 * wiring is proven by a test that dispatches a real keydown (see
 * tests/jump.test.ts) rather than by anyone eyeballing the panel.
 *
 * KEYS: `J` cycles the targets, `Shift+J` goes back to spawn. `KeyJ` is unused
 * elsewhere — `freeCam` only swallows W/A/S/D/R/F, and the panel's search box
 * stops propagation on keydown, so typing "j" into the filter cannot sail the
 * ship across the map.
 */
import { resetSeaMemory } from '../sea-physics/buoyancy';
import type { ShipState } from '../state/simState';

export interface JumpTarget {
  /** stable id — used by the key, by `__game.jumpTo` and by `?at=` */
  name: string;
  /** world XZ */
  x: number;
  z: number;
  /** yaw (radians) she arrives on */
  heading: number;
}

/** the origin, facing +z — where she starts, so it is always jumpable-to */
export const SPAWN_TARGET: JumpTarget = { name: 'spawn', x: 0, z: 0, heading: 0 };

/**
 * Where she boots when the URL says nothing (user: "I want it to be basically
 * anchored in this lagoon, with the ship being static there, sitting with
 * fully packed up sails, on anchor").
 *
 * §T.52 originally kept the ORIGIN as the default and put the lagoon behind
 * `?at=lagoon`, reasoning that every screenshot comparison boots at the origin
 * and §V.63 already makes cross-session A/B fragile. The user has overridden
 * that, and the open-water venue is not lost — it is `?at=spawn`, which is the
 * name {@link SPAWN_TARGET} has always carried, so the ocean-parity shot needs
 * no new vocabulary.
 *
 * NOT folded into `bootJumpTarget`, deliberately: that function answers "what
 * did the URL ask for", and the difference between "asked for nothing" and
 * "asked for something that does not exist" is what decides whether a missing
 * destination deserves a console warning. Policy belongs at the call site.
 */
export const DEFAULT_BOOT_TARGET = 'lagoon';

/**
 * Teleport, and leave her in a state she could plausibly have sailed into.
 *
 * A hard position write alone puts her at war with three things at once:
 *  - her own momentum, which is still the old place's (velocity + spin);
 *  - the buoyancy solver's per-location memory (see `resetSeaMemory`);
 *  - her orientation, which carries the pitch and heel of the wave she left.
 *
 * So: yaw only, everything else zeroed, and the sea memory dropped. `waterY`
 * is the live surface height at the destination — arriving at y = 0 while the
 * sea there is at +3 m drops her three metres and she answers with a heave she
 * has no reason to have. Non-finite `waterY` (the ocean mirror has not been
 * stepped yet, which is the case during boot) falls back to 0, the same datum
 * she spawns on (§V28: no NaN reaches SimState).
 */
export function teleportShip(ship: ShipState, target: JumpTarget, waterY: number): void {
  const y = Number.isFinite(waterY) ? waterY : 0;
  ship.position[0] = target.x;
  ship.position[1] = y;
  ship.position[2] = target.z;
  // yaw ONLY: a quaternion carrying the old wave's pitch/roll would be
  // integrated forward from a pose that means nothing here
  const half = target.heading * 0.5;
  ship.quaternion[0] = 0;
  ship.quaternion[1] = Math.sin(half);
  ship.quaternion[2] = 0;
  ship.quaternion[3] = Math.cos(half);
  ship.velocity[0] = 0;
  ship.velocity[1] = 0;
  ship.velocity[2] = 0;
  ship.angularVelocity[0] = 0;
  ship.angularVelocity[1] = 0;
  ship.angularVelocity[2] = 0;
  resetSeaMemory(ship);
}

export interface InstallJumpOptions {
  /**
   * Where to listen. A parameter, not `window`, for the same reason
   * `createInputCollector` takes one: it is the only way a test can dispatch a
   * real keydown and prove the binding drives something (§V.62).
   */
  target: EventTarget;
  ship: ShipState;
  /** destinations, in cycle order. `spawn` is appended if absent. */
  targets: readonly JumpTarget[];
  /** live sea surface height at a world XZ — CpuOcean.heightAt (§V8) */
  waterLevelAt(x: number, z: number): number;
  /**
   * Run straight after the sim state is written, on the same frame. The render
   * side caches a prev/curr tick pair to interpolate between, and the camera
   * chases on an exponential — both of them have to be told, or the ship smears
   * across the map for one frame and the lens flies after her for several.
   */
  onTeleport?(target: JumpTarget): void;
}

export interface JumpHandle {
  /** the resolved destination list, in cycle order */
  targets: readonly JumpTarget[];
  /** jump by name; false = no such target (the caller decides how loud to be) */
  jumpTo(name: string): boolean;
  /** advance one place through the cycle and jump there */
  next(): JumpTarget;
  dispose(): void;
}

export function installJump(opts: InstallJumpOptions): JumpHandle {
  const targets = opts.targets.some((t) => t.name === SPAWN_TARGET.name)
    ? [...opts.targets]
    : [...opts.targets, SPAWN_TARGET];
  let index = -1;

  const go = (target: JumpTarget): void => {
    teleportShip(opts.ship, target, opts.waterLevelAt(target.x, target.z));
    opts.onTeleport?.(target);
    console.info(
      `[jump] ${target.name} @ ${target.x.toFixed(0)}, ${target.z.toFixed(0)}`,
    );
  };

  const jumpTo = (name: string): boolean => {
    const i = targets.findIndex((t) => t.name === name);
    if (i < 0) return false;
    index = i;
    go(targets[i]);
    return true;
  };

  const next = (): JumpTarget => {
    index = (index + 1) % targets.length;
    go(targets[index]);
    return targets[index];
  };

  const onKeyDown = (e: Event): void => {
    const ev = e as KeyboardEvent;
    if (ev.code !== 'KeyJ') return;
    // never steal the key from a text field — the debug panel's own search box
    // already stops propagation, but a future input would not
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.shiftKey) jumpTo(SPAWN_TARGET.name);
    else next();
  };
  opts.target.addEventListener('keydown', onKeyDown);

  return {
    targets,
    jumpTo,
    next,
    dispose(): void {
      opts.target.removeEventListener('keydown', onKeyDown);
    },
  };
}

/**
 * `?at=<name>` — boot straight to a destination.
 *
 * Same lever as the existing `?boot=baseline` in main.ts, and deliberately NOT
 * a change to the default spawn: every screenshot comparison in flight boots at
 * the origin in open water, §V.63 already makes cross-session A/B fragile, and
 * the empty-horizon spawn is the §V.20 ocean-parity venue. Flipping the default
 * later is one line, if that is what the user wants.
 */
export function bootJumpTarget(search: string): string | null {
  return new URLSearchParams(search).get('at');
}
