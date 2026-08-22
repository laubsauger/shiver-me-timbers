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
 * THE BLADE'S OWN GEARING — rudder → rotation about the stock, in radians.
 *
 * §B92: "the rudder does not seem to move on the big pirate ship, or not
 * enough". It moved not at all — `updateRig` turned the wheel and nothing
 * turned the blade the wheel is geared to.
 *
 * A SEPARATE MAPPING FROM `helmWheelAngle`, and that is the point. The wheel
 * spins `helmTurnsLockToLock` (3.5) TURNS lock to lock through the barrel;
 * the blade swings `rudderBladeMax` (35°) each way and stops, because a rudder
 * past ~35° stalls and steers less, not more. Handing the wheel's angle to the
 * blade would have rotated it 5½ revolutions at hard over.
 *
 * THE SIGN IS THE SHIP'S, not the piece's. `ship.rudder` > 0 turns her to
 * starboard (`shipKinematics`: "positive rudder turns to starboard"), which
 * means the blade's TRAILING EDGE goes to starboard — and the blade lies aft
 * of its own stock (−z), so a positive-y rotation would take that edge to
 * PORT. Hence the negation: the number is a piece rotation, the property it
 * has to preserve is which way she swings.
 *
 * NO RATE LIMIT OF ITS OWN, for the reason `helmWheelAngle` has none and
 * stated here because this is where it would be tempting: `ship.rudder` IS the
 * rate-limited quantity. `shipKinematics.slewRudder` is documented as "the ONE
 * rudder rate limit — the keyboard, both helms and the AI all pass through
 * it", so the blade already follows the helm at the helmsman's own speed. A
 * second limit here would put the BLADE behind the number the hydrodynamics
 * are already steering on, i.e. draw a rudder that disagrees with the turn it
 * is making (§V.77, and the §T.78 lesson about second copies of one state).
 */
export function rudderBladeAngle(rudder: number, p: ShipRigParams): number {
  const r = Math.max(-1, Math.min(1, Number.isFinite(rudder) ? rudder : 0));
  return -r * Math.max(0, p.rudderBladeMax);
}

/**
 * §B100(a) — `ship.rudder` → the RAFT'S STEERING OAR, in radians about the
 * thole-pins. Its own mapping beside `rudderBladeAngle`, for the reason that
 * one is its own mapping beside `helmWheelAngle`: the two stops are different
 * things. A rudder stops at ~35° because past that it stalls; a steering oar
 * stops because "ropes from each side of the blade to each raft side" limit
 * the sweep [ref §5 Ropes]. They happen to be the same size of arc, which is
 * why this reads `rudderBladeMax` rather than inventing a knob nobody will
 * ever turn — but it is a SEPARATE call, so giving the oar its own rope stop
 * later is a change to this function and to nothing else.
 *
 * SAME SIGN AS THE BLADE, and for the same geometric reason: the oar's own
 * piece origin is at the pins and its blade lies ABAFT them (−z), so a
 * positive-y rotation would swing the blade to PORT. `ship.rudder` > 0 turns
 * her to starboard, which wants the blade to starboard. Hence the negation.
 */
export function oarSweepAngle(oar: number, p: ShipRigParams): number {
  const r = Math.max(-1, Math.min(1, Number.isFinite(oar) ? oar : 0));
  return -r * Math.max(0, p.rudderBladeMax);
}

/**
 * @param dt     render frame delta (s) — advances the gust and velocity filters
 * @param trim   sim `sailTrim` 0..1; omit to leave the canvas at full
 * @param rudder sim `ship.rudder` −1..1; omit to leave the wheel amidships
 * @param brace  sim `ship.brace` rad; omit to leave the yards where they are
 * @param trimBySail §T.148 per-sail override of `trim`, keyed by the sail
 *        piece's id stem (`sail-main-upper` → `main-upper`); a sail this map
 *        does not name keeps the ship-wide scalar
 */
export function updateRig(
  assembly: ShipAssembly,
  dt: number,
  trim = 1,
  rudder = 0,
  brace?: number,
  guaraDepth?: readonly number[],
  trimBySail?: Readonly<Record<string, number>>,
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
  // ...and the BLADE the wheel is geared to, from the same number (§B92). Both
  // here, in one place, so a hull can never get one of the two: the wheel used
  // to be the only thing that moved and the rudder stood amidships through
  // every turn. Its own gearing — a rudder has stops at ~35°, a wheel has
  // turns — see rudderBladeAngle.
  assembly.setRudderAngle(rudderBladeAngle(rudder, p));
  // §B100(a): ...and the RAFT'S oar, from the same number, through the same
  // one path (§V95). A vessel with no `steering-oar` piece pays a loop over
  // nothing; a vessel that HAS one can no longer be forgotten here, which is
  // exactly how the blade was forgotten in §B92 and the oar in §T.118.
  assembly.setSteeringOarAngle(oarSweepAngle(rudder, p));
  // §B100(b): the centreboards the raft actually steers on. Optional because
  // only one class has them — and `undefined` leaves the planks where the
  // blueprint put them rather than snapping them to 0.
  if (guaraDepth !== undefined) assembly.setGuaraDepths(guaraDepth);

  const sails = assembly.sailPieceIds();
  assembly.setSailWindFrame(frame);
  if (sails.length === 0) return;
  for (const id of sails) {
    // §T.148: EACH SAIL ON ITS OWN SHEET. One scalar used to be scaled onto
    // every sail here, which is why the raft's three sheet stations would all
    // have been the same control (§V62) however carefully they were placed.
    // A ship whose sim publishes no per-sail map (every square-rigger) is
    // unchanged: `sailTrimFor` falls back to the ship-wide scalar.
    const drop = trimDropScale(sailTrimFor(id, trim, trimBySail), p);
    assembly.setSailDropScale(id, drop);
    // §B86-3: the SAME scalar lowers the yard, so the roll arrives at the
    // bottom of the travel exactly as the last of the canvas leaves the hoist
    assembly.setYardHoist(id, drop);
    writeSailWindFrame(assembly.sailMesh(id), frame);
  }
}

