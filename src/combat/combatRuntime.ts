/**
 * Combat RUNTIME (T16/T17/T18/T19 wiring) — the one handle main.ts holds.
 *
 * Everything below this file already existed and was already unit-tested;
 * what did not exist was a caller. `createCombat` drives the sim chain,
 * `createCombatFx` draws it and `audio.event()` sounds it, but each of the
 * three wants a slightly different slice of the same `CombatFrame` at a
 * different point in the frame. Putting that assembly here rather than in
 * main.ts costs three call sites up there instead of a hundred lines — and
 * main.ts is the most contended file in the project.
 *
 * WHO CALLS WHAT, and why the order is not interchangeable:
 *   sim tick   tick(state, dt, orders)   AFTER sailing + cpuOcean.update
 *                                        (hits resolve against this tick's
 *                                        poses, and the ballistic water
 *                                        entry samples the LIVE sea, §V.8),
 *                                        BEFORE flooding — a breach opened
 *                                        this tick ships water this tick.
 *   sim tick   floodHoles(state, i)      feeds stepFlooding + stepShipBuoyancy
 *   sim tick   settle(state, dt)         AFTER buoyancy: it is the floor
 *                                        buoyancy stops providing at flood=1
 *                                        (see sinking.ts).
 *   render     update(frameDt, state)    particles + balls + wreckage.
 *
 * §V.2: nothing here writes SimState except through `createCombat`, which is
 * seeded, fixed-step and free of Math.random/wall clock. Wreckage and
 * particles are RENDER state driven by the render clock — they are the same
 * class of thing as spray, and no sim value is ever read back from them.
 * §V.3: one-way. Audio and fx are sinks.
 */
import { Group, Quaternion, Vector3, type Object3D } from 'three/webgpu';
import type { SimState, Vec3 } from '../state/simState';
import type { CombatEvent } from '../audio/events';
import { combatFxParams, combatParams, type CombatFxParams } from '../params/combat';
import { createCombat, type Combat, type CombatFrame, type CombatShipConfig, type FireOrder } from './combatSystem';
import { createCombatFx, type CombatFx } from './combatFx';
import { elevationForRange, type WaterHeightFn } from './ballistics';
import { buildBattery } from './battery';
import { isSunk, stepSinkSettle } from './sinking';

/** the audio facade, structurally — combat imports no audio runtime code */
export interface CombatAudioSink {
  event(e: CombatEvent): void;
}

export interface CombatRuntimeConfig {
  ships: readonly CombatShipConfig[];
  /** the SAME sea the hulls float on (§V.8 CPU mirror), not a flat plane */
  waterHeightAt: WaterHeightFn;
  /** omit and combat runs silent (tests, headless) */
  audio?: CombatAudioSink | null;
}

export interface CombatRuntime {
  /** add to the scene once — sprites, cannonballs and fallen spars */
  group: Object3D;
  tick(state: SimState, dt: number, orders: readonly FireOrder[]): CombatFrame;
  /** breach list for `shipIndex`, in the frame flooding + buoyancy expect */
  floodHoles(state: SimState, shipIndex: number): Vec3[];
  settle(state: SimState, dt: number): void;
  update(frameDt: number, state: SimState): void;
  /** the underlying sim system, for tests and the dev console */
  combat: Combat;
  dispose(): void;
}

interface Wreck {
  object: Object3D;
  /** m/s, integrated on the render clock like every other fx */
  vy: number;
  spin: number;
}

/**
 * World bearing the camera is looking along, same convention as ship yaw
 * (atan2(x, z)). §I gives the player one key — Space — so the battery that
 * bears has to be inferred; inferring it from the CAMERA rather than the
 * hull is what makes "look at her and fire" work while the ship is still
 * swinging. Reads a column-major matrixWorld (three cameras look down -Z).
 */
