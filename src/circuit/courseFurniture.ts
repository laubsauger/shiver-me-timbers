/**
 * COURSE FURNITURE RUNTIME (§T.187): the course GLBs (scripts/blender/course, contract
 * src/circuit/assets/courseAssetContract.json) drawn at the placements `buildTowerReach` measured.
 *
 * DRAWS (perf-baseline.md "Applied"). Each placement is a GROUP of variants (a pole = Spar + Strobe + board +
 * numeral) that picks its LOD as one object, by camera distance against the contract's `switchDistance` with
 * hysteresis, and is not drawn at all past its asset's `COURSE_CULL_DISTANCE`. Every non-lamp primitive of every
 * variant of an asset lives in ONE BatchedMesh per material slot per LOD band (LOD0 | LOD1+2), so a slot is one
 * draw whatever mix of boards, numerals, tags and roof kinds is in view; each instance is frustum-culled per pass
 * (main, shadow, foam capture) by the BatchedMesh itself. The LOD0 band is the §V10 foam target and both bands
 * cast shadows (roofs neither), as the LOD0/LOD1 meshes did. `C_Lamp` primitives stay one InstancedMesh per
 * variant per LOD (they carry the per-instance `lampLevel` attribute), packed only with groups in view, and a mesh
 * with nothing packed is hidden so it costs no render object. T205 measured the old layout (one InstancedMesh per
 * variant per primitive per LOD, empties included) at 137 draw calls and 4.1 ms of CPU.
 *
 * MATERIALS. One node material per asset per slot, rebuilt from the loaded glTF material with the shared
 * `waterLighting()` folded in exactly as `speedboat/assets/slotMaterials.ts` does (tint × albedo, bounce
 * as emissive, roughness × wet, relief × wet), so furniture standing in the sea gets the same caustics,
 * wet band and absorption as a hull. Build AFTER `setActiveCaustics` (buildSea does it). `C_Lamp` adds
 * `albedo × lampLevel × LAMP_NITS`, `lampLevel` a per-instance attribute the frame drives: the next
 * gate's strobe, the turn-mark lanterns, the start lamps (0–5 lit, then green), the aviation beacons.
 *
 * BOB (render hook, NO physics — design doc: "wave-driven bobbing is a render concern"). Spar markers,
 * buoys and guy-anchor floats read `waterHeightAt` (wire CpuOcean.heightAt, §V8) at their pivot: heave
 * follows the sea, tilt follows its slope through each asset's extras.bob gains, low-passed by its lag.
 * Gate-crossing logic keeps using the STATIC pole positions in the Course — a bobbing pole is a look.
 *
 * CABLES. Conductors and earth wires between neighbouring pylons, and the tower's nine guys, are
 * catenaries built here from the GLB attach points (extras.attach / extras.guys) to wherever the layout
 * put the neighbours, merged into ONE mesh.
 *
 * THIN MEMBERS (core/minWidth.ts, §V41). The pylon lattice, the radio mast, the spars and stakes are drawn never
 * narrower than ~1 px, with the widening paid back as a hashed coverage (USER: "the power poles in the distance get
 * too thin and then aliasing eats them"); the cables the same, blended. The far band keeps the members LOD1 has:
 * the pylon's and the mast's LOD2 drop their diagonals outright, which is a pop the coverage fade exists to avoid.
 */
import * as THREE from 'three/webgpu';
import { attribute, float, mix, normalMap, normalWorldGeometry, positionWorld, texture, uniform, vec2, vec3 } from 'three/tsl';
import { fbm2, valueNoise2 } from '../terrain/noise';
import { coordFilter, periodResolved } from '../ship/bandLimit';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import basisTranscoderJsUrl from 'three/addons/libs/basis/basis_transcoder.js?url';
import basisTranscoderWasmUrl from 'three/addons/libs/basis/basis_transcoder.wasm?url';
import contractRaw from './assets/courseAssetContract.json?raw';
import { waterLighting } from '../caustics';
import type { Course } from '../race/types';
import type { CourseFurnitureData, RoofKind } from './towerReach';
import { createStartMarkers } from './startMarkers';
import { applyMinWidth, computeThinAxes, THIN_AXIS_ATTRIBUTE } from '../core/minWidth';
import { SPRAY_OVER_WATER_ORDER } from '../foam/sprayPool';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

export const COURSE_CONTRACT = JSON.parse(contractRaw) as {
  version: number;
  assets: Record<CourseAssetName, { kind: string; switchDistance: [number, number]; variants: string[] }>;
  roofs: Record<string, { eave: number; ridge: number; top: number }>;
  lod: { levels: number; hysteresis: number };
};

export type CourseAssetName =
  | 'course_gate_pole'
  | 'course_turn_buoy'
  | 'course_bar_stake'
  | 'course_pylon'
  | 'course_radio_tower'
  | 'course_roofs';

export const COURSE_ASSET_URLS: Record<CourseAssetName, string> = {
  course_gate_pole: new URL('../../assets/models/course_gate_pole.glb', import.meta.url).href,
  course_turn_buoy: new URL('../../assets/models/course_turn_buoy.glb', import.meta.url).href,
  course_bar_stake: new URL('../../assets/models/course_bar_stake.glb', import.meta.url).href,
  course_pylon: new URL('../../assets/models/course_pylon.glb', import.meta.url).href,
  course_radio_tower: new URL('../../assets/models/course_radio_tower.glb', import.meta.url).href,
  course_roofs: new URL('../../assets/models/course_roofs.glb', import.meta.url).href,
};

/** RoofPlacement.kind → the roofs GLB variant */
export const ROOF_VARIANT: Record<RoofKind, string> = {
  gable: 'Gable',
  gableChimney: 'GableChimney',
  hip: 'Hip',
  shed: 'Shed',
  steeple: 'Steeple',
  waterTower: 'WaterTower',
};

/** emissive radiance of a fully lit lamp lens (the scene is lit in physical-ish sun units) */
const LAMP_NITS = 18;
const BOB_PROBE = 1.2;

/**
 * Camera distance (m) past which a placement is not drawn (hysteresis: `COURSE_CONTRACT.lod.hysteresis`). Each is
 * where the asset's tallest feature is ~2-3 px at 1080p with the chase camera's ~60° field: a 4 m spar or buoy at
 * 1.5 km, a 2.5 m stake at 0.9 km, a roof at 1.8 km, a 30 m pylon at 3.5 km. The tower (and its guy anchors) is the
 * course's landmark and is never culled.
 */
