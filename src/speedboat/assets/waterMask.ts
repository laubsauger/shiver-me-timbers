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
 *
 * WHAT THE CAP CANNOT DO, and the volume mask that does it (ocean/hullVolumeMask.ts, trailer review 2026-09-14): water
 * ABOVE the sheer (a buried bow, a heeled landing), an eye under the local surface, and spray streaming through the boat
 * are all in front of the cap or in another pass. Every cap therefore also hosts its boat's slot in the active hull
 * volume mask (`attachHullMaskSlot`): the ocean and every spray pool discard fragments inside the hull + cockpit column
 * of every boat, at the boat's render pose. The cap stays: it is what claims the slot, and on a page without an active
 * volume mask (lookdev, preview) it is still the well's lid. The ocean's side of the mask is an alpha-0 sheet, not a
 * discard, so the "no discard, early-Z" point above still holds.
 */
import * as THREE from 'three/webgpu';
import type { HullMask, HullMaskShape } from '../../ocean/hullVolumeMask';
import { HULL_MASK_STATIONS } from '../../ocean/hullVolumeMask';
import { HULL_DATA, type HullDataFile } from '../hullMesh';

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

/** the hull volume mask's margins (ocean/hullVolumeMask.ts): see `speedboatHullMaskShape` */
export const HULL_MASK_INSET = 0.05;
/** sheer → top of the masked column: over the pilot's head (eye at sheer + 0.63, raceCamEye.ts) and the roll arch */
export const HULL_MASK_COLUMN = 1.3;

/**
 * The SB-12's volume for the hull mask, BODY frame, from the same station table the render hull is lofted from
 * (deepV12.hull.json `stations` + `renderOnly.topsideFlare*`, scripts/blender/hull/hero_hull.py `at`/`proxy_sheer_half`).
 * Below the chine the section is the straight V from keel to chine: the render keel pad and strakes only ADD material
 * outboard/below it, so the V is inside the drawn shell; the keel arc (≤ 2.2 cm) and the deck-edge bevels are inside the
 * `inset`. Above the sheer the column keeps the sheer half-width.
 */
export function speedboatHullMaskShape(
  data: Readonly<Pick<HullDataFile, 'spec' | 'stations'>> = HULL_DATA,
  opts: { inset?: number; columnHeight?: number } = {},
): HullMaskShape {
  const st = data.stations;
  if (st.length < 2) throw new Error('hull mask: the hull JSON needs ≥ 2 stations');
  const vcg = data.spec.vcgAboveKeel;
  const lcg = data.spec.lcgFromTransom;
  const ro = (data as unknown as { renderOnly?: { topsideFlareDeg?: number; topsideFlareStartAboveChine?: number } }).renderOnly;
  const z0 = st[0].z;
  const z1 = st[st.length - 1].z;
  const stations = new Float32Array(HULL_MASK_STATIONS * 3);
  for (let k = 0; k < HULL_MASK_STATIONS; k++) {
    const z = z0 + ((z1 - z0) * k) / (HULL_MASK_STATIONS - 1);
    let j = 0;
    while (j < st.length - 2 && st[j + 1].z < z) j++;
    const a = st[j];
    const b = st[j + 1];
    const f = Math.min(1, Math.max(0, (z - a.z) / Math.max(b.z - a.z, 1e-9)));
    stations[k * 3] = a.keelY + (b.keelY - a.keelY) * f - vcg;
    stations[k * 3 + 1] = a.chineY + (b.chineY - a.chineY) * f - vcg;
    stations[k * 3 + 2] = a.chineHalfBeam + (b.chineHalfBeam - a.chineHalfBeam) * f;
  }
  return {
    sternZ: z0 - lcg,
    keelEndZ: z1 - lcg,
    deckY: st[0].deckY - vcg,
    columnHeight: opts.columnHeight ?? HULL_MASK_COLUMN,
    inset: opts.inset ?? HULL_MASK_INSET,
    flareStartAboveChine: ro?.topsideFlareStartAboveChine ?? 0,
    flareDeg: ro?.topsideFlareDeg ?? 0,
    stations,
  };
}

const _maskPos = new THREE.Vector3();
const _maskQuat = new THREE.Quaternion();
const _maskScale = new THREE.Vector3();
const _maskCam = new THREE.Vector3();

/**
 * Make a boat's depth cap host its slot in `mask`: every render call the cap draws in (never frustum-culled, so a boat
 * just off screen still masks its own spray) writes the boat's world pose. The cap's origin is the boat object's (the
 * physics CG), so its world matrix IS the pose the volume is defined in.
 */
export function attachHullMaskSlot(cap: THREE.Mesh, mask: HullMask, shape: HullMaskShape): void {
  if (mask.shape === null) mask.setShape(shape);
  cap.frustumCulled = false;
  cap.onBeforeRender = (renderer, _scene, camera) => {
    cap.matrixWorld.decompose(_maskPos, _maskQuat, _maskScale);
    _maskCam.setFromMatrixPosition(camera.matrixWorld);
    mask.claim((renderer as unknown as { info: { calls: number } }).info.calls, _maskPos, _maskQuat, _maskPos.distanceTo(_maskCam));
  };
}
