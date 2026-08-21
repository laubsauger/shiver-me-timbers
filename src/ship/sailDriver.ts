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
import { shipMaterialParams } from '../params/ship';
import { oceanParams } from '../params/ocean';
import type { ShipMaterialParams } from '../params/ship';
import { sailDrive, type SailDriveState } from './sailDynamics';
import { sailFlutterRate } from './sailShape';
import { readSailWindFrame, readSheetLeadSign, sailPhaseSeed, sheetLeadDirections } from './sailFrame';

const TAU = Math.PI * 2;

/** fold into [0, 2π) — an accumulator's float precision then never decays */
function wrapTau(x: number): number {
  const v = (Number.isFinite(x) ? x : 0) % TAU;
  return v < 0 ? v + TAU : v;
}

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
  /** 0..1 cloth drop scale from sim sail trim (set via setSailDropScale) */
  dropScale: ReturnType<typeof uniform>;
  /**
   * ∫ flutterRate dt, wrapped to [0, 2π). REPLACES the shader's old
   * `time × uFlutterFreq` carrier, and with it the last clock in the cloth
   * shape (§V.55, §B.30 — see sailFrame.ts).
   */
  flutterPhase: ReturnType<typeof uniform>;
  /** unit direction, in the sail's own frame, each sheet hauls its clew
   *  toward — see sailFrame.sheetLeadDirections and sailShape.sailCornerPull */
  sheetLeadPort: ReturnType<typeof uniform>;
  sheetLeadStarboard: ReturnType<typeof uniform>;
  /**
   * RGB multiplier on the canvas colour, per sail mesh (§T.73 — the NPC flies
   * red canvas; the reference is docs/inspo/ship/ref-npc-smaller-variant.png).
   * An OBJECT-group uniform, like `dropScale`, so both ships keep sharing the
   * one sail material and pipeline (§T.40); ShipAssembly.setSailTint writes
   * the hex onto each sail mesh's userData and this reads it back. White when
   * unset — the player's canvas is unchanged.
   */
  tint: ReturnType<typeof uniform>;
}

/** per-sail flutter phase, owned here and mirrored onto the mesh */
interface FlutterMemory {
  phase: number;
}

/** the sail's built (width, drop), read once off its own `sailShape` attribute */
function sailDimensions(object: THREE.Object3D): { width: number; drop: number } {
  const geo = (object as THREE.Mesh).geometry;
  const attr = geo?.getAttribute?.('sailShape');
  if (attr === undefined || attr === null || attr.count === 0) return { width: 1, drop: 1 };
  return { width: attr.getY(0), drop: attr.getZ(0) };
}