export const COURSE_CULL_DISTANCE: Record<CourseAssetName, number> = {
  course_gate_pole: 1500,
  course_turn_buoy: 1500,
  course_bar_stake: 900,
  course_pylon: 3500,
  course_radio_tower: Number.POSITIVE_INFINITY,
  course_roofs: 1800,
};

/**
 * The variants whose members get minimum projected width (core/minWidth.ts). Members only: boards, numerals, the hut
 * and the lamp rig's banner are flat artwork that triangulates into slivers too, and must not dither.
 */
const THIN_VARIANTS: Partial<Record<CourseAssetName, readonly string[]>> = {
  course_pylon: ['Pylon'],
  course_radio_tower: ['Mast'],
  course_gate_pole: ['Spar'],
  course_bar_stake: ['Stake'],
};

/**
 * assets whose LATTICE variant (THIN_VARIANTS) draws LOD1 at level 2 too: their LOD2 deletes members outright
 * (max_lod=1 diagonals). The lattice variant has the same primitives at both levels, so this adds triangles, not batch
 * instances; the asset's other variants keep LOD2 (the insulators' clamps would add one instance per pylon).
 */
const FAR_KEEPS_LOD1: ReadonlySet<CourseAssetName> = new Set(['course_pylon', 'course_radio_tower']);

interface Prim {
  geometry: THREE.BufferGeometry;
  slot: string;
  source: THREE.MeshStandardMaterial;
}

interface LoadedAsset {
  name: CourseAssetName;
  extras: Record<string, unknown>;
  variants: Record<string, Record<string, unknown>>;
  /** per LOD: variant → primitives */
  lods: Map<string, Prim[]>[];
  textureBytes: number;
}

function parseExtra(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

async function createCourseLoader(renderer: THREE.WebGPURenderer): Promise<GLTFLoader> {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url.endsWith('basis_transcoder.js')) return basisTranscoderJsUrl;
    if (url.endsWith('basis_transcoder.wasm')) return basisTranscoderWasmUrl;
    return url;
  });
  const ktx2 = new KTX2Loader(manager).setTranscoderPath('/basis/');
  await ktx2.detectSupportAsync(renderer);
  await MeshoptDecoder.ready;
  return new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
}

function assetFromScene(name: CourseAssetName, scene: THREE.Group, anisotropy: number): LoadedAsset {
  const root = scene.getObjectByName(`CF_${name}`) ?? scene.children[0];
  if (!root) throw new Error(`course asset ${name}: no CF_${name} root`);
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(root.userData ?? {})) extras[k] = parseExtra(v);
  const variants = (extras.variants ?? {}) as Record<string, Record<string, unknown>>;
  const lods: Map<string, Prim[]>[] = [];
  const textures = new Set<THREE.Texture>();
  for (const lodGroup of root.children) {
    const m = /^LOD(\d+)$/.exec(lodGroup.name);
    if (!m) continue;
    const level = Number(m[1]);
    const map = new Map<string, Prim[]>();
    for (const node of lodGroup.children) {
      const vm = /^(.+)_LOD\d+$/.exec(node.name);
      const variant = (node.userData?.variant as string | undefined) ?? (vm ? vm[1] : node.name);
      const prims: Prim[] = [];
      node.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mat = mesh.material as THREE.MeshStandardMaterial;
        for (const t of [mat.map, mat.normalMap, mat.roughnessMap, mat.emissiveMap]) if (t) textures.add(t);
        prims.push({ geometry: mesh.geometry, slot: mat.name.replace(/\.\d+$/, ''), source: mat });
      });
      map.set(variant, prims);
    }
    lods[level] = map;
  }
  let textureBytes = 0;
  for (const t of textures) {
    // KTX2 mips are trilinear; without anisotropy the atlases go mushy at grazing angles (roofs, spars, the mast)
    // — WebGPU applies it only with all filters linear, which the loader's full mip chains give
    t.anisotropy = anisotropy;
    t.needsUpdate = true;
    const img = t.image as { width?: number; height?: number } | undefined;
    if (img?.width && img?.height) textureBytes += img.width * img.height * 4 * (4 / 3) * 0.25; // KTX2 ≈ 1 byte/px + mips
  }
  return { name, extras, variants, lods, textureBytes };
}

/** a [0,1] field faded to its mean once its period is sub-pixel (§V48b) */
function fadedField(coord: Node, octaves: number): Node {
  const f = coordFilter(coord);
  return mix(float(0.5), fbm2(coord, octaves), periodResolved(coord, f.x.max(f.y)));
}

/**
 * §T.194 TIDE LINE on a drowned structure (design doc §8: "hazard paint at the waterline" on the pylons,
 * the circuit.md T187b review: "no tide line or weed at the waterline" on the roofs). World height against
 * mean sea: weed and slime below, a barnacle crust at the line, rust bleeding down from steel above it,
 * all broken up so no band is a ruler line. Albedo and roughness in, out; the water lighting goes on after.
 */
export function tideBand(albedo: Node, rough: Node, kind: 'steel' | 'build' | 'concrete'): { albedo: Node; rough: Node } {
  const y = positionWorld.y;
  const n = normalWorldGeometry;
  const wc = positionWorld.xz.sub(n.xz.div(n.y.add(1)).mul(y));
  const patch = fadedField(wc.mul(0.7), 2);
  const yb = y.add(patch.sub(0.5).mul(0.35));
  // @band-limited-elsewhere: elevation bands on world height (≥ 0.2 m ramps), not a spatial period
  const weed = yb.smoothstep(0.15, -0.35);
  // @band-limited-elsewhere: elevation band
  const crust = yb.smoothstep(-0.45, -0.1).mul(yb.smoothstep(0.55, 0.2));
  // @band-limited-elsewhere: elevation band (the splash-wet zone)
  const wet = yb.smoothstep(1.3, 0.2);
  const speckCoord = wc.mul(18);
  const f = coordFilter(speckCoord);
  const speck = mix(float(0.5), valueNoise2(speckCoord), periodResolved(speckCoord, f.x.max(f.y)));
  let a: Node = albedo;
  let r: Node = rough;
  if (kind === 'steel') {
    // rust bleeds DOWN from the joints: streaks long in y, narrow across
    const streakCoord = vec2(wc.x.add(wc.y).mul(3.2), y.mul(0.35));
    const streak = fadedField(streakCoord, 2);
    // @band-limited-elsewhere: elevation band — rust thins out with height above the splash
    const rustZone = yb.smoothstep(2.6, 0.3).mul(yb.smoothstep(-0.6, 0));
    const rust = streak.smoothstep(0.42, 0.62).mul(rustZone);
    a = mix(a, vec3(0.34, 0.15, 0.06).mul(patch.mul(0.4).add(0.8)), rust.mul(0.75));
    r = mix(r, float(0.85), rust);
  }
  a = mix(a, a.mul(0.55), wet);
  a = mix(a, vec3(0.62, 0.6, 0.55).mul(speck.mul(0.35).add(0.75)), crust.mul(speck.smoothstep(0.3, 0.6)).mul(0.8));
  a = mix(a, mix(vec3(0.07, 0.09, 0.04), vec3(0.12, 0.13, 0.05), patch), weed.mul(0.85));
  r = mix(r, float(0.3), wet.max(weed));
  return { albedo: a, rough: r };
}

