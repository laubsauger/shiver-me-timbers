/**
 * First-person player (§T.94): glue between the pure core, the deck field,
 * the keyboard/pointer-lock collectors and the camera.
 *
 * Locomotion integrates in SHIP-LOCAL space (§V73/§V85); the live ship pose
 * is applied here, once per query, to produce the WORLD camera pose — so the
 * walker rides the deck through every heave and roll with zero sliding. The
 * state lives in `SimState.player` (plain data, §V2/§V3) and is REPLACED each
 * tick, never mutated in place.
 */
import { Quaternion, Vector3 } from 'three';
import type { Quat, SimState, Vec3 as SimVec3 } from '../state/simState';
import type { DeckHeightfield } from '../ship/deckHeightfield';
import { playerParams } from '../params/player';
import { createDeckSurface } from './deckSurface';
import { LookAccumulator, attachPointerLock, type LockElement } from './pointerLock';
import { PlayerKeys, attachPlayerKeys } from './playerInput';
import {
  createPlayerState,
  eyeHeight,
  stepPlayer,
  type PlayerState,
  type Vec3,
  type WalkSurface,
} from './playerStep';

export type { PlayerInput, PlayerState, WalkSurface } from './playerStep';

export interface ShipPose {
  position: SimVec3;
  quaternion: Quat;
}

export interface PlayerOptions {
  sim: SimState;
  /** the live pose the deck is drawn at — `() => sim.ships[0]` works */
  shipPose: () => ShipPose;
  deckField: DeckHeightfield;
  /** WORLD sea height; absent = flat sea at y = 0 */
  waterAt?: (x: number, z: number) => number;
  /** ship-local foot-rail points a swimmer can climb back at */
  boardingPoints?: readonly Vec3[];
  /** ship-local cabin roof etc.; absent = open sky */
  ceilingAt?: (x: number, z: number) => number | null;
  /** where to stand at boot, ship-local feet; yaw 0 faces the bow */
  spawn?: Vec3;
  /** keyboard source (default window) and the canvas for pointer lock */
  keyTarget?: EventTarget;
  canvas?: LockElement;
  /** called on the tick T was pressed — main wiring flips the camera mode */
  onToggle?: () => void;
}

export interface CameraPose {
  position: Vector3;
  quaternion: Quaternion;
}

export type ActionHandler = (value: unknown) => void;

export interface Player {
  readonly state: PlayerState;
  /** advance one fixed sim tick; writes `sim.player` */
  step(dt: number): void;
  /** WORLD eye pose for the camera, through the live ship transform */
  cameraPose(): CameraPose;
  /** true while the first-person view owns the keys and the lens */
  isActive(): boolean;
  setActive(active: boolean): void;
  /**
   * Station hook for §T.95: `onAction` registers a named handler, `applyAction`
   * fires it. Returns false when nothing handles the name — a silent no-op is
   * the §V62 shape, so callers can assert on it.
   */
  onAction(name: string, handler: ActionHandler): () => void;
  applyAction(name: string, value?: unknown): boolean;
  dispose(): void;
}

function rotate(q: Quat, v: Vec3): Vec3 {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

export function createPlayer(o: PlayerOptions): Player {
  const sim = o.sim;
  const shipToWorld = (p: Vec3): Vec3 => {
    const s = o.shipPose();
    const r = rotate(s.quaternion, p);
    return [r[0] + s.position[0], r[1] + s.position[1], r[2] + s.position[2]];
  };
  const waterAt = o.waterAt ?? (() => 0);
  const surface: WalkSurface = createDeckSurface(o.deckField, {
    waterAt,
    boardingPoints: o.boardingPoints,
    shipToWorld,
    ceilingAt: o.ceilingAt,
  });
  if (sim.player === undefined) {
    const spawn = o.spawn ?? [0, o.deckField.deckY, 0];
    const st = createPlayerState(spawn);
    st.pos[1] = surface.heightAt(spawn[0], spawn[2]) ?? spawn[1];
    st.grounded = true;
    sim.player = st;
  }

  let active = false;
  const keys = new PlayerKeys();
  const look = new LookAccumulator();
  const detachKeys = attachPlayerKeys(keys, o.keyTarget ?? window, () => active);
  const detachLock = o.canvas === undefined
    ? (): void => {}
    : attachPointerLock(o.canvas, { isActive: () => active, look });
  const actions = new Map<string, ActionHandler>();

  const pos = new Vector3();
  const quat = new Quaternion();
  const shipQ = new Quaternion();
  const yawQ = new Quaternion();
  const pitchQ = new Quaternion();
  const Y = new Vector3(0, 1, 0);
  const X = new Vector3(1, 0, 0);

  return {
    get state() {
      return sim.player as PlayerState;
    },
    step(dt) {
      if (keys.takeToggle()) o.onToggle?.();
      const input = keys.sample(active ? look.take() : { yawDelta: 0, pitchDelta: 0 });
      sim.player = stepPlayer(sim.player as PlayerState, input, surface, dt);
    },
    cameraPose() {
      const s = sim.player as PlayerState;
      const eye: Vec3 = [s.pos[0], s.pos[1] + eyeHeight(s.crouch, playerParams), s.pos[2]];
      // camera looks down its own -z; yaw 0 must face frame +z, hence the π
      yawQ.setFromAxisAngle(Y, s.yaw + Math.PI);
      pitchQ.setFromAxisAngle(X, s.pitch);
      quat.copy(yawQ).multiply(pitchQ);
      if (s.frame === 'ship') {
        const w = shipToWorld(eye);
        pos.set(w[0], w[1], w[2]);
        const q = o.shipPose().quaternion;
        shipQ.set(q[0], q[1], q[2], q[3]);
        quat.premultiply(shipQ);
      } else {
        pos.set(eye[0], eye[1], eye[2]);
      }
      return { position: pos, quaternion: quat };
    },
    isActive: () => active,
    setActive(a) {
      active = a;
      if (!a) keys.clear();
    },
    onAction(name, handler) {
      actions.set(name, handler);
      return () => {
        if (actions.get(name) === handler) actions.delete(name);
      };
    },
    applyAction(name, value) {
      const h = actions.get(name);
      if (h === undefined) return false;
      h(value);
      return true;
    },
    dispose() {
      detachKeys();
      detachLock();
    },
  };
}
