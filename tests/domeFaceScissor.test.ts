/**
 * The dome capture draws each cube face only inside the rectangle the master reads (domeCapture.ts, ONLY THE
 * HEMISPHERE IS DRAWN). Two things matter: no pixel the master reads may fall outside its face's rectangle (it
 * would show last frame's picture, or black, in the film), and the rectangles must actually leave out the part
 * of the cube the dome never shows — that is the whole speed-up (the sea's frame is mostly fragment shading).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { faceScissor } from '../src/cine/domeCapture';
import { domeBasis, domeMasterDirection } from '../src/cine/domeMaster';

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
    if (v.z >= 0) continue; // behind this face's camera
    const n = v.applyMatrix4(cam.projectionMatrix);
    if (Math.abs(n.x) > 1 + 1e-9 || Math.abs(n.y) > 1 + 1e-9) continue;
    return { face, x: ((n.x + 1) / 2) * SIZE, y: ((1 - n.y) / 2) * SIZE };
  }
  throw new Error('direction on no face');
}

function rects(faces: THREE.PerspectiveCamera[], eye: THREE.Matrix4, tilt: number): Array<THREE.Vector4 | null> {
  const axis = new THREE.Vector3().fromArray(domeBasis(tilt).axis).applyMatrix3(new THREE.Matrix3().setFromMatrix4(eye)).normalize();
  return faces.map((cam) => {
    const r = faceScissor(cam, axis, SIZE, new THREE.Vector4());
    return r && r.clone();
  });
}

describe('dome face scissor', () => {
  const faces = cube();
  const eyes = [0, 0.7, 2.1, -1.3].map((yaw) => new THREE.Matrix4().makeRotationY(yaw));

  it('covers every pixel the master reads, for any eye heading and tilt', () => {
    for (const tilt of [0, 15, 30]) {
      for (const eye of eyes) {
        const r = rects(faces, eye, tilt);
        const rot = new THREE.Matrix3().setFromMatrix4(eye);
        for (let i = 0; i <= 80; i++) {
          for (let j = 0; j <= 80; j++) {
            const m = domeMasterDirection(i / 80, j / 80, tilt);
            if (!m) continue;
            const { face, x, y } = landing(faces, new THREE.Vector3(...m.dir).applyMatrix3(rot));
            const rect = r[face];
            expect(rect, `tilt ${tilt}: face ${face} skipped but read`).not.toBeNull();
            // (1e-6 px: a direction on a face's border lands a rounding error outside it)
            expect(x).toBeGreaterThanOrEqual(rect!.x - 1e-6);
            expect(x).toBeLessThanOrEqual(rect!.x + rect!.z + 1e-6);
            expect(y).toBeGreaterThanOrEqual(rect!.y - 1e-6);
            expect(y).toBeLessThanOrEqual(rect!.y + rect!.w + 1e-6);
          }
        }
      }
    }
  });

  it('leaves out the bottom face and about half the cube at the film’s 15° tilt', () => {
    for (const eye of eyes) {
      const r = rects(faces, eye, 15);
      expect(r[3]).toBeNull(); // −Y: the sea straight down, never on the dome
      const drawn = r.reduce((a, q) => a + (q ? q.z * q.w : 0), 0) / (6 * SIZE * SIZE);
      expect(drawn).toBeLessThan(0.6);
    }
  });
});
