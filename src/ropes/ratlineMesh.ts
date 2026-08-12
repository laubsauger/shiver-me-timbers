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
  If,
  Loop,
  cross,
  float,
  instanceIndex,
  int,
  max,
  mix,
  normalize,
  positionGeometry,
  select,
  smoothstep,
  uint,
  storage,
  uniform,
  vec3,
} from 'three/tsl';
import { Z_MIN } from './catenaryMath';
import { MIN_RUNG } from '../ship/ratlinePlan';
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

/** a rung fades out between MIN_RUNG × this and MIN_RUNG, rather than popping */
const MIN_RUNG_FADE = 0.8; // ratlines.rungVisibility is the tested CPU mirror

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
  const uMinRung = uniform(MIN_RUNG);
  const pts = rc.pointsRead;

  /**
   * World point at parameter t along rope `rope`, t measured from the
   * CHAINPLATE. Shroud samples run masthead → chainplate, hence the flip.
   *
   * BY ARC LENGTH, NOT BY SAMPLE INDEX — user report: "the horizontal climbing
   * bars seem to rotate and tilt in a strange way… almost completely vertical".
   *
   * `solveCatenary` samples uniformly in HORIZONTAL SPAN. A shroud is steep
   * (measured on the galleon: v/h ≈ 6.8 : 1), so uniform steps in x are
   * violently non-uniform in height — the first step of the main-mast shroud
   * covers 3.5 m of drop and the last covers 0.5 m. Sample index is therefore
   * not a physical station on the rope, and worse, HOW non-uniform it is
   * depends on the rope's own h: the two shrouds of one fan run h = 3.85 m and
   * h = 3.21 m, so index 8 lands at y = 9.52 on one and y = 8.71 on the other.
   * A rung seized between those two points stands 45° off level — measured, at
   * the shipped slack, with the tA/tB jitter disabled.
   *
   * Arc length is the station a rung is actually seized at (rope does not
   * stretch), it is identical on both shrouds because they share a masthead
   * and their plates are level, and it is the parameter §V42 preserves — the
   * chain's rest lengths are per-link arc lengths, so a station stays put on
   * the rope as it swings. Same measurement with this: 45.3° → 2.7° max.
   *
   * Cost is two fixed 16-step loops per end (§V28: literal bounds, no early
   * exit). That is the price of the rope's parameterisation not being uniform;
   * see the report for the cheaper fix at the source.
   */
  function sampleRope(rope: ReturnType<typeof float>, t: ReturnType<typeof float>) {
    const base0 = int(rope).mul(pointsPerRope);
    // three types a Loop's index as `number` though it is a node at runtime —
    // the same looseness ropeMesh.ts documents with its own TSLNode alias
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type Idx = any;
    const pointAt = (i: Idx) => pts.element(base0.add(int(i))).xyz;
    const linkLength = (i: Idx) =>
      max(pointAt(int(i).add(1)).sub(pointAt(i)).length(), float(Z_MIN));

    const total = float(0).toVar();
    Loop({ start: int(0), end: int(segments), condition: '<' }, ({ i }) => {
      total.addAssign(linkLength(i));
    });

    // distance to walk from the MASTHEAD end (sample 0), clamped so a t that
    // has drifted outside [0,1] lands on an endpoint instead of wrapping to
    // sample 0 and drawing a rung across open air
    const want = float(1).sub(t).mul(total).clamp(0, total).toVar();
    const acc = float(0).toVar();
    // defaults put an unmatched walk at the far end, never at index 0
    const idx = int(segments - 1).toVar();
    const frac = float(1).toVar();
    Loop({ start: int(0), end: int(segments), condition: '<' }, ({ i }) => {
      const segLen = linkLength(i);
      If(want.greaterThanEqual(acc).and(want.lessThanEqual(acc.add(segLen))), () => {
        idx.assign(i);
        frac.assign(want.sub(acc).div(segLen));
      });
      acc.addAssign(segLen);
    });
    return mix(pointAt(idx), pointAt(idx.add(1)), frac);
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

    // §V45 MIN_RUNG, enforced HERE because here is where the span is known.
    // The ship plan applies the same cutoff to straight lines between sockets
    // in ship space; the drawn rung is a chord of two solved curves resolved
    // through the piece graph, and the two disagree — 40 of the galleon's 162
    // rungs come out under the cutoff once they are placed by arc length and
    // therefore actually reach the top of the fan, where the shrouds close.
    // "A rung you cannot put a foot on is not a rung, and a ladder that tapers
    // to a point reads as a spike" — so those collapse to nothing rather than
    // draw. Smoothed over a band so a rung cannot pop as §V42 works the fan.
    const wide = smoothstep(uMinRung.mul(MIN_RUNG_FADE), uMinRung, span);

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
    return { q0, T, N, Bn, segLen, drawnRadius, aaAlpha, farness, wide };
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
    nearMaterial.positionNode = place(n, n.drawnRadius.mul(live).mul(n.wide));
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
    farMaterial.positionNode = place(n, n.drawnRadius.mul(live).mul(n.wide));
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
