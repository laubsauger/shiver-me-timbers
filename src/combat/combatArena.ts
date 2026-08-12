/**
 * COMBAT TEST SCENE (`?scene=combat`) — a dev harness, not a game mode.
 *
 * WHY: combat is unobservable in ordinary play. Two ships manoeuvre at
 * range, fire occasionally, and every interesting moment — muzzle flash,
 * ball flight, water impact, hull breach, splinters, flooding, mast fall,
 * sinking — happens once, somewhere, while the camera is pointed elsewhere.
 * FX cannot be judged under those conditions and neither can the damage
 * chain. The user asked for this directly ("it's hard for me to see… place
 * the ships directly next to each other, preset, and not have them move").
 *
 * Shape, deliberately matching the existing `?boot=baseline` lever: one URL
 * branch, no UI, no new game state. Off by default, and when off this module
 * costs one null check per tick.
 *
 * §V.2 IS PRESERVED, and that is not incidental — the whole point of a
 * harness is that a change can be A/B'd honestly:
 *   - placement is fixed data, not random;
 *   - the keys only ENQUEUE intent, and every mutation of SimState happens
 *     inside `hold()`, which the sim tick calls. Nothing here writes ship
 *     state from a DOM event handler, so the tick order stays the tick order.
 *
 * KEYS (all free of the existing map: C free-cam, H helm, WASD/QE sailing,
 * R/F fly, Space fire, Tab/F1 debug):
 *   B   enemy fires the battery bearing on the player
 *   N   BOTH ships fire — the shot that shows two smoke banks at once
 *   V   force a breach on the enemy's midship hull (holed swap + splinters)
 *   M   force the enemy's tallest mast to 0 hp (detach + fall + rope re-solve)
 *   J   reset: re-place both hulls, clear damage and flooding
 *   P   re-park the lens at the vantage (after flying off with C)
 * Every one of them is also a method, so the console can drive the scene.
 */
import type { PieceDef } from '../ship/pieceTypes';
import type { SimState, ShipState, Vec3 } from '../state/simState';
import { combatArenaParams, type CombatArenaParams } from '../params/combat';
import type { FireOrder } from './combatSystem';
import type { CombatRuntime } from './combatRuntime';
import { sideForBearing } from './battery';
import { resolvePieceFrames } from './pieceFrame';

/** the camera handle, structurally — combat imports nothing from src/camera */
export interface ArenaCamera {
  setDebugPose(position: readonly [number, number, number], target?: readonly [number, number, number]): void;
  clearDebugPose(): void;
}

export interface CombatArena {
  /**
   * Pin both hulls on station and drain the pending harness commands.
   * Call once per sim tick, AFTER sailing (it overrides what sailing did)
   * and BEFORE combat.tick (so a forced breach is in this tick's frame).
   */
  hold(state: SimState): void;
  /**
   * Fire orders for this tick, in place of the AI's and of the camera-aimed
   * player order. The harness lays BOTH batteries on the other ship: the
   * parked vantage looks across the line of fire, so a camera-derived bearing
   * would pick the wrong battery and Space would fire into empty sea.
   */
  playerOrder(fire: boolean): FireOrder;
  enemyOrder(): FireOrder;
  /** console handles — same commands as the keys */
  enemyFire(): void;
  bothFire(): void;
  breachEnemy(): void;
  dropEnemyMast(): void;
  /** queued, applied on the next `hold` — nothing writes SimState off a key */
  reset(): void;
  /** re-park the lens from the live params after a Tweakpane change */
  park(): void;
  dispose(): void;
}

/** `?scene=combat` — same lever shape as `?boot=baseline` */
export function combatSceneRequested(search: string): boolean {
  return new URLSearchParams(search).get('scene') === 'combat';
}

interface ArenaTargets {
  /**
   * Holeable hull sections, lowest and most midship first. The breach key
   * takes several of them: ONE hole is recoverable by design (ingress
   * 0.025/s against 0.03/s of pumps, §T.18 "single early hits are
   * recoverable"), so a one-piece breach demonstrates a hole that never
   * floods — which reads as flooding being broken.
   */
  hullIds: string[];
  /** tallest mast — the one worth watching go over the side */
  mastId: string;
}

