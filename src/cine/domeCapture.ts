/**
 * Fisheye capture: render the six faces around an eye, then resample them into a square DOME MASTER.
 *
 * The master's convention and the per-pixel direction are in domeMaster.ts (tested against studio-world's
 * playback mapping). This module is only the GPU half:
 *
 *   1. a world-aligned CubeCamera at the eye's position renders the scene into a half-float cube target
 *      (linear HDR, no tone map — the faces are data, not pictures);
 *   2. a full-screen quad looks each output pixel up in that cube along the dome direction, rotated by the
 *      eye's orientation, and writes it into whatever target is bound (the canvas, or the cine capture
 *      target). The quad's NodeMaterial applies the renderer's tone map and output colour space exactly
 *      once, there.
 *
 * WHY THE CUBE STAYS WORLD-ALIGNED: rotating the CubeCamera would rotate its faces, and the lookup would
 * then have to happen in the cube's own frame. Keeping it unrotated means the lookup direction is just the
 * eye's rotation applied to the camera-local dome direction.
 *
 * What does NOT survive this path: screen-space effects run per face (bloom, SMAA, god rays, DoF) would
 * seam at the face edges. Put them on the master after the resample, or not at all.
 */
import * as THREE from 'three/webgpu';
import { cubeTexture, mix, texture, uniform, uv, vec2, vec4 } from 'three/tsl';
import { domeMasterDirectionNode } from './domeMaster';

export interface DomeCaptureOptions {
  /** px per cube face; ~0.5–0.6 × the master width is enough (each face covers 90°) */
  faceSize: number;
  /**
   * Optional layer drawn in MASTER space over the resampled frame (titles, a crawl): straight alpha, sRGB,
   * same uv convention as the master (v = 0 at the bottom = front). Its radiance is set with
   * `setOverlayRadiance`, before the tone map.
   */
  overlay?: THREE.Texture;
  near?: number;
  far?: number;
}

export class DomeCapture {
  readonly cubeCamera: THREE.CubeCamera;
  readonly target: THREE.CubeRenderTarget;
  private readonly quad: THREE.QuadMesh;
  private readonly material: THREE.NodeMaterial;
  private readonly uTilt = uniform(0);
  private readonly uView = uniform(new THREE.Matrix3());
  private readonly uOverlayRadiance = uniform(1);

  constructor(opts: DomeCaptureOptions) {
    this.target = new THREE.CubeRenderTarget(opts.faceSize, { type: THREE.HalfFloatType });
    this.cubeCamera = new THREE.CubeCamera(opts.near ?? 0.05, opts.far ?? 1e6, this.target);
    // the full-screen quad's uv has v = 0 at the TOP of the target under WebGPU; the master's convention is
    // v = 0 at the bottom (front). Flip, or the master is mirrored front-to-back (caught by drift ?markers).
    const masterUV = vec2(uv().x, uv().y.oneMinus());
    const { dir, inside } = domeMasterDirectionNode(masterUV, this.uTilt);
    const world = this.uView.mul(dir);
    const material = (this.material = new THREE.NodeMaterial());
    const frame = cubeTexture(this.target.texture, world).rgb.mul(inside);
    if (opts.overlay) {
      const layer = texture(opts.overlay, masterUV);
      material.fragmentNode = vec4(mix(frame, layer.rgb.mul(this.uOverlayRadiance), layer.a), 1);
    } else {
      material.fragmentNode = vec4(frame, 1);
    }
    material.depthTest = false;
    material.depthWrite = false;
    material.name = 'dome-master';
    this.quad = new THREE.QuadMesh(material);
  }

  setOverlayRadiance(radiance: number): void {
    this.uOverlayRadiance.value = radiance;
  }

  setFaceSize(size: number): void {
    if (this.target.width !== size) this.target.setSize(size, size);
  }

  /**
   * Render the faces from `eye` (position + orientation; its −Z is the dome front, +Y the un-tilted
   * zenith), then the master into the currently bound target. `tiltDeg` leans the zenith toward the front.
   */
  render(renderer: THREE.WebGPURenderer, scene: THREE.Scene, eye: THREE.Object3D, tiltDeg: number): void {
    eye.updateMatrixWorld();
    this.cubeCamera.position.setFromMatrixPosition(eye.matrixWorld);
    this.cubeCamera.updateMatrixWorld();
    this.uView.value.setFromMatrix4(eye.matrixWorld);
    this.uTilt.value = (tiltDeg * Math.PI) / 180;
    this.cubeCamera.update(renderer, scene);
    this.quad.render(renderer);
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
  }
}
