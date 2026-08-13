/**
 * THE SAIL WIND FRAME — the per-frame, ship-level state every sail's cloth is
 * shaped by, and the one place its shape is written down.
 *
 * SINGLE OWNER, and this project keeps arriving at that rule the hard way
 * (§V33 ship orientation, §V51 one integrator per SimState channel). The
 * writer is `rigTrim.updateRig`, once per frame per ship. The readers are
 * `sailDriver.ts` (which pushes it into the per-object uniforms the vertex
 * stage runs on) and `ShipAssembly.clothState` (which resolves rope anchors
 * through the CPU evaluator). Two readers, one writer, one value — so the
 * canvas the shader draws and the canvas the sheets are tied to cannot drift
 * apart.
 *
 * That drift was real and recorded: §B.30 found "sailShape has TWO evaluators
 * on TWO clocks (node `time` vs `performance.now()`), so CPU/GPU flutter
 * phase already disagrees by up to ~0.28 m of rope anchor — §V.45-class,
 * unfixed". There is no clock in the shape functions any more; the phases are
 * integrated here and READ there.
 *
 * It rides on `mesh.userData`, which is where `sailDropScale` already lives —
 * per-object state carried by the mesh so that ONE shared material serves
 * every sail, a detached mast keeps responding (§V14), and a second ship gets
 * its own values for free.
 */
import type * as THREE from 'three';

/** what `updateRig` publishes onto every sail mesh, once per frame */
export interface SailWindFrame {
  /** the HULL's forward (world XZ) — trimEfficiency is a point-of-sail curve
   *  and must be measured on the hull, not on a braced yard */
  shipForwardX: number;
  shipForwardZ: number;
  /** the ship's own world velocity (m/s), for apparent wind */
  shipVelX: number;
  shipVelZ: number;
  /** ∫ gustRate dt and ∫ gustRate·detune dt, each wrapped to [0, 2π) */
  gustPhase: number;
  gustPhaseB: number;
}

const KEY = 'sailWindFrame';

/** neutral frame: true wind, no way on, gust at rest. What a headless probe
 *  or a sail rendered before its first `updateRig` correctly sees. */
export const NEUTRAL_SAIL_WIND_FRAME: SailWindFrame = {
  shipForwardX: 0,
  shipForwardZ: 1,
  shipVelX: 0,
  shipVelZ: 0,
  gustPhase: 0,
  gustPhaseB: 0,
};

export function writeSailWindFrame(object: THREE.Object3D, frame: SailWindFrame): void {
  object.userData[KEY] = frame;
}

/**
 * §V28: a caller-fed frame reaching a shader uniform must be finite-guarded,
 * and this one crosses a `userData` bag that anything may write to.
 */
export function readSailWindFrame(object: THREE.Object3D): SailWindFrame {
  const raw = object.userData[KEY] as Partial<SailWindFrame> | undefined;
  if (raw === undefined) return NEUTRAL_SAIL_WIND_FRAME;
  const n = (x: unknown, fallback: number): number =>
    typeof x === 'number' && Number.isFinite(x) ? x : fallback;
  return {
    shipForwardX: n(raw.shipForwardX, 0),
    shipForwardZ: n(raw.shipForwardZ, 1),
    shipVelX: n(raw.shipVelX, 0),
    shipVelZ: n(raw.shipVelZ, 0),
    gustPhase: n(raw.gustPhase, 0),
    gustPhaseB: n(raw.gustPhaseB, 0),
  };
}

/**
 * Where a sail's flutter phase STARTS, from its own dimensions.
 *
 * §B.4 is the standing lesson: the ocean's sparkle shared one time phase
 * across every cell and the whole sea flashed in unison. Six sails on one
 * ship rippling in step would read the same way — as one animation playing,
 * rather than as six pieces of cloth in the same air. Seeded, never random
 * (§V2), and shared by both evaluators so they start together as well as
 * advance together.
 */
export function sailPhaseSeed(width: number, drop: number): number {
  const w = Number.isFinite(width) ? width : 1;
  const d = Number.isFinite(drop) ? drop : 1;
  // hash2Scalar(width·3.71, drop·1.17)·2π — the SAME expression the shader
  // seeded this from before the phase moved to the CPU, so a change that is
  // only about WHO OWNS the phase does not also move the look.
  return hash2Scalar(w * 3.71, d * 1.17) * Math.PI * 2;
}

