/**
 * Pure mirror-plane math + layer bookkeeping for the planar reflection pass
 * (§V26). No three.js render state is touched here so every rule below is
 * unit-testable — the virtual camera pose, the §V26 "res ≤ half" clamp and
 * the layer masks are the three things that silently ruin a reflection.
 *
 * The mirror plane is the horizontal plane y = planeY with normal +Y. That is
 * the ocean's rest plane: the FFT displaces the surface around it, and the
 * displacement is folded back in as a UV distortion in the shading (see
 * reflectionShading.ts), which is the standard planar-reflection cheat.
 */
import * as THREE from 'three/webgpu';
import {
  REFLECTION_MAX_RESOLUTION_SCALE,
  REFLECTION_MIN_RESOLUTION_SCALE,
} from '../params/reflection';

/**
 * Objects on this layer render in the MAIN view only — the mirror pass skips
 * them. Use for anything that costs fill rate and contributes nothing to a
 * reflection (spray, the camera-pinned cloud quad, thin rigging).
 */
export const REFLECTION_HIDDEN_LAYER = 11;
/**
 * Objects on this layer render in the MIRROR pass only. Use for stand-ins
 * that only make sense from the virtual camera (the mirrored cloud quad).
 */
export const REFLECTION_ONLY_LAYER = 12;

const HIDDEN_BIT = 1 << REFLECTION_HIDDEN_LAYER;
const ONLY_BIT = 1 << REFLECTION_ONLY_LAYER;

/**
 * Mask for the camera that renders the mirror pass: keep everything the
 * source camera sees, add the reflection-only stand-ins, drop the hidden set.
 */
export function reflectionCameraMask(sourceMask: number): number {
  return ((sourceMask | ONLY_BIT) & ~HIDDEN_BIT) >>> 0;
}

/**
 * Mask for the main camera: it must be widened to see the hidden set (they
 * were moved OFF layer 0 to hide them from the mirror) and must never see
 * the reflection-only stand-ins.
 */
export function mainCameraMask(sourceMask: number): number {
  return ((sourceMask | HIDDEN_BIT) & ~ONLY_BIT) >>> 0;
}

/**
 * Object mask for "main view only". Layer 0 is dropped and the hidden layer
 * added, rather than `layers.set()` — other systems own bits on the same
 * objects (flowfoam tags hull meshes on layer 27) and a blanket set() would
 * silently drop them out of THEIR pass instead.
 */
export function hiddenObjectMask(mask: number): number {
  return ((mask | HIDDEN_BIT) & ~1) >>> 0;
}

/** Object mask for "mirror pass only" — same reasoning as above. */
export function reflectionOnlyObjectMask(mask: number): number {
  return ((mask | ONLY_BIT) & ~1) >>> 0;
}

/**
 * Mask for the sun's shadow camera. three copies the RENDERING camera's mask
 * onto the shadow camera whenever the shadow camera only has layer 0
 * (ShadowNode.updateShadow) — which would make shadow casting depend on
 * whether the main pass or the mirror pass hit the light first. Setting a
 * mask with any bit above 0 pins it instead: everything casts, always.
 */
export function shadowCameraMask(sourceMask: number): number {
  return ((sourceMask | HIDDEN_BIT | ONLY_BIT) | 1) >>> 0;
}

/**
 * §V26: reflection resolution ≤ half. Finite-guarded (§V28) — a NaN from the
 * panel or a preset must not reach renderTarget.setSize().
 */
export function clampResolutionScale(value: number): number {
  if (!Number.isFinite(value)) return REFLECTION_MAX_RESOLUTION_SCALE;
  return Math.min(
    Math.max(value, REFLECTION_MIN_RESOLUTION_SCALE),
    REFLECTION_MAX_RESOLUTION_SCALE,
  );
}

const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _target = new THREE.Vector3();
const _m = new THREE.Matrix4();

export interface MirrorPose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

/**
 * Pose of the virtual camera that renders the mirror pass, for the plane
 * y = planeY. Reproduces three's ReflectorNode construction exactly:
 *   - position mirrored across the plane
 *   - look-at target mirrored across the plane
 *   - the camera's world up vector reflected in the plane normal
 * The resulting basis is the mirror of the source basis EXCEPT that the
 * right vector comes out negated (a lookAt has determinant +1, it cannot
 * encode a reflection) — which is precisely why the reflection texture is
 * sampled with `screenUV.flipX()` downstream. Do not "fix" one without the
 * other.
 */
export function mirrorCameraPose(
  position: THREE.Vector3,
  quaternion: THREE.Quaternion,
  planeY: number,
  out: MirrorPose,
): MirrorPose {
  out.position.set(position.x, 2 * planeY - position.y, position.z);

  _fwd.set(0, 0, -1).applyQuaternion(quaternion);
  _up.set(0, 1, 0).applyQuaternion(quaternion);

  _target.set(
    position.x + _fwd.x,
    2 * planeY - (position.y + _fwd.y),
    position.z + _fwd.z,
  );
  // reflect(up, +Y) === up with y negated
  _up.y = -_up.y;

  // Camera convention: Object3D.lookAt uses lookAt(eye, target, up) for
  // cameras (the non-camera branch swaps eye/target).
  _m.lookAt(out.position, _target, _up);
  out.quaternion.setFromRotationMatrix(_m);
  return out;
}

/** allocate a MirrorPose scratch object */
export function createMirrorPose(): MirrorPose {
  return { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
}

/**
 * The mirror pass is meaningless once the eye is below the plane (the
 * virtual camera ends up above the water looking down, and three's reflector
 * clears the target instead). The margin keeps the crossing from flickering.
 */
export function eyeIsAbovePlane(eyeY: number, planeY: number, margin = 0.05): boolean {
  return Number.isFinite(eyeY) && eyeY > planeY + margin;
}