/**
 * Pick the pieces the harness demonstrates on, from the piece graph alone
 * (§V.13/§V.18): a hand-typed id would rot the first time the blueprint is
 * regenerated, and would silently demo nothing.
 */
export function arenaTargets(blueprint: readonly PieceDef[]): ArenaTargets {
  const frames = resolvePieceFrames(blueprint);
  const hulls: Array<{ id: string; score: number }> = [];
  let mastId = '';
  let mastHeight = -Infinity;
  for (const piece of blueprint) {
    const frame = frames.get(piece.id);
    if (frame === undefined) continue;
    if (piece.kind === 'mast') {
      const height = frame.position[1] + piece.aabb.max[1];
      if (height > mastHeight) {
        mastHeight = height;
        mastId = piece.id;
      }
      continue;
    }
    if (piece.kind !== 'hull-section') continue;
    if (!piece.damageStates.some((s) => s.id === 'holed')) continue;
    // midship and low: the breaches that flood, rather than ones up on a rail
    hulls.push({ id: piece.id, score: -Math.abs(frame.position[2]) - Math.abs(frame.position[1]) });
  }
  if (hulls.length === 0 || mastId === '') {
    // §Rule 8: a harness that silently demonstrates nothing is worse than one
    // that refuses to start
    throw new Error('combat arena: blueprint has no holeable hull section or no mast');
  }
  hulls.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { hullIds: hulls.map((h) => h.id), mastId };
}

/** yaw-only quaternion, same convention as the rest of the sim */
function yawQuat(yaw: number): [number, number, number, number] {
  return [0, Math.sin(yaw * 0.5), 0, Math.cos(yaw * 0.5)];
}

function place(ship: ShipState, position: Vec3, yaw: number): void {
  ship.position = [position[0], position[1], position[2]];
  ship.quaternion = yawQuat(yaw);
  ship.velocity = [0, 0, 0];
  ship.angularVelocity = [0, 0, 0];
  ship.rudder = 0;
  ship.sailTrim = 0; // hove to: canvas off her, so she holds station
  ship.flood = 0;
  ship.damage = {};
}

