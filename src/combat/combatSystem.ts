/**
 * Combat orchestrator (T16/T17/T18) — one call per sim tick drives the whole
 * chain: aim → fire → ballistic flight → hit → piece-graph damage → holes →
 * flooding input.
 *
 * TICK ORDER, and why each step sits where it does:
 *   1. reload + rolling broadside queue → fireCannon
 *   2. stepProjectiles          integrate this tick's segment
 *   3. testHits                 resolve that segment against every OTHER ship
 *   4. applyHitDamage           §V13 piece ops only; record breaches as holes
 *   5. resolveWaterEntry        LAST, so a ball crossing the surface still
 *                               gets its hit tested (see ballistics.ts)
 *
 * §V.3: this reads and writes SimState and the piece graph, never the scene.
 * §V.13/§V.14: every visual consequence of damage goes through
 * ShipAssembly's state swap / detach — nothing here touches a mesh, so
 * §V.18's AI-mesh drop-in contract is untouched.
 *
 * §V.2 note, same shape as AiMemory: gun reload timers and the recorded holes
 * live in `CombatMemory` outside SimState for now. They are strictly plain
 * JSON-serializable data and every mutation is a pure function of
 * (SimState, orders, dt), so lockstep can either replicate the struct or
 * rebuild it from the input log. No wall clock, no Math.random.
 */
import type { Object3D } from 'three';
import type { PieceDef, Vec3 as PieceVec3 } from '../ship/pieceTypes';
import type { ShipAssembly } from '../ship/shipAssembly';
import { applyHitDamage, type DestructionEvent } from '../ship/destruction';
import type { SimState, ShipState, Vec3 } from '../state/simState';
import { combatParams, type CombatParams } from '../params/combat';
import {
  resolveWaterEntry,
  stepProjectiles,
  type ProjectileEvent,
  type WaterHeightFn,
} from './ballistics';
import { buildBattery, sideForBearing, type BroadsideSide } from './battery';
import { fireCannon } from './cannons';
import { buildHitTargetSet, poseTargets } from './hitTargets';
import { testHits, type HitEvent, type HitTarget } from './hitTest';
import { resolvePieceFrames, socketLocalPosition } from './pieceFrame';
import { invRotateVec, rotateVec, sub } from './quatMath';
import { isSunk } from './sinking';

export interface CombatShipConfig {
  /** index into SimState.ships */
  shipIndex: number;
  blueprint: PieceDef[];
  assembly: ShipAssembly;
}

/** One tick's firing intent for a ship. Held `fire` re-fires at reload rate. */
export interface FireOrder {
  shipIndex: number;
  fire: boolean;
  /** explicit battery; omit and `aimBearing` picks the one that bears */
  side?: BroadsideSide;
  /** world bearing the gunner is sighting along (same convention as yaw) */
  aimBearing?: number;
  /** rad above horizontal; defaults to combatParams.defaultElevation */
  elevation?: number;
}

export interface MuzzleEvent {
  shipIndex: number;
  socketId: string;
  /** world muzzle station */
  position: Vec3;
  /** world unit firing direction */
  direction: Vec3;
}

export interface CombatFrame {
  muzzles: MuzzleEvent[];
  hits: HitEvent[];
  /** splash + expired, plain records (§V.2) */
  projectiles: ProjectileEvent[];
  destruction: DestructionEvent[];
  /**
   * Detached mast subtrees. LIVE three.js objects, deliberately kept out of
   * the plain event arrays so those stay serializable.
   */
  detached: Object3D[];
}

interface PendingShot {
  side: BroadsideSide;
  gunIndex: number;
  /** seconds until this gun in the ripple speaks */
  delay: number;
  elevation: number;
}

/** plain-data, JSON round-trippable (see §V.2 note in the header) */
export interface CombatMemory {
  reloadPort: number[];
  reloadStarboard: number[];
  pending: PendingShot[];
  /** ship-local breach positions feeding flooding (§V14) */
  holes: Vec3[];
}

interface ShipRig {
  config: CombatShipConfig;
  memory: CombatMemory;
  portOffsets: Vec3[];
  starboardOffsets: Vec3[];
  portIds: string[];
  starboardIds: string[];
  targets: ReturnType<typeof buildHitTargetSet>;
  /** ship-local damage-zone station per holeable piece (§V13 blueprint data) */
  damageZones: Map<string, Vec3[]>;
  holeBuffer: Vec3[];
}

