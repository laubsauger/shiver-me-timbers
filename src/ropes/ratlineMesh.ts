/**
 * §V45 ratline render. Same two-regime structure as the ropes (§V41), reading
 * the SAME compute-written points buffer — a rung is sampled off the solved
 * shroud curves rather than authored from their sockets, so the ladder rides
 * whatever the shrouds actually do (sag now, swing once §V42 is on, and a
 * whole mast going over the side after §V14).
 *
 * ZERO new compute: nothing here is solved. The rung descriptors are written
 * once when the rig is built, and the vertex stage does the rest.
 *
 * This is the hardest case §V41 has: at 0.022 m a rung is ~0.4 px at 100 m and
 * goes sub-pixel around 55 m, and there are 162 of them on the galleon — the
 * densest thin geometry in the scene. It gets phone-wire AA through the same
 * exported helper the ropes use, deliberately not a second copy of the maths.
 */
import * as THREE from 'three/webgpu';
import {
  cross,
  float,
  instanceIndex,
  int,
  max,
  mix,
  normalize,
  positionGeometry,
  select,
  uint,
  storage,
  uniform,
  vec3,
} from 'three/tsl';
import { Z_MIN } from './catenaryMath';
import { ropeParams } from '../params/ropes';
import type { RopeCompute } from './ropeCompute';
import { phoneWireRegime, type RegimeUniforms } from './ropeMesh';

/** |tangent.y| above this → rung ~vertical, swap frame reference to +x */
const REF_SWAP = 0.99;

/**
 * Tube segments per rung. A rung's belly is only a few centimetres, but at the
 * follow camera that is still several pixels, so a single straight segment
 * would read as a wire rack rather than seized line. Three is enough to show
 * the curve and keeps the instance count at 3× the rung count.
 */
const SEGMENTS_PER_RUNG = 3;

