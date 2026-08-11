/**
 * §V12 rope render: one InstancedMesh of unit tube segments for ALL ropes.
 * The vertex stage (positionNode) reads the compute-written points storage
 * buffer via instanceIndex and stretches each segment between two consecutive
 * curve samples — zero CPU work per frame, instanceMatrix is never consulted
 * because positionNode/normalNode fully determine placement and shading.
 * Material: dark hemp, high roughness with a slight specular sheen.
 */
import * as THREE from 'three/webgpu';
import {
  cross,
  instanceIndex,
  int,
  max,
  normalize,
  positionGeometry,
  select,
  uint,
  uniform,
  vec3,
} from 'three/tsl';
import { Z_MIN } from './catenaryMath';
import { ropeParams } from '../params/ropes';
import type { RopeCompute } from './ropeCompute';

/** |tangent.y| above this → chord ~vertical, swap frame reference to +x */
const REF_SWAP = 0.99;

export function createRopeMesh(rc: RopeCompute, maxRopes: number, segments: number) {
  // unit tube: radius 1, y ∈ [0,1] after translate → y is the lerp weight
  // along the segment, (x,z) is the unit cross-section circle
  const geometry = new THREE.CylinderGeometry(
    1,
    1,
    1,
    ropeParams.radialSegments,
    1,
    true,
  );
  geometry.translate(0, 0.5, 0);

  const uColor = uniform(new THREE.Color(ropeParams.colorHex));
  const uRoughness = uniform(ropeParams.roughness);

  const material = new THREE.MeshStandardNodeMaterial();
  material.colorNode = uColor;
  material.roughnessNode = uRoughness;

  // storage reads in the vertex stage must be read-only bindings
  const pts = rc.points.toReadOnly();
  const tans = rc.tangents.toReadOnly();

  const ropeIdx = int(instanceIndex.div(uint(segments)));
  const segIdx = int(instanceIndex.modInt(segments));
  const base = ropeIdx.mul(rc.pointsPerRope).add(segIdx);
  const p0 = pts.element(base);
  const p1 = pts.element(base.add(1));

  const axis = p1.xyz.sub(p0.xyz);
  const segLen = axis.length();
  const T = axis.div(max(segLen, Z_MIN));
  const ref = select(T.y.abs().greaterThan(REF_SWAP), vec3(1, 0, 0), vec3(0, 1, 0));
  const N = normalize(cross(ref, T));
  const Bn = cross(T, N);
  const g = positionGeometry;
  const radius = p0.w;

  material.positionNode = p0.xyz
    .add(T.mul(g.y.mul(segLen)))
    .add(N.mul(g.x.mul(radius)))
    .add(Bn.mul(g.z.mul(radius)));

  // smooth joints: radial normal made perpendicular to the per-point tangent
  // (each vertex picks the tangent of the sample at its own end, g.y ∈ {0,1})
  const tanHere = select(
    g.y.greaterThan(0.5),
    tans.element(base.add(1)).xyz,
    tans.element(base).xyz,
  );
  const radial = N.mul(g.x).add(Bn.mul(g.z));
  material.normalNode = normalize(radial.sub(tanHere.mul(radial.dot(tanHere))));

  const mesh = new THREE.InstancedMesh(geometry, material, maxRopes * segments);
  mesh.count = 0; // raised by setRopeCount
  mesh.frustumCulled = false; // positions live GPU-side, CPU knows no bounds

  return {
    mesh,
    uColor,
    uRoughness,
    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}

export type RopeMesh = ReturnType<typeof createRopeMesh>;
