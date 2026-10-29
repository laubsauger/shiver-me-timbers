/**
 * The review view (`DomeCapture.setFlat`) draws each cube face only inside the view's own frustum, widened a little
 * (domeCapture.ts flatViewPlanes → faceScissor). As for the dome's hemisphere (domeFaceScissor.test.ts), two things
 * matter: no pixel the view reads may fall outside its face's rectangle (a review still would show the clear there),
 * and the rectangles must leave out most of the cube — drawing six whole faces at the review's supersampling is what
 * made review frames cost seconds.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { faceScissor, flatViewPlanes } from '../src/cine/domeCapture';

const SIZE = 1200;

function cube(): THREE.PerspectiveCamera[] {
  const c = new THREE.CubeCamera(0.05, 1000, new THREE.CubeRenderTarget(SIZE));
  c.coordinateSystem = THREE.WebGPUCoordinateSystem;
  c.updateCoordinateSystem();
  c.updateMatrixWorld(true);
  return c.children as THREE.PerspectiveCamera[];
}

/** the face (and its pixel, WebGPU top-left origin) a world direction lands on */
function landing(faces: THREE.PerspectiveCamera[], d: THREE.Vector3): { face: number; x: number; y: number } {
  for (const [face, cam] of faces.entries()) {
    const v = d.clone().applyMatrix4(cam.matrixWorldInverse);
    if (v.z >= 0) continue;
    const n = v.applyMatrix4(cam.projectionMatrix);
    if (Math.abs(n.x) > 1 + 1e-9 || Math.abs(n.y) > 1 + 1e-9) continue;
    return { face, x: ((n.x + 1) / 2) * SIZE, y: ((1 - n.y) / 2) * SIZE };
  }
  throw new Error('direction on no face');
}

/** the aim `setFlat` builds (deg: yaw + left, pitch + up) */
function aim(yaw: number, pitch: number): THREE.Matrix3 {
  const D = Math.PI / 180;
  return new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(pitch * D, yaw * D, 0, 'YXZ')));
}

describe('review view face scissor', () => {
  const faces = cube();
  const eyes = [0, 0.7, 2.1, -1.3].map((yaw) => new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationY(yaw)));
  const views = [
    { fov: 60, yaw: -45, pitch: 0 },
    { fov: 80, yaw: 0, pitch: -20 },
    { fov: 30, yaw: 10, pitch: -4 },
    { fov: 60, yaw: 0, pitch: 30 },
    { fov: 120, yaw: 170, pitch: -60 },
  ];

  it('covers every pixel the view reads (the master turns its ray by the eye and the aim)', () => {
    for (const eye of eyes) {
      for (const v of views) {
        const tan = Math.tan((v.fov * Math.PI) / 360);
        const a = aim(v.yaw, v.pitch);
        const planes = flatViewPlanes(eye, a, tan)!;
        const rects = faces.map((cam) => {
          const r = faceScissor(cam, planes, SIZE, new THREE.Vector4());
          return r && r.clone();
        });
        const turn = new THREE.Matrix3().multiplyMatrices(eye, a);
        for (let i = 0; i <= 40; i++) {
          for (let j = 0; j <= 40; j++) {
            // domeCapture.ts flatRay: (u·2 − 1)·tan, (v·2 − 1)·tan, −1
            const ray = new THREE.Vector3(((i / 40) * 2 - 1) * tan, ((j / 40) * 2 - 1) * tan, -1).applyMatrix3(turn);
            const { face, x, y } = landing(faces, ray);
            const rect = rects[face];
            expect(rect, `fov ${v.fov}: face ${face} skipped but read`).not.toBeNull();
            expect(x).toBeGreaterThanOrEqual(rect!.x - 1e-6);
            expect(x).toBeLessThanOrEqual(rect!.x + rect!.z + 1e-6);
            expect(y).toBeGreaterThanOrEqual(rect!.y - 1e-6);
            expect(y).toBeLessThanOrEqual(rect!.y + rect!.w + 1e-6);
          }
        }
      }
    }
  });

  it('draws a fraction of the cube: a 60° view under two faces, a 30° one under a third of one (six whole faces were 6)', () => {
    const area = (fov: number, yaw: number, pitch: number): number => {
      const planes = flatViewPlanes(eyes[1], aim(yaw, pitch), Math.tan((fov * Math.PI) / 360))!;
      return faces.reduce((sum, cam) => {
        const r = faceScissor(cam, planes, SIZE, new THREE.Vector4());
        return sum + (r ? r.z * r.w : 0);
      }, 0) / (SIZE * SIZE);
    };
    expect(area(60, -45, 0)).toBeLessThan(2);
    expect(area(30, 10, -4)).toBeLessThan(1 / 3);
  });

  it('draws every face whole when the widened view reaches a hemisphere', () => {
    expect(flatViewPlanes(eyes[0], aim(0, 0), Math.tan((176 * Math.PI) / 360))).toBeNull();
  });
});
