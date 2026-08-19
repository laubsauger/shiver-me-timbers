/**
 * Rig driver: braces the yards to the live wind and publishes the sail trim.
 * §V3 one-way — reads the ship's render transform, the wind params the sim
 * reads, and the sim's `sailTrim` scalar; writes only three.js transforms and
 * piece states.
 *
 * This is the one thing the sail work could NOT do from inside a material:
 * a per-object uniform cannot move a transform, and a yard swinging round is
 * the most visible half of "the sails appear too static, especially when
 * we're turning". So main.ts drives it, once per frame:
 *
 *     updateRig(shipAssembly, frameDt, playerShip.sailTrim);
 *
 * Calling it every frame is correct and cheap: the brace damps toward its
 * target, and the trim is a scalar written onto each sail mesh. NO GEOMETRY IS
 * BUILT OR DISPOSED HERE — the reef used to swap meshes and that is exactly
 * what the user felt as a skip; see the block above the trim section.
 */
import type * as THREE from 'three';
import { shipMaterialParams, shipRigParams, type ShipRigParams } from '../params/ship';
import { setShipWorldMatrix } from './woodMaterial';
import type { ShipAssembly } from './shipAssembly';
import { SAIL_GUST_DETUNE, sailGustRate, trimDropScale } from './sailDynamics';
import { writeSailWindFrame, type SailWindFrame } from './sailFrame';

const TAU = Math.PI * 2;

/** ship forward (world XZ) from the assembly's own matrix — 3rd basis column */
function shipForward(group: THREE.Object3D): { x: number; z: number } {
  const m = group.matrixWorld.elements;
  return { x: m[8], z: m[10] };
}

/** fold into [0, 2π) — an accumulator's float precision then never decays */
function wrapTau(x: number): number {
  const v = (Number.isFinite(x) ? x : 0) % TAU;
  return v < 0 ? v + TAU : v;
}

/**
 * Per-ship wind bookkeeping: her damped world velocity, and the gust train's
 * two phases. Keyed by assembly, so a second ship gets her own for free.
 *
 * VELOCITY IS MEASURED, NOT HANDED IN. `updateRig` deliberately takes no sim
 * state (§V3 — it reads the render transform and the wind params the sim also
 * reads, and writes nothing back), and the group's own world position is the
 * ship's position. Low-passed for the same reason flagDriver low-passes its
 * own: an unfiltered per-frame derivative reads pitch and heave as gusts.
 */
interface RigMemory {
  x: number;
  z: number;
  velX: number;
  velZ: number;
  gustPhase: number;
  gustPhaseB: number;
  seeded: boolean;
}

const rigMemory = new WeakMap<ShipAssembly, RigMemory>();

/** velocity smoothing time constant (s) — long enough to reject wave motion */
const VELOCITY_TAU = 0.6;

function advanceFrame(assembly: ShipAssembly, group: THREE.Object3D, dt: number): SailWindFrame {
  const m = group.matrixWorld.elements;
  const x = m[12];
  const z = m[14];
  let mem = rigMemory.get(assembly);
  if (mem === undefined) {
    mem = { x, z, velX: 0, velZ: 0, gustPhase: 0, gustPhaseB: 0, seeded: true };
    rigMemory.set(assembly, mem);
  } else if (dt > 1e-4) {
    const k = 1 - Math.exp(-dt / VELOCITY_TAU);
    mem.velX += ((x - mem.x) / dt - mem.velX) * k;
    mem.velZ += ((z - mem.z) / dt - mem.velZ) * k;
    mem.x = x;
    mem.z = z;
  }
  // §V.55: `sailGustFreq` is a live Tweakpane value, so `time × rate` is not a
  // phase. Two accumulators rather than one scaled by SAIL_GUST_DETUNE —
  // multiplying a wrapped phase by a non-integer ratio breaks continuity at
  // every wrap, which is §V.55's own corollary from the flags' crack harmonic.
  const rate = sailGustRate(shipMaterialParams);
  mem.gustPhase = wrapTau(mem.gustPhase + rate * dt);
  mem.gustPhaseB = wrapTau(mem.gustPhaseB + rate * SAIL_GUST_DETUNE * dt);
  const fwd = shipForward(group);
  return {
    shipForwardX: fwd.x,
    shipForwardZ: fwd.z,
    shipVelX: mem.velX,
    shipVelZ: mem.velZ,
    gustPhase: mem.gustPhase,
    gustPhaseB: mem.gustPhaseB,
  };
}

