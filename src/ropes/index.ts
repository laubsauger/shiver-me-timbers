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
import { createRopeMesh, type RopeMesh } from './ropeMesh';
import { createRatlineMesh } from './ratlineMesh';
import { createBlocks, type Blocks } from './blocks';
import type { BlockDescriptor } from './blockMath';
import { packRungs, type RungDescriptor } from './ratlines';

export interface RopesOptions {
  /** buffer + instance capacity; setRope index must stay below this */
  maxRopes: number;
  /**
   * §V45 ratline rungs, built once from the ship's ratline plan:
   *   buildRungDescriptors(buildRatlinePlan(blueprint), riggingPlan)
   * They ride the SAME points buffer as the shrouds, so they need no compute
   * and no per-frame work — pass them here and they are simply drawn. Omitted
   * or empty means no ladders, which is the correct result for a ship class
   * whose masts have no chainplate fan.
   */
  rungs?: RungDescriptor[];
  /**
   * Rigging blocks (pulleys), from buildBlockDescriptors(riggingPlan, cap).
   * Same deal as the rungs and for the same §V45 reason: a block is addressed
   * by (rope, t) and hangs off the SOLVED curve, so it rides the rope's sag now
   * and its §V42 swing later without another line of CPU code. Omitted or empty
   * means no pulleys — correct for a rig with no running gear.
   */
  blocks?: BlockDescriptor[];
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
  /**
   * Push the live `ropeParams` into every rope uniform (§V62). Call once per
   * frame, before `renderer.compute(computeNode)`.
   *
   * WHY THIS EXISTS: `uniform(x)` COPIES x at construction, it does not bind
   * to it — so every tunable this system owns was seeded once at boot and then
   * frozen, and the whole `ropes` folder of the debug panel drove nothing.
   * The compute pass's frame-derived uniforms (dt, time, wind, camera) keep
   * their own `.onFrameUpdate` hooks; this is for the PANEL-owned values.
   */
  update(): void;
  /** dispatch every frame: renderer.compute(ropes.computeNode) */
  computeNode: THREE.ComputeNode;
  /** add to the scene once; draws all rope segments in one instanced call */
  mesh: THREE.Object3D;
  /** dev handle: the GPU-written buffers, for readback verification */
  buffers: Pick<RopeCompute, 'points' | 'tangents' | 'descA' | 'descB' | 'pointsPerRope'>;
  /**
   * dev handle: the two uniform blocks `update()` refreshes that are not
   * otherwise reachable from here (the ratlines' and blocks' own handles are
   * already exposed below). Console tuning and the §V62 refresh test read it.
   */
  uniforms: { compute: RopeCompute; mesh: RopeMesh };
  /** §V45 rung meshes, or null when the ship has no chainplate fans */
  ratlines: ReturnType<typeof createRatlineMesh> | null;
  /** the pulley instances, or null when no block descriptors were given */
  blocks: Blocks | null;
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

  // §V45 ratlines: drawn from the shrouds' own solved curve, so they cost one
  // extra draw pair and nothing else. They join the SAME group main.ts already
  // adds to the scene, so wiring them needs no scene-graph change.
  const rungs = opts.rungs ?? [];
  const ratlines = rungs.length > 0
    ? createRatlineMesh(rc, rungs.length, segments, rm.regime)
    : null;
  if (ratlines !== null) {
    packRungs(rungs, ratlines.descA.array as Float32Array, ratlines.descB.array as Float32Array);
    ratlines.markDirty();
    ratlines.setRungCount(rungs.length);
    rm.mesh.add(ratlines.nearMesh, ratlines.farMesh);
  }

  // blocks join the SAME group, for the same reason the rungs do: they are
  // part of this rig, they read this rig's buffers, and one scene add keeps
  // every consumer (reflection exclusion, deferred boot) from having to know
  // that pulleys exist as a separate object.
  const blockDescs = opts.blocks ?? [];
  const blocks = blockDescs.length > 0
    ? createBlocks(rc, blockDescs, maxRopes, segments)
    : null;
  if (blocks !== null) rm.mesh.add(blocks.mesh);

  // §V42 LOD needs the camera, but a compute pass has no camera context —
  // reading a render-stage camera node inside the kernel dereferences null at
  // build time and kills the boot. Feed it from the render side instead: three
  // hands onBeforeRender the live camera, one frame ahead of the next compute
  // dispatch, which is plenty for a distance gate.
  // Perspective only: the shadow pass calls this too, with the light's
  // orthographic camera, and the sun's position is not the viewer's.
  rm.nearMesh.onBeforeRender = (_renderer, _scene, camera): void => {
    if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera === true) {
      rc.camPos.setFromMatrixPosition(camera.matrixWorld);
    }
  };

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
      // both §V41 regimes cover the same segment range; which one is visible
      // is decided per-vertex by projected width, not by the instance count
      rm.setCount(n * segments);
    },
    markDirty,
    update(): void {
      rc.refresh();
      rm.refresh();
      ratlines?.refresh();
      blocks?.refresh();
    },
    computeNode: rc.computeNode,
    mesh: rm.mesh,
    buffers: rc,
    uniforms: { compute: rc, mesh: rm },
    ratlines,
    blocks,
    dispose(): void {
      rm.dispose();
      ratlines?.dispose();
      blocks?.dispose();
    },
  };
}