export function createCombatArena(
  state: SimState,
  combat: CombatRuntime,
  camera: ArenaCamera,
  blueprint: readonly PieceDef[],
  options: { enabled?: boolean; target?: EventTarget; params?: CombatArenaParams } = {},
): CombatArena | null {
  const enabled =
    options.enabled ??
    (typeof window !== 'undefined' && combatSceneRequested(window.location.search));
  if (!enabled) return null;

  const p = options.params ?? combatArenaParams;
  const targets = arenaTargets(blueprint);
  /** commands raised by a key, drained inside the sim tick (§V.2) */
  let pendingEnemyFire = false;
  let pendingBothFire = false;
  let pendingBreach = false;
  let pendingMast = false;
  let pendingReset = false;
  /** set for exactly one tick so main can fire the player too */
  let bothThisTick = false;
  /** station the hulls are pinned to, recomputed on reset */
  const stations: Array<{ position: Vec3; yaw: number }> = [];

  const layout = (): void => {
    stations.length = 0;
    stations.push({ position: [0, 0, 0], yaw: p.heading });
    stations.push({
      position: [Math.sin(p.bearing) * p.range, 0, Math.cos(p.bearing) * p.range],
      yaw: p.heading,
    });
  };

  const park = (): void => {
    // stand off perpendicular to the line of fire, above the gunports: the
    // whole flight path is then across the frame rather than into it, which
    // is the one vantage from which a ball's arc is readable at all
    const midX = stations[1].position[0] * 0.5;
    const midZ = stations[1].position[2] * 0.5;
    const nx = Math.cos(p.bearing);
    const nz = -Math.sin(p.bearing);
    camera.setDebugPose(
      [midX + nx * p.cameraOffset, p.cameraHeight, midZ + nz * p.cameraOffset],
      [midX, p.cameraAimHeight, midZ],
    );
  };

  const reset = (target: SimState): void => {
    layout();
    for (let i = 0; i < stations.length; i++) {
      const ship = target.ships[i];
      if (ship !== undefined) place(ship, stations[i].position, stations[i].yaw);
    }
    target.projectiles = [];
    park();
  };

  reset(state);
  console.info(
    '[combat arena] B enemy fires · N both fire · V breach · M mast · J reset · C fly · P re-park',
    `— hull ${targets.hullIds.slice(0, combatArenaParams.breachSections).join(', ')},`,
    `mast ${targets.mastId}`,
  );

  const onKey = (e: Event): void => {
    const ke = e as KeyboardEvent;
    if (ke.repeat) return;
    // The parked vantage is a DEBUG POSE, and a debug pose outranks every
    // camera mode by design — so C would toggle free-fly and the lens would
    // not budge. Release it here and let the camera module have the same
    // keystroke: park to look, C to go and see, P to come back.
    if (ke.code === 'KeyC' || ke.code === 'KeyH') {
      camera.clearDebugPose();
      return; // NOT handled here: the camera module still needs this event
    }
    if (ke.code === 'KeyP') {
      park();
      ke.preventDefault();
      return;
    }
    switch (ke.code) {
      case 'KeyB':
        pendingEnemyFire = true;
        break;
      case 'KeyN':
        pendingBothFire = true;
        break;
      case 'KeyV':
        pendingBreach = true;
        break;
      case 'KeyM':
        pendingMast = true;
        break;
      case 'KeyJ':
        pendingReset = true;
        break;
      default:
        return;
    }
    ke.preventDefault();
  };
  const listenTarget = options.target ?? (typeof window !== 'undefined' ? window : null);
  listenTarget?.addEventListener('keydown', onKey);

  /** bearing from ship `from` to ship `to`, sim yaw convention */
  const bearingBetween = (target: SimState, from: number, to: number): number => {
    const a = target.ships[from];
    const b = target.ships[to];
    if (a === undefined || b === undefined) return 0;
    return Math.atan2(b.position[0] - a.position[0], b.position[2] - a.position[2]);
  };

  return {
    hold(target) {
      if (pendingReset) {
        pendingReset = false;
        reset(target);
      }
      // pin the PLANAR channel only: heave, pitch and roll stay live, so the
      // hulls still ride the sea and the guns still have a roll to fire on.
      // Freezing the pose outright would make the harness lie about how a
      // broadside actually scatters.
      for (let i = 0; i < stations.length; i++) {
        const ship = target.ships[i];
        if (ship === undefined) continue;
        ship.position[0] = stations[i].position[0];
        ship.position[2] = stations[i].position[2];
        ship.velocity[0] = 0;
        ship.velocity[2] = 0;
        ship.angularVelocity[1] = 0;
        ship.rudder = 0;
        ship.sailTrim = 0;
      }
      // forced damage runs INSIDE the tick, through combat's own hit path
      if (pendingBreach) {
        pendingBreach = false;
        // several sections, each taken past the holed threshold in one go —
        // see ArenaTargets: one hole is out-pumped by design
        const n = Math.max(1, Math.floor(p.breachSections));
        for (const hullId of targets.hullIds.slice(0, n)) {
          combat.forceHit(target, 1, hullId, 3);
        }
      }
      if (pendingMast) {
        pendingMast = false;
        combat.forceHit(target, 1, targets.mastId, 5);
      }
      bothThisTick = pendingBothFire;
      pendingBothFire = false;
    },

    playerOrder(fire) {
      if (!(fire || bothThisTick)) return { shipIndex: 0, fire: false };
      return {
        shipIndex: 0,
        fire: true,
        side: sideForBearing(p.heading, bearingBetween(state, 0, 1)),
      };
    },

    enemyOrder() {
      const fire = pendingEnemyFire || bothThisTick;
      pendingEnemyFire = false;
      if (!fire) return { shipIndex: 1, fire: false };
      return {
        shipIndex: 1,
        fire: true,
        side: sideForBearing(p.heading, bearingBetween(state, 1, 0)),
      };
    },

    enemyFire() {
      pendingEnemyFire = true;
    },
    bothFire() {
      pendingBothFire = true;
    },
    breachEnemy() {
      pendingBreach = true;
    },
    dropEnemyMast() {
      pendingMast = true;
    },
    reset() {
      pendingReset = true;
    },
    park,
    dispose() {
      listenTarget?.removeEventListener('keydown', onKey);
      camera.clearDebugPose();
    },
  };
}