/**
 * THE HELM'S GEARING — rudder → wheel angle, in radians.
 *
 * `rudder` is the sim's own −1..1, i.e. the SAME number the hydrodynamics
 * steer on (`stepShipSailing` reads `ship.rudder` for its yaw target), and
 * deliberately not the raw key state: the input already ramps and springs, and
 * a wheel driven from the intent would LEAD the ship it is supposedly turning.
 *
 * The factor of 0.5 is the rudder's own range: −1..1 is two units of travel,
 * and `helmTurnsLockToLock` counts turns across all of it.
 */
export function helmWheelAngle(rudder: number, p: ShipRigParams): number {
  const r = Math.max(-1, Math.min(1, Number.isFinite(rudder) ? rudder : 0));
  return r * Math.max(0, p.helmTurnsLockToLock) * Math.PI; // turns·2π·(r/2)
}

/**
 * @param dt     render frame delta (s) — advances the gust and velocity filters
 * @param trim   sim `sailTrim` 0..1; omit to leave the canvas at full
 * @param rudder sim `ship.rudder` −1..1; omit to leave the wheel amidships
 * @param brace  sim `ship.brace` rad; omit to leave the yards where they are
 */
export function updateRig(
  assembly: ShipAssembly,
  dt: number,
  trim = 1,
  rudder = 0,
  brace?: number,
): void {
  const p = shipRigParams;
  const step = Math.min(0.25, Math.max(0, Number.isFinite(dt) ? dt : 0));

  // Publish the ship's world transform to the piece materials, so the hull
  // wetline's drying memory can be looked up in SHIP-local space (§T.32).
  // Done here rather than handed to main.ts because a stale identity matrix
  // is not a graceful degradation — it would place the wet band at world
  // origin, hundreds of metres from the hull. The group hangs directly off
  // the scene, so its local matrix IS its world matrix; composing it costs
  // one matrix and avoids traversing the whole 50-piece subtree.
  assembly.group.updateMatrix();
  setShipWorldMatrix(assembly.group.matrix);

  // --- the ship-level wind frame, published to every sail (sailFrame.ts) ---
  // ONE writer, two readers (sailDriver's uniforms, ShipAssembly.clothState),
  // so the canvas the shader draws and the canvas the sheets are tied to
  // cannot drift apart the way §B.30 measured them drifting.
  const frame = advanceFrame(assembly, assembly.group, step);

  // --- brace: the yards DISPLAY the sim's own angle, they no longer choose it
  //
  // This used to compute its own target from `oceanParams.windDirection` and
  // slew toward it on the RENDER delta. Both halves were wrong the moment the
  // brace started driving the ship (§T.76): the wind it read was a second copy
  // of the one the sim steps on (§V.77), and a slew on the frame delta makes a
  // FORCE frame-rate dependent (§V.2 — the same defect §T.78 found in the
  // wake). `shipKinematics.stepShipSailing` owns the target, the manual
  // override and the rate limit; there is nothing left to decide here.
  if (brace !== undefined && Number.isFinite(brace)) assembly.setRigTrim(brace);

  // --- trim: one continuous cloth drop, and NO geometry swap at all --------
  // NOTHING here selects a mesh, and nothing may start doing so again. The
  // §V13 label (sailStateForTrim) is hysteretic and three-valued, so keying
  // geometry off it jumped the cloth 34% of its drop at mid-travel going in
  // and 41% coming out; moving that swap to the bottom of the travel only made
  // it smaller (the top of the sail still moved 0.04-0.09 of the drop and the
  // silhouette still tripled in thickness). The reef is the scale, and the
  // gathered roll rides the SAME scale in the same mesh — see
  // sailDynamics.trimDropScale and sailShape.furlBundleScale.
  // the helm follows the RUDDER, geared through the barrel — see
  // helmWheelAngle. No rate limit of its own: the rudder already has one
  // (rudderRampRate / rudderSpringRate), and adding a second would put the
  // wheel behind the blade it is supposed to be turning.
  assembly.setHelmAngle(helmWheelAngle(rudder, p));

  const sails = assembly.sailPieceIds();
  assembly.setSailWindFrame(frame);
  if (sails.length === 0) return;
  const drop = trimDropScale(trim, p);
  for (const id of sails) {
    assembly.setSailDropScale(id, drop);
    writeSailWindFrame(assembly.sailMesh(id), frame);
  }
}