/** a slot material with the shared water lighting folded in (slotMaterials.ts's recipe, course slots) */
function courseMaterial(
  slot: string,
  s: THREE.MeshStandardMaterial,
  water: boolean,
  /** §T.194: a drowned structure's tide line (pylons, roofs); absent for the maintained race furniture */
  tide?: 'steel' | 'build',
): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = `course:${slot}`;
  const factor = uniform(s.color ? s.color.clone() : new THREE.Color(1, 1, 1));
  const map = s.map ? texture(s.map) : null;
  const ormTex = s.roughnessMap ?? s.aoMap ?? s.metalnessMap ?? null;
  const orm = ormTex ? texture(ormTex) : null;
  const baseAlbedo: Node = map ? map.rgb.mul(factor) : factor;
  const baseRough: Node = orm ? orm.g.mul(s.roughness ?? 1) : float(s.roughness ?? 0.6);
  const tided = tide && slot !== 'C_Lamp' ? tideBand(baseAlbedo, baseRough, tide) : null;
  const albedo: Node = tided ? tided.albedo : baseAlbedo;
  const rough: Node = tided ? tided.rough : baseRough;
  const metal: Node = orm ? orm.b.mul(s.metalness ?? 1) : float(s.metalness ?? 0);
  if (orm) m.aoNode = mix(float(1), orm.r, float(s.aoMapIntensity ?? 1));
  const w = water ? waterLighting({ worldPos: positionWorld, normal: normalWorldGeometry, mode: 'both' }) : null;
  m.colorNode = w ? albedo.mul(w.tint) : albedo;
  m.roughnessNode = (w ? rough.mul(w.roughnessScale) : rough).clamp(0.02, 1);
  m.metalnessNode = metal;
  if (s.normalMap) {
    const scale = vec2(s.normalScale?.x ?? 1, s.normalScale?.y ?? 1);
    m.normalNode = normalMap(texture(s.normalMap), w ? scale.mul(w.reliefScale) : scale);
  }
  if (slot === 'C_Lamp') {
    const lamp = albedo.mul(attribute('lampLevel', 'float')).mul(LAMP_NITS);
    m.emissiveNode = w ? w.addLight.add(lamp) : lamp;
  } else if (w) {
    m.emissiveNode = w.addLight;
  }
  return m;
}

/**
 * §T.194: where the pylon's legs cross the waterline, in asset space — the four clusters of LOD0 'Pylon'
 * vertices within ±0.4 m of y = 0, one per quadrant. Measured off the GLB, so a rebuilt pylon moves its
 * footings with it.
 */
export function pylonLegsAtWaterline(asset: LoadedAsset): [number, number][] {
  const prims = asset.lods[0]?.get('Pylon') ?? [];
  // the legs are the OUTERMOST members of a lattice: per quadrant, the vertices within ±3 m of the
  // waterline that lie at ≥ 85 % of that band's widest radius
  const pts: [number, number][] = [];
  let widest = 0;
  for (const prim of prims) {
    const pos = prim.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(pos.getY(i)) > 3) continue;
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pts.push([x, z]);
      widest = Math.max(widest, Math.hypot(x, z));
    }
  }
  const sum = [0, 0, 0, 0].map(() => ({ x: 0, z: 0, n: 0 }));
  for (const [x, z] of pts) {
    if (Math.hypot(x, z) < widest * 0.85) continue;
    const q = (x >= 0 ? 0 : 1) + (z >= 0 ? 0 : 2);
    sum[q].x += x;
    sum[q].z += z;
    sum[q].n++;
  }
  return sum.filter((c) => c.n > 0).map((c) => [c.x / c.n, c.z / c.n]);
}

/** a unit-height concrete pedestal (y 0 → 1), 1.3 m square with chamfered corners and a bevelled cap */
function buildFootingGeometry(): THREE.BufferGeometry {
  const body = new THREE.CylinderGeometry(0.78, 0.86, 1, 8, 1, false);
  body.rotateY(Math.PI / 8);
  body.translate(0, 0.5, 0);
  const cap = new THREE.CylinderGeometry(0.62, 0.78, 0.08, 8, 1, false);
  cap.rotateY(Math.PI / 8);
  cap.translate(0, 1.0, 0);
  const merged = mergeGeometries([body.toNonIndexed(), cap.toNonIndexed()], false)!;
  merged.deleteAttribute('uv');
  merged.computeVertexNormals();
  return merged;
}

interface BobSpec {
  pivotY: number;
  heaveGain: number;
  tiltGain: number;
  lagSeconds: number;
  maxTiltRad: number;
}

/** one physical object: its variants share a pose, a LOD and (for lamps) a level */
interface Group {
  asset: CourseAssetName;
  x: number;
  z: number;
  /** placement pose without bob */
  base: THREE.Matrix4;
  members: { variant: string; local?: THREE.Matrix4; lamp?: (f: CourseFurnitureFrame) => number }[];
  bob?: BobSpec;
  lod: number;
  /** past `COURSE_CULL_DISTANCE`: not drawn, not bobbed */
  culled: boolean;
  /** pose changed since the batches last read it */
  moved: boolean;
  heave: number;
  tiltX: number;
  tiltZ: number;
  pose: THREE.Matrix4;
  /** bounding sphere of the LOD0 members in asset space (lamp frustum test) */
  sphere: THREE.Sphere;
  /** batched instances of this group's non-lamp primitives */
  slots: BatchedSlot[];
}

/** one non-lamp primitive of one member of one group, as an instance in each LOD band's BatchedMesh */
interface BatchedSlot {
  local?: THREE.Matrix4;
  /** LOD0 band */
  near: THREE.BatchedMesh | null;
  nearId: number;
  nearGeometry: number;
  nearShown: boolean;
  /** LOD1+2 band: geometry per level (index 1, 2), null where the variant has no such primitive */
  far: THREE.BatchedMesh | null;
  farId: number;
  farGeometry: (number | null)[];
  farShown: boolean;
  farCurrent: number;
}

