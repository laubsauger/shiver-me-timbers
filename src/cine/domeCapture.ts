/**
 * Fisheye capture: render the six faces around an eye, resample them into a square DOME MASTER, then
 * present it with bloom and a tone map.
 *
 * The master's convention and the per-pixel direction are in domeMaster.ts (tested against studio-world's
 * playback mapping). This module is the GPU half:
 *
 *   1. a world-aligned CubeCamera at the eye's position renders the scene into a half-float cube target
 *      (linear HDR — the faces are data, not pictures);
 *   2. the MASTER pass looks each output pixel up in that cube along the dome direction (rotated by the
 *      eye's orientation) into a half-float square target, still linear HDR;
 *   3. the PRESENT pass adds bloom, composites the optional master-space overlay (titles, a crawl), masks
 *      the circle and tone-maps, into whatever target is bound (the canvas, or the cine capture target).
 *
 * WHY BLOOM HERE AND NOT PER FACE: screen-space effects run on cube faces seam at the face edges. On the
 * master they are seamless — and the master is the frame the audience sees.
 *
 * WHY THE TONE MAP IS EXPLICIT: three applies `renderer.toneMapping` only when drawing to the canvas
 * (`Renderer.isOutputTarget`). A capture target would get none, so a recording would show clipped linear
 * light while the preview showed the tone-mapped picture. The present pass tone-maps itself, with the
 * renderer's own tone map switched off around it, so screen and recording are the same frame. The output
 * colour space conversion still comes from the target (canvas: the renderer's; a capture target: its sRGB
 * format), which is the same transform in both.
 *
 * MOTION BLUR is sub-frame accumulation (`accumulate` / `present`): the master is rendered at several
 * instants across the shutter and averaged in linear HDR, BEFORE bloom and the tone map — averaging after the
 * tone map would darken every moving highlight. A 180° shutter at 30 fps blurs over 1/60 s.
 *
 * WHY THE CUBE STAYS WORLD-ALIGNED: rotating the CubeCamera would rotate its faces, and the lookup would
 * then have to happen in the cube's own frame. Keeping it unrotated means the lookup direction is just the
 * eye's rotation applied to the camera-local dome direction.
 *
 * ONLY THE HEMISPHERE IS DRAWN (`drawFaces`). The master looks up directions within 90° of the dome's zenith,
 * about half the cube: with a 15° tilt the bottom face is never read, and neither is the lower part of each
 * side face. The dome's edge is a great circle, a straight line on every face, so the part of a face the master
 * reads lies inside one rectangle; each face is drawn with that rectangle as its scissor, and a face with none
 * is not drawn. Frame time is mostly fragment shading (the sea at 2160²: ~80 ms fixed, ~385 ms in pixels,
 * docs/drift/engine-findings.md), and the skipped part is mostly the sea, the most expensive surface.
 */
