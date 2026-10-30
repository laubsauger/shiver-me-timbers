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
 * docs/drift/engine-findings.md), and the skipped part is mostly the sea, the most expensive surface. The review
 * view (`setFlat`) clips each face the same way by the four sides of its own frustum (widened by FLAT_MARGIN_DEG):
 * a 60° view reads a fraction of one or two faces, and drawing all six whole had made every review frame cost a
 * whole cube at the review's supersampling.
 *
 * EDGES ARE MULTISAMPLED (`samples`, default 4). Each face's colour pass rasterises with 4× MSAA: a geometric edge,
 * and an alpha-tested cut-out whose material sets `alphaToCoverage` (the foliage), covers a pixel a quarter at a
 * time instead of all or nothing; shading still runs once a pixel. Single-sampled, every edge on a face was a
 * one-sample decision, and the leaves, pebbles, the raft's poles and rope came out as speckle that changed every
 * frame (the user, 2026-10-29: "our sub-pixel rendering is horrendous … I'd much rather have stuff disappear than look
 * like this"). A cube target cannot be multisampled in three r186 (its clear pairs a 4-sample depth with a 1-sample
 * colour: docs/drift/engine-findings.md §11), so each face is drawn into ONE 2D multisampled target of the face's size,
 * shared by the six faces (a sixth of the memory of six), resolved at the end of its pass, and the resolved picture
 * copied whole into the face: the part outside the scissor is the clear, exactly as when a face was drawn straight
 * into the cube, so nothing of an earlier frame survives into the mips. What it buys, its cost and memory: `setSamples`.
 *
 * AMBIENT OCCLUSION, opt-in per scene (`setAmbientOcclusion`, the sea's acts): each face drawn is preceded by a
 * depth pre-pass from the same camera widened by a guard band, the occlusion marched and blurred in it, and the face
 * then shaded with that occlusion on its materials' indirect light (domeAo.ts says why there, and why seam-free).
 */
import * as THREE from 'three/webgpu';
import { cubeTexture, float, mix, step, texture, toneMapping, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { domeBasis, domeMasterDirectionNode } from './domeMaster';
import { DomeAo, type DomeAoLook } from './domeAo';

/**
 * px drawn past the dome's edge on each face: the master's lookups at the spring line read across it, from mip
 * levels up to ~3 near the face corners (16 px there is 2)
 */
const EDGE_PAD = 16;

/**
 * The faces are MIPMAPPED and the master reads them with the derivative's level. A master pixel covers up to
 * ~3 face texels across near a face's corners (a face spends its texels evenly in tan, the master evenly in
 * angle), and a single bilinear tap there skips texels: the sea's fine detail at the horizon came out as pixel
 * noise that changed every frame. With mips each master pixel averages the texels it covers; at the face
 * centres (level < 0) nothing changes.
 */
const FACES = { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter } as const;

/** the grade's knee (`grade`): the tone map's output (0..1, linear) above which its contrast power hands over to
 * the shoulder — 0.6 is AgX's for a scene radiance of ~1 (a white surface in full sun): the grade is unchanged below */
const GRADE_KNEE = 0.6;

/** the faces' cube target; its texture named for three's MRT, which the AO's colour pass binds (domeAo.ts colourMrt) */
function faceTarget(size: number): THREE.CubeRenderTarget {
  const target = new THREE.CubeRenderTarget(size, FACES);
  target.texture.name = 'output';
  return target;
}

/**
 * MSAA samples of the faces' colour pass (header: EDGES ARE MULTISAMPLED): 4, the only count above 1 a WebGPU render
 * attachment is guaranteed (2 fails allocation on Metal: core/postPipeline.ts msaaSamples), or 0 for none
 */
const FACE_SAMPLES = 4;

/**
 * deg the review view's frustum is widened by on every side for its faces' scissors (header): the water's refraction
 * looks the scene up beside its pixel, up to ~0.02 of a face (ocean/surfaceRefraction.ts: 0.06 × the facet's tilt),
 * ~2° at a face's centre, and a lookup past the scissor would read the clear
 */
const FLAT_MARGIN_DEG = 3;

const _axis = new THREE.Vector3();
const _p = new THREE.Vector3();
const _rects = Array.from({ length: 6 }, () => new THREE.Vector4());
const _rot = new THREE.Matrix3();
const _flatRot = new THREE.Matrix3();
const _flatPlanes = Array.from({ length: 4 }, () => new THREE.Vector3());
const _at = new THREE.Vector3();

/**
 * The part of face camera `cam` (of a cube `size` px a face) that sees directions on the kept side (d·n ≥ 0) of every
 * plane through the eye with normal `axes` (world: the dome's side of its spring line, or the review view's four
 * sides), as a scissor rectangle in the face's pixels (WebGPU: top-left origin) into `out`; null when the face sees
 * none of it.
 */
export function faceScissor(cam: THREE.PerspectiveCamera, axes: THREE.Vector3 | readonly THREE.Vector3[], size: number, out: THREE.Vector4): THREE.Vector4 | null {
  _rot.setFromMatrix4(cam.matrixWorld);
  // clip the face square by each plane in turn (Sutherland–Hodgman); d·n over the face is affine in NDC (points of
  // one depth lie on a plane, d unnormalised): three samples a plane
  let kept: Array<[number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (const axis of axes instanceof THREE.Vector3 ? [axes] : axes) {
    const f = (nx: number, ny: number): number => _p.set(nx, ny, 0.5).applyMatrix4(cam.projectionMatrixInverse).applyMatrix3(_rot).dot(axis);
    const f0 = f(0, 0);
    const fx = f(1, 0) - f0;
    const fy = f(0, 1) - f0;
    const value = ([x, y]: [number, number]): number => f0 + fx * x + fy * y;
    const polygon = kept;
    kept = [];
    polygon.forEach((a, i) => {
      const b = polygon[(i + 1) % polygon.length];
      const va = value(a);
      const vb = value(b);
      if (va >= 0) kept.push(a);
      if (va >= 0 !== vb >= 0) {
        const s = va / (va - vb);
        kept.push([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s]);
      }
    });
    if (kept.length < 3) return null;
  }
  const xs = kept.map((q) => q[0]);
  const ys = kept.map((q) => q[1]);
  const x0 = Math.max(0, Math.floor(((Math.min(...xs) + 1) / 2) * size) - EDGE_PAD);
  const x1 = Math.min(size, Math.ceil(((Math.max(...xs) + 1) / 2) * size) + EDGE_PAD);
  const y0 = Math.max(0, Math.floor(((1 - Math.max(...ys)) / 2) * size) - EDGE_PAD);
  const y1 = Math.min(size, Math.ceil(((1 - Math.min(...ys)) / 2) * size) + EDGE_PAD);
  if (x1 <= x0 || y1 <= y0) return null;
  return out.set(x0, y0, x1 - x0, y1 - y0);
}

/**
 * The review view's frustum (`setFlat`: `tan` of its half-angle, aimed by `aim` in the eye's frame, the eye turned by
 * `eye` in the world) widened by FLAT_MARGIN_DEG on every side, as four planes through the eye (world normals, kept
 * side d·n ≥ 0) for `faceScissor`; null when that is a hemisphere or wider (every face drawn whole).
 */
export function flatViewPlanes(eye: THREE.Matrix3, aim: THREE.Matrix3, tan: number): THREE.Vector3[] | null {
  const half = Math.atan(tan) + (FLAT_MARGIN_DEG * Math.PI) / 180;
  if (half >= Math.PI / 2 - 0.01) return null;
  const t = Math.tan(half);
  // in the view's frame (looking down −z) |x| ≤ t·(−z) and |y| ≤ t·(−z); to the world as the master's lookup turns
  // its ray (uView · uFlatAim · ray)
  _flatRot.multiplyMatrices(eye, aim);
  _flatPlanes[0].set(1, 0, -t);
  _flatPlanes[1].set(-1, 0, -t);
  _flatPlanes[2].set(0, 1, -t);
  _flatPlanes[3].set(0, -1, -t);
  for (const n of _flatPlanes) n.applyMatrix3(_flatRot);
  return _flatPlanes;
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
  /**
   * Optional layer drawn instead of `overlay` while the review view is on (`setFlat`): the same titles composed for
   * the flat frame (drift/flatTitles.ts), in the flat frame's own uv — the square view, v = 0 at its bottom. Only the
   * texture `overlay`'s lookup reads is swapped (`setFlat`): the shader is the same, and the dome's frames are
   * exactly what they were without it. Needs `overlay`.
   */
  flatOverlay?: THREE.Texture;
  /** baked into the shader; AgX keeps saturated emitters cleaner than ACES */
  toneMapping?: THREE.ToneMapping;
  /** MSAA samples of the faces' colour pass: 4 (the default) or 0 (`setSamples`) */
  samples?: number;
  /**
   * A grade after the tone map, set per frame (`setGrade`): saturation about the luminance, and contrast as a
   * power about mid grey (a camera's curve; AgX alone is flat) that rolls into a shoulder above GRADE_KNEE instead
   * of clipping. Absent, the present pass is exactly the tone map and `setGrade` does nothing.
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
  /** the cube target whose GPU texture exists, created with its mip chain (`drawFaces`) */
  private initialised: THREE.CubeRenderTarget | null = null;
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
  /** the review view (setFlat): 1 on, tan of its half-angle, and its aim in the eye's frame */
  private readonly uFlat = uniform(0);
  private readonly uFlatTan = uniform(1);
  private readonly uFlatAim = uniform(new THREE.Matrix3());
  /** the occlusion's passes (built on first use) and the look the faces drawn next take it with (null: none) */
  private ao: DomeAo | null = null;
  private aoLook: DomeAoLook | null = null;
  /** MSAA samples of the faces' colour pass (0: drawn straight into the cube), and the multisampled target (built on
   * first use, at the faces' size) */
  private samples: number;
  private msaa: THREE.RenderTarget | null = null;
  /** the overlay's lookup, and the two layers it reads (the master's, and the flat view's: `flatOverlay`) */
  private overlayNode: ReturnType<typeof texture> | null = null;
  private readonly overlays: { dome: THREE.Texture | null; flat: THREE.Texture | null };

  constructor(opts: DomeCaptureOptions) {
    this.overlays = { dome: opts.overlay ?? null, flat: opts.flatOverlay ?? null };
    this.samples = (opts.samples ?? FACE_SAMPLES) > 1 ? FACE_SAMPLES : 0;
    this.target = faceTarget(opts.faceSize);
    this.cubeCamera = new THREE.CubeCamera(opts.near ?? 0.05, opts.far ?? 1e6, this.target);
    this.hdr = new THREE.RenderTarget(1024, 1024, { type: THREE.HalfFloatType, depthBuffer: false });
    this.accum = new THREE.RenderTarget(1024, 1024, { type: THREE.FloatType, depthBuffer: false });

    // the full-screen quad's uv has v = 0 at the TOP of the target under WebGPU; the master's convention is
    // v = 0 at the bottom (front). Flip, or the master is mirrored front-to-back (caught by drift ?markers).
    const masterUV = vec2(uv().x, uv().y.oneMinus());
    const dome = domeMasterDirectionNode(masterUV, this.uTilt);
    // THE REVIEW VIEW (setFlat): a rectilinear (pinhole) view instead of the fisheye — the same faces, occlusion,
    // bloom and grade, only resampled as a normal camera would see them, so a detail can be judged without
    // un-warping the dome in one's head (the user, 2026-10-29). Square, as the master is: crop it to 16:9.
    const flatRay = vec3(masterUV.x.mul(2).sub(1).mul(this.uFlatTan), masterUV.y.mul(2).sub(1).mul(this.uFlatTan), -1);
    const flatDir = this.uFlatAim.mul(flatRay).normalize();
    const dir = mix(dome.dir, flatDir, this.uFlat);
    const inside = mix(dome.inside, float(1), this.uFlat);

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
      this.overlayNode = layer;
      lit = mix(lit, layer.rgb.mul(this.uOverlayRadiance), layer.a);
    }
    const present = this.material('dome-present');
    const mapped = toneMapping(opts.toneMapping ?? THREE.AgXToneMapping, this.uExposure, lit.mul(inside)).rgb;
    let graded = mapped;
    if (opts.grade) {
      const luma = mapped.dot(vec3(0.2126, 0.7152, 0.0722));
      const saturated = mix(vec3(luma), mapped, this.uSaturation).max(0).min(1);
      // THE SHOULDER (the 2026-10-29 review: cloudlets near the Sun "flat 255 blobs", the sky round it a clipped
      // dome with a hard ring at its edge). The power about mid grey, cut at 1, reached white at AgX's 0.83 — a
      // scene radiance of ~3.2 — and threw away the 2.3 stops AgX keeps above it (to ~16): the sky within a few
      // degrees of a low Sun (2–4) and every thin cloud lit through by it (3–14, measured at 604 and 665 s) went flat
      // white, the red first, ending in an edge. Now the power holds up to GRADE_KNEE, as before, and above it a
      // curve reaches 1 only at AgX's own 1, with the same value and slope at the knee: everything under a scene
      // radiance of ~1 is unchanged, a white of 2 goes 241 → 238 in 8-bit sRGB, of 3 253 → 246, of 4 255 → 249, and
      // nothing clips short of AgX's white
      const toe = saturated.div(0.18).pow(vec3(this.uContrast)).mul(0.18);
      const kneeY = float(GRADE_KNEE / 0.18).pow(this.uContrast).mul(0.18);
      const bend = this.uContrast.mul(kneeY).div(GRADE_KNEE).mul(1 - GRADE_KNEE).div(kneeY.oneMinus());
      const shoulder = vec3(1).sub(vec3(1).sub(saturated).div(1 - GRADE_KNEE).pow(vec3(bend)).mul(kneeY.oneMinus()));
      graded = mix(toe, shoulder, step(vec3(GRADE_KNEE), saturated));
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
   * The REVIEW VIEW: render a rectilinear view instead of the dome master (null: back to the dome). `fov` is the
   * square frame's full angle (deg; its 16:9 crop keeps it across), `yaw` (deg, + left) and `pitch` (deg, + up)
   * aim it from the eye's front. For detail stills and clips to review, and the show's 16:9 cut (aimed per frame by
   * drift/flatFraming.ts, its titles from `flatOverlay`).
   */
  setFlat(view: { fov: number; yaw?: number; pitch?: number } | null): void {
    this.uFlat.value = view ? 1 : 0;
    // the titles: the flat frame's own layer while it is on (`flatOverlay`), the master's otherwise
    const layer = view && this.overlays.flat ? this.overlays.flat : this.overlays.dome;
    if (this.overlayNode && layer && this.overlayNode.value !== layer) this.overlayNode.value = layer;
    if (!view) return;
    this.uFlatTan.value = Math.tan((view.fov * Math.PI) / 360);
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(((view.pitch ?? 0) * Math.PI) / 180, ((view.yaw ?? 0) * Math.PI) / 180, 0, 'YXZ'));
    this.uFlatAim.value.setFromMatrix4(m);
  }

  /** whether the review view is on (`setFlat`) */
  get flat(): boolean {
    return this.uFlat.value > 0;
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

  /**
   * Ambient occlusion for the faces drawn from now on (domeAo.ts), or none (null, or a strength of 0: the faces
   * are drawn exactly as without it). Per scene: set it before each scene's `render` / `accumulate`.
   */
  setAmbientOcclusion(look: DomeAoLook | null): void {
    this.aoLook = look && look.strength > 0 ? look : null;
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
    // (and the multisampled target, rebuilt at the new size on the next frame: never both sizes held at once)
    this.msaa?.dispose();
    this.msaa = null;
    this.target = faceTarget(size);
    // @types/three types CubeCamera.renderTarget as the WebGL cube target; the WebGPU one is what it renders into
    (this.cubeCamera as unknown as { renderTarget: THREE.CubeRenderTarget }).renderTarget = this.target;
    this.cubeNode.value = this.target.texture;
  }

  /**
   * MSAA samples of the faces' colour pass from the next frame on (header: EDGES ARE MULTISAMPLED): 4, or 0 for none
   * — the faces drawn straight into the cube as before, and the multisampled target's memory freed. For A/B reviews,
   * and for a master whose faces leave no room for it.
   *
   * WHAT IT BUYS (2026-10-29, 16:9 review views, mean |f[n+1] − 2f[n] + f[n−1]| of luma over the region, 30 fps):
   * the forest edge at 604 s 14.0 → 9.3 with matched faces, as much as 2× supersampled faces without it (9.0), and
   * 6.8 with both; the beach's tree line at 630 s 3.7 → 2.8 (2.0 with 2× faces). It does nothing for shading
   * aliasing — a texture's or a highlight's own detail — which only supersampling (record.ts `supersample`) reaches.
   *
   * COST, a face texel: the cube 64 B (six faces of half-float RGBA, 4/3 for the mips) without it; with it the target
   * adds 4 × 8 B of colour, 4 × 4 of depth and 8 resolved, and the water's framebuffer copies of it (its refraction:
   * 8 colour, 4 × 4 depth) 24 more — 80 B, so 144 B in all, 2.2× the memory. Measured (the page's GPU process, peak,
   * ±1 GB; ~11 GB of it is the page before any master): 8192² at 6768 px faces 22.5 GB without, 26.6 GB with — at
   * 9024 px (the 8K master at 2× supersampling) 27.6 GB without, ~34 GB with by the sum above, past what a 36 GB
   * machine holds. Time: about nothing at 2048² (0.73 → 0.70 s a frame at the forest edge), +20–70 % at 4096²
   * (0.76 → 0.91 s, 0.65 → 1.13 s at the raft); record.ts says which supersampling to pair it with.
   */
  setSamples(samples: number): void {
    this.samples = samples > 1 ? FACE_SAMPLES : 0;
    if (this.samples === 0) {
      this.msaa?.dispose();
      this.msaa = null;
    }
  }

  /**
   * The faces' multisampled target at `size` px: half-float as the faces, with its own depth; its texture named for
   * three's MRT, which the AO's colour pass binds (domeAo.ts colourMrt)
   */
  private faceMsaa(size: number): THREE.RenderTarget {
    if (this.msaa && this.msaa.width === size && this.msaa.samples === this.samples) return this.msaa;
    this.msaa?.dispose();
    this.msaa = new THREE.RenderTarget(size, size, { type: THREE.HalfFloatType, samples: this.samples });
    this.msaa.texture.name = 'output';
    return this.msaa;
  }

  /**
   * The cube camera's six faces, each only where the master reads it (header: ONLY THE HEMISPHERE IS DRAWN):
   * `CubeCamera.update` with a scissor per face, and the faces that see none of the dome's hemisphere (`axis`,
   * world) — or of the review view — skipped. Multisampled, each face is drawn into `msaa` and copied into the cube
   * (header: EDGES ARE MULTISAMPLED).
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
    // the mip chain is built after a render into the target: once, after the last face drawn (as CubeCamera
    // does). But three sizes the GPU texture's mip chain when it first creates it, from `generateMipmaps` at that
    // moment — switched off for the first face, it got ONE level and the faces were never filtered (CubeCamera
    // has the same fault, mirror.ts). So the target is created before the switching starts.
    if (this.initialised !== target) {
      renderer.initRenderTarget(target);
      this.initialised = target;
    }
    const cams = cube.children as THREE.PerspectiveCamera[];
    // (the review view may look anywhere, below the dome's spring line too: each face where the view's frustum is)
    const planes = this.uFlat.value > 0 ? flatViewPlanes(this.uView.value, this.uFlatAim.value, this.uFlatTan.value) : axis;
    const rects = cams.map((cam, face) => (planes ? faceScissor(cam, planes, size, _rects[face]) : _rects[face].set(0, 0, size, size)));
    const last = rects.reduce((at: number, r, face) => (r ? face : at), -1);
    const mips = target.texture.generateMipmaps;
    const msaa = this.samples > 1 ? this.faceMsaa(size) : null;
    const ao = this.aoLook ? (this.ao ??= new DomeAo()) : null;
    if (ao && this.aoLook) {
      ao.setFaceSize(size);
      ao.setLook(this.aoLook);
    }
    const context = renderer.contextNode;
    const boundMrt = renderer.getMRT();
    try {
      cams.forEach((cam, face) => {
        const rect = rects[face];
        if (!rect) return;
        // the face's occlusion first (its own targets), then the face shaded with it: straight into the cube's face,
        // or into the multisampled target and its resolved picture copied in
        if (ao) ao.draw(renderer, scene, cam, rect);
        const into = msaa ?? target;
        into.scissor.copy(rect);
        // (the mips are built after the last face: by its render drawn straight in, by its copy multisampled)
        target.texture.generateMipmaps = mips && face === last;
        renderer.setRenderTarget(into, msaa ? 0 : face, 0);
        if (ao) {
          renderer.contextNode = ao.contextFor(context);
          renderer.setMRT(ao.colourMrt);
        }
        try {
          renderer.render(scene, cam);
        } finally {
          renderer.contextNode = context;
          renderer.setMRT(boundMrt);
        }
        if (msaa) renderer.copyTextureToTexture(msaa.texture, target.texture, null, _at.set(0, 0, face));
      });
    } finally {
      target.texture.generateMipmaps = mips;
      target.scissor.set(0, 0, size, size);
      msaa?.scissor.set(0, 0, size, size);
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
    this.ao?.dispose();
    this.msaa?.dispose();
    this.target.dispose();
    this.hdr.dispose();
    this.accum.dispose();
    this.glow.dispose();
    for (const m of this.materials) m.dispose();
  }
}