/** the `sail-` prefix every sail piece id carries; its remainder is the sail's key */
const SAIL_ID_PREFIX = 'sail-';

/**
 * §T.148 — the trim ONE sail is set to: its own entry in the per-sail map, or
 * the ship-wide scalar when the class does not carry one. Exported because it
 * is the whole contract between `ShipState.sailTrimBySail`'s key spelling and
 * the blueprint's piece ids, and a test holds the two together.
 */
export function sailTrimFor(
  sailPieceId: string,
  trim: number,
  trimBySail?: Readonly<Record<string, number>>,
): number {
  if (trimBySail === undefined) return trim;
  const key = sailPieceId.startsWith(SAIL_ID_PREFIX) ? sailPieceId.slice(SAIL_ID_PREFIX.length) : sailPieceId;
  const v = trimBySail[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : trim; // §V28
}

/**
 * The sim state a vessel's rig is drawn from. Structural, not `ShipState`:
 * `rigTrim` must not import the sim (§V3 one-way), and the three scalars ARE
 * the whole contract — anything that can produce them can be rigged.
 */
export interface RiggedShip {
  /** 0..1 canvas set */
  sailTrim: number;
  /** −1..1 blade angle, geared to the wheel */
  rudder: number;
  /** yard brace (rad); absent = this class has no braceable yards */
  brace?: number;
  /**
   * §B100(b) — the raft's five guara depths, 0 (hauled clear) .. 1 (down),
   * index k driving `guara-{k+1}`. Absent = this class has no centreboards.
   */
  guaraDepth?: readonly number[];
  /**
   * §T.148 — per-sail canvas set, keyed by the sail piece's id stem. Absent =
   * this class trims her whole rig on one sheet, which is every square-rigger
   * in the game; present = each named sail is drawn at its OWN trim and
   * `sailTrim` stays the whole-rig number the HUD and the ropes read.
   */
  sailTrimBySail?: Readonly<Record<string, number>>;
}

/** What one frame of rig drive produced, for the consumers downstream of it. */
export interface ShipRigDrive {
  /** continuous cloth drop 0..1 — the SAME scalar the canvas, the sheets and
   *  the haul audio read, so none of the three can disagree (§B.30) */
  drop: number;
  /** 0..1 how far the RUNNING RIGGING is furled: the normalised complement of
   *  `drop`, which is what `applyRiggingPlan` takes */
  furl: number;
}

/**
 * §V95 — THE ONE PER-FRAME RIG DRIVE, AND IT TAKES A SHIP.
 *
 * Every vessel in the game goes through this: the player's galleon, the AI's
 * brigantine, the raft, and whatever is added next. It exists because the
 * per-frame drive had started to be COPIED per ship instead of shared, and the
 * copies had already drifted (§B88):
 *
 *   · `main.ts` computed the furl scalar for the rigging from the PLAYER's
 *     `sailTrim` and then handed that same number to the ENEMY's rigging plan,
 *     so her ropes were hauled by the player's sheets;
 *   · `raftFrame.ts` carried its own third copy of the same three lines.
 *
 * Each copy is one more place a third ship can be forgotten in, which is
 * exactly the failure §B88 was reported as. `updateRig` below is still the
 * assembly-level primitive (the ship preview and the profile tests drive it
 * with a bare scalar and no sim); this is the call a VESSEL makes.
 */
export function updateShipRig(
  ship: RiggedShip,
  assembly: ShipAssembly,
  dt: number,
): ShipRigDrive {
  updateRig(assembly, dt, ship.sailTrim, ship.rudder, ship.brace, ship.guaraDepth, ship.sailTrimBySail);
  // the RIGGING's furl is still the whole rig's: `applyRiggingPlan` hauls one
  // plan for the vessel, and `sailTrim` is the area-weighted set on a raft
  // (`raftShip.stepRaftShip`), so the ropes follow the canvas that is actually
  // drawing rather than whichever sail happened to be asked last.
  return rigDrive(ship.sailTrim);
}

/**
 * trim → (cloth drop, rigging furl), the pair every consumer of "how much
 * canvas is set" reads. ONE expression: the ropes used to normalise the
 * complement at two call sites with the same three-line snippet, and a third
 * ship arrived without it.
 */
export function rigDrive(trim: number, p: ShipRigParams = shipRigParams): ShipRigDrive {
  const drop = trimDropScale(trim, p);
  // §V28 floored divisor — trimDropMin is a live panel value and may reach 1
  const span = Math.max(1e-3, 1 - p.trimDropMin);
  return { drop, furl: Math.min(1, Math.max(0, (1 - drop) / span)) };
}
