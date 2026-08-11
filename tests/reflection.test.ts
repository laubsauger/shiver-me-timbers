/**
 * Planar reflection invariants (T30, §V26).
 *
 * These pin the three things that make a mirrored scene pass either correct
 * or silently, expensively wrong:
 *
 *  - §V26 says "reflection res ≤ half". That is a budget invariant (§V17: a
 *    second full scene render), not a default — the Tweakpane panel writes
 *    the params object directly, so the clamp has to hold against anything
 *    typed into it, NaN included (§V28).
 *  - The virtual camera pose IS the reflection. If it drifts, nothing errors:
 *    the water just shows a plausible-looking wrong world. The test below
 *    checks the property that actually matters — a point's mirror image, seen
 *    by the real camera, lands where the point itself lands when seen by the
 *    virtual camera, up to the horizontal flip. That flip is why the texture
 *    is sampled through `screenUV.flipX()`; the pair is tested together so
 *    nobody can "fix" one half of it.
 *  - The layer split is the whole cost story. If the masks stop excluding
 *    what they should, the mirror pass silently becomes a second full frame.
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import {
  REFLECTION_HIDDEN_LAYER,
  REFLECTION_ONLY_LAYER,
  clampResolutionScale,
  createMirrorPose,
  eyeIsAbovePlane,
  hiddenObjectMask,
  mainCameraMask,
  mirrorCameraPose,
  reflectionCameraMask,
  reflectionOnlyObjectMask,
  shadowCameraMask,
} from '../src/reflection/mirrorMath';
import {
  REFLECTION_MAX_RESOLUTION_SCALE,
  reflectionParams,
} from '../src/params/reflection';

const PLANE_Y = 0;

/** a camera looking down at the water from astern, as the follow cam does */
function sourceCamera(): PerspectiveCamera {
  const cam = new PerspectiveCamera(55, 16 / 9, 0.1, 8000);
  cam.position.set(4, 12, 30);
  cam.lookAt(0, 2, 0);
  cam.updateMatrixWorld();
  return cam;
}

/** the same camera reflected in y = planeY, built through mirrorCameraPose */
function mirrorCamera(source: PerspectiveCamera, planeY: number): PerspectiveCamera {
  const pose = mirrorCameraPose(
    source.position,
    source.quaternion,
    planeY,
    createMirrorPose(),
  );
  const cam = new PerspectiveCamera(source.fov, source.aspect, source.near, source.far);
  cam.position.copy(pose.position);
  cam.quaternion.copy(pose.quaternion);
  cam.updateMatrixWorld();
  return cam;
}

describe('§V26 resolution clamp — reflection res ≤ half', () => {
  it('never exceeds half, whatever the panel writes', () => {
    for (const v of [0.5, 0.75, 1, 4, 1e9]) {
      expect(clampResolutionScale(v)).toBeLessThanOrEqual(REFLECTION_MAX_RESOLUTION_SCALE);
    }
  });

  it('never returns a non-positive or non-finite size (§V28)', () => {
    for (const v of [0, -1, -1e9, NaN, Infinity, -Infinity]) {
      const out = clampResolutionScale(v);
      expect(Number.isFinite(out)).toBe(true);
      expect(out).toBeGreaterThan(0);
    }
  });

  it('passes sane values through untouched', () => {
    expect(clampResolutionScale(0.25)).toBeCloseTo(0.25, 12);
    expect(clampResolutionScale(0.5)).toBeCloseTo(0.5, 12);
  });

  it('the shipped default and the panel ceiling both honour §V26', () => {
    expect(reflectionParams.resolutionScale).toBeLessThanOrEqual(
      REFLECTION_MAX_RESOLUTION_SCALE,
    );
    expect(clampResolutionScale(reflectionParams.resolutionScale)).toBeCloseTo(
      reflectionParams.resolutionScale,
      12,
    );
  });
});