export interface Combat {
  step(
    state: SimState,
    dt: number,
    orders: readonly FireOrder[],
    waterHeightAt?: WaterHeightFn,
  ): CombatFrame;
  /**
   * Breach positions for `shipIndex` in the frame flooding expects:
   * ship-origin-relative and world-rotated, with y measured against the LIVE
   * sea surface. Drop-in for `floodingHoles(...).positions`.
   */
  floodHoles(state: SimState, shipIndex: number, waterHeight: number): Vec3[];
  memoryOf(shipIndex: number): CombatMemory | undefined;
}

export function createCombat(
  ships: readonly CombatShipConfig[],
  params: CombatParams = combatParams,
): Combat {
  const rigs = new Map<number, ShipRig>();
  for (const config of ships) {
    const battery = buildBattery(config.blueprint);
    const frames = resolvePieceFrames(config.blueprint);
    const damageZones = new Map<string, Vec3[]>();
    for (const piece of config.blueprint) {
      if (!piece.damageStates.some((s) => s.id === 'holed')) continue;
      const frame = frames.get(piece.id);
      if (frame === undefined) continue;
      const zones = piece.sockets
        .filter((s) => s.type === 'damage-zone')
        .map((s) => toVec3(socketLocalPosition(frame, s.position)));
      if (zones.length > 0) damageZones.set(piece.id, zones);
    }
    rigs.set(config.shipIndex, {
      config,
      memory: {
        reloadPort: battery.port.map(() => 0),
        reloadStarboard: battery.starboard.map(() => 0),
        pending: [],
        holes: [],
      },
      portOffsets: battery.port.map((g) => toVec3(g.position)),
      starboardOffsets: battery.starboard.map((g) => toVec3(g.position)),
      portIds: battery.port.map((g) => g.socketId),
      starboardIds: battery.starboard.map((g) => g.socketId),
      targets: buildHitTargetSet(config.blueprint),
      damageZones,
      holeBuffer: [],
    });
  }

  const frame: CombatFrame = {
    muzzles: [], hits: [], projectiles: [], destruction: [], detached: [],
  };
  const targetScratch: HitTarget[] = [];

  const step: Combat['step'] = (state, dt, orders, waterHeightAt) => {
    frame.muzzles.length = 0;
    frame.hits.length = 0;
    frame.projectiles.length = 0;
    frame.destruction.length = 0;
    frame.detached.length = 0;

    const elevationOf = (order: FireOrder | undefined): number =>
      clamp(order?.elevation ?? params.defaultElevation, params.minElevation, params.maxElevation);

    for (const [shipIndex, rig] of rigs) {
      const ship = state.ships[shipIndex];
      if (ship === undefined) continue;
      const mem = rig.memory;
      decay(mem.reloadPort, dt);
      decay(mem.reloadStarboard, dt);

      const order = orders.find((o) => o.shipIndex === shipIndex);
      if (order?.fire === true && !isSunk(ship)) {
        const side =
          order.side ??
          (order.aimBearing === undefined
            ? 'starboard'
            : sideForBearing(yawOfShip(ship), order.aimBearing));
        enqueueBroadside(mem, side, elevationOf(order), params);
      }

      // drained in queue order (bow → stern), so the ripple stays a ripple
      // even when several guns come due inside one tick
      const held: PendingShot[] = [];
      for (const shot of mem.pending) {
        shot.delay -= dt;
        if (shot.delay > 0) held.push(shot);
        else fire(state, shipIndex, rig, shot, params, frame);
      }
      mem.pending = held;
    }

    frame.projectiles.push(...stepProjectiles(state, dt, params));

    targetScratch.length = 0;
    for (const [shipIndex, rig] of rigs) {
      const ship = state.ships[shipIndex];
      if (ship === undefined) continue;
      const n = poseTargets(rig.targets, shipIndex, ship);
      for (let i = 0; i < n; i++) targetScratch.push(rig.targets.buffer[i]);
    }

    const hits = testHits(state, targetScratch, dt, params.ballRadius);
    for (const hit of hits) {
      const rig = rigs.get(hit.shipIndex);
      const ship = state.ships[hit.shipIndex];
      if (rig === undefined || ship === undefined) continue;
      frame.hits.push(hit);
      const result = applyHitDamage(rig.config.assembly, rig.config.blueprint, hit, ship.damage);
      frame.destruction.push(...result.events);
      if (result.detachedSubtree !== undefined) frame.detached.push(result.detachedSubtree);
      // applyHitDamage emits splinters exactly once, at the moment a piece
      // crosses into 'holed' — so a splinter burst IS the breach signal, and
      // reading it here keeps the hole list in step with destruction's own
      // threshold instead of re-deriving (and drifting from) it.
      if (result.events.some((e) => e.type === 'splinters')) {
        recordBreach(rig, ship, hit);
      }
    }

    frame.projectiles.push(...resolveWaterEntry(state, dt, waterHeightAt));
    return frame;
  };

  return {
    step,
    floodHoles(state, shipIndex, waterHeight) {
      const rig = rigs.get(shipIndex);
      const ship = state.ships[shipIndex];
      if (rig === undefined || ship === undefined) return [];
      const out = rig.holeBuffer;
      out.length = 0;
      // holes are ship-local; flooding wants them world-ROTATED and measured
      // against the live surface, so the same breach floods hard in a trough
      // and takes nothing on a crest
      const lift = ship.position[1] - (Number.isFinite(waterHeight) ? waterHeight : 0);
      for (const local of rig.memory.holes) {
        const r = rotateVec(ship.quaternion, local);
        out.push([r[0], r[1] + lift, r[2]]);
      }
      return out;
    },
    memoryOf: (shipIndex) => rigs.get(shipIndex)?.memory,
  };
}

