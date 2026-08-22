/**
 * OCTAHEDRAL IMPOSTORS FOR THE PLANT BATCHES (§T.112g, §V94, §V17, research
 * §2.4 "impostors and culling").
 *
 * THE DEFECT THIS CLOSES. A Jeffrey pine out of `pineGeometry.ts` is ~1-1.5 k
 * triangles and there are ~1550 live plants on the largest dome. Past a few
 * hundred metres each one is a smear 20-90 px tall and every one of those
 * triangles is sub-pixel — the definition of geometry the screen cannot
 * resolve (the same law §V79 measured on the ocean's radial rings). Today the
 * only answer is `palmLodCount`, which RAMPS THE COUNT TO ZERO: the trees do
 * not get cheaper, they get DELETED, and a stand thinning out as you sail away
 * is the pop this task is named after.
 *
 * WHAT AN OCTAHEDRAL IMPOSTOR IS. Render the plant once per view direction
 * into a tile of an atlas, the directions laid out by mapping the hemisphere
 * onto a square (hemi-octahedral: the four horizon bearings land on the four
 * corners, straight-down-the-zenith in the middle). At runtime draw ONE quad
 * per plant, look up which four tiles bracket the current view direction, and
 * blend them. Cost per plant goes from ~1200 triangles to 2.
 *
 * WHY THE BAKE IS AT RUNTIME AND NOT AN ASSET. Every plant in this world is
 * generated from a seed (`buildPineGeometry(seed, …)`), so there is no image
 * to ship and no rule against images to break — the atlas is a render target
 * filled at load from the same geometry the near LOD draws. That also means
 * the impostor cannot drift from the mesh: they are the same vertices.
 *
 * TWO TARGETS, AND BOTH ARE REQUIRED BY WHAT T112e BUILT.
 *  - ALBEDO + COVERAGE. Captured UNLIT (a `MeshBasicNodeMaterial` fed the
 *    conifer material's own albedo node), because an impostor with the sun
 *    baked in is a plant that does not turn when the day does.
 *  - WORLD NORMAL + LEAF MASK. `applyClusterNormals` BAKES the canopy-sphere
 *    normals into the geometry's `normal` attribute — that is the whole reason
 *    a tier reads as a soft mass instead of a folded card — so capturing
 *    `normalWorld` captures the cluster normals for free, and the impostor can
 *    run the SAME `foliageEmissive` wrap + back-transmission the mesh runs, on
 *    the same leaf mask, off `emissiveNode`. Skip this target and every
 *    distant tree loses its backlight in a Sierra evening, which is the one
 *    lighting cue T112e exists for.
 *
 * WHAT IS PURE HERE AND WHAT NEEDS A GPU. The octahedral mapping, the atlas
 * layout, the quad sizing, the silhouette rasteriser and the cross-fade ramp
 * are pure functions over numbers and geometry arrays — tests pin all of them
 * headlessly (§V88). `bakeImpostorAtlas` and `createImpostorMaterial` need a
 * renderer and are UNVERIFIED until the R3 lookdev pass; nothing constructs
 * them unless a caller passes a renderer, so an island built without one
 * behaves exactly as it did before this file existed.
 */
import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  float,
  normalWorld,
  positionWorld,
  screenCoordinate,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { sierraParams, type SierraParams } from '../params/sierra';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyNode = any;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// ── the octahedral mapping ────────────────────────────────────────────────

/**
 * Upper-hemisphere direction → atlas coordinates in [0,1]².
 *
 * HEMI-octahedral, not full: nothing in this world is ever seen from below a
 * tree, so folding only the top half onto the square doubles the angular
 * resolution for the same number of tiles. The four horizon bearings land on
 * the four CORNERS and the zenith in the centre, so the views that matter most
 * (a tree seen from a walking eye, or from the deck of a raft) are the ones the
 * grid samples exactly rather than by interpolation.
 *
 * y is up, matching the world. Directions below the horizon are folded to it —
 * a conservative clamp rather than a NaN.
 */
export function hemiOctEncode(x: number, y: number, z: number): [number, number] {
  const l1 = Math.abs(x) + Math.abs(Math.max(y, 0)) + Math.abs(z);
  const inv = 1 / Math.max(l1, 1e-9); // §V28
  const px = x * inv;
  const pz = z * inv;
  return [(px + pz) * 0.5 + 0.5, (pz - px) * 0.5 + 0.5];
}

