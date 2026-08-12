/**
 * Rig driver: braces the yards to the live wind and swaps sail trim states.
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
 * Both halves are internally edge-triggered/rate-limited, so calling it every
 * frame is correct and cheap: the brace damps toward its target, and a sail
 * state swap (which disposes and rebuilds geometry) only happens when the
 * state actually changes.
 */
import type * as THREE from 'three';
import { shipRigParams } from '../params/ship';
import { setShipWorldMatrix } from './woodMaterial';
import { oceanParams } from '../params/ocean';
import type { ShipAssembly } from './shipAssembly';
import { braceAngle, sailGeometryState, trimDropScale } from './sailDynamics';

/** ship forward (world XZ) from the assembly's own matrix — 3rd basis column */
function shipForward(group: THREE.Object3D): { x: number; z: number } {
  const m = group.matrixWorld.elements;
  return { x: m[8], z: m[10] };
}

/**
 * @param dt   render frame delta (s) — rate-limits the swing
 * @param trim sim `sailTrim` 0..1; omit to leave the canvas at full
 */
export function updateRig(assembly: ShipAssembly, dt: number, trim = 1): void {
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

  // --- brace: yards swing toward the wind-derived target, never snap ------
  const fwd = shipForward(assembly.group);
  const target = braceAngle(
    { forwardX: fwd.x, forwardZ: fwd.z, windDirection: oceanParams.windDirection },
    p,
  );
  const current = assembly.braceAngle;
  const maxStep = Math.max(0, p.braceRate) * step;
  const delta = target - current;
  const next =
    Math.abs(delta) <= maxStep ? target : current + Math.sign(delta) * maxStep;
  assembly.setRigTrim(next);

  // --- trim: continuous cloth drop, and ONE geometry swap at the bottom ----
  // The §V13 label (sailStateForTrim) deliberately does NOT appear here. It is
  // hysteretic and three-valued, so keying geometry off it made the cloth jump
  // 34% of its drop at mid-travel going in and 41% at a different trim coming
  // out, with a 39%-wide dead band between. The reef is the continuous scale;
  // the mesh only changes once, where the two silhouettes already match.
  const sails = assembly.sailPieceIds();
  if (sails.length === 0) return;
  const state = sailGeometryState(trim, assembly.sailState(sails[0]), p);
  const drop = trimDropScale(trim, p);
  for (const id of sails) {
    assembly.setSailState(id, state); // no-op unless the state changed
    assembly.setSailDropScale(id, drop);
  }
}