function decay(timers: number[], dt: number): void {
  for (let i = 0; i < timers.length; i++) {
    if (timers[i] > 0) timers[i] = Math.max(0, timers[i] - dt);
  }
}

function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return x < lo ? lo : x > hi ? hi : x;
}

/** heading of the hull's bow, same convention as ai/steering.yawOf */
function yawOfShip(ship: ShipState): number {
  const f = rotateVec(ship.quaternion, [0, 0, 1]);
  return Math.atan2(f[0], f[2]);
}

/**
 * Queue every reloaded gun on `side`, staggered by rippleDelay so the
 * broadside rolls fore → aft instead of firing as one slab of sound. Guns
 * already queued are skipped, so holding the fire key simply re-fires each
 * gun as its own reload comes up.
 */
function enqueueBroadside(
  mem: CombatMemory,
  side: BroadsideSide,
  elevation: number,
  params: CombatParams,
): void {
  const timers = side === 'port' ? mem.reloadPort : mem.reloadStarboard;
  const ripple = Math.max(0, params.rippleDelay);
  let queued = 0;
  for (let gunIndex = 0; gunIndex < timers.length; gunIndex++) {
    if (timers[gunIndex] > 0) continue;
    if (mem.pending.some((s) => s.side === side && s.gunIndex === gunIndex)) continue;
    mem.pending.push({ side, gunIndex, delay: queued * ripple, elevation });
    queued++;
  }
}

function fire(
  state: SimState,
  shipIndex: number,
  rig: ShipRig,
  shot: PendingShot,
  params: CombatParams,
  out: CombatFrame,
): void {
  const offsets = shot.side === 'port' ? rig.portOffsets : rig.starboardOffsets;
  const ids = shot.side === 'port' ? rig.portIds : rig.starboardIds;
  if (offsets[shot.gunIndex] === undefined) return;
  const projectile = fireCannon(
    state, shipIndex, shot.side, shot.gunIndex, { elevation: shot.elevation }, offsets, params,
  );
  const timers = shot.side === 'port' ? rig.memory.reloadPort : rig.memory.reloadStarboard;
  timers[shot.gunIndex] = Math.max(0, params.reloadTime);
  const v = projectile.velocity;
  const speed = Math.max(1e-6, Math.hypot(v[0], v[1], v[2])); // floored divisor
  out.muzzles.push({
    shipIndex,
    socketId: ids[shot.gunIndex] ?? `gun-${shot.gunIndex}`,
    position: [projectile.position[0], projectile.position[1], projectile.position[2]],
    direction: [v[0] / speed, v[1] / speed, v[2] / speed],
  });
}

/**
 * A breached section ships water two ways, and the demo needs both:
 *  - the SHOT HOLE itself, at the impact point, so where you hit her matters
 *    — a ball on the waterline floods hard, one through the bulwark barely
 *    at all;
 *  - the section's blueprint DAMAGE-ZONE station, which sits below the
 *    waterline by construction: planks sprung along the whole strake. Without
 *    it a ship could be shot to pieces along her rail and never take a drop,
 *    because guns sit above the freeboard and shoot roughly flat — §V14's
 *    flood clause would be unreachable in ordinary play while every unit test
 *    still went green.
 */
function recordBreach(rig: ShipRig, ship: ShipState, hit: HitEvent): void {
  const local = invRotateVec(ship.quaternion, sub(hit.point, ship.position));
  rig.memory.holes.push([local[0], local[1], local[2]]);
  for (const zone of rig.damageZones.get(hit.pieceId) ?? []) {
    rig.memory.holes.push([zone[0], zone[1], zone[2]]);
  }
}

function toVec3(v: PieceVec3): Vec3 {
  return [v[0], v[1], v[2]];
}
