/**
 * §V12/§V41 rope render: TWO instanced regimes over the SAME compute-written
 * points buffer, crossfaded by projected screen width.
 *
 * The vertex stage (positionNode) reads the points storage buffer via
 * instanceIndex and stretches each segment between two consecutive curve
 * samples — zero CPU work per frame, instanceMatrix is never consulted because
 * positionNode/normalNode fully determine placement and shading. Neither
 * regime touches the solve; §V12 is untouched by this file.
 *
 * REGIMES (§V41, per the Rare talk's "Ropes" slide):
 *   NEAR  the shaded tube — radialSegments faces, MeshStandardNodeMaterial,
 *         per-vertex normals, lit, casts shadow.
 *   FAR   "simpler translucent rendering (without textures or normals)" —
 *         farRadialSegments faces, unlit MeshBasicNodeMaterial, no normalNode
 *         computed at all, no shadow, with PHONE-WIRE AA so a sub-pixel rope
 *         stays a stable continuous line instead of a crawling dashed one.
 *
 * WHY TWO MESHES rather than one material that branches: the far regime has to
 * be genuinely cheaper to be worth having — fewer faces, no normal basis, no
 * lighting, no shadow pass. A branch inside one shader buys none of that on a
 * GPU. The cost of the split is paid back by collapsing each regime's radius
 * to ZERO outside its band, so the idle one rasterises nothing at all rather
 * than burning fill on alpha-0 fragments (§V28, and §B5 for what invisible
 * geometry can cost).
 *
 * Both regimes draw at the SAME phone-wire-widened radius, so the crossfade is
 * a pure alpha handover with no width step — that is what makes it not pop.
 * src/ropes/phoneWireAA.ts is the tested CPU mirror of the maths below.
 */
import * as THREE from 'three/webgpu';
import {
  cameraProjectionMatrix,
  cameraViewMatrix,
  cross,
  float,
  instanceIndex,
  int,
  max,
  min,
  normalize,
  positionGeometry,
  select,
  smoothstep,
  uint,
  uniform,
  vec3,
  vec4,
  viewport,
} from 'three/tsl';
import type { ShaderNodeObject } from 'three/tsl';
import { Z_MIN } from './catenaryMath';
import { ropeParams } from '../params/ropes';
import type { RopeCompute } from './ropeCompute';

/** |tangent.y| above this → chord ~vertical, swap frame reference to +x */
const REF_SWAP = 0.99;

/** any TSL node — the regime maths is agnostic to how the point was built */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TSLNode = ShaderNodeObject<any>;

/** the three §V41 thresholds, shared by every thin-geometry mesh in this dir */
export interface RegimeUniforms {
  uMinWidthPx: TSLNode;
  uFarWidthPx: TSLNode;
  uNearWidthPx: TSLNode;
}

/**
 * §V41 phone-wire response at a world-space point, for geometry of world
 * `radius`. Exported because RATLINES must get exactly this treatment and not
 * a second implementation of it: at 0.022 m they go sub-pixel around 55 m and
 * are the densest thin geometry in the scene, so they are the hardest test
 * this code has. A divergent copy would alias where the ropes did not.
 *
 * Returns the widened radius to draw at, the alpha that pays that widening
 * back, and how far into the cheap unlit regime the geometry is.
 */
export function phoneWireRegime(
  worldPos: TSLNode,
  radius: TSLNode,
  u: RegimeUniforms,
) {
  // A view-space offset of `radius` along X pushed through the projection
  // matrix gives the NDC half-width directly; dividing by the point's own clip
  // w applies the perspective foreshortening, and NDC spans 2 across the
  // viewport so the full width covers (ndcHalf · viewportWidth) pixels. No
  // FOV, aspect or resolution appears explicitly — which is the point: the
  // same code is correct in the half-res reflection pass (§V36 lesson).
  const clip = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(worldPos, 1)));
  const clipW = max(clip.w, float(Z_MIN));
  const ndcHalf = cameraProjectionMatrix.mul(vec4(radius, 0, 0, 0)).x.abs();
  const widthPx = ndcHalf.div(clipW).mul(viewport.z);

  const widen = max(float(1), u.uMinWidthPx.div(max(widthPx, float(Z_MIN))));
  const aaAlpha = min(float(1), widthPx.div(max(u.uMinWidthPx, float(Z_MIN))));
  // reading: smoothstep(far, near, width) is 0 at the far edge and 1 at the
  // near edge — FUNCTIONAL 3-arg form, never the chained receiver-is-factor
  // one (§V23/§B1). Inverted because a THIN rope is a FAR rope.
  const farness = smoothstep(u.uFarWidthPx, u.uNearWidthPx, widthPx).oneMinus();
  return { drawnRadius: radius.mul(widen), aaAlpha, farness, widthPx };
}