/** object-group uniforms that track the live wind for whichever sail is drawn */
export function createSailWindUniforms(p: ShipMaterialParams): SailWindUniforms {
  // seeded to a drawing sail: if the per-object update never runs (renderer
  // change, headless probe), the cloth still reads as a filled sail rather
  // than collapsing to a flat sheet — fail visible, not silently worse
  const drive = uniform(0.8).setGroup(objectGroup);
  const luff = uniform(0.05).setGroup(objectGroup);
  const skew = uniform(0).setGroup(objectGroup);
  // 1 = full canvas; ShipAssembly.setSailDropScale writes the sim's trim onto
  // each sail mesh, so one shared material still serves per-ship trim
  const dropScale = uniform(1).setGroup(objectGroup);
  const flutterPhase = uniform(0).setGroup(objectGroup);
  const sheetLeadPort = uniform(new THREE.Vector3()).setGroup(objectGroup);
  const sheetLeadStarboard = uniform(new THREE.Vector3()).setGroup(objectGroup);
  const tint = uniform(new THREE.Color(1, 1, 1)).setGroup(objectGroup);
  const smoothed = new WeakMap<THREE.Object3D, SailDriveState>();
  const flutter = new WeakMap<THREE.Object3D, FlutterMemory>();

  drive.onObjectUpdate((frame: { object: THREE.Object3D | null; time: number }): void => {
    const object = frame.object;
    if (object === null || object === undefined) return;
    const m = object.matrixWorld.elements;
    // 3rd basis column = the SAIL's own forward. Once the yards brace round
    // (rigTrim.ts) this is no longer the ship's heading, and that is the
    // point: the cloth then answers the wind across its own braced face.
    const fx = m[8];
    const fz = m[10];
    const now = frame.time;
    const motion = sampleMotion(object, Math.atan2(fx, fz), now);
    // the ship-level half of the wind state, published once per frame by
    // rigTrim.updateRig — hull heading, way through the water, gust phases
    const wf = readSailWindFrame(object);
    const target = sailDrive(
      {
        forwardX: fx,
        forwardZ: fz,
        shipForwardX: wf.shipForwardX,
        shipForwardZ: wf.shipForwardZ,
        windDirection: oceanParams.windDirection,
        windSpeed: oceanParams.windSpeed,
        shipVelX: wf.shipVelX,
        shipVelZ: wf.shipVelZ,
        yawRate: motion.yawRate,
        gustPhase: wf.gustPhase,
        gustPhaseB: wf.gustPhaseB,
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
    const trimDrop = object.userData.sailDropScale;
    dropScale.value = typeof trimDrop === 'number' && Number.isFinite(trimDrop) ? trimDrop : 1;
    const sailTint = object.userData.sailTint;
    if (typeof sailTint === 'number' && Number.isFinite(sailTint)) tint.value.set(sailTint);
    else tint.value.setScalar(1);

    /**
     * THE FLUTTER PHASE, AND WHY IT IS INTEGRATED HERE (§V.55, §B.30).
     *
     * A phase is ∫ω dt. The shader used to build one as `time × ω(luff)`,
     * which is a phase only while ω is constant — and luff breathes with
     * every gust and every turn of the helm, so elapsed time multiplied every
     * wobble in the rate. Measured on the flags, whose carrier was the same
     * expression: 0.93 Hz intended, 59.5 Hz after ten minutes, with sign
     * flips. The sail's own `sailFlutterFreq·(1+luff)` was found in the same
     * pass and was capped at a CONSTANT rate as a holding fix, because an
     * accumulator needs ONE owner and the shape had two evaluators on two
     * clocks (node `time` here, `performance.now()` in shipAssembly).
     *
     * This is that owner. The phase is advanced with the driver's own dt,
     * wrapped so its float precision never decays, seeded per sail so no two
     * ripple in step (§B.4), and mirrored onto the mesh so the CPU evaluator
     * feeding the rope anchors reads the SAME number rather than
     * re-deriving it from a different clock. With that in place a luffing
     * sail is finally allowed to shake FASTER, not just harder.
     */
    let f = flutter.get(object);
    if (f === undefined) {
      const dim = sailDimensions(object);
      f = { phase: sailPhaseSeed(dim.width, dim.drop) };
      flutter.set(object, f);
    }
    f.phase = wrapTau(f.phase + sailFlutterRate(s.luff, p) * motion.dt);
    flutterPhase.value = f.phase;
    object.userData.sailFlutterPhase = f.phase;

    // where each sheet hauls its clew, in this sail's own frame — recomputed
    // per frame because a bracing yard swings the sail under fixed anchors
    const leads = sheetLeadDirections(m, wf.shipForwardX, wf.shipForwardZ, shipMaterialParams.sailSheetSpread, readSheetLeadSign(object));
    sheetLeadPort.value.set(leads.port[0], leads.port[1], leads.port[2]);
    sheetLeadStarboard.value.set(leads.starboard[0], leads.starboard[1], leads.starboard[2]);
  });

  return { drive, luff, skew, dropScale, flutterPhase, sheetLeadPort, sheetLeadStarboard, tint };
}
