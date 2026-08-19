/**
 * Rigging blocks — the wooden pulleys the running rigging reeves through
 * (docs/ship-full-view.png, docs/ref-storm-whitecaps.png). ONE instanced draw
 * for every block on a ship.
 *
 * WHAT CHANGED, AND WHY (user report: "the blocks are kinda not round, they're
 * actually just boxes… and they're not really playing with the physics, as the
 * ropes do"). Both halves of that report had the same root cause — a block was
 * authored and placed as if it were furniture rather than part of the rig:
 *
 *  GEOMETRY  was five BoxGeometry parts. A block's shell is a turned wooden
 *            lozenge: it swells around the sheave, is scored round for its
 *            strop and tapers to a rounded crown and tail. That is a LATHE, so
 *            it is one here — a flattened surface of revolution per cheek, with
 *            the slot and its sheave between them. ~340 tris at 8 faces, which
 *            is where the silhouette stops changing for a 0.25 m object read at
 *            a few pixels (see the reference shot).
 *
 *  MOTION    was a CPU-written instance matrix at the socket's world position
 *            with a fixed decorative yaw. It therefore rode the ship and
 *            nothing else, while the line it hangs on sagged and swung right
 *            past it. It now reads the SAME solved points/tangents buffer the
 *            rope is drawn from, addressed by (rope, t) — §V45's rule, one
 *            source of truth for a rope's position — so it rides whatever the
 *            rope actually does, and inherits §V42's swing and gust whip the
 *            moment `ropeParams.dynamic` flips, with no further work here.
 *            The CPU no longer touches a block after the rig is built (§V12).
 *
 * ORIENTATION is the visible half of "playing with the physics": the shell
 * hangs plumb on a slack line and is dragged into the line as it goes taut, off
 * the rope's own live slack ratio — so §V46 hauling a buntline in swings its
 * block up into the line. src/ropes/blockMath.ts is the tested CPU mirror of
 * all of it; this file is the transliteration.
 *
 * §V48/§B.20: the sheave in the slot and the hemp strop in the score are the
 * only high-contrast features on the shell, and both are a fraction of its
 * width — so they go sub-pixel long before it does. Their contrast is faded to
 * the shell tone by projected width, using the same projection helper the ropes
 * measure themselves with, never a second copy of it.
 */
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  attribute,
  cross,
  float,
  instanceIndex,
  int,
  max,
  mix,
  normalGeometry,
  normalize,
  positionGeometry,
  select,
  smoothstep,
  storage,
  uniform,
  varying,
  vec3,
} from 'three/tsl';
import { Z_MIN } from './catenaryMath';
import { ropeParams } from '../params/ropes';
import { pushParam, type RopeCompute } from './ropeCompute';
import { projectedWidthPx } from './ropeMesh';
import type { BlockDescriptor } from './blockMath';
import { AXLE_SOFTNESS, packBlocks } from './blockMath';

/** part ids baked into the merged geometry; the material tints on them */
const PART_SHELL = 0;
const PART_STROP = 1;
const PART_SHEAVE = 2;

/** the shell's lathe profile, (halfWidth, y) in units of the block's HEIGHT,
 *  tail apex at y = −1 up to the crown at y = 0. The block hangs from y = 0,
 *  so the crown is the point that sits on the rope. Read bottom-up because
 *  that is the winding LatheGeometry expects.
 *
 *  The score — the groove at y ≈ −0.15 the strop is seized into — is the one
 *  feature that makes a turned shell read as a BLOCK rather than a bead, and it
 *  costs two profile points. */
const SHELL_PROFILE: ReadonlyArray<readonly [number, number]> = [
  [0.004, -1.0], // tail apex (never exactly 0: a zero-radius ring has no normal)
  [0.09, -0.965],
  [0.185, -0.9],
  [0.26, -0.74],
  [0.285, -0.52], // widest, abeam the sheave pin
  [0.268, -0.3],
  [0.232, -0.205], // shoulder
  [0.175, -0.15], // score: the strop sits in here
  [0.212, -0.105], // crown swell above the score
  [0.142, -0.045], // neck
  [0.004, 0.0], // crown apex — the point that hangs on the rope
];