export interface CourseFurnitureFrame {
  camera: THREE.Camera;
  time: number;
  dt: number;
  /** §V8 sea height at world XZ (CpuOcean.heightAt) — omit for static furniture */
  waterHeightAt?: (x: number, z: number) => number;
  /** index into Course.elements of the next element for the tracked racer; its gate strobes */
  nextElement?: number;
  /** start lamps lit, 0..5 */
  startLamps?: number;
  startGreen?: boolean;
  /**
   * §T.202 the pace boat's DISPLAYED pose (page/paceBoat `display` while `visible`, yaw 0 = +z), null after green:
   * the FOLLOW-ME mast and amber strobe ride it (src/circuit/startMarkers.ts)
   */
  pace?: { x: number; z: number; yaw: number } | null;
}

export interface CourseFurnitureStats {
  draws: number;
  instances: number;
  trianglesDrawn: number;
  textureMB: number;
  /** anisotropy applied to every furniture texture */
  anisotropy: number;
  /** placements per LOD level */
  lodHistogram: number[];
}

export interface CourseFurniture {
  group: THREE.Group;
  /** every InstancedMesh straddling the water (spars, buoys, stakes, pylons, mast) — §V10 foam targets */
  foamTargets: THREE.Object3D[];
  update(frame: CourseFurnitureFrame): void;
  stats(): CourseFurnitureStats;
  dispose(): void;
}

export interface CreateCourseFurnitureOptions {
  renderer: THREE.WebGPURenderer;
  data: CourseFurnitureData;
  course: Course;
  seabedAt(x: number, z: number): number;
  /** fold in waterLighting (a sea is bound); false for a studio view */
  water?: boolean;
  urls?: Partial<Record<CourseAssetName, string>>;
  /** texture anisotropy cap (settings `maxAnisotropy`); default and ceiling: the renderer's max */
  maxAnisotropy?: number;
}

const Y = new THREE.Vector3(0, 1, 0);

function yawMatrix(yaw: number): THREE.Matrix4 {
  return new THREE.Matrix4().makeRotationY(yaw);
}

function leanMatrix(lean: number, leanDir: number): THREE.Matrix4 {
  // lean TOWARD world bearing leanDir (atan2 z, x): rotate about the horizontal axis perpendicular to it
  const axis = new THREE.Vector3(-Math.sin(leanDir), 0, Math.cos(leanDir));
  return new THREE.Matrix4().makeRotationAxis(axis, -lean);
}

