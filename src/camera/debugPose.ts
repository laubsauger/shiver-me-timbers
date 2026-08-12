/**
 * Debug vantage (§V22) — an exact world pose that outranks every camera
 * mode and is re-asserted on every frame.
 *
 * WHY this exists as a first-class thing rather than "just set
 * camera.position": verification agents park the lens and then screenshot,
 * and a screenshot forces rAF frames. Whatever owns the camera pose writes
 * it again on each of those frames, so an externally-set position gets
 * stomped and the shot comes out from the game camera's framing instead.
 * Agents worked around it with Object.defineProperty(..., {writable:
 * false}); this is the supported way.
 */
import type { PerspectiveCamera } from 'three';
import { Vector3 } from 'three';

/** console-friendly: an array literal or anything with x/y/z (Vector3) */
export type Vec3Like = readonly [number, number, number] | { x: number; y: number; z: number };

export function readVec3(v: Vec3Like, out: Vector3): void {
  if (Array.isArray(v)) {
    const a = v as readonly [number, number, number];
    out.set(a[0], a[1], a[2]);
  } else {
    const o = v as { x: number; y: number; z: number };
    out.set(o.x, o.y, o.z);
  }
}

export class DebugPose {
  private active = false;
  readonly position = new Vector3();
  readonly target = new Vector3();

  get pinned(): boolean {
    return this.active;
  }

  /** Park at `position`; `target` omitted keeps the camera's current aim. */
  set(camera: PerspectiveCamera, position: Vec3Like, target: Vec3Like | undefined, tmp: Vector3): void {
    readVec3(position, this.position);
    if (target !== undefined) readVec3(target, this.target);
    else this.target.copy(this.position).add(camera.getWorldDirection(tmp));
    this.active = true;
    this.apply(camera);
  }

  clear(): void {
    this.active = false;
  }

  /** write the pinned pose onto the camera — called every frame */
  apply(camera: PerspectiveCamera): void {
    camera.position.copy(this.position);
    camera.lookAt(this.target);
  }
}