/** vertices between these heights are the strop, and get the hemp tone */
const SCORE_BAND: readonly [number, number] = [-0.215, -0.09];

/** slot half-width, cheek half-thickness and sheave geometry, all in block
 *  heights. The slot is ~1/6 of the shell's width, which is the §V48 number
 *  that matters: it is the feature that goes sub-pixel first. */
const SLOT_HALF = 0.028;
const CHEEK_HALF = 0.081;
const SHEAVE_RADIUS = 0.24;
const SHEAVE_Y = -0.52;

/** a cross product shorter than this counts as degenerate (parallel inputs) */
const EPS = 1e-6;

export interface Blocks {
  mesh: THREE.Object3D;
  /** dev handle: the packed descriptor buffer, for console verification */
  descriptors: THREE.StorageInstancedBufferAttribute;
  /** the live-tunable uniforms, exposed for the same reason the rope mesh
   *  returns its own: they are what §V62's refresh test reads */
  uniforms: {
    uShell: { value: THREE.Color };
    uSheave: { value: THREE.Color };
    uStrop: { value: THREE.Color };
    uSlackSpan: { value: number };
    uDetailMinPx: { value: number };
    uDetailMaxPx: { value: number };
  };
  /** re-read the live params (§V62); called per frame by ropes/index.ts */
  refresh(): void;
  dispose(): void;
}

/** scale a geometry along z, fixing the normals for the non-uniform squash
 *  (normals transform by the INVERSE transpose — three's geometry.scale() does
 *  not do this, and a lit block with stretched normals reads as plastic) */
function squashZ(geometry: THREE.BufferGeometry, k: number): void {
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  const nrm = geometry.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    pos.setZ(i, pos.getZ(i) * k);
    const nx = nrm.getX(i);
    const ny = nrm.getY(i);
    const nz = nrm.getZ(i) / k;
    const l = Math.max(Math.hypot(nx, ny, nz), 1e-9);
    nrm.setXYZ(i, nx / l, ny / l, nz / l);
  }
  pos.needsUpdate = true;
  nrm.needsUpdate = true;
}

/** tag every vertex with a part id so one material can tint the sheave and the
 *  strop without a second draw call or a texture */
function tagPart(
  geometry: THREE.BufferGeometry,
  part: number,
  bandY?: readonly [number, number],
): void {
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  const ids = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    ids[i] = bandY !== undefined && y >= bandY[0] && y <= bandY[1] ? PART_STROP : part;
  }
  geometry.setAttribute('blockPart', new THREE.BufferAttribute(ids, 1));
}

/**
 * The shell: two lathed cheeks either side of the slot, and the sheave filling
 * it. Unit height (y ∈ [−1, 0]); the vertex stage scales by the descriptor's
 * size, so the geometry is built once and shared by every block on the ship.
 */
export function buildBlockGeometry(faces = ropeParams.blockSegments): THREE.BufferGeometry {
  const seg = Math.max(5, Math.round(faces));
  const profile = SHELL_PROFILE.map(([r, y]) => new THREE.Vector2(r, y));
  const parts: THREE.BufferGeometry[] = [];
  for (const sign of [-1, 1]) {
    const cheek = new THREE.LatheGeometry(profile, seg);
    // a lathe is round in z as well as x; squashing it is what turns the
    // turned shell into a CHEEK — flat-sided, oval seen face on
    squashZ(cheek, CHEEK_HALF / 0.285);
    cheek.translate(0, 0, sign * (SLOT_HALF + CHEEK_HALF));
    tagPart(cheek, PART_SHELL, SCORE_BAND);
    parts.push(cheek);
  }
  // the sheave: wider than the slot, so it is seated INTO the cheeks and the
  // block is never a see-through hole (a hole is a hard silhouette edge on a
  // few-pixel object — §V48's speckle, arriving by geometry instead of shader)
  const sheave = new THREE.CylinderGeometry(
    SHEAVE_RADIUS,
    SHEAVE_RADIUS,
    (SLOT_HALF + CHEEK_HALF) * 1.2,
    seg,
    1,
    true,
  );
  sheave.rotateX(Math.PI / 2);
  sheave.translate(0, SHEAVE_Y, 0);
  tagPart(sheave, PART_SHEAVE);
  parts.push(sheave);

  const merged = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  if (merged === null) throw new Error('buildBlockGeometry: geometries failed to merge');
  return merged;
}

