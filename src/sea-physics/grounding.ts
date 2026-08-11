/**
 * Running aground (§V.8 hull-vs-world, feeds §V.14 flooding later).
 *
 * Nothing stopped the hull sailing straight through an island, which is the
 * first thing anyone tries once land is in the scene. What reads well is not
 * a wall: a 40 m galleon that hits a sandbank TOUCHES, slows, heels over as
 * one bilge takes the weight, and sticks — she can be worked off if the sea
 * lifts her, but she is not going anywhere under sail.
 *
 * The model is the buoyancy model upside down. Where buoyancy asks "how far
 * is this bit of hull under the water", grounding asks "how far is this bit
 * of hull under the SEABED", and answers with the same spring/damper at the
 * same lever arms — so pitch and roll fall out of the geometry exactly as
 * righting does, with no separate "beached" pose to author. A bank that
 * shelves to starboard puts more penetration under the starboard stations,
 * which rolls her that way on its own.
 *
 * COST: it reuses the hull-contact stations' world positions, computed once
 * per tick for the spray/wake feed (§V.17 — no second pose pass, and the
 * seabed lookup is a heightmap bilinear, not an FFT sample).
 *
 * SPLIT CONTRACT (§B.6): grounding is an EXTERNAL force. It writes the
 * vertical channel (buoyancy's) and applies planar friction to the shared
 * velocity that sailing reads at the top of its next step — sailing still
 * owns thrust, rudder and yaw; it simply finds the ship slower, as it would
 * against any drag. It never touches yaw or the quaternion directly.
 */
import { rotateVec, invRotateVec } from '../combat/quatMath';
import type { ShipState, Vec3 } from '../state/simState';
import { seaPhysicsParams, type SeaPhysicsParams } from '../params/seaPhysics';
import type { HullContact } from './hullContact';

/**
 * The seabed as physics needs it — satisfied structurally by the island
 * archipelago's `seabed` (island/*), which reads the same heightmap the
 * terrain mesh was built from, so the ship cannot ground on a bank that
 * isn't drawn (the §V.8 argument, applied to the bottom instead of the top).
 */
export interface SeabedField {
  /** seabed elevation (m); waterline = 0, negative below */
  heightAt(x: number, z: number): number;
}

export interface GroundingResult {
  /** any part of the keel line is in the seabed */
  aground: boolean;
  /** deepest keel penetration into the bed this tick (m) */
  penetration: number;
  /** how much of the keel line is in contact, 0..1 */
  extent: number;
  /** upward normal force the bed is carrying (N) */
  normalForce: number;
}

/**
 * One fixed-dt grounding step. Call AFTER buoyancy and after
 * `contact.update()` — it reads that tick's station world positions.
 *
 * `draft` is the depth of the keel below the ship-space waterline plane
 * (galleon 2 m). Stations sit on the waterline outline, so the hull bottom
 * under each is that far down the ship's own up-axis: coarse (a real hull
 * pinches in at the keel) but honest for a "does this touch" test, and it
 * errs toward touching early, which is the safe direction.
 */
export function stepShipGrounding(
  ship: ShipState,
  contact: HullContact,
  seabed: SeabedField,
  draft: number,
  dt: number,
  p: SeaPhysicsParams = seaPhysicsParams,
): GroundingResult {
  const out: GroundingResult = { aground: false, penetration: 0, extent: 0, normalForce: 0 };
  const n = contact.stations.length;
  if (n === 0 || dt <= 0) return out;

  const q = ship.quaternion;
  const up = rotateVec(q, [0, 1, 0]); // ship's own up — she leans, the keel leans
  const pos = ship.position;
  const vel = ship.velocity;
  const w = ship.angularVelocity;
  const torque: Vec3 = [0, 0, 0];
  let fy = 0;
  let touched = 0;

  for (let i = 0; i < n; i++) {
    // keel point under this station: waterline outline, one draft down the
    // hull's up-axis (contact.world* already carries the rotated station)
    const kx = contact.worldX[i] - up[0] * draft;
    const ky = contact.worldY[i] - up[1] * draft;
    const kz = contact.worldZ[i] - up[2] * draft;
    const bed = seabed.heightAt(kx, kz);
    const pen = bed - ky;
    if (pen <= 0) continue;
    touched++;
    out.penetration = Math.max(out.penetration, pen);
    // lever arm from the ship origin to the contact point
    const rx = kx - pos[0];
    const ry = ky - pos[1];
    const rz = kz - pos[2];
    // vertical speed of THIS point (rigid body), damped against the bed
    const vy = vel[1] + (w[2] * rx - w[0] * rz);
    // the bed can push, never pull — a floored normal force (§V.28 spirit:
    // no sign flips smuggled into a force term)
    const f = Math.max(0, p.groundingSpring * pen - p.groundingDamping * vy);
    fy += f;
    // torque = r × (0, f, 0)
    torque[0] += -rz * f;
    torque[2] += rx * f;
    void ry;
  }
  if (touched === 0) return out;

  out.aground = true;
  out.extent = touched / n;
  out.normalForce = fy;

  const mass = p.mass;
  vel[1] += (fy / mass) * dt;

  // Coulomb friction on the planar channel: the bank drags on the hull in
  // proportion to the weight it is carrying, so a light touch slows her and
  // a hard grounding stops her — no special "stuck" state to author.
  const speed = Math.hypot(vel[0], vel[2]);
  if (speed > 1e-6) {
    const decel = (p.groundingFriction * fy) / mass;
    const scale = Math.max(0, 1 - (decel * dt) / speed);
    vel[0] *= scale;
    vel[2] *= scale;
  }

  // same body-frame diagonal inertia as buoyancy; yaw stays sailing's (§B.6)
  const tBody = invRotateVec(q, torque);
  const wBody = invRotateVec(q, [w[0], 0, w[2]]);
  wBody[0] += (tBody[0] / p.inertiaPitch) * dt;
  wBody[2] += (tBody[2] / p.inertiaRoll) * dt;
  const wWorld = rotateVec(q, wBody);
  w[0] = wWorld[0];
  w[2] = wWorld[2];
  return out;
}
