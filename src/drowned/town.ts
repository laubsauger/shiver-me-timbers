/**
 * A DROWNED TOWN — Main Street's houses, its store and its church, standing in the sea where the sand has filled the
 * streets to the eaves. One builder for the film and, later, the Raft 2100 game: a kit and a list of buildings in, a
 * group of meshes out. It knows nothing of the film's coast; where each building stands, how deep its floor lies and
 * what sand buries it are handed in (`TownSite`).
 *
 * WHY (the user, 2026-10-29, on The Drift: "without someone telling me the story it doesn't become apparent that this
 * is what happened"; drift-narrative/wandering-on/sunken-world-cues.md, cue 6: "clear turquoise water over roofs, a
 * chimney … just before the raft beaches. We sail over a town").
 *
 * THE KIT is the speedboat circuit's (assets/models/course_roofs.glb, scripts/blender/course/roofs.py): each variant a
 * WHOLE building from its old ground floor (y = 0) up — Gable and GableChimney (two-storey clapboard houses, the
 * street front +z), Hip (a cottage), Shed (a brick false-front store), Steeple (the white church), WaterTower — at
 * LOD0 (under a thousand triangles each; the shingle courses are geometry). With the renderer given its KTX2 atlases
 * are read (shingle, slate, brick, clapboard: a part's own colour is what tells a chimney from a roof under the
 * growth); without it, geometry only (tests, a studio view).
 *
 * WHAT THE SEA HAS DONE TO THEM, baked into the geometry once (every frame then a pure function of the time; nothing
 * here moves):
 *   - each building settles: a tilt of a degree or two, its ridge sagging at mid-span where the rafters gave
 *     (`tilt`, `sag`), and a few centimetres of warp in every plane — so no ridge is a ruled line;
 *   - what the sand has buried more than BURIED m deep is not drawn (most of the walls);
 *   - every vertex carries the sand's height under it (`drownSand`) and its building's seed (`drownSeed`), and the
 *     material grows the sea's look on it (drownedLook.ts): turf, coralline crusts, silt on what faces up, the sand
 *     drifted onto the lower slopes, the crust at the waterline where a chimney or a spire breaks it.
 * The material keeps the kit's own (map × factor, ORM, normal map; the normal map flattened under growth), folds in
 * the shared `waterLighting()` (caustics and absorption where a sea binds them: the game; neutral in the film, which
 * binds none — sea.ts), and takes a caller's shadow lookup for receivers under the water (the film's refracted one).
 *
 * Positions are kept LOCAL to `site.origin` (the group stands there): the film's coast is 40 km from its world's
 * origin, where a 32-bit world position steps every 4 mm and fine patterns read there crawl (drownedLook.ts).
 */
import * as THREE from 'three/webgpu';
import { attribute, float, mix, normalMap, normalWorldGeometry, positionLocal, positionWorld, texture, uniform, vec2 } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { waterLighting } from '../caustics';
import { gradNoise2Cpu } from '../terrain/noiseCpu';
import contractRaw from '../circuit/assets/courseAssetContract.json?raw';
import { drownedLook, seedOf } from './drownedLook';
import { kitPrims, loadKitRoot, type KitPrim } from './kit';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node unions
type Node = any;

export const TOWN_KIT_URL = new URL('../../assets/models/course_roofs.glb', import.meta.url).href;

export type BuildingKind = 'Gable' | 'GableChimney' | 'Hip' | 'Shed' | 'Steeple' | 'WaterTower';
export const BUILDING_KINDS: readonly BuildingKind[] = ['Gable', 'GableChimney', 'Hip', 'Shed', 'Steeple', 'WaterTower'];

export interface TownKit {
  /** LOD0's primitives of each variant */
  variants: Record<BuildingKind, KitPrim[]>;
}

/** m over the old ground floor, per variant: eave (the lowest roof edge), ridge (the highest roof line), top (the
 * highest point: a chimney, a parapet, the spire) — the kit's contract (courseAssetContract.json `roofs`, which the
 * course checker holds the GLB to), so a layout can be laid before the kit loads */
export const BUILDING_DIMS = (JSON.parse(contractRaw) as { roofs: Record<BuildingKind, { eave: number; ridge: number; top: number }> }).roofs;

export interface BuildingSpec {
  kind: BuildingKind;
  /** m: the plot's centre, world x, z */
  x: number;
  z: number;
  /** rad: its street front (the kit's +z) turned about y (0: the front faces +z) */
  yaw: number;
  /** m: its old ground floor (the kit's y 0), world y */
  floor: number;
  /** rad: the lean it has settled into, about its own x (front down +) and z */
  tilt?: [number, number];
  /** m: its roof's sag at mid-span */
  sag?: number;
  /** its own variation (growth, warp) */
  seed: number;
}

