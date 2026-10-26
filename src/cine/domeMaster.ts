/**
 * DOME MASTER: the square fisheye frame a planetarium plays, and the direction each of its pixels looks.
 *
 * Convention (IMERSA dome-master, the one studio-world already plays and cross-checked against the Paul
 * Bourke charts — studio-world/src/engine/surfaces/domeWarp.ts `domeMasterUV`, SPEC R11):
 *   - equidistant azimuthal: radius is linear in zenith angle, r = (90° − elevation) / 90° · R
 *   - zenith at the circle centre, spring line (elevation 0) at the circle edge
 *   - frame BOTTOM = dome front; frame RIGHT = the seated viewer's right
 *   - uv: u right, v up, v = 0 at the bottom (three's texture/quad convention)
 *
 * Camera-local frame: front = −Z, up = +Y, right = +X (three's camera convention). A TILTED dome leans
 * its zenith toward the front by `tiltDeg` (Horizon 18: 15°); the front horizon then sits below the eye.
 *
 * `domeMasterDirection` is the inverse of studio-world's `domeMasterUV`; tests/domeMaster.test.ts holds the
 * round trip. The TSL twin below is what the capture pass runs per output pixel.
 */
import { atan, cos, float, length, sin, step, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';

export type Vec3 = [number, number, number];

/** zenith (`axis`), `front` and `right` of the dome in camera-local coordinates */
export function domeBasis(tiltDeg: number): { axis: Vec3; front: Vec3; right: Vec3 } {
  const t = (tiltDeg * Math.PI) / 180;
  // rotate up (+Y) and front (−Z) about right (+X) so the zenith leans toward the front
  return { axis: [0, Math.cos(t), -Math.sin(t)], front: [0, -Math.sin(t), -Math.cos(t)], right: [1, 0, 0] };
}

/**
 * Direction (unit, camera-local) that dome-master pixel (u, v) looks along, or null outside the circle.
 * Also returns elevation and azimuth (rad; azimuth 0 = front, +π/2 = right).
 */
export function domeMasterDirection(
  u: number,
  v: number,
  tiltDeg = 0,
): { dir: Vec3; el: number; az: number } | null {
  const dx = u - 0.5;
  const dy = v - 0.5;
  const r = Math.hypot(dx, dy); // 0 at the zenith, 0.5 at the spring line
  if (r > 0.5) return null;
  const el = (1 - r / 0.5) * (Math.PI / 2);
  const az = Math.atan2(dx, -dy); // bottom of the frame (dy < 0) is azimuth 0, the front
  const { axis, front, right } = domeBasis(tiltDeg);
  const h = Math.cos(el);
  const s = Math.sin(el);
  const ca = Math.cos(az);
  const sa = Math.sin(az);
  const dir: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) dir[i] = h * (ca * front[i] + sa * right[i]) + s * axis[i];
  return { dir, el, az };
}

/**
 * TSL twin: dome-master uv → camera-local view direction, plus `inside` (1 inside the circle, 0 outside).
 * `tilt` is in radians. Plain node composition (inlined at the call site), mirroring the CPU function line
 * for line; three's two-argument `atan(y, x)` is atan2.
 */
export function domeMasterDirectionNode(uvNode: Node<'vec2'>, tilt: Node<'float'>): { dir: Node<'vec3'>; inside: Node<'float'> } {
  const dx = uvNode.x.sub(0.5);
  const dy = uvNode.y.sub(0.5);
  const r = length(uvNode.sub(0.5));
  const el = float(1).sub(r.mul(2)).mul(Math.PI / 2);
  const az = atan(dx, dy.negate());
  const ct = cos(tilt);
  const st = sin(tilt);
  const axis = vec3(0, ct, st.negate());
  const front = vec3(0, st.negate(), ct.negate());
  const right = vec3(1, 0, 0);
  const horizontal = front.mul(cos(az)).add(right.mul(sin(az)));
  const dir = horizontal.mul(cos(el)).add(axis.mul(sin(el)));
  // a hard edge is right for a master: the dome screen ends at the spring line
  const inside = step(r, float(0.5));
  return { dir, inside };
}