export async function createCourseFurniture(opts: CreateCourseFurnitureOptions): Promise<CourseFurniture> {
  const water = opts.water ?? true;
  const urls = { ...COURSE_ASSET_URLS, ...opts.urls };
  const loader = await createCourseLoader(opts.renderer);
  const names = Object.keys(COURSE_ASSET_URLS) as CourseAssetName[];
  const rendererMax = opts.renderer.getMaxAnisotropy();
  const anisotropy = Math.max(1, Math.min(rendererMax, opts.maxAnisotropy ?? rendererMax));
  const loaded = await Promise.all(names.map(async (n) => assetFromScene(n, (await loader.loadAsync(urls[n])).scene, anisotropy)));
  const assets = Object.fromEntries(loaded.map((a) => [a.name, a])) as Record<CourseAssetName, LoadedAsset>;
  const { data, course } = opts;
  // member axes for the thin variants; every other non-lamp primitive of the asset carries zeros, because a
  // BatchedMesh slot needs one attribute set across all of its geometries
  for (const a of loaded) {
    const thin = THIN_VARIANTS[a.name];
    if (!thin) continue;
    for (const lod of a.lods) {
      for (const [variant, prims] of lod ?? new Map<string, Prim[]>()) {
        for (const prim of prims) {
          if (prim.slot === 'C_Lamp') continue;
          const g = prim.geometry;
          const axes = thin.includes(variant) ? computeThinAxes(g) : new Float32Array(g.getAttribute('position').count * 4);
          g.setAttribute(THIN_AXIS_ATTRIBUTE, new THREE.BufferAttribute(axes, 4));
        }
      }
    }
  }

  // ── placements → groups ────────────────────────────────────────────────
  const groups: Group[] = [];
  const add = (asset: CourseAssetName, x: number, z: number, base: THREE.Matrix4, members: Group['members'], bob?: BobSpec): void => {
    groups.push({ asset, x, z, base, members, bob, lod: -1, culled: false, moved: true, heave: 0, tiltX: 0, tiltZ: 0, pose: base.clone(), sphere: new THREE.Sphere(), slots: [] });
  };
  const elementIndex = new Map(course.elements.map((e, i) => [e.kind === 'gate' ? e.gate.id : e.mark.id, i]));
  const flash = (hz: number, t: number, duty = 0.18): number => ((t * hz) % 1 < duty ? 1 : 0.08);

  const poleBob = assets.course_gate_pole.extras.bob as BobSpec;
  const triOffsetY = Number(assets.course_gate_pole.extras.triangleNumeralOffsetY ?? -0.12);
  for (const p of data.poles) {
    const idx = elementIndex.get(p.gateId) ?? -1;
    const board = p.number === 0 ? 'BoardChequer' : p.board === 'square' ? 'BoardSquare' : 'BoardTriangle';
    const members: Group['members'] = [
      { variant: 'Spar' },
      { variant: 'Strobe', lamp: (f) => (f.nextElement === idx ? flash(1.2, f.time + (p.side === 'left' ? 0 : 0.1)) : 0.1) },
      { variant: board },
    ];
    if (p.number > 0) {
      members.push({ variant: `Numeral${p.number}`, local: p.board === 'triangle' ? new THREE.Matrix4().makeTranslation(0, triOffsetY, 0) : undefined });
    }
    add('course_gate_pole', p.at[0], p.at[1], new THREE.Matrix4().makeTranslation(p.at[0], 0, p.at[1]).multiply(yawMatrix(p.yaw)), members, poleBob);
  }
  const buoyBob = assets.course_turn_buoy.extras.bob as BobSpec;
  for (const b of data.buoys) {
    const n = Number(b.markId.replace(/\D/g, '')) || 1;
    add('course_turn_buoy', b.at[0], b.at[1], new THREE.Matrix4().makeTranslation(b.at[0], 0, b.at[1]).multiply(yawMatrix(b.yaw)), [
      { variant: 'Buoy' },
      { variant: 'Lantern', lamp: (f) => flash(0.5, f.time + n * 0.37, 0.25) },
      { variant: `Tag${Math.min(Math.max(n, 1), 3)}` },
    ], buoyBob);
  }
  for (const s of data.stakes) {
    const base = new THREE.Matrix4().makeTranslation(s.at[0], 0, s.at[1]).multiply(leanMatrix(s.lean, s.leanDir)).multiply(yawMatrix(s.yaw));
    add('course_bar_stake', s.at[0], s.at[1], base, [{ variant: 'Stake' }]);
  }
  for (const p of data.pylons) {
    add('course_pylon', p.at[0], p.at[1], new THREE.Matrix4().makeTranslation(p.at[0], 0, p.at[1]).multiply(yawMatrix(p.yaw)), [
      { variant: 'Pylon' },
      { variant: 'Insulators' },
    ]);
  }
  for (const r of data.roofs) {
    add('course_roofs', r.at[0], r.at[1], new THREE.Matrix4().makeTranslation(r.at[0], r.floor, r.at[1]).multiply(yawMatrix(r.yaw)), [
      { variant: ROOF_VARIANT[r.kind] },
    ]);
  }
  const t = data.tower;
  const footY = opts.seabedAt(t.at[0], t.at[1]);
  const towerBase = new THREE.Matrix4()
    .makeTranslation(t.at[0], footY, t.at[1])
    .multiply(leanMatrix(t.lean, t.leanDir))
    .multiply(new THREE.Matrix4().makeTranslation(0, -footY, 0))
    .multiply(yawMatrix(t.yaw));
  const lampMembers: Group['members'] = [1, 2, 3, 4, 5].map((c) => ({
    variant: `StartLamp${c}`,
    lamp: (f: CourseFurnitureFrame) => ((f.startLamps ?? 0) >= c && !f.startGreen ? 1 : 0.04),
  }));
  add('course_radio_tower', t.at[0], t.at[1], towerBase, [
    { variant: 'Mast' },
    { variant: 'Hut' },
    { variant: 'LampRig' },
    ...lampMembers,
    { variant: 'StartGreen', lamp: (f) => (f.startGreen ? 1 : 0.04) },
    { variant: 'Beacons', lamp: (f) => flash(0.6, f.time, 0.3) },
  ]);
  const anchorBob: BobSpec = { pivotY: -0.4, heaveGain: 1, tiltGain: 0.1, lagSeconds: 0.9, maxTiltRad: 0.08 };
  t.anchors.forEach((a) => add('course_radio_tower', a[0], a[1], new THREE.Matrix4().makeTranslation(a[0], 0, a[1]), [{ variant: 'GuyAnchor' }], anchorBob));

  // ── batched meshes per (asset, slot, LOD band); lamp primitives instanced per (asset, variant, lod) ──
  const root = new THREE.Group();
  root.name = 'course-furniture';
  const materials = new Map<string, THREE.MeshStandardNodeMaterial>();
  const materialFor = (asset: CourseAssetName, prim: Prim): THREE.MeshStandardNodeMaterial => {
    const key = `${asset}:${prim.slot}`;
    let m = materials.get(key);
    if (!m) {
      m = courseMaterial(prim.slot, prim.source, water, asset === 'course_pylon' ? 'steel' : asset === 'course_roofs' ? 'build' : undefined);
      if (THIN_VARIANTS[asset] && prim.slot !== 'C_Lamp') applyMinWidth(m, 'hash');
      materials.set(key, m);
    }
    return m;
  };
  interface Bucket {
    meshes: THREE.InstancedMesh[];
    lamp: THREE.InstancedBufferAttribute[];
    /** (group, member) pairs currently packed, for lamp updates */
    packed: { g: Group; m: Group['members'][number] }[];
  }
  const buckets = new Map<string, Bucket>();
  const bucketKey = (asset: string, variant: string, lod: number): string => `${asset}|${variant}|${lod}`;
  const foamTargets: THREE.Object3D[] = [];
  const straddles = new Set(['Spar', 'Buoy', 'Stake', 'Pylon', 'Mast', 'GuyAnchor']);
  const batches: THREE.BatchedMesh[] = [];
  const isLamp = (prim: Prim): boolean => prim.slot === 'C_Lamp';
  /**
   * A BatchedMesh copies each attribute into a plain array of the source's element type, dropping the glTF's
   * 4-byte-aligned interleaving: the meshopt normals (int16 × 3 = 6 bytes) then fail WebGPU's "arrayStride multiple
   * of 4" check. Such attributes go into the batch dequantised to float32 (the values the shader already received).
   */
  const batchable = (g: THREE.BufferGeometry): THREE.BufferGeometry => {
    const out = new THREE.BufferGeometry();
    for (const [key, attr] of Object.entries(g.attributes)) {
      const bytes = (attr as THREE.BufferAttribute).array.BYTES_PER_ELEMENT * attr.itemSize;
      if (bytes % 4 === 0 && !(attr as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) {
        out.setAttribute(key, attr);
        continue;
      }
      const arr = new Float32Array(attr.count * attr.itemSize);
      for (let i = 0; i < attr.count; i++) for (let c = 0; c < attr.itemSize; c++) arr[i * attr.itemSize + c] = attr.getComponent(i, c);
      out.setAttribute(key, new THREE.BufferAttribute(arr, attr.itemSize));
    }
    out.setIndex(g.index);
    return out;
  };
  const countOf = (g: THREE.BufferGeometry): [number, number] => [g.getAttribute('position').count, g.index ? g.index.count : g.getAttribute('position').count];
  for (const name of names) {
    const a = assets[name];
    const mine = groups.filter((g) => g.asset === name);
    // ── lamps: as before, one InstancedMesh per lamp primitive per variant per LOD ──
    const capacity = new Map<string, number>();
    for (const g of mine) for (const m of g.members) capacity.set(m.variant, (capacity.get(m.variant) ?? 0) + 1);
    for (let lod = 0; lod < a.lods.length; lod++) {
      for (const [variant, prims] of a.lods[lod] ?? new Map()) {
        const cap = capacity.get(variant) ?? 0;
        const lampPrims = (prims as Prim[]).filter(isLamp);
        if (cap === 0 || lampPrims.length === 0) continue;
        const b: Bucket = { meshes: [], lamp: [], packed: [] };
        for (const prim of lampPrims) {
          const geom = prim.geometry;
          const mesh = new THREE.InstancedMesh(geom, materialFor(name, prim), cap);
          mesh.name = `${name}/${variant}_LOD${lod}/${prim.slot}`;
          mesh.count = 0;
          mesh.visible = false;
          mesh.frustumCulled = false;
          mesh.castShadow = lod < 2 && name !== 'course_roofs';
          mesh.receiveShadow = true;
          const attr = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
          attr.setUsage(THREE.DynamicDrawUsage);
          geom.setAttribute('lampLevel', attr);
          b.lamp.push(attr);
          b.meshes.push(mesh);
          root.add(mesh);
        }
        buckets.set(bucketKey(name, variant, lod), b);
      }
    }
    // ── every other slot: one BatchedMesh per slot per band ──
    const bandLods = [[0], [1, 2]];
    const keepsLod1 = (variant: string): boolean => FAR_KEEPS_LOD1.has(name) && (THIN_VARIANTS[name]?.includes(variant) ?? false);
    const slotNames = new Set<string>();
    for (const lod of a.lods) for (const prims of lod?.values() ?? []) for (const prim of prims) if (!isLamp(prim)) slotNames.add(prim.slot);
    for (const slot of slotNames) {
      for (let band = 0; band < 2; band++) {
        const lods = bandLods[band].filter((l) => a.lods[l]);
        // per variant: slot primitives per level, and the instances a member needs (the most primitives at any level)
        const perVariant = new Map<string, { prims: Map<number, Prim[]>; width: number }>();
        for (const lod of lods) {
          for (const [variant, prims] of a.lods[lod]) {
            const inSlot = prims.filter((p) => p.slot === slot);
            if (!inSlot.length) continue;
            const e = perVariant.get(variant) ?? { prims: new Map(), width: 0 };
            e.prims.set(lod, inSlot);
            e.width = Math.max(e.width, inSlot.length);
            perVariant.set(variant, e);
          }
        }
        let vertices = 0;
        let indices = 0;
        let instances = 0;
        let source: Prim | null = null;
        for (const e of perVariant.values()) {
          for (const prims of e.prims.values()) {
            for (const prim of prims) {
              const [v, i] = countOf(prim.geometry);
              vertices += v;
              indices += i;
              source ??= prim;
            }
          }
        }
        for (const g of mine) for (const m of g.members) instances += perVariant.get(m.variant)?.width ?? 0;
        if (!source || instances === 0) continue;
        const bm = new THREE.BatchedMesh(instances, vertices, indices, materialFor(name, source));
        bm.name = `${name}/${slot}/${band === 0 ? 'LOD0' : 'LOD1-2'}`;
        // per-instance culling runs per pass; the whole-object sphere would be computed once and go stale as things bob
        bm.frustumCulled = false;
        bm.perObjectFrustumCulled = true;
        bm.sortObjects = false;
        bm.castShadow = name !== 'course_roofs';
        bm.receiveShadow = true;
        const geometryIds = new Map<string, number>();
        for (const [variant, e] of perVariant) {
          for (const [lod, prims] of e.prims) prims.forEach((prim, k) => geometryIds.set(`${variant}|${lod}|${k}`, bm.addGeometry(batchable(prim.geometry))));
        }
        for (const g of mine) {
          for (const m of g.members) {
            const e = perVariant.get(m.variant);
            if (!e) continue;
            for (let k = 0; k < e.width; k++) {
              if (band === 0) {
                const id = geometryIds.get(`${m.variant}|0|${k}`);
                if (id === undefined) continue;
                const inst = bm.addInstance(id);
                bm.setVisibleAt(inst, false);
                g.slots.push({ local: m.local, near: bm, nearId: inst, nearGeometry: id, nearShown: false, far: null, farId: -1, farGeometry: [], farShown: false, farCurrent: -1 });
              } else {
                const lod1 = geometryIds.get(`${m.variant}|1|${k}`) ?? null;
                const farGeometry = [null, lod1, keepsLod1(m.variant) ? lod1 : (geometryIds.get(`${m.variant}|2|${k}`) ?? null)];
                const first = farGeometry.find((x) => x !== null);
                if (first === undefined || first === null) continue;
                const inst = bm.addInstance(first);
                bm.setVisibleAt(inst, false);
                g.slots.push({ local: m.local, near: null, nearId: -1, nearGeometry: -1, nearShown: false, far: bm, farId: inst, farGeometry, farShown: false, farCurrent: first });
              }
            }
          }
        }
        if (band === 0 && [...perVariant.keys()].some((v) => straddles.has(v))) {
          bm.userData.foamTarget = true;
          foamTargets.push(bm);
        }
        batches.push(bm);
        root.add(bm);
      }
    }
    // lamp frustum test: the group's LOD0 members in asset space
    for (const g of mine) {
      const box = new THREE.Box3();
      for (const m of g.members) {
        for (const prim of a.lods[0]?.get(m.variant) ?? []) {
          prim.geometry.computeBoundingBox();
          const b = prim.geometry.boundingBox!.clone();
          if (m.local) b.applyMatrix4(m.local);
          box.union(b);
        }
      }
      if (!box.isEmpty()) box.getBoundingSphere(g.sphere);
      // bob heave and tilt swing it by up to a metre or two
      g.sphere.radius += 2;
    }
  }

  // ── §T.194 pylon footings: a concrete pedestal under every leg, standing out of the sea ──
  let footings: THREE.InstancedMesh | null = null;
  const pylonPlacements = groups.filter((g) => g.asset === 'course_pylon');
  const legs = pylonLegsAtWaterline(assets.course_pylon);
  if (pylonPlacements.length && legs.length) {
    const geo = buildFootingGeometry();
    const fm = new THREE.MeshStandardNodeMaterial();
    fm.name = 'course:footing';
    const speckCoord = positionWorld.xz.add(vec2(positionWorld.y, positionWorld.y.mul(0.7))).mul(6);
    const concrete = vec3(0.5, 0.49, 0.46).mul(fadedField(speckCoord, 2).mul(0.35).add(0.8));
    const tided = tideBand(concrete, float(0.88), 'concrete');
    // the rust the steel leg bleeds onto the cap and down its face
    // @band-limited-elsewhere: elevation band on world height (the cap's top half metre)
    const bleed = positionWorld.y.smoothstep(-0.6, 0.6).mul(fadedField(vec2(positionWorld.x.add(positionWorld.z).mul(4), positionWorld.y.mul(0.5)), 2).smoothstep(0.45, 0.65));
    const albedo = mix(tided.albedo, vec3(0.36, 0.17, 0.07), bleed.mul(0.6));
    const w = water ? waterLighting({ worldPos: positionWorld, normal: normalWorldGeometry, mode: 'both' }) : null;
    fm.colorNode = w ? albedo.mul(w.tint) : albedo;
    fm.roughnessNode = w ? tided.rough.mul(w.roughnessScale).clamp(0.02, 1) : tided.rough;
    if (w) fm.emissiveNode = w.addLight;
    footings = new THREE.InstancedMesh(geo, fm, pylonPlacements.length * legs.length);
    footings.name = 'course-pylon-footings';
    const m4 = new THREE.Matrix4();
    let k = 0;
    for (const g of pylonPlacements) {
      for (const leg of legs) {
        const at = new THREE.Vector3(leg[0], 0, leg[1]).applyMatrix4(g.base);
        const floor = Math.min(opts.seabedAt(at.x, at.z), -1);
        // the pedestal runs from the old ground (or 6 m down, whichever is shallower) to +0.7 m
        const bottom = Math.max(floor, -6);
        m4.makeTranslation(at.x, bottom, at.z).multiply(new THREE.Matrix4().makeScale(1, 0.7 - bottom, 1));
        footings.setMatrixAt(k++, m4);
      }
    }
    footings.instanceMatrix.needsUpdate = true;
    footings.computeBoundingSphere();
    footings.castShadow = true;
    footings.receiveShadow = true;
    footings.userData.foamTarget = true;
    foamTargets.push(footings);
    root.add(footings);
  }

  // ── cables: pylon spans + tower guys, one merged mesh ──────────────────
  const cableGeoms: THREE.BufferGeometry[] = [];
  const cableAlong = (a: THREE.Vector3, b: THREE.Vector3, sag: number, radius: number): void => {
    const pts: THREE.Vector3[] = [];
    const n = 20;
    for (let i = 0; i <= n; i++) {
      const s = i / n;
      pts.push(new THREE.Vector3().lerpVectors(a, b, s).addScaledVector(Y, -4 * sag * s * (1 - s)));
    }
    const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), n, radius, 5, false);
    // a tube's normals ARE its unit offsets from the centreline
    const normal = tube.getAttribute('normal');
    const axes = new Float32Array(normal.count * 4);
    for (let i = 0; i < normal.count; i++) axes.set([normal.getX(i) * radius, normal.getY(i) * radius, normal.getZ(i) * radius, radius], i * 4);
    tube.setAttribute(THIN_AXIS_ATTRIBUTE, new THREE.BufferAttribute(axes, 4));
    cableGeoms.push(tube);
  };
  const pylonGroups = groups.filter((g) => g.asset === 'course_pylon');
  const attach = (assets.course_pylon.extras.attach ?? []) as [number, number, number][];
  const cableSpec = (assets.course_pylon.extras.cable ?? { phaseRadius: 0.018, earthRadius: 0.011, sagPerSpan: 0.012 }) as {
    phaseRadius: number;
    earthRadius: number;
    sagPerSpan: number;
  };
  for (const [i, j] of data.spans) {
    const A = pylonGroups[i].base;
    const B = pylonGroups[j].base;
    const span = Math.hypot(pylonGroups[i].x - pylonGroups[j].x, pylonGroups[i].z - pylonGroups[j].z);
    attach.forEach((p, k) => {
      const a = new THREE.Vector3(...p).applyMatrix4(A);
      const b = new THREE.Vector3(...p).applyMatrix4(B);
      const earth = k >= attach.length - 2;
      cableAlong(a, b, cableSpec.sagPerSpan * span * (earth ? 0.8 : 1), earth ? cableSpec.earthRadius : cableSpec.phaseRadius);
    });
  }
  const guys = (assets.course_radio_tower.extras.guys ?? []) as { level: number; leg: number; at: [number, number, number] }[];
  const anchorTop = (assets.course_radio_tower.extras.guyAnchorTop ?? [0, 1.5, 0]) as [number, number, number];
  for (const gy of guys) {
    const anchor = t.anchors[gy.leg];
    if (!anchor) continue;
    const a = new THREE.Vector3(...gy.at).applyMatrix4(towerBase);
    const b = new THREE.Vector3(anchor[0] + anchorTop[0], anchorTop[1], anchor[1] + anchorTop[2]);
    cableAlong(a, b, 0.006 * a.distanceTo(b), 0.024);
  }
  let cables: THREE.Mesh | null = null;
  if (cableGeoms.length) {
    const merged = mergeGeometries(cableGeoms, false);
    for (const g of cableGeoms) g.dispose();
    const cm = new THREE.MeshStandardNodeMaterial({ color: 0x4a4e50, roughness: 0.42, metalness: 0.85 });
    cm.name = 'course:cables';
    // coverage blended, as the far ropes are: sub-pixel wires neither occlude nor write depth, and they draw after the
    // ocean (a transparent, depth-writing mesh at order 0) so the sea behind a span does not paint over it
    applyMinWidth(cm, 'blend');
    cm.transparent = true;
    cm.depthWrite = false;
    cables = new THREE.Mesh(merged, cm);
    cables.name = 'course-cables';
    cables.castShadow = false;
    cables.renderOrder = SPRAY_OVER_WATER_ORDER;
    root.add(cables);
  }

  // ── §T.202 start pontoons + the pace boat's follow-me rig (in-engine meshes) ──
  const markers = createStartMarkers(data.startPontoons);
  root.add(markers.group);

  // ── per frame ──────────────────────────────────────────────────────────
  const camPos = new THREE.Vector3();
  const tmp = new THREE.Matrix4();
  const tilt = new THREE.Matrix4();
  const rot = new THREE.Matrix4();
  const back = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const n = new THREE.Vector3();
  const frustum = new THREE.Frustum();
  const sphere = new THREE.Sphere();
  const hyst = COURSE_CONTRACT.lod.hysteresis;
  const lampGroups = groups.filter((g) => g.members.some((m) => [0, 1, 2].some((lod) => buckets.has(bucketKey(g.asset, m.variant, lod)))));

  /** push a group's pose, LOD and cull state into its batched instances */
  const syncBatched = (g: Group): void => {
    for (const sl of g.slots) {
      if (sl.near) {
        const show = !g.culled && g.lod === 0;
        if (show && (g.moved || !sl.nearShown)) {
          tmp.copy(g.pose);
          if (sl.local) tmp.multiply(sl.local);
          sl.near.setMatrixAt(sl.nearId, tmp);
        }
        if (show !== sl.nearShown) {
          sl.near.setVisibleAt(sl.nearId, show);
          sl.nearShown = show;
        }
      } else if (sl.far) {
        const geometry = !g.culled && g.lod >= 1 ? sl.farGeometry[g.lod] : null;
        const show = geometry !== null && geometry !== undefined;
        if (show) {
          if (geometry !== sl.farCurrent) {
            sl.far.setGeometryIdAt(sl.farId, geometry);
            sl.farCurrent = geometry;
          }
          if (g.moved || !sl.farShown) {
            tmp.copy(g.pose);
            if (sl.local) tmp.multiply(sl.local);
            sl.far.setMatrixAt(sl.farId, tmp);
          }
        }
        if (show !== sl.farShown) {
          sl.far.setVisibleAt(sl.farId, show);
          sl.farShown = show;
        }
      }
    }
    g.moved = false;
  };

  /** the lamp buckets hold only groups in view this frame; an empty bucket is hidden */
  const packLamps = (): void => {
    for (const b of buckets.values()) b.packed.length = 0;
    for (const g of lampGroups) {
      if (g.culled) continue;
      sphere.copy(g.sphere).applyMatrix4(g.pose);
      if (!frustum.intersectsSphere(sphere)) continue;
      for (const m of g.members) {
        const b = buckets.get(bucketKey(g.asset, m.variant, g.lod));
        if (!b) continue;
        const i = b.packed.length;
        tmp.copy(g.pose);
        if (m.local) tmp.multiply(m.local);
        for (const mesh of b.meshes) mesh.setMatrixAt(i, tmp);
        b.packed.push({ g, m });
      }
    }
    for (const b of buckets.values()) {
      for (const mesh of b.meshes) {
        mesh.count = b.packed.length;
        mesh.visible = b.packed.length > 0;
        if (mesh.visible) mesh.instanceMatrix.needsUpdate = true;
      }
    }
  };

  return {
    group: root,
    foamTargets,
    update(f) {
      f.camera.getWorldPosition(camPos);
      f.camera.updateMatrixWorld();
      tmp.multiplyMatrices(f.camera.projectionMatrix, f.camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(tmp, f.camera.coordinateSystem);
      for (const g of groups) {
        const d = Math.hypot(camPos.x - g.x, camPos.z - g.z, camPos.y);
        const sw = COURSE_CONTRACT.assets[g.asset].switchDistance;
        let lod = g.lod < 0 ? (d < sw[0] ? 0 : d < sw[1] ? 1 : 2) : g.lod;
        if (lod === 0 && d > sw[0] * (1 + hyst)) lod = 1;
        if (lod === 1 && d < sw[0] * (1 - hyst)) lod = 0;
        if (lod === 1 && d > sw[1] * (1 + hyst)) lod = 2;
        if (lod === 2 && d < sw[1] * (1 - hyst)) lod = 1;
        let changed = lod !== g.lod;
        g.lod = lod;
        const far = COURSE_CULL_DISTANCE[g.asset];
        const culled = g.culled ? d > far : d > far * (1 + hyst);
        // back in range: the bob filter restarts from the sea it is on now, not from where it was left
        const snap = g.culled && !culled;
        if (culled !== g.culled) {
          g.culled = culled;
          changed = true;
        }
        if (!culled && g.bob && f.waterHeightAt) {
          const h = f.waterHeightAt(g.x, g.z);
          const sx = (f.waterHeightAt(g.x + BOB_PROBE, g.z) - f.waterHeightAt(g.x - BOB_PROBE, g.z)) / (2 * BOB_PROBE);
          const sz = (f.waterHeightAt(g.x, g.z + BOB_PROBE) - f.waterHeightAt(g.x, g.z - BOB_PROBE)) / (2 * BOB_PROBE);
          const k = snap ? 1 : 1 - Math.exp(-Math.max(f.dt, 0) / Math.max(g.bob.lagSeconds, 1e-3));
          g.heave += (h * g.bob.heaveGain - g.heave) * k;
          const cap = g.bob.maxTiltRad;
          g.tiltX += (Math.max(-cap, Math.min(cap, -sx * g.bob.tiltGain)) - g.tiltX) * k;
          g.tiltZ += (Math.max(-cap, Math.min(cap, -sz * g.bob.tiltGain)) - g.tiltZ) * k;
          // pivot below the waterline: the spar swings about its float, not about its top
          n.set(-g.tiltX, 1, -g.tiltZ).normalize();
          q.setFromUnitVectors(Y, n);
          tilt.makeTranslation(g.x, g.heave + g.bob.pivotY, g.z).multiply(rot.makeRotationFromQuaternion(q)).multiply(back.makeTranslation(-g.x, -g.bob.pivotY, -g.z));
          g.pose.multiplyMatrices(tilt, g.base);
          g.moved = true;
        }
        if (changed || g.moved) syncBatched(g);
      }
      packLamps();
      for (const b of buckets.values()) {
        if (!b.packed.length) continue;
        b.packed.forEach(({ m }, i) => {
          const level = m.lamp ? m.lamp(f) : 0;
          for (const attr of b.lamp) attr.setX(i, level);
        });
        for (const attr of b.lamp) attr.needsUpdate = true;
      }
      markers.update(f);
    },
    stats() {
      const drawn = new Set<THREE.Object3D>();
      let instances = 0;
      let tris = 0;
      const hist = [0, 0, 0];
      const range = { start: 0, count: 0 } as THREE.BatchedMeshGeometryRange;
      for (const g of groups) {
        for (const sl of g.slots) {
          const bm = sl.nearShown ? sl.near : sl.farShown ? sl.far : null;
          if (!bm) continue;
          drawn.add(bm);
          instances++;
          bm.getGeometryRangeAt(sl.nearShown ? sl.nearGeometry : sl.farCurrent, range);
          tris += range.count / 3;
        }
      }
      for (const b of buckets.values()) {
        for (const mesh of b.meshes) {
          if (mesh.count === 0) continue;
          drawn.add(mesh);
          instances += mesh.count;
          const idx = mesh.geometry.index;
          tris += ((idx ? idx.count : mesh.geometry.attributes.position.count) / 3) * mesh.count;
        }
      }
      let draws = drawn.size;
      for (const g of groups) if (g.lod >= 0 && !g.culled) hist[g.lod]++;
      if (cables) {
        draws++;
        tris += (cables.geometry.index?.count ?? 0) / 3;
      }
      const textureMB = loaded.reduce((s, a) => s + a.textureBytes, 0) / (1024 * 1024);
      return { draws, instances, trianglesDrawn: Math.round(tris), textureMB, anisotropy, lodHistogram: hist };
    },
    dispose() {
      for (const b of buckets.values()) for (const mesh of b.meshes) mesh.dispose();
      for (const bm of batches) bm.dispose();
      for (const m of materials.values()) m.dispose();
      markers.dispose();
      cables?.geometry.dispose();
      (cables?.material as THREE.Material | undefined)?.dispose();
      footings?.geometry.dispose();
      (footings?.material as THREE.Material | undefined)?.dispose();
      for (const a of loaded) for (const lod of a.lods) for (const prims of lod?.values() ?? []) for (const p of prims) p.geometry.dispose();
    },
  };
}