/**
 * CPU mirror of src/terrain/noise.ts `hash2` (Hoskins hash22 → 1D). It lived
 * in shipAssembly.ts while that file seeded the ripple phase itself; the seed
 * is shared by both evaluators now, so it lives with them.
 */
function hash2Scalar(x: number, y: number): number {
  const f = (v: number): number => v - Math.floor(v);
  let p3x = f(x * 0.1031);
  let p3y = f(y * 0.1031);
  let p3z = f(x * 0.1031);
  const d = p3x * (p3y + 33.33) + p3y * (p3z + 33.33) + p3z * (p3x + 33.33);
  p3x += d;
  p3y += d;
  p3z += d;
  return f((p3x + p3y) * p3z);
}

/** a unit-ish direction in the SAIL's own local frame */
export type SailLocalDir = [number, number, number];

export interface SheetLeads {
  /** where the PORT sheet hauls its clew, in sail-local space */
  port: SailLocalDir;
  starboard: SailLocalDir;
}

/** both sheets dead, i.e. the corners stay in the yard's plane */
export const NO_SHEET_LEADS: SheetLeads = { port: [0, 0, 0], starboard: [0, 0, 0] };

/**
 * WHERE EACH SHEET HAULS ITS CLEW, in the sail's own frame.
 *
 * A square sail's sheets lead AFT AND DOWN from the clews to the ship — in
 * `src/ropes/shipRigging.ts` they run to the chainplate of the next mast aft,
 * or to the stern. So the direction is: the hull's own stern vector, plus
 * gravity, plus a lateral spread that sends the port sheet to port and the
 * starboard one to starboard.
 *
 * IT IS EXPRESSED IN SAIL-LOCAL SPACE, which is the whole point: the sail
 * hangs off a yard that BRACES, so as the yard swings the same fixed anchors
 * arrive from a different quarter and the foot is hauled a different way. The
 * corners stop being flat against the mast, exactly as asked.
 *
 * THE SEAM, DELIBERATELY LEFT HERE. This resolves a DIRECTION from the hull's
 * heading rather than a POINT from the sheet's actual anchor socket. The
 * cloth evaluators take a direction either way, so upgrading to true anchor
 * points is a change to this function alone and touches neither evaluator.
 * Points are the better model and would give each sail its own lead; a
 * direction is what can be had without plumbing the rope plan's socket
 * naming (`belay(side, aftMast)`) into src/ship, where it would be a second
 * copy free to drift.
 *
 * NON-CIRCULAR BY CONSTRUCTION, and that matters: it reads the HULL's heading
 * and the sail's own transform, never a rope's solved curve. 24 of 68 ropes
 * resolve their endpoints THROUGH the cloth, so a corner that read a solved
 * rope back would close a loop between the cloth and the rigging that would
 * settle differently on the CPU and the GPU — §V.45's failure mode.
 *
 * @param m sail `matrixWorld.elements` — its upper 3x3 is a pure rotation
 *          (rigid ship transforms), so the inverse is the transpose
 */
export function sheetLeadDirections(
  m: ArrayLike<number>,
  shipForwardX: number,
  shipForwardZ: number,
  spread: number,
): SheetLeads {
  const n = (x: number): number => (Number.isFinite(x) ? x : 0);
  const fx = n(shipForwardX);
  const fz = n(shipForwardZ, );
  const fl = Math.hypot(fx, fz);
  // no heading yet ⟹ no honest lead. Fail to "flat", never to a made-up one.
  if (fl < 1e-4) return NO_SHEET_LEADS;
  const ax = -fx / fl; // aft
  const az = -fz / fl;
  const sx = -az; // starboard = aft rotated, i.e. forward's right
  const sz = ax;
  const sp = Math.max(0, n(spread));
  const build = (side: number): SailLocalDir => {
    // world-space lead: aft, down, and out to its own side
    const wx = ax + sx * sp * side;
    const wy = -1;
    const wz = az + sz * sp * side;
    // world → sail-local by the transpose of the sail's rotation
    const lx = m[0] * wx + m[1] * wy + m[2] * wz;
    const ly = m[4] * wx + m[5] * wy + m[6] * wz;
    const lz = m[8] * wx + m[9] * wy + m[10] * wz;
    const len = Math.hypot(lx, ly, lz);
    if (!Number.isFinite(len) || len < 1e-6) return [0, 0, 0]; // §V28
    return [lx / len, ly / len, lz / len];
  };
  return { port: build(-1), starboard: build(1) };
}