export function viewBearing(e: ArrayLike<number>): number {
  const fx = -e[8];
  const fz = -e[10];
  return Math.abs(fx) < 1e-12 && Math.abs(fz) < 1e-12 ? 0 : Math.atan2(fx, fz);
}

export function createCombatRuntime(config: CombatRuntimeConfig): CombatRuntime {
  const combat = createCombat(config.ships, combatParams);
  const fx: CombatFx = createCombatFx(combatFxParams);
  const audio = config.audio ?? null;

  const group = new Group();
  group.name = 'combat';
  group.add(fx.group);
  const wreckage = new Group();
  wreckage.name = 'combat-wreckage';
  group.add(wreckage);

  // mean gun height above the waterline, read off the piece graph rather than
  // typed in (§V.13/§V.18: an AI-generated hull with the same sockets lays her
  // guns correctly with no code change here)
  const gunHeight = new Map<number, number>();
  for (const cfg of config.ships) {
    const battery = buildBattery(cfg.blueprint);
    const guns = [...battery.port, ...battery.starboard];
    gunHeight.set(
      cfg.shipIndex,
      guns.length > 0 ? guns.reduce((s, g) => s + g.position[1], 0) / guns.length : 2,
    );
  }

  const wrecks: Wreck[] = [];
  /** flood at the end of the previous tick, per ship — for edge triggers */
  const lastFlood = new Map<number, number>();
  const tmpPos = new Vector3();
  const tmpQuat = new Quaternion();
  const tmpScale = new Vector3();
  /** deterministic alternating tumble, so no Math.random reaches the frame */
  let wreckCount = 0;

  const sea = (x: number, z: number): number => {
    const h = config.waterHeightAt(x, z);
    return Number.isFinite(h) ? h : 0;
  };

  /**
   * A mast that simply disappears reads as a bug, and `detachPiece` hands
   * back a node whose LOCAL transform is still ship-local — dropping it
   * straight into the scene teleports it to the world origin. Its last
   * matrixWorld is still valid at this point, so bake that instead.
   */
  const adoptWreck = (object: Object3D): void => {
    object.matrixWorld.decompose(tmpPos, tmpQuat, tmpScale);
    object.position.copy(tmpPos);
    object.quaternion.copy(tmpQuat);
    object.scale.copy(tmpScale);
    wreckage.add(object);
    wrecks.push({
      object,
      vy: 0,
      spin: (wreckCount++ % 2 === 0 ? 1 : -1) * combatFxParams.wreckTumble,
    });
  };

  /**
   * A gun crew lays its guns for the range. Without this the elevation is a
   * constant, and a constant elevation is a constant range — 56 m at the
   * default, against a §V.15 broadside fought at 90 m. See
   * ballistics.elevationForRange for the measurement.
   *
   * The mark is the nearest ship still afloat: with two hulls in the world
   * that is unambiguous, and it keeps the aim out of SimState (§V.2 — this is
   * a pure function of the tick's poses, so a replay lays the same guns).
   * Callers that know better keep control: an explicit `elevation` on the
   * order is passed straight through.
   */
  const layGuns = (state: SimState, order: FireOrder): FireOrder => {
    if (!order.fire || order.elevation !== undefined) return order;
    const shooter = state.ships[order.shipIndex];
    if (shooter === undefined) return order;
    let bestRange = Infinity;
    let drop = 0;
    for (let i = 0; i < state.ships.length; i++) {
      if (i === order.shipIndex) continue;
      const target = state.ships[i];
      if (isSunk(target)) continue;
      const range = Math.hypot(
        target.position[0] - shooter.position[0],
        target.position[2] - shooter.position[2],
      );
      if (range < bestRange) {
        bestRange = range;
        drop = shooter.position[1] + (gunHeight.get(order.shipIndex) ?? 2) - target.position[1];
      }
    }
    if (!Number.isFinite(bestRange)) return order; // nothing to shoot at
    return { ...order, elevation: elevationForRange(bestRange, drop, combatParams) };
  };

  /**
   * §V.14's audible half. Everything positional goes out with a world
   * point so it can be localised (the panner graph in audio/events.ts is
   * built for exactly this) — a broadside from the ship to windward has to
   * come from over there, not out of the middle of the mix.
   */
  const sound = (frame: CombatFrame, state: SimState): void => {
    if (audio === null) return;
    for (const m of frame.muzzles) audio.event({ kind: 'cannonFire', world: m.position });
    for (const h of frame.hits) audio.event({ kind: 'ballHit', world: h.point });
    for (const e of frame.destruction) {
      if (e.type === 'splinters') {
        audio.event({ kind: 'splinter', world: e.position });
        continue;
      }
      // mastFall carries only a pieceId; the hit that took the mast to 0 hp
      // is in THIS frame under the same pieceId, so its impact point is the
      // exact place the spar let go rather than an approximation.
      const cause = frame.hits.find((h) => h.pieceId === e.pieceId);
      audio.event({ kind: 'mastBreak', world: cause?.point });
    }
    for (const p of frame.projectiles) {
      if (p.type === 'splash') audio.event({ kind: 'ballSplash', world: p.position });
    }
    for (const cfg of config.ships) {
      const ship = state.ships[cfg.shipIndex];
      if (ship === undefined) continue;
      const before = lastFlood.get(cfg.shipIndex) ?? 0;
      if (before < 1 && isSunk(ship)) {
        audio.event({ kind: 'sinkGroan', world: ship.position });
      }
      lastFlood.set(cfg.shipIndex, ship.flood);
    }
  };

  return {
    group,
    combat,

    tick(state, dt, orders) {
      // only allocates on a tick where somebody actually pulls a trigger
      const laid = orders.some((o) => o.fire && o.elevation === undefined)
        ? orders.map((o) => layGuns(state, o))
        : orders;
      const frame = combat.step(state, dt, laid, config.waterHeightAt);
      // one emit per SIM tick, not per rendered frame: a burst queued twice
      // would double every broadside at high refresh rates
      fx.emit(frame);
      sound(frame, state);
      for (const object of frame.detached) adoptWreck(object);
      return frame;
    },

    floodHoles(state, shipIndex) {
      const ship = state.ships[shipIndex];
      if (ship === undefined) return [];
      return combat.floodHoles(state, shipIndex, sea(ship.position[0], ship.position[2]));
    },

    settle(state, dt) {
      for (const cfg of config.ships) {
        const ship = state.ships[cfg.shipIndex];
        if (ship === undefined) continue;
        stepSinkSettle(ship, sea(ship.position[0], ship.position[2]), dt);
      }
    },

    update(frameDt, state) {
      fx.update(frameDt, state.projectiles);
      // §V.28 shape: a non-finite or restored-tab dt would teleport the whole
      // wreck field, so it is clamped exactly as combatFx clamps its own
      const dt = Number.isFinite(frameDt) ? Math.max(0, Math.min(frameDt, 0.25)) : 0;
      for (let i = wrecks.length - 1; i >= 0; i--) {
        const w = wrecks[i];
        w.vy -= combatParams.gravity * dt;
        w.object.position.y += w.vy * dt;
        w.object.rotateZ(w.spin * dt);
        const surface = sea(w.object.position.x, w.object.position.z);
        if (w.object.position.y < surface - combatFxParams.wreckSinkDepth) {
          wreckage.remove(w.object);
          wrecks.splice(i, 1);
        } else if (w.object.position.y < surface) {
          // hit the water: kill the fall to a slow settle so a topmast does
          // not knife through the sea at terminal velocity
          w.vy = Math.max(w.vy, -combatFxParams.wreckSinkSpeed);
        }
      }
    },

    dispose() {
      fx.dispose();
      for (const w of wrecks) wreckage.remove(w.object);
      wrecks.length = 0;
    },
  };
}

/** re-exported so main.ts imports the whole feature from one place */
export type { CombatFrame, FireOrder, CombatFxParams };
