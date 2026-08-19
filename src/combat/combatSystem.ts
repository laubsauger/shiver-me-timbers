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
import { combatFxParams, combatParams, type CombatParams } from '../params/combat';
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
import { add, invRotateVec, lerp, rotateVec, sub } from './quatMath';
import { isSunk } from './sinking';
import { createRng } from '../state/rng';

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
  /**
   * Deterministic per-shot seed (§V.2). fx varies smoke and sparks off this
   * so no two guns throw the identical puff — "identical across all cannons"
   * was the first thing the user saw, and it is this project's recurring
   * visual failure (sail teardrops, foam lattice, machined hull).
   */
  seed: number;
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

/**
 * Hard cap on `CombatMemory.holes`, per ship.
 *
 * THE DEFECT IT CLOSES, stated at the size it actually is. The list is read
 * twice per sim tick (flooding + the buoyancy list torque) and three more
 * times inside the flooding solver, and NOTHING ever removed an entry. One
 * engagement does plateau on its own — `recordBreach` fires on the SPLINTER
 * event, i.e. once per piece as it crosses into 'holed', so a galleon tops out
 * at 12 entries (6 holeable sections × shot hole + zone; MEASURED over 180 s
 * of continuous broadside: 36 hits, 12 holes, flat from t = 40 s). What is
 * unbounded is the cycle: clearing a ship's DAMAGE does not clear her HOLES,
 * so every re-damage cycle appends another full set on top of the last. The
 * combat arena's reset key does exactly that (`combatArena.place`:
 * `ship.damage = {}`, `flood = 0`, holes untouched), and the list lives in a
 * closure, so no heap walk and no `renderer.info` counter can see it grow.
 *
 * WORTH KNOWING SEPARATELY, and NOT fixed here because it belongs to whoever
 * owns the arena: those retained holes mean a ship "reset" to undamaged starts
 * flooding again from breaches she no longer has.
 *
 * WHY A HOLE CAN BE FORGOTTEN, and why 32 is not a guess. Flooding is a SUM
 * over SUBMERGED holes: `ingressRatePerHole` is 0.02 flood/s against a
 * `pumpRate` of 0.03, so TWO holes under water already beat the pumps, and at
 * `sinkThreshold` 0.6 the ramp is one-way and reaches 1 within `sinkDuration`
 * (12 s) whatever the ingress. The outcome of a fight is therefore decided by
 * the first handful of breaches below the waterline; every hole after that
 * only changes how fast an already-sinking ship goes down, and `sinkDuration`
 * bounds that anyway. 32 is roughly an order of magnitude past the point where
 * the result stops depending on the count, and no ship in the shipped scene
 * survives long enough to reach it.
 *
 * FIFO, oldest first: the newest breach is the one the player just made, the
 * one the list torque should lean the hull toward, and the one nearest the
 * fight. Eviction is deterministic, so §V.2 replay is unaffected, and the
 * serialised state stays bounded.
 */