/** atlas coordinates → the unit direction they stand for (exact inverse) */
export function hemiOctDecode(u: number, v: number): [number, number, number] {
  const a = u * 2 - 1;
  const b = v * 2 - 1;
  const px = (a - b) * 0.5;
  const pz = (a + b) * 0.5;
  const py = 1 - Math.abs(px) - Math.abs(pz);
  const len = Math.max(Math.hypot(px, py, pz), 1e-9); // §V28
  return [px / len, py / len, pz / len];
}

/**
 * View direction for the tile at (col, row) of a `frames × frames` atlas.
 *
 * Frames sit on the grid's VERTICES (`col / (frames − 1)`), not at cell
 * centres. That is what puts a captured frame on each of the four horizon
 * bearings; with cell centres the horizontal view — the only one a walking
 * player ever has — would always be an interpolation of two oblique ones.
 */
export function impostorFrameDirection(
  col: number,
  row: number,
  frames: number,
): [number, number, number] {
  const n = Math.max(2, Math.floor(frames));
  return hemiOctDecode(col / (n - 1), row / (n - 1));
}

export interface ImpostorFrameBlend {
  /** lower-left tile of the four that bracket the direction */
  col: number;
  row: number;
  /** bilinear weights across that 2×2 patch */
  fu: number;
  fv: number;
}

/** which four tiles bracket a view direction, and by how much */
export function impostorFrameBlend(
  x: number,
  y: number,
  z: number,
  frames: number,
): ImpostorFrameBlend {
  const n = Math.max(2, Math.floor(frames));
  const [u, v] = hemiOctEncode(x, y, z);
  const gu = clamp01(u) * (n - 1);
  const gv = clamp01(v) * (n - 1);
  const col = Math.min(Math.floor(gu), n - 2);
  const row = Math.min(Math.floor(gv), n - 2);
  return { col, row, fu: gu - col, fv: gv - row };
}

// ── quad sizing and the silhouette ────────────────────────────────────────

export interface ImpostorBounds {
  /** height above the instance origin the quad is centred at (m) */
  centerY: number;
  /** quad half-width, in the geometry's own units */
  radius: number;
}

/**
 * Where to centre the impostor quad and how big to make it.
 *
 * THE PIVOT IS NOT THE INSTANCE ORIGIN. A plant's origin is its FOOT — that is
 * what the placement puts on the ground — so a quad centred there has to be a
 * full tree-height in half-width and the tree lives in the top half of it:
 * three quarters of every tile is empty, and the tile resolution the swap
 * distance needs quadruples for nothing. Centring on the mid-height of the
 * geometry and taking the radius about THAT is tight, and it stays correct
 * under the per-instance yaw because the offset is along world up, which yaw
 * does not touch.
 *
 * The radius is a MAXIMUM over vertices, not a bounding-sphere fit: the quad
 * has to contain the silhouette from EVERY direction in the atlas, and a bake
 * that clips the top of a tree off is a silhouette that does not match the
 * mesh — which is the pop, exactly.
 */