import * as THREE from 'three/webgpu';
import { cubeTexture, mix, texture, toneMapping, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { domeBasis, domeMasterDirectionNode } from './domeMaster';

/** px drawn past the dome's edge on each face: the master's bilinear lookups at the spring line read across it */
const EDGE_PAD = 4;

const _axis = new THREE.Vector3();
const _p = new THREE.Vector3();
const _rect = new THREE.Vector4();
const _rot = new THREE.Matrix3();

/**
 * The part of face camera `cam` (of a cube `size` px a face) that sees directions on the dome side of the plane
 * through the eye with normal `axis` (world), as a scissor rectangle in the face's pixels (WebGPU: top-left
 * origin) into `out`; null when the face sees none of it.
 */
export function faceScissor(cam: THREE.PerspectiveCamera, axis: THREE.Vector3, size: number, out: THREE.Vector4): THREE.Vector4 | null {
  // d·axis over the face is affine in NDC (points of one depth lie on a plane, d unnormalised): three samples
  _rot.setFromMatrix4(cam.matrixWorld);
  const f = (nx: number, ny: number): number => _p.set(nx, ny, 0.5).applyMatrix4(cam.projectionMatrixInverse).applyMatrix3(_rot).dot(axis);
  const f0 = f(0, 0);
  const fx = f(1, 0) - f0;
  const fy = f(0, 1) - f0;
  // clip the face square by f ≥ 0 (Sutherland–Hodgman, one plane)
  const square: Array<[number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const value = ([x, y]: [number, number]): number => f0 + fx * x + fy * y;
  const kept: Array<[number, number]> = [];
  square.forEach((a, i) => {
    const b = square[(i + 1) % 4];
    const va = value(a);
    const vb = value(b);
    if (va >= 0) kept.push(a);
    if (va >= 0 !== vb >= 0) {
      const s = va / (va - vb);
      kept.push([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s]);
    }
  });
  if (kept.length < 3) return null;
  const xs = kept.map((q) => q[0]);
  const ys = kept.map((q) => q[1]);
  const x0 = Math.max(0, Math.floor(((Math.min(...xs) + 1) / 2) * size) - EDGE_PAD);
  const x1 = Math.min(size, Math.ceil(((Math.max(...xs) + 1) / 2) * size) + EDGE_PAD);
  const y0 = Math.max(0, Math.floor(((1 - Math.max(...ys)) / 2) * size) - EDGE_PAD);
  const y1 = Math.min(size, Math.ceil(((1 - Math.min(...ys)) / 2) * size) + EDGE_PAD);
  if (x1 <= x0 || y1 <= y0) return null;
  return out.set(x0, y0, x1 - x0, y1 - y0);
}

export interface DomeCaptureOptions {
  /** px per cube face; ~0.55 × the master width matches resolution (drift/record.ts faceSizeFor) */
  faceSize: number;
  near?: number;
  far?: number;
  /**
   * Optional layer drawn in MASTER space over the frame (titles, a crawl): straight alpha, sRGB, same uv
   * convention as the master (v = 0 at the bottom = front). Composited before the tone map.
   */
  overlay?: THREE.Texture;
  /** baked into the shader; AgX keeps saturated emitters cleaner than ACES */
  toneMapping?: THREE.ToneMapping;
  /**
   * A grade after the tone map, set per frame (`setGrade`): saturation about the luminance, and contrast as a
   * power about mid grey (a camera's curve; AgX alone is flat). Absent, the present pass is exactly the tone
   * map and `setGrade` does nothing.
   */
  grade?: boolean;
}

export interface DomeLook {
  exposure: number;
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
  overlayRadiance: number;
}

export class DomeCapture {
  readonly cubeCamera: THREE.CubeCamera;
  private target: THREE.CubeRenderTarget;
  private readonly cubeNode: ReturnType<typeof cubeTexture>;
  private readonly hdr: THREE.RenderTarget;
  private readonly accum: THREE.RenderTarget;
  private readonly accumQuad: THREE.QuadMesh;
  private readonly resolveQuad: THREE.QuadMesh;
  private readonly uWeight = uniform(1);
  private readonly masterQuad: THREE.QuadMesh;
  private readonly presentQuad: THREE.QuadMesh;
  private readonly materials: THREE.NodeMaterial[] = [];
  private readonly glow: ReturnType<typeof bloom>;
  private readonly uTilt = uniform(0);
  private readonly uView = uniform(new THREE.Matrix3());
  private readonly uExposure = uniform(1);
  private readonly uSaturation = uniform(1);
  private readonly uContrast = uniform(1);
  private readonly uOverlayRadiance = uniform(1);

  constructor(opts: DomeCaptureOptions) {
    this.target = new THREE.CubeRenderTarget(opts.faceSize, { type: THREE.HalfFloatType });
    this.cubeCamera = new THREE.CubeCamera(opts.near ?? 0.05, opts.far ?? 1e6, this.target);
    this.hdr = new THREE.RenderTarget(1024, 1024, { type: THREE.HalfFloatType, depthBuffer: false });
    this.accum = new THREE.RenderTarget(1024, 1024, { type: THREE.FloatType, depthBuffer: false });

    // the full-screen quad's uv has v = 0 at the TOP of the target under WebGPU; the master's convention is
    // v = 0 at the bottom (front). Flip, or the master is mirrored front-to-back (caught by drift ?markers).
    const masterUV = vec2(uv().x, uv().y.oneMinus());
    const { dir, inside } = domeMasterDirectionNode(masterUV, this.uTilt);

    const master = this.material('dome-master');
    this.cubeNode = cubeTexture(this.target.texture, this.uView.mul(dir));
    master.fragmentNode = vec4(this.cubeNode.rgb.mul(inside), 1);
    this.masterQuad = new THREE.QuadMesh(master);

    // accumulation: each sub-frame's master is added in with its weight; the sum is resolved back into hdr
    const add = this.material('dome-accumulate');
    add.fragmentNode = vec4(texture(this.hdr.texture).rgb.mul(this.uWeight), 1);
    add.blending = THREE.AdditiveBlending;
    add.transparent = true;
    this.accumQuad = new THREE.QuadMesh(add);
    const resolve = this.material('dome-resolve');
    resolve.fragmentNode = vec4(texture(this.accum.texture).rgb, 1);
    this.resolveQuad = new THREE.QuadMesh(resolve);

    const hdrTex = texture(this.hdr.texture);
    this.glow = bloom(hdrTex, 0.9, 0.5, 0.6);
    // BloomNode sizes its mip chain from the CANVAS drawing buffer every frame; the master is square and of
    // its own size, and a mismatched aspect smears the blur (vertical streaks at 2048² from a 16:9 canvas)
    const setSize = this.glow.setSize.bind(this.glow);
    this.glow.setSize = (): void => setSize(this.hdr.width, this.hdr.height);
    let lit = hdrTex.rgb.add(this.glow.rgb);
    if (opts.overlay) {
      const layer = texture(opts.overlay, masterUV);
      lit = mix(lit, layer.rgb.mul(this.uOverlayRadiance), layer.a);
    }
    const present = this.material('dome-present');
    const mapped = toneMapping(opts.toneMapping ?? THREE.AgXToneMapping, this.uExposure, lit.mul(inside)).rgb;
    let graded = mapped;
    if (opts.grade) {
      const luma = mapped.dot(vec3(0.2126, 0.7152, 0.0722));
      const saturated = mix(vec3(luma), mapped, this.uSaturation).max(0);
      graded = saturated.div(0.18).pow(vec3(this.uContrast)).mul(0.18).min(1);
    }
    present.fragmentNode = vec4(graded, 1);
    this.presentQuad = new THREE.QuadMesh(present);
  }

  private material(name: string): THREE.NodeMaterial {
    const m = new THREE.NodeMaterial();
    m.depthTest = false;
    m.depthWrite = false;
    m.name = name;
    this.materials.push(m);
    return m;
  }

  /**
   * Near clip of the six face cameras. Acts that travel down through scales (Get the Drift arrives at the
   * Sun from galaxy distances) put things millimetres from the eye; everything here is drawn additively
   * without depth writes, so a tiny near plane costs nothing but depth precision nobody reads.
   */
  setNear(near: number): void {
    for (const c of this.cubeCamera.children as THREE.PerspectiveCamera[]) {
      if (c.near === near) continue;
      c.near = near;
      c.updateProjectionMatrix();
    }
  }

  /** the grade for the frames that follow (see `grade`): 1, 1 is none */
  setGrade(saturation: number, contrast: number): void {
    this.uSaturation.value = saturation;
    this.uContrast.value = contrast;
  }

  /** Far clip of the six face cameras (the sea's acts need depth precision a 1e6 far plane spends) */
  setFar(far: number): void {
    for (const c of this.cubeCamera.children as THREE.PerspectiveCamera[]) {
      if (c.far === far) continue;
      c.far = far;
      c.updateProjectionMatrix();
    }
  }

  /**
   * REBUILD, never resize: three r186 `RenderTarget.setSize` writes width/height onto `texture.image`, which
   * for a CubeTexture is the ARRAY of six face images — the faces keep their old size while the target
   * reports the new one, and the master then samples faces that were only partly redrawn (moving content cut
   * along the cube seams in every recording at a size other than the preview's).
   */
  setFaceSize(size: number): void {
    if (this.target.width === size) return;
    this.target.dispose();
    this.target = new THREE.CubeRenderTarget(size, { type: THREE.HalfFloatType });
    // @types/three types CubeCamera.renderTarget as the WebGL cube target; the WebGPU one is what it renders into
    (this.cubeCamera as unknown as { renderTarget: THREE.CubeRenderTarget }).renderTarget = this.target;
    this.cubeNode.value = this.target.texture;
  }

  /**
   * The cube camera's six faces, each only where the master reads it (header: ONLY THE HEMISPHERE IS DRAWN):
   * `CubeCamera.update` with a scissor per face, and the faces that see none of the dome's hemisphere (`axis`,
   * world) skipped.
   */
  private drawFaces(renderer: THREE.WebGPURenderer, scene: THREE.Scene, axis: THREE.Vector3): void {
    const cube = this.cubeCamera;
    if (cube.coordinateSystem !== renderer.coordinateSystem) {
      cube.coordinateSystem = renderer.coordinateSystem;
      cube.updateCoordinateSystem();
    }
    const target = this.target;
    const size = target.width;
    const bound = renderer.getRenderTarget();
    const boundFace = renderer.getActiveCubeFace();
    const boundMip = renderer.getActiveMipmapLevel();
    const scissorTest = renderer.getScissorTest();
    const xr = renderer.xr.enabled;
    renderer.xr.enabled = false;
    renderer.setScissorTest(true);
    try {
      (cube.children as THREE.PerspectiveCamera[]).forEach((cam, face) => {
        const rect = faceScissor(cam, axis, size, _rect);
        if (!rect) return;
        target.scissor.copy(rect);
        renderer.setRenderTarget(target, face, 0);
        renderer.render(scene, cam);
      });
    } finally {
      target.scissor.set(0, 0, size, size);
      renderer.setScissorTest(scissorTest);
      renderer.xr.enabled = xr;
      renderer.setRenderTarget(bound, boundFace, boundMip);
    }
  }

  /** cube faces from `eye`, then the master at `size`² into hdr (linear) */
  private renderHdr(renderer: THREE.WebGPURenderer, scene: THREE.Scene, eye: THREE.Object3D, tiltDeg: number, size: number): void {
    eye.updateMatrixWorld();
    this.cubeCamera.position.setFromMatrixPosition(eye.matrixWorld);
    this.cubeCamera.updateMatrixWorld();
    this.uView.value.setFromMatrix4(eye.matrixWorld);
    this.uTilt.value = (tiltDeg * Math.PI) / 180;
    this.drawFaces(renderer, scene, _axis.fromArray(domeBasis(tiltDeg).axis).applyMatrix3(this.uView.value).normalize());
    const s = Math.max(16, Math.round(size));
    if (this.hdr.width !== s) {
      this.hdr.setSize(s, s);
      this.accum.setSize(s, s);
    }
    const bound = renderer.getRenderTarget();
    renderer.setRenderTarget(this.hdr);
    this.masterQuad.render(renderer);
    renderer.setRenderTarget(bound);
  }

  /** bloom, overlay, mask and tone map of hdr into the currently bound target */
  private presentHdr(renderer: THREE.WebGPURenderer, look: DomeLook): void {
    this.uExposure.value = look.exposure;
    this.uOverlayRadiance.value = look.overlayRadiance;
    this.glow.strength.value = look.bloomStrength;
    this.glow.radius.value = look.bloomRadius;
    this.glow.threshold.value = look.bloomThreshold;
    const tm = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping; // the present pass tone-maps itself (see header)
    try {
      this.presentQuad.render(renderer);
    } finally {
      renderer.toneMapping = tm;
    }
  }

  /**
   * Render the faces from `eye` (position + orientation; its −Z is the dome front, +Y the un-tilted
   * zenith), the master at `size`² px, then present it into the currently bound target.
   */
  render(renderer: THREE.WebGPURenderer, scene: THREE.Scene, eye: THREE.Object3D, tiltDeg: number, size: number, look: DomeLook): void {
    this.renderHdr(renderer, scene, eye, tiltDeg, size);
    this.presentHdr(renderer, look);
  }

  /**
   * MOTION BLUR, one sub-frame: render the master as `render` would and add it into the accumulator with
   * `weight` (the weights of one frame's sub-frames sum to 1). `first` clears the accumulator.
   */
  accumulate(renderer: THREE.WebGPURenderer, scene: THREE.Scene, eye: THREE.Object3D, tiltDeg: number, size: number, weight: number, first: boolean): void {
    this.renderHdr(renderer, scene, eye, tiltDeg, size);
    const bound = renderer.getRenderTarget();
    renderer.setRenderTarget(this.accum);
    if (first) {
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
    }
    this.uWeight.value = weight;
    this.accumQuad.render(renderer);
    renderer.setRenderTarget(bound);
  }

  /** present the accumulated sub-frames into the currently bound target */
  presentAccumulated(renderer: THREE.WebGPURenderer, look: DomeLook): void {
    const bound = renderer.getRenderTarget();
    renderer.setRenderTarget(this.hdr);
    this.resolveQuad.render(renderer);
    renderer.setRenderTarget(bound);
    this.presentHdr(renderer, look);
  }

  dispose(): void {
    this.target.dispose();
    this.hdr.dispose();
    this.accum.dispose();
    this.glow.dispose();
    for (const m of this.materials) m.dispose();
  }
}