export function createRopeMesh(rc: RopeCompute, maxRopes: number, segments: number) {
  const uColor = uniform(new THREE.Color(ropeParams.colorHex));
  const uRoughness = uniform(ropeParams.roughness);
  const uMinWidthPx = uniform(ropeParams.aaMinWidthPx);
  const uFarWidthPx = uniform(ropeParams.farWidthPx);
  const uNearWidthPx = uniform(ropeParams.nearWidthPx);
  const regime: RegimeUniforms = { uMinWidthPx, uFarWidthPx, uNearWidthPx };
  // the far regime is unlit; this lifts its flat albedo to roughly where the
  // lit near tube sits so the handover is not a tonal step (§V41 "no pop")
  const uFarLightness = uniform(ropeParams.farLightness);

  // storage reads in the vertex stage must be read-only bindings — these are
  // separate read-only VIEWS over the compute buffers, never the write nodes
  // themselves (§B.8: toReadOnly() mutates in place and kills the writes)
  const pts = rc.pointsRead;
  const tans = rc.tangentsRead;

  /** the shared per-segment frame + phone-wire response, built once per regime
   *  (node graphs are per-material, so this cannot be hoisted out) */
  function segmentNodes() {
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
    const radius = p0.w;

    const { drawnRadius, aaAlpha, farness } = phoneWireRegime(p0.xyz, radius, regime);

    return { base, segLen, T, N, Bn, drawnRadius, aaAlpha, farness };
  }

  /** unit tube: radius 1, y ∈ [0,1] after translate → y is the lerp weight
   *  along the segment, (x,z) is the unit cross-section circle */
  function tube(faces: number): THREE.CylinderGeometry {
    const g = new THREE.CylinderGeometry(1, 1, 1, Math.max(3, Math.round(faces)), 1, true);
    g.translate(0, 0.5, 0);
    return g;
  }

  function place(
    n: ReturnType<typeof segmentNodes>,
    radiusNode: ReturnType<typeof segmentNodes>['drawnRadius'],
  ) {
    const g = positionGeometry;
    const base = pts.element(n.base);
    return base.xyz
      .add(n.T.mul(g.y.mul(n.segLen)))
      .add(n.N.mul(g.x.mul(radiusNode)))
      .add(n.Bn.mul(g.z.mul(radiusNode)));
  }

  // --- NEAR: shaded tube, normals, lit, shadow-casting ----------------------
  const nearGeometry = tube(ropeParams.radialSegments);
  const nearMaterial = new THREE.MeshStandardNodeMaterial();
  nearMaterial.colorNode = uColor;
  nearMaterial.roughnessNode = uRoughness;
  nearMaterial.transparent = true;
  // thin, near-opaque geometry: keep writing depth so ropes still occlude and
  // are occluded correctly against the hull instead of floating over it
  nearMaterial.depthWrite = true;
  {
    const n = segmentNodes();
    // collapse to nothing once the far regime owns the rope outright — an
    // alpha-0 tube still rasterises, and that is pure wasted fill (§V28)
    const live = select(n.farness.greaterThanEqual(float(1)), float(0), float(1));
    const radius = n.drawnRadius.mul(live);
    nearMaterial.positionNode = place(n, radius);
    nearMaterial.opacityNode = n.farness.oneMinus().mul(n.aaAlpha);

    // smooth joints: radial normal made perpendicular to the per-point tangent
    // (each vertex picks the tangent of the sample at its own end, g.y ∈ {0,1})
    const g = positionGeometry;
    const tanHere = select(
      g.y.greaterThan(0.5),
      tans.element(n.base.add(1)).xyz,
      tans.element(n.base).xyz,
    );
    const radial = n.N.mul(g.x).add(n.Bn.mul(g.z));
    nearMaterial.normalNode = normalize(radial.sub(tanHere.mul(radial.dot(tanHere))));
  }

  // --- FAR: translucent line, no normals, no lighting, no shadow ------------
  const farGeometry = tube(ropeParams.farRadialSegments);
  const farMaterial = new THREE.MeshBasicNodeMaterial();
  farMaterial.colorNode = uColor.mul(uFarLightness);
  farMaterial.transparent = true;
  // sub-pixel translucent lines must not occlude each other or the rig behind
  // them; they are additive-ish coverage, not surfaces
  farMaterial.depthWrite = false;
  {
    const n = segmentNodes();
    const live = select(n.farness.lessThanEqual(float(0)), float(0), float(1));
    farMaterial.positionNode = place(n, n.drawnRadius.mul(live));
    farMaterial.opacityNode = n.farness.mul(n.aaAlpha);
    // deliberately NO normalNode: "without textures or normals" is the whole
    // saving of this regime, not an oversight
  }

  const nearMesh = new THREE.InstancedMesh(nearGeometry, nearMaterial, maxRopes * segments);
  const farMesh = new THREE.InstancedMesh(farGeometry, farMaterial, maxRopes * segments);
  for (const m of [nearMesh, farMesh]) {
    m.count = 0; // raised by setCount
    m.frustumCulled = false; // positions live GPU-side, CPU knows no bounds
  }
  // main.ts sets castShadow on the group, which three does NOT propagate to
  // children — so own it here. Only the near regime casts: a translucent
  // sub-pixel line has no meaningful shadow and would just cost a pass.
  nearMesh.castShadow = true;
  farMesh.castShadow = false;
  farMesh.renderOrder = 1; // after the near tube it is fading in behind

  const mesh = new THREE.Group();
  mesh.name = 'ropes';
  mesh.add(nearMesh, farMesh);

  return {
    mesh,
    nearMesh,
    farMesh,
    /** shared with the ratline mesh so both regimes switch on the same edges */
    regime,
    uColor,
    uRoughness,
    uMinWidthPx,
    uFarWidthPx,
    uNearWidthPx,
    uFarLightness,
    /** both regimes always draw the same segment range — the crossfade picks
     *  which one is visible, never which one exists */
    setCount(instances: number): void {
      nearMesh.count = instances;
      farMesh.count = instances;
    },
    dispose(): void {
      nearGeometry.dispose();
      farGeometry.dispose();
      nearMaterial.dispose();
      farMaterial.dispose();
    },
  };
}

export type RopeMesh = ReturnType<typeof createRopeMesh>;