/**
 * Blocks for one ship's rig. `rc` is the rope system's compute handle: the
 * blocks read its solved points and tangents, and its descriptor buffer for
 * each rope's live length (which §V46 moves as the sails furl).
 */
export function createBlocks(
  rc: RopeCompute,
  descriptors: BlockDescriptor[],
  maxRopes: number,
  segments: number,
): Blocks {
  const maxBlocks = Math.max(descriptors.length, 1);
  const geometry = buildBlockGeometry();

  // descriptors: (rope, t, size, away). Written ONCE here — a block costs the
  // CPU nothing per frame, which is the §V12 rule the old setBlock() broke.
  const descAttr = new THREE.StorageInstancedBufferAttribute(
    new Float32Array(maxBlocks * 4),
    4,
  );
  packBlocks(descriptors, descAttr.array as Float32Array);
  descAttr.needsUpdate = true;
  const blockDesc = storage(descAttr, 'vec4', maxBlocks).toReadOnly();

  // §V29/§B.8: SEPARATE read-only views over the compute's buffers. Calling
  // toReadOnly() on rc.points / rc.descA themselves would mutate the shared
  // node and downgrade the kernel's own binding.
  const pts = rc.pointsRead;
  const tans = rc.tangentsRead;
  const descA = storage(rc.descA.value, 'vec4', maxRopes).toReadOnly();
  const descB = storage(rc.descB.value, 'vec4', maxRopes).toReadOnly();

  const uShell = uniform(new THREE.Color(ropeParams.blockColorHex));
  const uSheave = uniform(new THREE.Color(ropeParams.blockSheaveColorHex));
  // the strop IS rope, so it takes the rope's own albedo rather than a fourth
  // colour that could drift away from it
  const uStrop = uniform(new THREE.Color(ropeParams.colorHex));
  const uSlackSpan = uniform(ropeParams.blockSlackSpan);
  const uDetailMinPx = uniform(ropeParams.blockDetailMinPx);
  const uDetailMaxPx = uniform(ropeParams.blockDetailMaxPx);

  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.85 });

  // --- the pose (mirrors blockMath.blockPose term for term) ------------------
  const d = blockDesc.element(instanceIndex);
  const rope = int(d.x);
  const size = d.z;

  // sample the SOLVED curve, not the socket: this is the whole fix
  const s = d.y.clamp(0, 1).mul(segments);
  const i0 = s.floor().clamp(0, segments - 1);
  const frac = s.sub(i0);
  const base = rope.mul(rc.pointsPerRope).add(int(i0));
  const P = mix(pts.element(base).xyz, pts.element(base.add(1)).xyz, frac);
  const tanRaw = mix(
    tans.element(base).xyz,
    tans.element(base.add(1)).xyz,
    frac,
  ).mul(d.w);
  // same guard-then-normalise shape as every other unit vector here, and the
  // same one blockMath's unit() has: never hand normalize() a zero vector
  const T = normalize(select(tanRaw.length().lessThan(float(EPS)), vec3(0, -1, 0), tanRaw));

  // tension from the rope's own live slack ratio (length ÷ chord)
  const dA = descA.element(rope);
  const dB = descB.element(rope);
  const chord = dB.xyz.sub(dA.xyz).length();
  const slackRatio = dA.w.div(max(chord, float(Z_MIN)));
  const tension = smoothstep(float(0), max(uSlackSpan, float(Z_MIN)), slackRatio.sub(1))
    .oneMinus()
    .clamp(0, 1);

  const down = vec3(0, -1, 0);
  const hangRaw = mix(down, T, tension);
  // guard BEFORE normalising rather than selecting after it: normalize(0) is
  // NaN, and a NaN vertex position is the §B5 GPU wedge, not a visual bug
  const H = normalize(select(hangRaw.length().lessThan(float(EPS)), down, hangRaw));

  // the sheave's axle is horizontal and square to the line, so the slot lies in
  // the vertical plane the line runs in. That plane is undefined for a PLUMB
  // line, and a hard fallback there snapped the block's frame 127.6° in one
  // frame as the ship rolled a lift through vertical — so the deterministic
  // fallback is BLENDED in, not switched to (blockMath.AXLE_SOFTNESS), and the
  // last two axes are Gram-Schmidt'd so the frame stays orthonormal wherever
  // the blend — or a §V42 chain swinging out of plane — has pulled the axle off
  // the line's own plane.
  const angle = float(rope).mul(2.399);
  const ref = vec3(angle.cos(), 0, angle.sin());
  const soft = normalize(cross(ref, down)).mul(float(AXLE_SOFTNESS));
  const axle0 = cross(T, down).add(soft);
  const X = normalize(cross(axle0, H));
  const Z = cross(H, X);

  // local frame → world: local +X is `X`, local +Y is UP the shell (−H), local
  // +Z is the axle. Geometry spans y ∈ [−1, 0], so the crown lands exactly on
  // the sampled rope point and the body hangs along H.
  const g = positionGeometry;
  material.positionNode = P.add(X.mul(g.x.mul(size)))
    .add(H.mul(g.y.negate().mul(size)))
    .add(Z.mul(g.z.mul(size)));
  const n = normalGeometry;
  material.normalNode = normalize(X.mul(n.x).add(H.mul(n.y.negate())).add(Z.mul(n.z)));

  // --- §V48 band limit: fade the internal contrast out with distance --------
  // Deliberately the only camera-dependent term: the POSITION must not depend
  // on the camera or the shadow pass (which draws from the sun) would place the
  // block somewhere else than the beauty pass does.
  const part = attribute('blockPart', 'float');
  const detail = smoothstep(uDetailMinPx, uDetailMaxPx, projectedWidthPx(P, size.mul(0.5)));
  const feature = select(
    part.greaterThan(float(1.5)),
    uSheave,
    select(part.greaterThan(float(0.5)), uStrop, uShell),
  );
  // resolved in the VERTEX stage: every input is per-instance (the descriptor,
  // hence instanceIndex) or per-vertex (the part id), and neither exists in a
  // fragment shader. Interpolating it also band-limits the strop's edge for
  // free — the score's tone arrives as a gradient, never a step (§V48).
  material.colorNode = varying(mix(uShell, feature, detail));

  const mesh = new THREE.InstancedMesh(geometry, material, maxBlocks);
  mesh.name = 'rigging-blocks';
  mesh.count = descriptors.length;
  mesh.castShadow = true;
  mesh.frustumCulled = false; // positions live GPU-side, the CPU knows no bounds

  return {
    mesh,
    descriptors: descAttr,
    uniforms: { uShell, uSheave, uStrop, uSlackSpan, uDetailMinPx, uDetailMaxPx },
    refresh(): void {
      // colours mutated in place (binding kept) and through Color.set(hex),
      // which is setHex(…, SRGBColorSpace) — the §V31 entry point
      uShell.value.set(ropeParams.blockColorHex);
      uSheave.value.set(ropeParams.blockSheaveColorHex);
      // the strop IS rope, so it keeps tracking the rope's own albedo
      uStrop.value.set(ropeParams.colorHex);
      pushParam(uSlackSpan, ropeParams.blockSlackSpan);
      pushParam(uDetailMinPx, ropeParams.blockDetailMinPx);
      pushParam(uDetailMaxPx, ropeParams.blockDetailMaxPx);
    },
    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}