describe('virtual camera pose (the mirror itself)', () => {
  it('mirrors the eye across the plane and leaves x/z alone', () => {
    const src = sourceCamera();
    const mir = mirrorCamera(src, PLANE_Y);
    expect(mir.position.x).toBeCloseTo(src.position.x, 10);
    expect(mir.position.z).toBeCloseTo(src.position.z, 10);
    expect(mir.position.y).toBeCloseTo(2 * PLANE_Y - src.position.y, 10);
  });

  it('honours a plane that is not at y = 0', () => {
    const src = sourceCamera();
    const mir = mirrorCamera(src, 3);
    expect(mir.position.y).toBeCloseTo(6 - src.position.y, 10);
  });

  it('flips the view direction vertically, keeping its horizontal heading', () => {
    const src = sourceCamera();
    const mir = mirrorCamera(src, PLANE_Y);
    const f = new Vector3(0, 0, -1).applyQuaternion(src.quaternion);
    const fm = new Vector3(0, 0, -1).applyQuaternion(mir.quaternion);
    expect(fm.x).toBeCloseTo(f.x, 10);
    expect(fm.z).toBeCloseTo(f.z, 10);
    expect(fm.y).toBeCloseTo(-f.y, 10);
  });

  it('comes out with its RIGHT vector negated — this is why flipX exists', () => {
    // A lookAt matrix has determinant +1, so it cannot encode a reflection:
    // three's reflector absorbs the handedness change by sampling the target
    // through screenUV.flipX(). Deleting the flip requires changing this.
    const src = sourceCamera();
    const mir = mirrorCamera(src, PLANE_Y);
    const r = new Vector3(1, 0, 0).applyQuaternion(src.quaternion);
    const rm = new Vector3(1, 0, 0).applyQuaternion(mir.quaternion);
    expect(rm.x).toBeCloseTo(-r.x, 10);
    expect(rm.z).toBeCloseTo(-r.z, 10);
    expect(rm.y).toBeCloseTo(r.y, 10); // mirrored, then negated → y unchanged
  });

  it('a point seen by the virtual camera lands where its mirror image lands, flipped in x', () => {
    // The correctness criterion for the whole pass: the water pixel showing
    // the reflection of P is the screen position of P mirrored in the plane,
    // and the virtual camera must have drawn P at that same position with x
    // flipped. Any pose error breaks this without raising anything.
    const src = sourceCamera();
    const mir = mirrorCamera(src, PLANE_Y);
    const points = [
      new Vector3(0, 8, 0), // masthead, dead ahead
      new Vector3(-6, 2, -10), // hull off the port bow
      new Vector3(12, 25, -60), // something tall and far away
    ];
    for (const p of points) {
      const seenByMirror = p.clone().project(mir);
      const image = new Vector3(p.x, 2 * PLANE_Y - p.y, p.z).project(src);
      expect(seenByMirror.x).toBeCloseTo(-image.x, 8);
      expect(seenByMirror.y).toBeCloseTo(image.y, 8);
    }
  });

  it('is an involution — mirroring the mirror gives the original camera back', () => {
    const src = sourceCamera();
    const mir = mirrorCamera(src, PLANE_Y);
    const back = mirrorCamera(mir, PLANE_Y);
    expect(back.position.distanceTo(src.position)).toBeLessThan(1e-9);
    expect(Math.abs(back.quaternion.dot(src.quaternion))).toBeCloseTo(1, 9);
  });

  it('does not allocate per call — the pose object is reused', () => {
    const src = sourceCamera();
    const pose = createMirrorPose();
    const same = mirrorCameraPose(src.position, src.quaternion, PLANE_Y, pose);
    expect(same).toBe(pose);
  });

  it('leaves the source camera untouched', () => {
    const src = sourceCamera();
    const pos = src.position.clone();
    const quat = new Quaternion().copy(src.quaternion);
    mirrorCameraPose(src.position, src.quaternion, PLANE_Y, createMirrorPose());
    expect(src.position.equals(pos)).toBe(true);
    expect(src.quaternion.equals(quat)).toBe(true);
  });
});

