/**
 * Undertime tracks: one luminous ribbon per particle, laid along its exact spiral (pairModel.ts).
 *
 * Geometry is a single strip of `segments` quads, instanced twice per pair slot (matter, antimatter). The
 * vertex shader evaluates the spiral at the strip's parameter s ∈ [0, 1] — s = 1 is the head (the particle
 * now), s = 0 the end of the tail `tail` seconds earlier — and offsets each side across the track, facing
 * the eye. Facing is computed from the camera POSITION, not its orientation, so all six cube faces of a dome
 * capture agree on the ribbon's width (they share the position, not the view direction).
 *
 * Look: a thin bright head, a tail that fades and narrows, a soft cross-section. Additive, no depth write.
 * `slotOf` says whose tracks these are: the field's pair slots (pairModel.ts pairSlot) or the hero pair.
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  attribute,
  cameraPosition,
  cross,
  float,
  instanceIndex,
  max,
  min,
  mix,
  normalize,
  select,
  smoothstep,
  vec4,
} from 'three/tsl';
import { trackPosition, type PairSlot } from './pairModel';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

export interface TrackUniforms {
  /** s of history a track shows behind its head */
  tail: F;
  /** m, ribbon half-width at the head */
  width: F;
  /** rad per pixel of the view being drawn; a ribbon is never drawn narrower than ~1 px */
  pixelAngle: F;
  radiance: F;
  matter: V3;
  anti: V3;
}

function stripGeometry(segments: number): THREE.BufferGeometry {
  const n = (segments + 1) * 2;
  const s = new Float32Array(n);
  const side = new Float32Array(n);
  for (let i = 0; i <= segments; i++) {
    s[i * 2] = s[i * 2 + 1] = i / segments;
    side[i * 2] = -1;
    side[i * 2 + 1] = 1;
  }
  const index: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('trackS', new THREE.BufferAttribute(s, 1));
  g.setAttribute('trackSide', new THREE.BufferAttribute(side, 1));
  g.setIndex(index);
  return g;
}

export function createTracks(slots: number, segments: number, U: TrackUniforms, slotOf: (slot: F) => PairSlot, name = 'undertime-tracks'): THREE.InstancedMesh {
  const S = attribute<'float'>('trackS', 'float');
  const side = attribute<'float'>('trackSide', 'float');
  const slot = float(instanceIndex.div(2));
  const isAnti = float(instanceIndex.mod(2));
  const q = float(1).sub(isAnti.mul(2)); // +1 matter, −1 antimatter
  const P = slotOf(slot);
  const tEnd = mix(P.tEnd, P.tEndAnti, isAnti);
  const head = min(P.tau, tEnd);
  const ts = max(head.sub(U.tail.mul(float(1).sub(S))), 0);
  const pos = trackPosition(P, q, ts);
  const ahead = trackPosition(P, q, ts.add(0.012));
  const tangent = normalize(ahead.sub(pos));
  const across = normalize(cross(tangent, normalize(pos.sub(cameraPosition))));
  // born fast, gone once the track has ended and its annihilation has begun
  const fade = smoothstep(0, 0.06, P.tau).mul(float(1).sub(smoothstep(tEnd, tEnd.add(P.period.mul(0.12)), P.tau))).mul(P.alive);
  // MINIMUM PROJECTED WIDTH (the trick src/core/minWidth.ts uses for ropes): never thinner than ~2 px — the
  // finest line that survives a dome projector's blend — and the widening paid back as coverage, so a far
  // track is a faint continuous line instead of a dashed, shimmering one
  const wanted = U.width.mul(mix(float(0.15), float(1), S));
  const minW = U.pixelAngle.mul(1.0).mul(pos.sub(cameraPosition).length());
  const drawn = max(wanted, minW);
  const coverage = wanted.div(drawn);
  const width = drawn.mul(fade);

  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.AdditiveBlending;
  material.positionNode = pos.add(across.mul(side.mul(width)));
  material.colorNode = Fn(() => {
    const edge = float(1).sub(side.mul(side)); // soft cross-section
    const body = S.mul(S).mul(S); // the tail fades away from the head
    const tip = smoothstep(0.9, 1, S).mul(3);
    const base = select(isAnti.greaterThan(0.5), U.anti, U.matter) as V3;
    return vec4(base.mul(U.radiance.mul(body.add(tip)).mul(edge).mul(fade).mul(coverage)), 1);
  })();
  material.name = name;

  const mesh = new THREE.InstancedMesh(stripGeometry(segments), material, slots * 2);
  mesh.frustumCulled = false;
  mesh.name = name;
  return mesh;
}

