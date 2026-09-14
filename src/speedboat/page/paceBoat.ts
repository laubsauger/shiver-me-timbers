/**
 * THE PACE BOAT (§T.191, race-logic.md "rolling start"): the marshal skiff the grid follows until green, drawn from
 * `RaceState.paceBoat {x, z, yaw, speed}` (null after green → hidden). RENDER ONLY (§V3): the race logic owns the
 * pose; this file never feeds anything back.
 *
 * SMOOTH BETWEEN RACE TICKS. The race publishes a pose per sim tick while frames run at display rate, so a frame
 * that sees the same pose twice dead-reckons along the published yaw at the published speed (capped at
 * `PACE_PREDICT_S`), and the drawn boat follows that target with a short exponential half-life. A jump of more
 * than `PACE_SNAP_M` (first pose, restart) cuts instead of gliding. Yaw follows the shortest arc.
 * Yaw convention: race/polyline `yawOfTangent` = atan2(fwd.x, fwd.z), 0 = +z (the physics' own).
 *
 * The hull sits at the water under it + `PACE_REST_Y` (the grid's rest CG height, page/course.ts SPAWN_CG_Y),
 * level: a marshal boat idling ahead of the field is a look, not a floating body.
 */
import type * as THREE from 'three/webgpu';
import type { App } from '../../core/app';
import type { BoatAsset, BoatInstance, BoatLivery } from '../assets';
import { SPAWN_CG_Y } from './course';

/** marshal white with amber band, number 0 (STYLE-SPEC palette hues: bone topsides, signal amber) */
export const PACE_LIVERY: Readonly<BoatLivery> = {
  topsides: 0xe9e5da,
  band: 0xf2a71b,
  stripe: 0x151b1c,
  antifoul: 0x1e1f21,
  numeral: 0x151b1c,
  dominant: 0xf2a71b,
  number: 0,
};

export const PACE_REST_Y = SPAWN_CG_Y;
/** longest dead-reckoning between two published poses, s (a stalled race must not drive the boat away) */
export const PACE_PREDICT_S = 0.1;
/** follow half-life, s */
export const PACE_HALF_LIFE = 0.05;
/** a target this far from the drawn boat is a cut, m */
export const PACE_SNAP_M = 20;

export interface PacePose {
  x: number;
  z: number;
  yaw: number;
  speed: number;
}

export interface PaceDisplay {
  visible: boolean;
  x: number;
  z: number;
  yaw: number;
  /** internal: last published pose and the time since it changed */
  lastX: number;
  lastZ: number;
  lastYaw: number;
  since: number;
  primed: boolean;
}

export function createPaceDisplay(): PaceDisplay {
  return { visible: false, x: 0, z: 0, yaw: 0, lastX: 0, lastZ: 0, lastYaw: 0, since: 0, primed: false };
}

const wrapPi = (a: number): number => {
  let d = a % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
};

/** one render frame (pure): hide on null, cut on the first pose or a big jump, else predict + follow */
export function stepPaceDisplay(s: PaceDisplay, pose: Readonly<PacePose> | null | undefined, dt: number): PaceDisplay {
  if (!pose || ![pose.x, pose.z, pose.yaw, pose.speed].every(Number.isFinite)) {
    s.visible = false;
    s.primed = false;
    return s;
  }
  const h = Number.isFinite(dt) && dt > 0 ? dt : 0;
  if (pose.x !== s.lastX || pose.z !== s.lastZ || pose.yaw !== s.lastYaw || !s.primed) {
    s.lastX = pose.x;
    s.lastZ = pose.z;
    s.lastYaw = pose.yaw;
    s.since = 0;
  } else {
    s.since += h;
  }
  const ahead = Math.max(0, pose.speed) * Math.min(s.since, PACE_PREDICT_S);
  const tx = pose.x + Math.sin(pose.yaw) * ahead;
  const tz = pose.z + Math.cos(pose.yaw) * ahead;
  if (!s.primed || Math.hypot(tx - s.x, tz - s.z) > PACE_SNAP_M) {
    s.x = tx;
    s.z = tz;
    s.yaw = pose.yaw;
    s.primed = true;
  } else {
    const k = 1 - Math.pow(0.5, h / PACE_HALF_LIFE);
    s.x += (tx - s.x) * k;
    s.z += (tz - s.z) * k;
    s.yaw = wrapPi(s.yaw + wrapPi(pose.yaw - s.yaw) * k);
  }
  s.visible = true;
  return s;
}

export interface PaceBoat {
  readonly instance: BoatInstance;
  readonly display: PaceDisplay;
  update(pose: Readonly<PacePose> | null | undefined, dt: number): void;
  dispose(): void;
}

/** instantiate AFTER `attachHullWetline` (the slot materials bake the wetline), i.e. inside `buildSpeedboatBoats` */
export function createPaceBoat(app: App, asset: BoatAsset, waterAt: (x: number, z: number) => number): PaceBoat {
  const instance = asset.instantiate({ variant: 'npc', water: true, livery: PACE_LIVERY, fovDeg: app.camera.fov });
  const obj = instance.object as THREE.Object3D;
  obj.name = 'paceBoat';
  obj.visible = false;
  app.scene.add(obj);
  const display = createPaceDisplay();
  return {
    instance,
    display,
    update(pose, dt) {
      stepPaceDisplay(display, pose, dt);
      obj.visible = display.visible;
      if (!display.visible) return;
      const y = waterAt(display.x, display.z);
      obj.position.set(display.x, (Number.isFinite(y) ? y : 0) + PACE_REST_Y, display.z);
      obj.quaternion.set(0, Math.sin(display.yaw / 2), 0, Math.cos(display.yaw / 2));
    },
    dispose() {
      obj.removeFromParent();
    },
  };
}
