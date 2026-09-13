/**
 * `HullWater` drives → `PropWashInput` (§T.180 c). Its own module so the wake,
 * flowfoam and every page that never carries a speedboat do not pull the
 * contact model in. See propWash.ts for the §V101 residue this adapter states.
 */
import type { HullDrive } from '../sea-physics/hullWater';
import { STANDIN_THRUST } from '../sea-physics/hullWater';
import type { Rigid6State } from '../sea-physics/rigidBody';
import type { PropWashInput } from './propWash';

/** the HullWater surface this adapter reads (structural; the physics agent owns the class) */
export interface PropWashSource {
  readonly mesh: { readonly drives?: readonly HullDrive[]; readonly propRadius: number };
  readonly steer: number;
  readonly throttle: number;
  readonly thrust: number;
  readonly driveImmersion: ArrayLike<number>;
  readonly patch: { heightAt(x: number, z: number): number };
}

/**
 * The props of a `HullWater` after its `evaluate` this tick, as wash inputs
 * (header: §V101 residue). Reuses `out`'s objects; returns the live count.
 */
export function propWashFromHullWater(hw: PropWashSource, state: Readonly<Rigid6State>, out: PropWashInput[]): number {
  const drives = hw.mesh.drives;
  if (!drives || drives.length === 0) return 0;
  const [qx, qy, qz, qw] = state.quaternion;
  const rot = (bx: number, by: number, bz: number): [number, number, number] => {
    const tx = 2 * (qy * bz - qz * by);
    const ty = 2 * (qz * bx - qx * bz);
    const tz = 2 * (qx * by - qy * bx);
    return [bx + qw * tx + (qy * tz - qz * ty), by + qw * ty + (qz * tx - qx * tz), bz + qw * tz + (qx * ty - qy * tx)];
  };
  const [vx, vy, vz] = state.velocity;
  const weights: number[] = [];
  const placed: { x: number; y: number; z: number; dx: number; dz: number; ua: number }[] = [];
  let wsum = 0;
  for (let k = 0; k < drives.length; k++) {
    const dv = drives[k];
    const lock = dv.maxSteerRad;
    const del = hw.steer < -lock ? -lock : hw.steer > lock ? lock : hw.steer;
    const cs = Math.cos(del);
    const sn = Math.sin(del);
    const D = rot(sn, 0, cs);
    const ox = dv.prop[0] - dv.pivot[0];
    const oz = dv.prop[2] - dv.pivot[2];
    const R = rot(dv.pivot[0] + ox * cs + oz * sn, dv.prop[1], dv.pivot[2] - ox * sn + oz * cs);
    const ua = Math.abs(vx * D[0] + vy * D[1] + vz * D[2]);
    const imm = Math.max(0, Math.min(1, hw.driveImmersion[k] ?? 0));
    const w = (imm * Math.sqrt(imm)) / Math.max(ua, STANDIN_THRUST.refSpeed);
    weights.push(w);
    wsum += w;
    placed.push({ x: state.position[0] + R[0], y: state.position[1] + R[1], z: state.position[2] + R[2], dx: D[0], dz: D[2], ua });
  }
  const area = Math.PI * hw.mesh.propRadius * hw.mesh.propRadius;
  // reverse gear (throttle < 0) sends the jet FORWARD along the shaft
  const sign = hw.throttle < 0 ? 1 : -1;
  const total = Math.abs(hw.thrust);
  let live = 0;
  for (let k = 0; k < drives.length; k++) {
    const p = placed[k];
    const len = Math.hypot(p.dx, p.dz);
    if (!(len > 1e-9)) continue;
    const j = (out[live] ??= { x: 0, z: 0, dirX: 0, dirZ: 1, thrust: 0, discArea: area, depth: 0, advance: 0, immersion: 0 });
    j.x = p.x;
    j.z = p.z;
    j.dirX = (sign * p.dx) / len;
    j.dirZ = (sign * p.dz) / len;
    j.thrust = wsum > 0 ? (total * weights[k]) / wsum : 0;
    j.discArea = area;
    j.surfaceY = hw.patch.heightAt(p.x, p.z);
    j.depth = j.surfaceY - p.y;
    j.advance = p.ua;
    j.immersion = Math.max(0, Math.min(1, hw.driveImmersion[k] ?? 0));
    live++;
  }
  out.length = live;
  return live;
}
