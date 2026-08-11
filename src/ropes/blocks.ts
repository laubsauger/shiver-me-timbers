/**
 * Rigging blocks (wooden pulleys) at rope termination points — visual
 * dressing for the §V12 rig ("blocks and the whole shebang" per the
 * docs/ship-full-view.png reference). One InstancedMesh for all blocks:
 * two cheeks + a sheave visible in the slot + top/bottom binding bands,
 * ~25 cm tall (params). CPU only writes instance transforms when anchors
 * move (same cadence as applyRiggingPlan) — no per-frame geometry math.
 */
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ropeParams } from '../params/ropes';
import type { Vec3Like } from './catenaryMath';

/** yaw step per block (≈ golden angle) so instanced blocks don't all face
 *  the same way — deterministic in the block index */
const YAW_STEP = 2.399;

export interface Blocks {
  /** place block `index` (world position); orientation is derived */
  setBlock(index: number, position: Vec3Like): void;
  setBlockCount(n: number): void;
  mesh: THREE.Object3D;
  dispose(): void;
}

/** cheeks + sheave + bands, sized from ropeParams.blockSize (height, m) */
function buildBlockGeometry(): THREE.BufferGeometry {
  const s = ropeParams.blockSize;
  const cheekW = 0.55 * s;
  const cheekT = 0.2 * s;
  const gap = 0.16 * s;
  const parts: THREE.BufferGeometry[] = [];
  for (const sign of [-1, 1]) {
    const cheek = new THREE.BoxGeometry(cheekW, s, cheekT);
    cheek.translate(0, 0, sign * (gap / 2 + cheekT / 2));
    parts.push(cheek);
  }
  // sheave (pulley wheel) peeking through the slot
  const sheave = new THREE.CylinderGeometry(0.32 * s, 0.32 * s, gap * 0.9, 10);
  sheave.rotateX(Math.PI / 2);
  parts.push(sheave);
  // binding bands close the shell top and bottom
  for (const sign of [-1, 1]) {
    const band = new THREE.BoxGeometry(cheekW, 0.14 * s, gap + 2 * cheekT);
    band.translate(0, sign * (s / 2 - 0.07 * s), 0);
    parts.push(band);
  }
  const merged = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  return merged;
}

export function createBlocks(maxBlocks: number): Blocks {
  if (!Number.isInteger(maxBlocks) || maxBlocks < 0) {
    throw new RangeError(`createBlocks: bad maxBlocks ${maxBlocks}`);
  }
  const geometry = buildBlockGeometry();
  const material = new THREE.MeshStandardNodeMaterial({
    color: ropeParams.blockColorHex,
    roughness: 0.85,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(maxBlocks, 1));
  mesh.count = 0;
  mesh.castShadow = true;
  mesh.frustumCulled = false; // instances span the whole rig
  const tmp = new THREE.Matrix4();
  const rot = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);

  return {
    setBlock(index, position): void {
      if (!Number.isInteger(index) || index < 0 || index >= maxBlocks) {
        throw new RangeError(`setBlock: index ${index} outside [0, ${maxBlocks})`);
      }
      pos.set(position.x, position.y, position.z);
      rot.setFromAxisAngle(up, index * YAW_STEP);
      tmp.compose(pos, rot, one);
      mesh.setMatrixAt(index, tmp);
      mesh.instanceMatrix.needsUpdate = true;
    },
    setBlockCount(n): void {
      if (!Number.isInteger(n) || n < 0 || n > maxBlocks) {
        throw new RangeError(`setBlockCount: ${n} outside [0, ${maxBlocks}]`);
      }
      mesh.count = n;
    },
    mesh,
    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}