export function impostorBounds(geometry: THREE.BufferGeometry): ImpostorBounds {
  const pos = geometry.getAttribute('position');
  if (!pos) return { centerY: 0, radius: 0 };
  const a = pos.array as ArrayLike<number>;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const y = a[i * 3 + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const centerY = (minY + maxY) / 2;
  let radius = 0;
  for (let i = 0; i < pos.count; i++) {
    const d = Math.hypot(a[i * 3], a[i * 3 + 1] - centerY, a[i * 3 + 2]);
    if (d > radius) radius = d;
  }
  return { centerY, radius };
}

/** quad half-width alone — see `impostorBounds` */
export function impostorRadius(geometry: THREE.BufferGeometry): number {
  return impostorBounds(geometry).radius;
}

/**
 * Fraction of a `res × res` orthographic frame the geometry covers, seen along
 * `dir`, over a square of half-width `radius` centred on the pivot.
 *
 * This is the CPU twin of what the bake writes into a tile's alpha channel:
 * the same projection, the same extent, the same resolution. So a test can ask
 * the question that decides whether the swap is visible — does the silhouette
 * the impostor can represent still match the silhouette the mesh draws at the
 * distance where they trade places — without a GPU (§V88).
 */
export function silhouetteCoverage(
  geometry: THREE.BufferGeometry,
  dir: [number, number, number],
  radius: number,
  res: number,
  centerY = 0,
): number {
  const pos = geometry.getAttribute('position');
  const index = geometry.getIndex();
  if (!pos || !index) return 0;
  const p = pos.array as ArrayLike<number>;
  const idx = index.array as ArrayLike<number>;
  const n = res | 0;
  const grid = new Uint8Array(n * n);
  // orthonormal frame about the view direction; the world up degenerates when
  // looking straight down, so fall back to +z there
  const len = Math.max(Math.hypot(dir[0], dir[1], dir[2]), 1e-9); // §V28
  const f: [number, number, number] = [dir[0] / len, dir[1] / len, dir[2] / len];
  const upRef: [number, number, number] = Math.abs(f[1]) > 0.999 ? [0, 0, 1] : [0, 1, 0];
  const rx = upRef[1] * f[2] - upRef[2] * f[1];
  const ry = upRef[2] * f[0] - upRef[0] * f[2];
  const rz = upRef[0] * f[1] - upRef[1] * f[0];
  const rl = Math.max(Math.hypot(rx, ry, rz), 1e-9); // §V28
  const right: [number, number, number] = [rx / rl, ry / rl, rz / rl];
  const up: [number, number, number] = [
    f[1] * right[2] - f[2] * right[1],
    f[2] * right[0] - f[0] * right[2],
    f[0] * right[1] - f[1] * right[0],
  ];
  const half = Math.max(radius, 1e-6); // §V28
  const project = (i: number): [number, number] => {
    const x = p[i * 3];
    const y = p[i * 3 + 1] - centerY;
    const z = p[i * 3 + 2];
    const u = (x * right[0] + y * right[1] + z * right[2]) / half;
    const v = (x * up[0] + y * up[1] + z * up[2]) / half;
    return [(u * 0.5 + 0.5) * n, (v * 0.5 + 0.5) * n];
  };
  for (let t = 0; t < idx.length; t += 3) {
    const a = project(idx[t]);
    const b = project(idx[t + 1]);
    const c = project(idx[t + 2]);
    const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
    const maxX = Math.min(n - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
    const maxY = Math.min(n - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    if (Math.abs(area) < 1e-12) continue;
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const sx = px + 0.5;
        const sy = py + 0.5;
        const w0 = ((b[0] - a[0]) * (sy - a[1]) - (sx - a[0]) * (b[1] - a[1])) / area;
        const w1 = ((sx - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (sy - a[1])) / area;
        if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue;
        grid[py * n + px] = 1;
      }
    }
  }
  let hits = 0;
  for (let i = 0; i < grid.length; i++) hits += grid[i];
  return hits / (n * n);
}

/**
 * Screen height in pixels of an object of world height `h` at `distance`,
 * for a camera of vertical fov `fovDeg` on a `screenHeight`-pixel viewport.
 * Used to justify the tile resolution against the swap distance rather than
 * picking a round number.
 */
export function screenPixels(
  worldHeight: number,
  distance: number,
  fovDeg: number,
  screenHeight: number,
): number {
  const half = Math.tan((fovDeg * Math.PI) / 360);
  return (worldHeight / Math.max(distance, 1e-3)) * (screenHeight / (2 * half)); // §V28
}

// ── the cross-fade ────────────────────────────────────────────────────────

export interface ImpostorFade {
  /** weight of the full mesh, 1 near */
  mesh: number;
  /** weight of the impostor, 1 far */
  impostor: number;
}

/**
 * Cross-fade weights at a camera distance. MONOTONE and COMPLETE by
 * construction: mesh falls 1 → 0 across the band, impostor rises 0 → 1, and
 * they sum to exactly 1 everywhere — so at no distance is the plant partly
 * missing, which is what a naive "swap when closer than X" does for one frame
 * and what the eye reads as a pop.
 *
 * Smoothstepped rather than linear: a linear cross-fade has a slope
 * discontinuity at both ends, and a discontinuity in the DERIVATIVE of a
 * brightness ramp is visible as a crease under motion even when the value is
 * continuous (the same lesson §V.48b records for a fade-to-own-mean).
 */
export function impostorFade(distance: number, p: SierraParams = sierraParams): ImpostorFade {
  const start = p.impostorDistance;
  const band = Math.max(p.impostorFadeBand, 1e-3); // §V28
  const t = clamp01((distance - start) / band);
  const s = t * t * (3 - 2 * t);
  return { mesh: 1 - s, impostor: s };
}

// ── atlas layout + cost ───────────────────────────────────────────────────

export interface ImpostorAtlasLayout {
  frames: number;
  tile: number;
  /** atlas side in texels */
  size: number;
  /** render targets: albedo+coverage and normal+leaf mask */
  targets: number;
  bytes: number;
}

/**
 * Atlas geometry and its standing VRAM. RGBA8 × two targets, no mips (§V48 is
 * satisfied by the tile being MAGNIFIED at every distance the impostor is used
 * — the quad is drawn larger on screen than the tile is, by construction of
 * `impostorDistance`; a minified atlas would need the chain).
 */
export function impostorAtlasLayout(
  frames: number,
  tile: number,
  targets = 2,
): ImpostorAtlasLayout {
  const f = Math.max(2, Math.floor(frames));
  const t = Math.max(1, Math.floor(tile));
  const size = f * t;
  return { frames: f, tile: t, size, targets, bytes: size * size * 4 * targets };
}

// ── the bake (needs a renderer) ───────────────────────────────────────────

export interface BakeImpostorOptions {
  renderer: THREE.WebGPURenderer;
  geometry: THREE.BufferGeometry;
  /** unlit albedo for this species (createPineMaterial exposes its own) */
  albedoNode: AnyNode;
  /** 1 on leaf roles, 0 on wood — drives wrap + transmission at runtime */
  leafMaskNode: AnyNode;
  frames?: number;
  tile?: number;
}

export interface ImpostorAtlas {
  albedo: THREE.Texture;
  normal: THREE.Texture;
  layout: ImpostorAtlasLayout;
  /** quad half-size and its height above the instance origin */
  bounds: ImpostorBounds;
  /** wall-clock of the bake (ms) */
  bakeMs: number;
  dispose(): void;
}

/**
 * Render the plant once per atlas tile into two targets.
 *
 * ORTHOGRAPHIC, at exactly the quad's half-width, so the tile's extent and the
 * runtime quad's extent are the same number and the silhouette lands where the
 * mesh's did. Scissor + viewport per tile rather than one camera per atlas:
 * one target, `frames²` small draws, no per-tile allocation.
 *
 * UNVERIFIED ON A GPU (§V88 — no browser this phase). The maths it depends on
 * is pinned in tests/vegetationLod.test.ts; the render-target plumbing is not.
 */
export async function bakeImpostorAtlas(opts: BakeImpostorOptions): Promise<ImpostorAtlas> {
  const t0 = performance.now();
  const layout = impostorAtlasLayout(
    opts.frames ?? sierraParams.impostorFrames,
    opts.tile ?? sierraParams.impostorTile,
  );
  const bounds = impostorBounds(opts.geometry);
  const radius = bounds.radius;
  const make = (): THREE.RenderTarget => {
    const rt = new THREE.RenderTarget(layout.size, layout.size, {
      depthBuffer: true,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    return rt;
  };
  const albedoRT = make();
  const normalRT = make();

  const albedoMat = new THREE.MeshBasicNodeMaterial();
  albedoMat.colorNode = opts.albedoNode;
  albedoMat.transparent = false;
  const normalMat = new THREE.MeshBasicNodeMaterial();
  // World normal into [0,1]; the leaf mask rides the alpha channel so the
  // runtime can tell needle from bark without a second lookup. `normalWorld`
  // here IS the cluster normal — `applyClusterNormals` wrote it into the
  // geometry's own `normal` attribute at build (foliage.ts).
  normalMat.colorNode = vec4(normalWorld.mul(0.5).add(0.5), opts.leafMaskNode);
  normalMat.transparent = false;

  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(opts.geometry, albedoMat);
  scene.add(mesh);
  const camera = new THREE.OrthographicCamera(
    -radius,
    radius,
    radius,
    -radius,
    0.01,
    radius * 4 + 1,
  );
  const prevTarget = opts.renderer.getRenderTarget();
  const prevAutoClear = opts.renderer.autoClear;
  const prevScissor = opts.renderer.getScissorTest();
  opts.renderer.autoClear = false;

  const renderInto = async (
    rt: THREE.RenderTarget,
    material: THREE.MeshBasicNodeMaterial,
  ): Promise<void> => {
    mesh.material = material;
    opts.renderer.setRenderTarget(rt);
    opts.renderer.setScissorTest(false);
    opts.renderer.clear();
    opts.renderer.setScissorTest(true);
    for (let row = 0; row < layout.frames; row++) {
      for (let col = 0; col < layout.frames; col++) {
        const dir = impostorFrameDirection(col, row, layout.frames);
        camera.position
          .set(dir[0], dir[1], dir[2])
          .multiplyScalar(radius * 2)
          .setY(camera.position.y + bounds.centerY);
        camera.up.set(0, 1, 0);
        if (Math.abs(dir[1]) > 0.999) camera.up.set(0, 0, 1);
        camera.lookAt(0, bounds.centerY, 0);
        camera.updateMatrixWorld();
        const x = col * layout.tile;
        const y = row * layout.tile;
        opts.renderer.setViewport(x, y, layout.tile, layout.tile);
        opts.renderer.setScissor(x, y, layout.tile, layout.tile);
        await opts.renderer.renderAsync(scene, camera);
      }
    }
  };

  await renderInto(albedoRT, albedoMat);
  await renderInto(normalRT, normalMat);

  opts.renderer.setScissorTest(prevScissor);
  opts.renderer.setRenderTarget(prevTarget);
  opts.renderer.autoClear = prevAutoClear;
  opts.renderer.setViewport(0, 0, 1, 1);
  albedoMat.dispose();
  normalMat.dispose();

  return {
    albedo: albedoRT.texture,
    normal: normalRT.texture,
    layout,
    bounds,
    bakeMs: performance.now() - t0,
    dispose(): void {
      albedoRT.dispose();
      normalRT.dispose();
    },
  };
}

// ── the runtime quad ──────────────────────────────────────────────────────

/**
 * The impostor quad geometry: four vertices ALL AT THE LOCAL ORIGIN, with the
 * corner offset carried in `uv`.
 *
 * That is the trick that makes the billboard work under instancing without
 * reaching for the instance matrix in the shader. `positionLocal` is zero, so
 * after `InstancedMesh`'s own transform `positionWorld` is exactly the plant's
 * world position; the quad is then extruded in the shader along camera right
 * and up, which arrive as uniforms the handle refreshes per frame. No matrix
 * element access, no assumption about the order in which three applies the
 * instance node.
 */
export function buildImpostorQuad(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
  g.setAttribute(
    'uv',
    new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2),
  );
  g.setIndex([0, 1, 2, 0, 2, 3]);
  // the shader places every vertex; a zero-extent bound would be culled at
  // once, so the sphere is opened to the largest plant the atlas holds
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1);
  return g;
}

export interface ImpostorMaterialHandle {
  material: THREE.MeshStandardNodeMaterial;
  /** per frame: camera basis for the billboard + the fade the cell sits at */
  update(camera: THREE.Camera, fade: number): void;
  dispose(): void;
}

/**
 * The impostor's own material: a camera-facing quad sampling the four atlas
 * tiles that bracket the view direction.
 *
 * THE CROSS-FADE IS DITHERED, NOT BLENDED. Two alpha-blended copies of the
 * same plant at 0.5 each do not add up to the plant — they add up to a ghost,
 * and they need a sort. A per-pixel threshold against the fade weight gives a
 * coverage that is exactly the weight, in one opaque draw, with no sorting and
 * no double-count. @band-limited-elsewhere §V.48: the hash is a DITHER over
 * screen coordinates, deliberately per-pixel, not a spatial field being
 * minified — its whole job is to be white noise at the sample grid.
 *
 * KNOWN LIMITATION, stated rather than hidden: the four tiles are blended
 * without per-frame parallax reprojection, so between two captured directions
 * the silhouette swims by up to `radius · sin(½ frame step)`. At the shipped
 * 8 frames that is ~0.2 of the quad at the worst bearing and ~0 at the four
 * horizon frames, which are the ones a walking camera actually uses. Closing
 * it needs a depth channel in the atlas and a ray-plane intersection per tile.
 */
export function createImpostorMaterial(
  atlas: ImpostorAtlas,
  p: SierraParams = sierraParams,
): ImpostorMaterialHandle {
  const material = new THREE.MeshStandardNodeMaterial();
  material.roughness = 1;
  material.metalness = 0;
  const uRight = uniform(new THREE.Vector3(1, 0, 0));
  const uUp = uniform(new THREE.Vector3(0, 1, 0));
  const uFade = uniform(1);
  const uFrames = uniform(atlas.layout.frames);
  const uRadius = uniform(atlas.bounds.radius);
  const uCenterY = uniform(atlas.bounds.centerY);
  const albedoTex = texture(atlas.albedo);
  const normalTex = texture(atlas.normal);

  // billboard: the quad's corner, in world space, added to the plant's origin
  const corner = uv().sub(0.5).mul(2);
  const size = uRadius;
  const world = positionWorld
    .add(vec3(0, uCenterY, 0))
    .add(uRight.mul(corner.x.mul(size)).add(uUp.mul(corner.y.mul(size))));
  material.vertexNode = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(world, 1)));

  // Which tiles bracket the view: the direction from THIS PLANT to the camera,
  // hemi-octahedrally encoded — the exact arithmetic of `hemiOctEncode`.
  // Per-plant, not per-camera: two trees 60 m apart are seen from measurably
  // different bearings, and a single camera-forward direction would give the
  // whole stand one frame and turn the parallax between them off.
  const toCam = cameraPosition.sub(positionWorld).normalize();
  const l1 = toCam.x.abs().add(toCam.y.max(0)).add(toCam.z.abs()).max(1e-9); // §V28
  const px = toCam.x.div(l1);
  const pz = toCam.z.div(l1);
  const octU = px.add(pz).mul(0.5).add(0.5).clamp(0, 1);
  const octV = pz.sub(px).mul(0.5).add(0.5).clamp(0, 1);
  const n1 = uFrames.sub(1);
  const gu = octU.mul(n1);
  const gv = octV.mul(n1);
  const c0 = gu.floor().min(n1.sub(1));
  const r0 = gv.floor().min(n1.sub(1));
  const fu = gu.sub(c0);
  const fv = gv.sub(r0);
  const tileUv = uv().div(uFrames);
  const sampleAt = (tex: AnyNode, dc: number, dr: number): AnyNode =>
    tex.sample(tileUv.add(vec2(c0.add(dc), r0.add(dr)).div(uFrames)));
  const blend = (tex: AnyNode): AnyNode =>
    sampleAt(tex, 0, 0)
      .mul(fu.oneMinus().mul(fv.oneMinus()))
      .add(sampleAt(tex, 1, 0).mul(fu.mul(fv.oneMinus())))
      .add(sampleAt(tex, 0, 1).mul(fu.oneMinus().mul(fv)))
      .add(sampleAt(tex, 1, 1).mul(fu.mul(fv)));

  const albedo = blend(albedoTex);
  const captured = blend(normalTex);
  material.colorNode = albedo.xyz;
  material.normalNode = captured.xyz.mul(2).sub(1).normalize();

  // Dithered coverage: survive iff the fade weight beats this pixel's own
  // threshold.
  //
  // @band-limited-elsewhere §V.48: this is the ONE case the invariant does not
  // govern. §V.48 is about a spatial field going sub-pixel and aliasing into
  // per-pixel speckle; here per-pixel decorrelation IS THE OUTPUT. The hash is
  // in SCREEN coordinates, so its period is exactly one pixel at every
  // distance — it cannot minify, there is no footprint to widen, and filtering
  // it would turn a stochastic coverage of exactly `uFade` into a uniform
  // half-transparent ghost, which is the artifact the dither exists to avoid.
  const hash = screenCoordinate.xy
    .dot(vec2(12.9898, 78.233))
    .sin()
    .mul(43758.5453)
    .fract(); // @band-limited-elsewhere: screen-space dither, period = 1 px
  // @band-limited-elsewhere: threshold against that dither, not a spatial edge
  material.opacityNode = albedo.w.mul(float(1).sub(hash.step(uFade.oneMinus())));
  material.alphaTest = p.impostorAlphaTest;

  return {
    material,
    update(camera: THREE.Camera, fade: number): void {
      camera.updateMatrixWorld();
      const e = camera.matrixWorld.elements;
      (uRight.value as THREE.Vector3).set(e[0], e[1], e[2]);
      (uUp.value as THREE.Vector3).set(e[4], e[5], e[6]);
      uFade.value = fade;
    },
    dispose(): void {
      material.dispose();
    },
  };
}