describe('layer split (§V17 — the mirror pass must not be a second full frame)', () => {
  const bit = (n: number) => (1 << n) >>> 0;
  const has = (mask: number, layer: number) => (mask & bit(layer)) !== 0;

  it('main camera sees the hidden set and never the mirror-only stand-ins', () => {
    const m = mainCameraMask(1);
    expect(has(m, 0)).toBe(true);
    expect(has(m, REFLECTION_HIDDEN_LAYER)).toBe(true);
    expect(has(m, REFLECTION_ONLY_LAYER)).toBe(false);
  });

  it('mirror camera sees the stand-ins and never the hidden set', () => {
    const m = reflectionCameraMask(mainCameraMask(1));
    expect(has(m, 0)).toBe(true);
    expect(has(m, REFLECTION_ONLY_LAYER)).toBe(true);
    expect(has(m, REFLECTION_HIDDEN_LAYER)).toBe(false);
  });

  it('the two masks are disjoint on exactly the two reflection layers', () => {
    const main = mainCameraMask(1);
    const refl = reflectionCameraMask(main);
    expect((main & refl) >>> 0).toBe(1); // only the shared default layer 0
  });

  it('both masks are idempotent — update() reapplies them every frame', () => {
    const main = mainCameraMask(1);
    expect(mainCameraMask(main)).toBe(main);
    const refl = reflectionCameraMask(main);
    expect(reflectionCameraMask(refl)).toBe(refl);
  });

  it('the shadow camera keeps casting for BOTH sets', () => {
    // three copies the rendering camera's mask onto a layer-0-only shadow
    // camera, so whichever pass reached the light first would decide what
    // casts. Pinning the mask is what stops excluded rigging from losing its
    // shadow the moment reflections are switched on.
    const m = shadowCameraMask(1);
    expect(has(m, 0)).toBe(true);
    expect(has(m, REFLECTION_HIDDEN_LAYER)).toBe(true);
    expect(has(m, REFLECTION_ONLY_LAYER)).toBe(true);
    // three's own test is `(mask & 0xFFFFFFFE) === 0` → must be non-zero
    expect((m & 0xfffffffe) >>> 0).not.toBe(0);
  });

  it('object masks leave other systems\' layer bits alone', () => {
    // flowfoam tags hull meshes on layer 27 for its injection pass. A blanket
    // layers.set() here would drop them out of THAT pass — silently, and the
    // wake foam would just stop appearing under the hull.
    const foamTagged = (1 | bit(27)) >>> 0;
    const hidden = hiddenObjectMask(foamTagged);
    expect(has(hidden, 27)).toBe(true);
    expect(has(hidden, REFLECTION_HIDDEN_LAYER)).toBe(true);
    expect(has(hidden, 0)).toBe(false); // off layer 0 = invisible to the mirror
    const only = reflectionOnlyObjectMask(foamTagged);
    expect(has(only, 27)).toBe(true);
    expect(has(only, REFLECTION_ONLY_LAYER)).toBe(true);
    expect(has(only, 0)).toBe(false);
  });

  it('an excluded object is visible to the main camera and not the mirror', () => {
    const obj = hiddenObjectMask(1);
    expect((obj & mainCameraMask(1)) >>> 0).not.toBe(0);
    expect((obj & reflectionCameraMask(mainCameraMask(1))) >>> 0).toBe(0);
  });

  it('a reflection-only object is visible to the mirror and not the main camera', () => {
    const obj = reflectionOnlyObjectMask(1);
    expect((obj & reflectionCameraMask(mainCameraMask(1))) >>> 0).not.toBe(0);
    expect((obj & mainCameraMask(1)) >>> 0).toBe(0);
  });

  it('does not collide with flowfoam\'s injection layer (27)', () => {
    expect(REFLECTION_HIDDEN_LAYER).not.toBe(27);
    expect(REFLECTION_ONLY_LAYER).not.toBe(27);
    expect(REFLECTION_HIDDEN_LAYER).not.toBe(REFLECTION_ONLY_LAYER);
  });
});

describe('underwater gate (§V25 puts the camera below the surface on purpose)', () => {
  it('is off at and below the plane, on above it', () => {
    expect(eyeIsAbovePlane(5, 0)).toBe(true);
    expect(eyeIsAbovePlane(0, 0)).toBe(false);
    expect(eyeIsAbovePlane(-3, 0)).toBe(false);
  });

  it('tracks a plane that is not at y = 0', () => {
    expect(eyeIsAbovePlane(5, 10)).toBe(false);
    expect(eyeIsAbovePlane(12, 10)).toBe(true);
  });

  it('treats a non-finite eye height as below (§V28 — never render on NaN)', () => {
    expect(eyeIsAbovePlane(NaN, 0)).toBe(false);
  });
});