export function createRatlineMesh(
  rc: RopeCompute,
  maxRungs: number,
  segments: number,
  regime: RegimeUniforms,
) {
  const pointsPerRope = segments + 1;
  const descA = new THREE.StorageInstancedBufferAttribute(new Float32Array(maxRungs * 4), 4);
  const descB = new THREE.StorageInstancedBufferAttribute(new Float32Array(maxRungs * 4), 4);
  const rungA = storage(descA, 'vec4', maxRungs).toReadOnly();
  const rungB = storage(descB, 'vec4', maxRungs).toReadOnly();

  const uColor = uniform(new THREE.Color(ropeParams.colorHex));
  const uRoughness = uniform(ropeParams.roughness);
  const uFarLightness = uniform(ropeParams.farLightness);
  const pts = rc.pointsRead;

  /** world point at parameter t along rope `rope`, t measured from the
   *  CHAINPLATE. Shroud samples run masthead → chainplate, hence the flip. */
  function sampleRope(rope: ReturnType<typeof float>, t: ReturnType<typeof float>) {
    const s = float(1).sub(t).mul(segments);
    const i0 = s.floor().clamp(0, segments - 1);
    const frac = s.sub(i0);
    const base = int(rope).mul(pointsPerRope).add(int(i0));
    return mix(pts.element(base).xyz, pts.element(base.add(1)).xyz, frac);
  }

  function segmentNodes() {
    const rungIdx = int(instanceIndex.div(uint(SEGMENTS_PER_RUNG)));
    const segIdx = float(instanceIndex.modInt(SEGMENTS_PER_RUNG));
    const dA = rungA.element(rungIdx);
    const dB = rungB.element(rungIdx);

    const pA = sampleRope(dA.x, dA.z);
    const pB = sampleRope(dA.y, dA.w);
    const span = pB.sub(pA).length();
    const belly = dB.x.mul(span);

    /** the rung's own curve: a parabolic belly, pinned at both shrouds */
    const at = (u: ReturnType<typeof float>) =>
      mix(pA, pB, u).sub(vec3(0, belly.mul(u.mul(u.oneMinus()).mul(4)), 0));

    const u0 = segIdx.div(SEGMENTS_PER_RUNG);
    const u1 = segIdx.add(1).div(SEGMENTS_PER_RUNG);
    const q0 = at(u0);
    const q1 = at(u1);

    const axis = q1.sub(q0);
    const segLen = axis.length();
    const T = axis.div(max(segLen, Z_MIN));
    const ref = select(T.y.abs().greaterThan(REF_SWAP), vec3(1, 0, 0), vec3(0, 1, 0));
    const N = normalize(cross(ref, T));
    const Bn = cross(T, N);
    const { drawnRadius, aaAlpha, farness } = phoneWireRegime(q0, dB.y, regime);
    return { q0, T, N, Bn, segLen, drawnRadius, aaAlpha, farness };
  }

  function tube(faces: number): THREE.CylinderGeometry {
    const g = new THREE.CylinderGeometry(1, 1, 1, Math.max(3, Math.round(faces)), 1, true);
    g.translate(0, 0.5, 0);
    return g;
  }

  function place(n: ReturnType<typeof segmentNodes>, radius: ReturnType<typeof float>) {
    const g = positionGeometry;
    return n.q0
      .add(n.T.mul(g.y.mul(n.segLen)))
      .add(n.N.mul(g.x.mul(radius)))
      .add(n.Bn.mul(g.z.mul(radius)));
  }

  // --- NEAR: shaded, lit ----------------------------------------------------
  const nearGeometry = tube(ropeParams.radialSegments);
  const nearMaterial = new THREE.MeshStandardNodeMaterial();
  nearMaterial.colorNode = uColor;
  nearMaterial.roughnessNode = uRoughness;
  nearMaterial.transparent = true;
  nearMaterial.depthWrite = true;
  {
    const n = segmentNodes();
    // collapse to nothing once the far regime owns it — an alpha-0 tube still
    // rasterises, and with 162 rungs that is real wasted fill (§V28)
    const live = select(n.farness.greaterThanEqual(float(1)), float(0), float(1));
    nearMaterial.positionNode = place(n, n.drawnRadius.mul(live));
    nearMaterial.opacityNode = n.farness.oneMinus().mul(n.aaAlpha);
    const g = positionGeometry;
    nearMaterial.normalNode = normalize(n.N.mul(g.x).add(n.Bn.mul(g.z)));
  }

  // --- FAR: translucent line, no normals, no lighting -----------------------
  const farGeometry = tube(ropeParams.farRadialSegments);
  const farMaterial = new THREE.MeshBasicNodeMaterial();
  farMaterial.colorNode = uColor.mul(uFarLightness);
  farMaterial.transparent = true;
  farMaterial.depthWrite = false;
  {
    const n = segmentNodes();
    const live = select(n.farness.lessThanEqual(float(0)), float(0), float(1));
    farMaterial.positionNode = place(n, n.drawnRadius.mul(live));
    farMaterial.opacityNode = n.farness.mul(n.aaAlpha);
  }

  const capacity = maxRungs * SEGMENTS_PER_RUNG;
  const nearMesh = new THREE.InstancedMesh(nearGeometry, nearMaterial, capacity);
  const farMesh = new THREE.InstancedMesh(farGeometry, farMaterial, capacity);
  for (const m of [nearMesh, farMesh]) {
    m.count = 0;
    m.frustumCulled = false; // positions live GPU-side, CPU knows no bounds
  }
  nearMesh.castShadow = true;
  farMesh.castShadow = false;
  farMesh.renderOrder = 1;

  return {
    nearMesh,
    farMesh,
    descA,
    descB,
    uColor,
    uFarLightness,
    setRungCount(n: number): void {
      const instances = Math.max(0, Math.min(maxRungs, n)) * SEGMENTS_PER_RUNG;
      nearMesh.count = instances;
      farMesh.count = instances;
    },
    markDirty(): void {
      descA.needsUpdate = true;
      descB.needsUpdate = true;
    },
    dispose(): void {
      nearGeometry.dispose();
      farGeometry.dispose();
      nearMaterial.dispose();
      farMaterial.dispose();
    },
  };
}

export type RatlineMesh = ReturnType<typeof createRatlineMesh>;
