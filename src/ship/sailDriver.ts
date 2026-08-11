/**
 * Per-sail wind uniforms (§V3: reads the ship's own render transform and the
 * wind params the sim reads; writes nothing back). Split out of
 * sailMaterial.ts at the file cap (§C).
 *
 * The values live in three's OBJECT uniform group and are refreshed in
 * `onObjectUpdate`, so every sail mesh gets its own drive/luff/skew without
 * anything outside src/ship having to push state in — a detached mast keeps
 * responding, and a second ship gets its own values for free.
 */
import * as THREE from 'three/webgpu';
import { objectGroup, uniform } from 'three/tsl';
import { oceanParams } from '../params/ocean';
import type { ShipMaterialParams } from '../params/ship';
import { sailDrive, type SailDriveState } from './sailDynamics';

const TAU = Math.PI * 2;

/**
 * Per-object yaw history → yaw rate + frame dt. Returns BOTH because the
 * caller damps with the same dt: sampling the history twice (once here, once
 * for dt) reads back the value just written, yields dt ≈ 0 and freezes the
 * damping — the cloth would then look static, the exact bug being fixed.
 */
const yawMemory = new WeakMap<THREE.Object3D, { yaw: number; time: number }>();

function sampleMotion(
  object: THREE.Object3D,
  worldYaw: number,
  now: number,
): { yawRate: number; dt: number } {
  const prev = yawMemory.get(object);
  yawMemory.set(object, { yaw: worldYaw, time: now });
  if (prev === undefined) return { yawRate: 0, dt: 1 / 60 };
  const raw = now - prev.time;
  const dt = Math.min(0.25, Math.max(1 / 1000, raw)); // §V28: floored divisor
  if (raw <= 1e-4) return { yawRate: 0, dt };
  let d = worldYaw - prev.yaw;
  if (d > Math.PI) d -= TAU;
  else if (d < -Math.PI) d += TAU;
  return { yawRate: d / dt, dt };
}

export interface SailWindUniforms {
  /** signed belly fill (−back … +full) */
  drive: ReturnType<typeof uniform>;
  /** 0..1 shake */
  luff: ReturnType<typeof uniform>;
  /** −1..1 sideways belly lag while turning */
  skew: ReturnType<typeof uniform>;
}

/** object-group uniforms that track the live wind for whichever sail is drawn */
export function createSailWindUniforms(p: ShipMaterialParams): SailWindUniforms {
  // seeded to a drawing sail: if the per-object update never runs (renderer
  // change, headless probe), the cloth still reads as a filled sail rather
  // than collapsing to a flat sheet — fail visible, not silently worse
  const drive = uniform(0.8).setGroup(objectGroup);
  const luff = uniform(0.05).setGroup(objectGroup);
  const skew = uniform(0).setGroup(objectGroup);
  const smoothed = new WeakMap<THREE.Object3D, SailDriveState>();

  drive.onObjectUpdate((frame: { object: THREE.Object3D | null; time: number }): void => {
    const object = frame.object;
    if (object === null || object === undefined) return;
    const m = object.matrixWorld.elements;
    // 3rd basis column = the sail's forward (= ship forward: yards are square)
    const fx = m[8];
    const fz = m[10];
    const now = frame.time;
    const motion = sampleMotion(object, Math.atan2(fx, fz), now);
    const target = sailDrive(
      {
        forwardX: fx,
        forwardZ: fz,
        windDirection: oceanParams.windDirection,
        windSpeed: oceanParams.windSpeed,
        yawRate: motion.yawRate,
        time: now,
      },
      p,
    );
    // exp-damped: cloth has inertia, it does not snap with the rudder
    let s = smoothed.get(object);
    if (s === undefined) {
      s = { ...target };
      smoothed.set(object, s);
    } else {
      const k = 1 - Math.exp(-Math.max(0.2, p.sailResponse) * motion.dt);
      s.drive += (target.drive - s.drive) * k;
      s.luff += (target.luff - s.luff) * k;
      s.skew += (target.skew - s.skew) * k;
    }
    drive.value = s.drive;
    luff.value = s.luff;
    skew.value = s.skew;
  });

  return { drive, luff, skew };
}
