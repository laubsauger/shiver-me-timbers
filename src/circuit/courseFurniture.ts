/**
 * COURSE FURNITURE RUNTIME (§T.187): the course GLBs (scripts/blender/course, contract
 * src/circuit/assets/courseAssetContract.json) drawn at the placements `buildTowerReach` measured.
 *
 * DRAWS. Every variant node of every asset is one InstancedMesh per primitive per LOD, shared by all
 * placements of that variant — 18 gate poles cost the same draws as one. Each placement is a GROUP of
 * variants (a pole = Spar + Strobe + board + numeral) that picks its LOD as one object, by camera
 * distance against the contract's `switchDistance` with hysteresis, and the per-LOD meshes are
 * re-packed (matrices + lamp levels) only when an assignment or a pose changed.
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
 */
import * as THREE from 'three/webgpu';
import { attribute, float, mix, normalMap, normalWorldGeometry, positionWorld, texture, uniform, vec2 } from 'three/tsl';
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

/** a slot material with the shared water lighting folded in (slotMaterials.ts's recipe, course slots) */
function courseMaterial(slot: string, s: THREE.MeshStandardMaterial, water: boolean): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = `course:${slot}`;
  const factor = uniform(s.color ? s.color.clone() : new THREE.Color(1, 1, 1));
  const map = s.map ? texture(s.map) : null;
  const albedo: Node = map ? map.rgb.mul(factor) : factor;
  const ormTex = s.roughnessMap ?? s.aoMap ?? s.metalnessMap ?? null;
  const orm = ormTex ? texture(ormTex) : null;
  const rough: Node = orm ? orm.g.mul(s.roughness ?? 1) : float(s.roughness ?? 0.6);
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
  heave: number;
  tiltX: number;
  tiltZ: number;
  pose: THREE.Matrix4;
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

  // ── placements → groups ────────────────────────────────────────────────
  const groups: Group[] = [];
  const add = (asset: CourseAssetName, x: number, z: number, base: THREE.Matrix4, members: Group['members'], bob?: BobSpec): void => {
    groups.push({ asset, x, z, base, members, bob, lod: -1, heave: 0, tiltX: 0, tiltZ: 0, pose: base.clone() });
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

  // ── instanced meshes per (asset, variant, lod, primitive) ──────────────
  const root = new THREE.Group();
  root.name = 'course-furniture';
  const materials = new Map<string, THREE.MeshStandardNodeMaterial>();
  const materialFor = (asset: CourseAssetName, prim: Prim): THREE.MeshStandardNodeMaterial => {
    const key = `${asset}:${prim.slot}`;
    let m = materials.get(key);
    if (!m) {
      m = courseMaterial(prim.slot, prim.source, water);
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
  for (const name of names) {
    const a = assets[name];
    const capacity = new Map<string, number>();
    for (const g of groups) if (g.asset === name) for (const m of g.members) capacity.set(m.variant, (capacity.get(m.variant) ?? 0) + 1);
    for (let lod = 0; lod < a.lods.length; lod++) {
      for (const [variant, prims] of a.lods[lod] ?? new Map()) {
        const cap = capacity.get(variant) ?? 0;
        if (cap === 0) continue;
        const b: Bucket = { meshes: [], lamp: [], packed: [] };
        for (const prim of prims) {
          const geom = prim.geometry;
          const mesh = new THREE.InstancedMesh(geom, materialFor(name, prim), cap);
          mesh.name = `${name}/${variant}_LOD${lod}/${prim.slot}`;
          mesh.count = 0;
          mesh.frustumCulled = false;
          mesh.castShadow = lod < 2 && name !== 'course_roofs';
          mesh.receiveShadow = true;
          if (prim.slot === 'C_Lamp') {
            const attr = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
            attr.setUsage(THREE.DynamicDrawUsage);
            geom.setAttribute('lampLevel', attr);
            b.lamp.push(attr);
          }
          if (lod === 0 && straddles.has(variant)) {
            mesh.userData.foamTarget = true;
            foamTargets.push(mesh);
          }
          b.meshes.push(mesh);
          root.add(mesh);
        }
        buckets.set(bucketKey(name, variant, lod), b);
      }
    }
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
    cableGeoms.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), n, radius, 5, false));
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
    cables = new THREE.Mesh(merged, cm);
    cables.name = 'course-cables';
    cables.castShadow = false;
    root.add(cables);
  }

  // ── per frame ──────────────────────────────────────────────────────────
  const camPos = new THREE.Vector3();
  const tmp = new THREE.Matrix4();
  const tilt = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const n = new THREE.Vector3();
  let dirty = true;
  const hyst = COURSE_CONTRACT.lod.hysteresis;

  const repack = (): void => {
    for (const b of buckets.values()) {
      for (const mesh of b.meshes) mesh.count = 0;
      b.packed.length = 0;
    }
    for (const g of groups) {
      for (const m of g.members) {
        const b = buckets.get(bucketKey(g.asset, m.variant, g.lod));
        if (!b) continue;
        const i = b.packed.length;
        tmp.copy(g.pose);
        if (m.local) tmp.multiply(m.local);
        for (const mesh of b.meshes) {
          mesh.setMatrixAt(i, tmp);
          mesh.count = i + 1;
        }
        b.packed.push({ g, m });
      }
    }
    for (const b of buckets.values()) for (const mesh of b.meshes) mesh.instanceMatrix.needsUpdate = true;
  };

  return {
    group: root,
    foamTargets,
    update(f) {
      f.camera.getWorldPosition(camPos);
      for (const g of groups) {
        const d = Math.hypot(camPos.x - g.x, camPos.z - g.z, camPos.y);
        const sw = COURSE_CONTRACT.assets[g.asset].switchDistance;
        let lod = g.lod < 0 ? (d < sw[0] ? 0 : d < sw[1] ? 1 : 2) : g.lod;
        if (lod === 0 && d > sw[0] * (1 + hyst)) lod = 1;
        if (lod === 1 && d < sw[0] * (1 - hyst)) lod = 0;
        if (lod === 1 && d > sw[1] * (1 + hyst)) lod = 2;
        if (lod === 2 && d < sw[1] * (1 - hyst)) lod = 1;
        if (lod !== g.lod) {
          g.lod = lod;
          dirty = true;
        }
        if (g.bob && f.waterHeightAt) {
          const h = f.waterHeightAt(g.x, g.z);
          const sx = (f.waterHeightAt(g.x + BOB_PROBE, g.z) - f.waterHeightAt(g.x - BOB_PROBE, g.z)) / (2 * BOB_PROBE);
          const sz = (f.waterHeightAt(g.x, g.z + BOB_PROBE) - f.waterHeightAt(g.x, g.z - BOB_PROBE)) / (2 * BOB_PROBE);
          const k = 1 - Math.exp(-Math.max(f.dt, 0) / Math.max(g.bob.lagSeconds, 1e-3));
          g.heave += (h * g.bob.heaveGain - g.heave) * k;
          const cap = g.bob.maxTiltRad;
          g.tiltX += (Math.max(-cap, Math.min(cap, -sx * g.bob.tiltGain)) - g.tiltX) * k;
          g.tiltZ += (Math.max(-cap, Math.min(cap, -sz * g.bob.tiltGain)) - g.tiltZ) * k;
          // pivot below the waterline: the spar swings about its float, not about its top
          n.set(-g.tiltX, 1, -g.tiltZ).normalize();
          q.setFromUnitVectors(Y, n);
          tilt.makeTranslation(g.x, g.heave + g.bob.pivotY, g.z).multiply(new THREE.Matrix4().makeRotationFromQuaternion(q)).multiply(new THREE.Matrix4().makeTranslation(-g.x, -g.bob.pivotY, -g.z));
          g.pose.multiplyMatrices(tilt, g.base);
          dirty = true;
        }
      }
      if (dirty) {
        repack();
        dirty = false;
      }
      for (const b of buckets.values()) {
        if (!b.lamp.length) continue;
        b.packed.forEach(({ m }, i) => {
          const level = m.lamp ? m.lamp(f) : 0;
          for (const attr of b.lamp) attr.setX(i, level);
        });
        for (const attr of b.lamp) attr.needsUpdate = true;
      }
    },
    stats() {
      let draws = 0;
      let instances = 0;
      let tris = 0;
      const hist = [0, 0, 0];
      for (const b of buckets.values()) {
        for (const mesh of b.meshes) {
          if (mesh.count === 0) continue;
          draws++;
          instances += mesh.count;
          const idx = mesh.geometry.index;
          tris += ((idx ? idx.count : mesh.geometry.attributes.position.count) / 3) * mesh.count;
        }
      }
      for (const g of groups) if (g.lod >= 0) hist[g.lod]++;
      if (cables) {
        draws++;
        tris += (cables.geometry.index?.count ?? 0) / 3;
      }
      const textureMB = loaded.reduce((s, a) => s + a.textureBytes, 0) / (1024 * 1024);
      return { draws, instances, trianglesDrawn: Math.round(tris), textureMB, anisotropy, lodHistogram: hist };
    },
    dispose() {
      for (const b of buckets.values()) for (const mesh of b.meshes) mesh.dispose();
      for (const m of materials.values()) m.dispose();
      cables?.geometry.dispose();
      (cables?.material as THREE.Material | undefined)?.dispose();
      for (const a of loaded) for (const lod of a.lods) for (const prims of lod?.values() ?? []) for (const p of prims) p.geometry.dispose();
    },
  };
}
