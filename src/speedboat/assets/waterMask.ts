/**
 * HULL WATER MASK (§T.192, USER: "we see water poking through the boat's bottom … keep water outside of water-proof
 * things below the waterline").
 *
 * DIAGNOSIS, case (a): the sea surface stands INSIDE the hull. The SB-12's rest waterline is ≈ 0.60 m above the keel
 * (hero_hull.py `waterline`) and the cockpit sole is 0.55 m (deck 1.30 − well 0.75), so at rest — and on every crest at
 * speed — the ocean's drawn surface passes through the well, above the sole, and the open cockpit shows it. The shell
 * itself is closed and manifold at every LOD (checker rule 7), so nothing else can show inner water: the well opening
 * is the one window.
 *
 * FIX: a DEPTH-ONLY cap over that opening, drawn after every opaque object and before the ocean. The ocean material is
 * `transparent` (surfaceMaterial.ts §V.24: it reads the opaque scene behind it), so it draws in the transparent pass
 * with depth test on; the cap (colorWrite off, depthWrite on, `renderOrder` −1 in that same pass) has already put the
 * sheer plane's depth over the well, and every ocean fragment below the sheer inside the well fails the depth test.
 *  - The boat's interior, the pilot and anything else OPAQUE drew first: they sit behind the cap's depth but are already
 *    in the colour buffer, and the cap writes depth only.
 *  - Water IN FRONT of the cap (a crest between the lens and the cockpit, green water over a swamped deck) passes the
 *    depth test as it should: this is a depth range test, not a stencil hole.
 *  - No ocean change, no new sampler (§V40), no discard (the ocean keeps early-Z), one ~100-triangle draw per boat,
 *    any number of boats, any camera whose eye is above the sheer — the chase rigs always, the cockpit eye (sheer
 *    + 0.63 m) always, also looking back.
 *  - Trade-off, recorded: a TRANSPARENT surface below the sheer inside the well also sorts after the cap and would be
 *    hidden. The one such surface on the boat is the gauge glass, which the build keeps as its own `GaugeGlass` node
 *    and the runtime draws BEFORE the cap (`GAUGE_GLASS_RENDER_ORDER`). Spray or rain falling below the sheer inside
 *    the well is clipped at the sheer plane.
 *
 * The outline comes from the build (root extras `waterMask`, scripts/blender/hull/hero_hull.py `water_mask`), checked
 * by `checkGlb.mjs waterMaskErrors`: it covers every sole vertex and stays ≥ 5 cm inside the deck edge.
 */
import * as THREE from 'three/webgpu';

/** transparent-pass order: gauge glass (under the sheer) → water mask → ocean (0) → windscreen */
export const GAUGE_GLASS_RENDER_ORDER = -2;
export const WATER_MASK_RENDER_ORDER = -1;
export const PERSPEX_RENDER_ORDER = 1;

export interface WaterMaskSpec {
  /** body-frame height of the cap (the deck / sheer plane), m */
  y: number;
  /** body-frame height of the well sole, m (checker only) */
  soleY: number;
  /** closed outline in the body frame, [x, z] */
  outline: [number, number][];
}

/** root extras → spec; null when the GLB carries none (a pipeline-test hull has no well) */
export function readWaterMask(userData: Record<string, unknown>): WaterMaskSpec | null {
  let v = userData.waterMask;
  if (v === undefined) return null;
  if (typeof v === 'string') v = JSON.parse(v) as unknown;
  const s = v as Partial<WaterMaskSpec>;
  const ok =
    typeof s.y === 'number' && Number.isFinite(s.y) &&
    Array.isArray(s.outline) && s.outline.length >= 3 &&
    s.outline.every((p) => Array.isArray(p) && p.length === 2 && p.every((c) => typeof c === 'number' && Number.isFinite(c)));
  if (!ok) throw new Error('speedboat asset: extras.waterMask must be {y, soleY, outline: [[x, z], …]} with finite numbers');
  return { y: s.y as number, soleY: typeof s.soleY === 'number' ? s.soleY : Number.NaN, outline: s.outline as [number, number][] };
}

/** the cap's triangles, facing +Y, in the body frame (shared by every instance) */
export function waterMaskGeometry(spec: WaterMaskSpec): THREE.BufferGeometry {
  // earcut in the (x, −z) plane so a CCW contour there faces +Y after the swap back to (x, y, z)
  let contour = spec.outline.map(([x, z]) => new THREE.Vector2(x, -z));
  if (THREE.ShapeUtils.isClockWise(contour)) contour = contour.reverse();
  const faces = THREE.ShapeUtils.triangulateShape(contour, []);
  const pos = new Float32Array(contour.length * 3);
  contour.forEach((p, i) => pos.set([p.x, spec.y, -p.y], i * 3));
  const idx: number[] = [];
  for (const [a, b, c] of faces) idx.push(a, b, c);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  // winding check: the first triangle's normal must point up, else flip (earcut's output order is not a promise)
  const n = new THREE.Vector3();
  if (faces.length > 0) {
    const [a, b, c] = faces[0];
    const va = new THREE.Vector3().fromArray(pos, a * 3);
    const vb = new THREE.Vector3().fromArray(pos, b * 3);
    const vc = new THREE.Vector3().fromArray(pos, c * 3);
    n.subVectors(vb, va).cross(new THREE.Vector3().subVectors(vc, va));
    if (n.y < 0) {
      for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
      g.setIndex(idx);
    }
  }
  g.computeVertexNormals(); // unlit, but node materials still bind the attribute
  g.computeBoundingSphere();
  return g;
}

/** one depth-only material for every boat's cap */
export function createWaterMaskMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'WaterMask';
  m.colorWrite = false;
  m.depthWrite = true;
  m.depthTest = true;
  // the ocean is in the TRANSPARENT pass: the cap must be there too, ahead of it by renderOrder
  m.transparent = true;
  m.side = THREE.FrontSide;
  m.fog = false;
  return m;
}

export function createWaterMaskMesh(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'WaterMask';
  mesh.renderOrder = WATER_MASK_RENDER_ORDER;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData.waterMask = true;
  return mesh;
}