export interface TownSite {
  /** m: the sand's height at world x, z (what buries them) */
  sand: (x: number, z: number) => number;
  /** m: world x, z the group stands at; geometry is kept relative to it */
  origin: [number, number];
}

export interface TownOptions {
  /** the world point a submerged receiver is shadow-tested at (the film: its refracted sunbeam's entry, sea.ts) */
  shadowAt?: Node;
  /** cast sun shadows (a church's spire over the water does; roofs under it need not) — default false */
  castShadow?: boolean;
  /** fold in the shared waterLighting (default true) */
  water?: boolean;
}

/** m: geometry this far under the sand everywhere is not drawn */
export const BURIED = 0.35;
/** m: the warp's amplitude and wavelength in every plane */
const WARP = { amp: 0.035, wave: 2.6 };

/** the kit (loaded once per URL and renderer kind: kit.ts), textured when given the renderer */
export async function loadTownKit(source: string | ArrayBuffer, renderer?: THREE.WebGPURenderer): Promise<TownKit> {
  const root = await loadKitRoot(source, 'CF_course_roofs', renderer);
  return { variants: Object.fromEntries(BUILDING_KINDS.map((k) => [k, kitPrims(root, 0, k)])) as TownKit['variants'] };
}

/** a building's pose: the kit's frame → world (its floor at `floor`, turned, tilted about its own floor's centre) */
export function buildingMatrix(b: BuildingSpec): THREE.Matrix4 {
  const [tx, tz] = b.tilt ?? [0, 0];
  return new THREE.Matrix4()
    .makeTranslation(b.x, b.floor, b.z)
    .multiply(new THREE.Matrix4().makeRotationY(b.yaw))
    .multiply(new THREE.Matrix4().makeRotationX(tx))
    .multiply(new THREE.Matrix4().makeRotationZ(tz));
}

/**
 * The settling, in the kit's own frame (m): the roof's middle down by `sag` (a bowl over the plan, deepening up the
 * roof from the eave), and the warp. A smooth function of position, so pieces that met still meet.
 */
export function settle(x: number, y: number, z: number, kind: BuildingKind, sag: number, seed: number): [number, number, number] {
  const d = BUILDING_DIMS[kind];
  const half = kind === 'Steeple' ? [5, 9] : kind === 'Shed' ? [5, 7.5] : [4.5, 5.5];
  const bowl = Math.max(0, 1 - (x / half[0]) ** 2) * Math.max(0, 1 - (z / half[1]) ** 2);
  const roofward = Math.min(1, Math.max(0, (y - d.eave * 0.8) / Math.max(0.5, d.ridge - d.eave * 0.8)));
  // (the spire stands: only the nave and the houses' roofs sag)
  const spire = kind === 'Steeple' && y > d.ridge + 0.5 ? 0 : 1;
  const s = seed * 17.3;
  const wx = gradNoise2Cpu(y / WARP.wave + s, z / WARP.wave).v;
  const wy = gradNoise2Cpu(x / WARP.wave - s, z / WARP.wave + 3.1).v;
  const wz = gradNoise2Cpu(x / WARP.wave + 7.7, y / WARP.wave - s).v;
  return [x + WARP.amp * wx, y - sag * bowl * roofward * spire + WARP.amp * wy, z + WARP.amp * wz];
}