export const MAX_RECORDED_HOLES = 32;

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
   *
   * The array is a per-ship scratch buffer, rewritten on the next call for
   * the SAME ship. Feeding it straight to stepFlooding + stepShipBuoyancy in
   * one tick is the intended use; copy it if you need to keep it.
   */
  floodHoles(state: SimState, shipIndex: number, waterHeight: number): Vec3[];
  memoryOf(shipIndex: number): CombatMemory | undefined;
  /**
   * DEV/TEST (§V.22): land `count` hits on a named piece at its own centre,
   * through the exact same damage path a real ball takes — hp, holed swap,
   * splinters, breach recording, mast detach. The downstream half of §V.14
   * is otherwise only observable after a lucky shot, which is precisely why
   * nobody had ever seen it.
   *
   * Throws on an unknown piece rather than no-op'ing (§Rule 8): a silent
   * miss here would read exactly like "destruction does not work".
   */
  forceHit(state: SimState, shipIndex: number, pieceId: string, count?: number): CombatFrame;
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

  const clearFrame = (): void => {
    frame.muzzles.length = 0;
    frame.hits.length = 0;
    frame.projectiles.length = 0;
    frame.destruction.length = 0;
    frame.detached.length = 0;
  };

  /**
   * One hit → piece ops → events. Extracted so `forceHit` walks the SAME
   * path a ball does; a second implementation for the dev harness would let
   * the harness and the game disagree about what damage means.
   */
  const applyHit = (state: SimState, hit: HitEvent): void => {
    const rig = rigs.get(hit.shipIndex);
    const ship = state.ships[hit.shipIndex];
    if (rig === undefined || ship === undefined) return;
    frame.hits.push(hit);
    // §T.63 — the seat is what turns `hit.point` into a hole in the planking
    // instead of a decal at an authored station. The piece frame is the one
    // `buildHitTargetSet` already resolved for hit detection, so the shell is
    // cut against exactly the box the ball was tested against (§V.72).
    const target = rig.targets.pieces.find((p) => p.pieceId === hit.pieceId);
    const result = applyHitDamage(
      rig.config.assembly,
      rig.config.blueprint,
      hit,
      ship.damage,
      undefined,
      target === undefined
        ? undefined
        : {
            shipPosition: ship.position,
            shipQuaternion: ship.quaternion,
            pieceFrame: target.frame,
            ballRadius: combatFxParams.ballDrawRadius,
          },
    );
    frame.destruction.push(...result.events);
    if (result.detachedSubtree !== undefined) frame.detached.push(result.detachedSubtree);
    // applyHitDamage emits splinters exactly once, at the moment a piece
    // crosses into 'holed' — so a splinter burst IS the breach signal, and
    // reading it here keeps the hole list in step with destruction's own
    // threshold instead of re-deriving (and drifting from) it.
    if (result.events.some((e) => e.type === 'splinters')) {
      recordBreach(rig, ship, hit);
    }
  };

  const step: Combat['step'] = (state, dt, orders, waterHeightAt) => {
    clearFrame();

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
        // §V.2: the ripple's jitter stream is keyed off state + tick + ship,
        // never Math.random, so a replay fires the same rolling broadside
        enqueueBroadside(
          mem,
          side,
          elevationOf(order),
          params,
          (state.seed + state.tick * 2654435761 + shipIndex * 7919) >>> 0,
        );
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

    for (const hit of testHits(state, targetScratch, dt, params.ballRadius)) {
      applyHit(state, hit);
    }

    frame.projectiles.push(...resolveWaterEntry(state, dt, waterHeightAt));
    return frame;
  };

  return {
    step,

    forceHit(state, shipIndex, pieceId, count = 1) {
      clearFrame();
      const rig = rigs.get(shipIndex);
      const ship = state.ships[shipIndex];
      if (rig === undefined || ship === undefined) {
        throw new Error(`forceHit: no combat ship at index ${shipIndex}`);
      }
      const piece = rig.targets.pieces.find((p) => p.pieceId === pieceId);
      if (piece === undefined) throw new Error(`forceHit: unknown piece ${pieceId}`);
      // The piece's outboard FACE, not its centre.
      //
      // This used to be `lerp(min, max, 0.5)` — the centre of the AABB, i.e.
      // a point INSIDE the solid — and every fx spawned from the resulting
      // HitEvent was born inside opaque geometry and depth-rejected. The dev
      // harness's breach key is the one path built to make §V.14 observable,
      // and it was the path that buried its own burst; if the user tested
      // damage through `?scene=combat` they saw nothing for that reason ON
      // TOP of hits never being drawn at all.
      //
      // THIRD instance of this shape in one day (bow wake 3.5 m inside the
      // stem, bow spray at the same wrong bowZ, now this): an effect emitted
      // at a correct-looking position that happens to be inside a solid.
      //
      // A real ball arrives from abeam, so the outboard face across the beam
      // is where it would score. `lerp(min, max, 0.5)` on y/z keeps the
      // station amidships and at mid-height; x goes to whichever face is
      // further from the hull centreline.
      const mid = lerp(piece.min, piece.max, 0.5);
      const outboard = Math.abs(piece.max[0]) >= Math.abs(piece.min[0])
        ? piece.max[0]
        : piece.min[0];
      const local = add(
        piece.frame.position,
        rotateVec(piece.frame.quaternion, [outboard, mid[1], mid[2]]),
      );
      const point = add(ship.position, rotateVec(ship.quaternion, local));
      // §T.63 — the dev key must carry a SHOT DIRECTION too, or the one path
      // built to make §V.14 observable is the one path that cannot show the
      // ejecta leaning downrange. A ball reaching this face came from abeam,
      // i.e. inbound along the face's own outward normal, reversed.
      const inward = rotateVec(ship.quaternion, [outboard >= 0 ? -1 : 1, 0, 0]);
      for (let i = 0; i < Math.max(1, Math.floor(count)); i++) {
        applyHit(state, { shipIndex, pieceId, point, projectileId: -1, direction: inward });
      }
      return frame;
    },
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

/**
 * Heading of the hull's bow, same convention as ai/steering.yawOf.
 * Exported because the aim reticle has to pick the SAME battery `step` will
 * pick from the same bearing — two copies of this would let the crosshair
 * describe the other broadside on the tie.
 */
export function yawOfShip(ship: ShipState): number {
  const f = rotateVec(ship.quaternion, [0, 0, 1]);
  return Math.atan2(f[0], f[2]);
}

/**
 * Queue every reloaded gun on `side`, staggered by rippleDelay so the
 * broadside rolls fore → aft instead of firing as one slab of sound. Guns
 * already queued are skipped, so holding the fire key simply re-fires each
 * gun as its own reload comes up.
 *
 * On top of the regular ripple each gun draws its OWN delay out of
 * `rippleJitter`. A metronomic 80 ms ripple is still a machine — the user's
 * report was "they shoot at the perfect identical same time" — while a real
 * broadside is fired by gun captains each judging their own roll, so the
 * spacing has to be uneven. Jitter smaller than the ripple keeps the roll
 * reading fore → aft while letting neighbours occasionally swap, which is
 * exactly what a gun deck sounds like.
 *
 * Every gun draws whether it fires or not: the stream must not depend on
 * which guns happened to be reloaded, or two replays of the same input log
 * would diverge the moment one shot came due a tick earlier (§V.2).
 */
function enqueueBroadside(
  mem: CombatMemory,
  side: BroadsideSide,
  elevation: number,
  params: CombatParams,
  seed: number,
): void {
  const timers = side === 'port' ? mem.reloadPort : mem.reloadStarboard;
  const ripple = Math.max(0, params.rippleDelay);
  const jitter = Math.max(0, params.rippleJitter);
  const rng = createRng(seed);
  let queued = 0;
  for (let gunIndex = 0; gunIndex < timers.length; gunIndex++) {
    const roll = rng();
    if (timers[gunIndex] > 0) continue;
    if (mem.pending.some((s) => s.side === side && s.gunIndex === gunIndex)) continue;
    mem.pending.push({ side, gunIndex, delay: queued * ripple + roll * jitter, elevation });
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
    // the projectile id is already a per-shot serial from SimState, so it is
    // the cheapest seed that is unique per gun AND per volley (§V.2)
    seed: (projectile.id * 2654435761 + shipIndex * 40503) >>> 0,
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
  // FIFO past the cap — the OLDEST breaches go, not the newest (see
  // MAX_RECORDED_HOLES). splice rather than shift so a burst that pushes
  // several entries in one call still costs one array op.
  const over = rig.memory.holes.length - MAX_RECORDED_HOLES;
  if (over > 0) rig.memory.holes.splice(0, over);
}

function toVec3(v: PieceVec3): Vec3 {
  return [v[0], v[1], v[2]];
}
