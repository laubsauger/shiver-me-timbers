/**
 * §V12 ropes integration surface. CPU code here ONLY edits the rope
 * descriptor buffer (endpoints/length/thickness) when rigging changes; the
 * per-frame curve solve runs entirely in the compute pass (pass `computeNode`
 * to renderer.compute each frame). Anchors arrive as raw world points — ship
 * socket lookup (§V13) happens in the ship system, which re-calls setRope
 * when a mast moves and the rope must re-solve (§V14).
 */
import type * as THREE from 'three/webgpu';
import { ropeParams } from '../params/ropes';
import type { Vec3Like } from './catenaryMath';
import { createRopeCompute, type RopeCompute } from './ropeCompute';
import { createRopeMesh } from './ropeMesh';

export interface RopesOptions {
  /** buffer + instance capacity; setRope index must stay below this */
  maxRopes: number;
}

export interface Ropes {
  /**
   * Write one rope's descriptor. `length` defaults to chord × slackFactor
   * (params), `thickness` to params.defaultThickness. Degenerate lengths
   * (≤ chord) render as a straight taut rope — never NaN.
   */
  setRope(
    index: number,
    a: Vec3Like,
    b: Vec3Like,
    length?: number,
    thickness?: number,
  ): void;
  /** number of active ropes; also sets the drawn segment instance count */
  setRopeCount(n: number): void;
  /** re-upload the descriptor buffer (setRope calls this automatically) */
  markDirty(): void;
  /** dispatch every frame: renderer.compute(ropes.computeNode) */
  computeNode: THREE.ComputeNode;
  /** add to the scene once; draws all rope segments in one instanced call */
  mesh: THREE.Object3D;
  /** dev handle: the GPU-written buffers, for readback verification */
  buffers: Pick<RopeCompute, 'points' | 'tangents' | 'descA' | 'descB' | 'pointsPerRope'>;
  dispose(): void;
}

export function createRopes(opts: RopesOptions): Ropes {
  const { maxRopes } = opts;
  if (!Number.isInteger(maxRopes) || maxRopes <= 0) {
    throw new RangeError(`createRopes: maxRopes must be a positive integer, got ${maxRopes}`);
  }
  const segments = ropeParams.segmentsPerRope;
  const rc = createRopeCompute(maxRopes, segments);
  const rm = createRopeMesh(rc, maxRopes, segments);

  const arrA = rc.descA.value.array as Float32Array;
  const arrB = rc.descB.value.array as Float32Array;

  const markDirty = (): void => {
    rc.descA.value.needsUpdate = true;
    rc.descB.value.needsUpdate = true;
  };

  return {
    setRope(index, a, b, length, thickness): void {
      if (!Number.isInteger(index) || index < 0 || index >= maxRopes) {
        throw new RangeError(`setRope: index ${index} outside [0, ${maxRopes})`);
      }
      const chord = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      const L = length ?? chord * ropeParams.slackFactor;
      const o = index * 4;
      arrA[o] = a.x;
      arrA[o + 1] = a.y;
      arrA[o + 2] = a.z;
      arrA[o + 3] = L;
      arrB[o] = b.x;
      arrB[o + 1] = b.y;
      arrB[o + 2] = b.z;
      arrB[o + 3] = thickness ?? ropeParams.defaultThickness;
      markDirty();
    },
    setRopeCount(n): void {
      if (!Number.isInteger(n) || n < 0 || n > maxRopes) {
        throw new RangeError(`setRopeCount: ${n} outside [0, ${maxRopes}]`);
      }
      rc.uRopeCount.value = n;
      (rm.mesh as THREE.InstancedMesh).count = n * segments;
    },
    markDirty,
    computeNode: rc.computeNode,
    mesh: rm.mesh,
    buffers: rc,
    dispose(): void {
      rm.dispose();
    },
  };
}