/** the buildings, one merged mesh per material slot (drawn in the group's frame, at `site.origin`) */
export function buildTown(kit: TownKit, buildings: readonly BuildingSpec[], site: TownSite, o: TownOptions = {}): { group: THREE.Group; triangles: number } {
  const group = new THREE.Group();
  group.name = 'drowned-town';
  const [ox, oz] = site.origin;
  group.position.set(ox, 0, oz);
  const perSlot = new Map<string, { geoms: THREE.BufferGeometry[]; source: THREE.MeshStandardMaterial }>();
  const p = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const tan = new THREE.Vector3();
  for (const b of buildings) {
    const m = buildingMatrix(b);
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const seed = seedOf(b.seed);
    for (const prim of kit.variants[b.kind]) {
      const g = prim.geometry.index ? prim.geometry.toNonIndexed() : prim.geometry.clone();
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
      const norm = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
      const tg = g.getAttribute('tangent') as THREE.BufferAttribute | undefined;
      const sand = new Float32Array(pos.count);
      const keep: number[] = [];
      for (let v = 0; v < pos.count; v++) {
        const [sx, sy, sz] = settle(pos.getX(v), pos.getY(v), pos.getZ(v), b.kind, b.sag ?? 0, seed);
        p.set(sx, sy, sz).applyMatrix4(m);
        sand[v] = site.sand(p.x, p.z);
        pos.setXYZ(v, p.x - ox, p.y, p.z - oz);
        if (norm) {
          nrm.set(norm.getX(v), norm.getY(v), norm.getZ(v)).applyMatrix3(nm).normalize();
          norm.setXYZ(v, nrm.x, nrm.y, nrm.z);
        }
        if (tg) {
          tan.set(tg.getX(v), tg.getY(v), tg.getZ(v)).transformDirection(m);
          tg.setXYZ(v, tan.x, tan.y, tan.z);
        }
      }
      // (a triangle the sand has buried at all three corners is never seen)
      for (let t = 0; t < pos.count; t += 3) {
        let under = 0;
        for (let k = 0; k < 3; k++) if (pos.getY(t + k) < sand[t + k] - BURIED) under++;
        if (under < 3) keep.push(t);
      }
      if (!keep.length) continue;
      const out = new THREE.BufferGeometry();
      for (const name of Object.keys(g.attributes)) {
        const a = g.getAttribute(name) as THREE.BufferAttribute;
        const arr = new Float32Array(keep.length * 3 * a.itemSize);
        keep.forEach((t, i) => {
          for (let k = 0; k < 3; k++) for (let c = 0; c < a.itemSize; c++) arr[(i * 3 + k) * a.itemSize + c] = a.array[(t + k) * a.itemSize + c] as number;
        });
        out.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize));
      }
      const sandKept = new Float32Array(keep.length * 3);
      keep.forEach((t, i) => sandKept.set([sand[t], sand[t + 1], sand[t + 2]], i * 3));
      out.setAttribute('drownSand', new THREE.BufferAttribute(sandKept, 1));
      out.setAttribute('drownSeed', new THREE.BufferAttribute(new Float32Array(keep.length * 3).fill(seed), 1));
      let entry = perSlot.get(prim.slot);
      if (!entry) perSlot.set(prim.slot, (entry = { geoms: [], source: prim.source }));
      entry.geoms.push(out);
    }
  }
  let triangles = 0;
  for (const [slot, { geoms, source }] of perSlot) {
    // (every slot's primitives share one attribute set: the kit's are position, uv, normal and tangent)
    const merged = mergeGeometries(geoms, false);
    if (!merged) throw new Error(`town: the kit's ${slot} primitives do not share one attribute set`);
    merged.computeBoundingSphere();
    triangles += merged.getAttribute('position').count / 3;
    const mesh = new THREE.Mesh(merged, townMaterial(slot, source, o));
    mesh.name = `drowned-town-${slot}`;
    mesh.castShadow = o.castShadow ?? false;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return { group, triangles };
}

/** a slot's material: the kit's own (map, ORM, normal map) under the sea's growth (drownedLook.ts) */
export function townMaterial(slot: string, s: THREE.MeshStandardMaterial, o: TownOptions = {}): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = `drowned:${slot}`;
  const factor = uniform(s.color ? s.color.clone() : new THREE.Color(1, 1, 1));
  const map = s.map ? texture(s.map) : null;
  const ormTex = s.roughnessMap ?? s.aoMap ?? s.metalnessMap ?? null;
  const orm = ormTex ? texture(ormTex) : null;
  const albedo: Node = map ? map.rgb.mul(factor) : factor;
  const rough: Node = orm ? orm.g.mul(s.roughness ?? 1) : float(s.roughness ?? 0.8);
  const metal: Node = orm ? orm.b.mul(s.metalness ?? 1) : float(s.metalness ?? 0);
  const look = drownedLook({
    albedo,
    rough,
    p: positionLocal,
    y: positionWorld.y,
    n: normalWorldGeometry,
    overSand: positionWorld.y.sub(attribute('drownSand', 'float')),
    seed: attribute('drownSeed', 'float'),
  });
  if (orm) m.aoNode = mix(float(1), orm.r, float(s.aoMapIntensity ?? 1));
  const w = (o.water ?? true) ? waterLighting({ worldPos: positionWorld, normal: normalWorldGeometry, mode: 'both' }) : null;
  m.colorNode = w ? look.albedo.mul(w.tint) : look.albedo;
  m.roughnessNode = w ? look.rough.mul(w.roughnessScale).clamp(0.02, 1) : look.rough;
  // (growth is not metal: the steel under it is)
  m.metalnessNode = metal.mul(float(1).sub(look.cover));
  if (s.normalMap) {
    const scale = vec2(s.normalScale?.x ?? 1, s.normalScale?.y ?? 1).mul(float(1).sub(look.cover.mul(0.7)));
    m.normalNode = normalMap(texture(s.normalMap), w ? scale.mul(w.reliefScale) : scale);
  }
  if (w) m.emissiveNode = w.addLight;
  if (o.shadowAt) (m as unknown as { receivedShadowPositionNode: Node }).receivedShadowPositionNode = o.shadowAt;
  return m;
}
