/**
 * The water mirror clips each cube face at the waterline with an oblique near plane (mirror.ts `clipToWater`).
 * What matters: everything above the water that the plain face saw is still drawn (or the reflection loses
 * pieces of the raft), and nothing under it is (or the submerged halves of the planks reflect as dark
 * undersides, the artefact the clip exists to remove). The face looking straight down sees only water and is
 * skipped.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { clipToWater } from '../src/drift/wandering/mirror';

function faces(eyeHeight: number): THREE.PerspectiveCamera[] {
  const c = new THREE.CubeCamera(0.05, 3000, new THREE.CubeRenderTarget(64));
  c.coordinateSystem = THREE.WebGPUCoordinateSystem;
  c.updateCoordinateSystem();
  c.position.set(3, -eyeHeight, -7); // the mirrored eye, under the water
  c.updateMatrixWorld(true);
  return c.children as THREE.PerspectiveCamera[];
}

/** a pseudo-random point inside the plain frustum of `cam`, in world space */
function inside(cam: THREE.PerspectiveCamera, r: () => number): THREE.Vector3 {
  const p = new THREE.Vector3(r() * 2 - 1, r() * 2 - 1, r()).applyMatrix4(cam.projectionMatrixInverse);
  return p.applyMatrix4(cam.matrixWorld);
}

describe('mirror waterline clip', () => {
  let seed = 7;
  const r = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  it('keeps all the plain frustum above the water and nothing below it', () => {
    for (const h of [0.3, 1.6, 12]) {
      for (const cam of faces(h)) {
        cam.updateProjectionMatrix();
        const pts = Array.from({ length: 400 }, () => inside(cam, r));
        if (!clipToWater(cam)) {
          for (const p of pts) expect(p.y).toBeLessThan(1e-6);
          continue;
        }
        for (const p of pts) {
          const n = p.clone().applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix);
          if (p.y > 1e-3) {
            expect(n.z).toBeGreaterThanOrEqual(-1e-6);
            expect(n.z).toBeLessThanOrEqual(1 + 1e-6);
          } else if (p.y < -1e-3) {
            expect(n.z).toBeLessThan(0);
          }
        }
      }
    }
  });

  it('skips the face that looks straight down', () => {
    const down = faces(1.6)[3]; // −Y
    expect(clipToWater(down)).toBe(false);
  });
});
