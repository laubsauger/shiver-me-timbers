/**
 * Speedboat GLB loader + instances (docs/speedboat/asset-pipeline.md §Runtime).
 *
 *   const loader = await createBoatAssetLoader(app.renderer);   // after renderer.init()
 *   const asset  = await loader.load(HERO_BOAT_URL);
 *   // sea pages: setActiveCaustics(...) and caustics.attachHullWetline(wetlineOptions(asset.extras))
 *   // BEFORE instantiate — the slot materials bake waterLighting() at construction
 *   const boat = asset.instantiate({ variant: 'hero', water: true, livery: FLEET_LIVERIES.yellow });
 *   scene.add(boat.object);
 *
 * One asset → any number of instances sharing geometry, textures and (per variant) materials:
 * ≤ 7 pipelines for all eight boats (doc §5.3). Livery is per instance via `userData.boatLivery` (hues + race
 * number, livery.ts) or the older single hue `userData.liveryTint`.
 *
 * §V109: imports nothing from main.ts, main-raft.ts, raft/, combat/ or ai/
 * (tests/assetPipelineIsolation.test.ts walks the graph).
 */
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
// Vite-correct transcoder hosting: the files are emitted as hashed assets (dev and build alike)
// and KTX2Loader's fixed filenames are redirected to them through its LoadingManager, so nothing
// is copied into a public/ dir and nothing 404s after a three upgrade.
import basisTranscoderJsUrl from 'three/addons/libs/basis/basis_transcoder.js?url';
import basisTranscoderWasmUrl from 'three/addons/libs/basis/basis_transcoder.wasm?url';
import { FOAM_INJECTION_LAYER } from '../../flowfoam/accumulation';
import {
  ASSET_CONTRACT,
  isSlotName,
  lodDistances,
  readBoatExtras,
  tagFoamTargets,
  textureBytes,
  type BoatExtras,
  type SlotName,
  type TaggableObject,
} from './contract';
import type { BoatLivery } from './livery';
import { createSlotMaterial, type BoatVariant } from './slotMaterials';

/** the SB-12 hero boat (hero hull + parts) built by `node scripts/asset-build.mjs` */
export const HERO_BOAT_URL = new URL('../../../assets/models/speedboat_hero.glb', import.meta.url).href;
/** the pipeline-test GLB (`node scripts/asset-build.mjs --pipeline-test`) — NOT the hero model; only if built */
export const PIPELINE_TEST_BOAT_URL = new URL('../../../assets/models/speedboat_pipeline_test.glb', import.meta.url).href;

export interface BoatLodStats {
  level: number;
  tris: number;
  draws: number;
}

export interface BoatAssetStats {
  lods: BoatLodStats[];
  materials: number;
  textures: number;
  /** GPU bytes of every texture the asset uploads (compressed mip chains as transcoded) */
  textureBytes: number;
}

export interface BoatInstanceOptions {
  variant: BoatVariant;
  /** fold the sea's waterLighting() into the slot materials (needs setActiveCaustics first) */
  water: boolean;
  /** a full livery (hues + race number), or one hue (0xRRGGBB) for the band and cowl tops; omitted = the hero livery */
  livery?: BoatLivery | number;
  /** vertical FOV the LOD thresholds are converted at (default 55°, App's camera) */
  fovDeg?: number;
}

export interface BoatInstance {
  /** add this to the scene; its origin is the boat's CG (body frame) */
  readonly object: THREE.LOD;
  /** foam-tagged hull meshes per LOD level */
  readonly hulls: THREE.Mesh[][];
  setLivery(livery: BoatLivery | number | null): void;
  /** re-derive LOD switch distances after a FOV change (thresholds are screen fractions) */
  setFov(fovDeg: number): void;
  currentLevel(): number;
  /** swap every mesh's material, e.g. for a slot debug view; null restores the slot materials */
  overrideMaterials(pick: ((slot: SlotName, mesh: THREE.Mesh) => THREE.Material) | null): void;
}

export interface BoatAsset {
  readonly extras: BoatExtras;
  readonly stats: BoatAssetStats;
  readonly slots: readonly SlotName[];
  instantiate(opts: BoatInstanceOptions): BoatInstance;
  dispose(): void;
}

export interface BoatAssetLoader {
  load(url: string): Promise<BoatAsset>;
  dispose(): void;
}

const LOD_NAME = /^LOD(\d+)$/;

function triCount(geo: THREE.BufferGeometry): number {
  const n = geo.index ? geo.index.count : (geo.getAttribute('position')?.count ?? 0);
  return Math.floor(n / 3);
}

function meshesOf(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
  });
  return out;
}

function slotOf(mesh: THREE.Mesh): SlotName {
  const mat = mesh.material as THREE.Material;
  if (Array.isArray(mesh.material) || !isSlotName(mat.name)) {
    throw new Error(`speedboat asset: mesh '${mesh.name}' has material '${Array.isArray(mesh.material) ? '[array]' : mat.name}', not a contract slot`);
  }
  return mat.name;
}

const TEXTURE_KEYS = [
  'map', 'normalMap', 'aoMap', 'roughnessMap', 'metalnessMap', 'emissiveMap',
  'clearcoatMap', 'clearcoatRoughnessMap', 'clearcoatNormalMap', 'transmissionMap', 'thicknessMap',
] as const;

export function assetFromGltf(scene: THREE.Group): BoatAsset {
  if (scene.children.length !== 1) throw new Error(`speedboat asset: expected one root node, got ${scene.children.length}`);
  const root = scene.children[0];
  const extras = readBoatExtras(root.userData);

  const groups: THREE.Object3D[] = [];
  for (const child of root.children) {
    const m = LOD_NAME.exec(child.name);
    if (m) groups[Number(m[1])] = child;
  }
  if (groups.length === 0 || groups.some((g) => g === undefined)) {
    throw new Error(`speedboat asset: LOD groups must be contiguous from LOD0 (found ${root.children.map((c) => c.name).join(', ')})`);
  }

  const sources = new Map<SlotName, THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const lods: BoatLodStats[] = groups.map((g, level) => {
    let tris = 0;
    let draws = 0;
    for (const mesh of meshesOf(g)) {
      const slot = slotOf(mesh);
      if (!sources.has(slot)) sources.set(slot, mesh.material as THREE.Material);
      tris += triCount(mesh.geometry);
      draws++;
      const mat = mesh.material as unknown as Record<string, unknown>;
      for (const key of TEXTURE_KEYS) {
        const t = mat[key];
        if (t instanceof THREE.Texture) textures.add(t);
      }
    }
    return { level, tris, draws };
  });
  if (sources.size > ASSET_CONTRACT.maxMaterials) {
    throw new Error(`speedboat asset: ${sources.size} material slots > contract ${ASSET_CONTRACT.maxMaterials}`);
  }
  let bytes = 0;
  for (const t of textures) bytes += textureBytes(t as unknown as Parameters<typeof textureBytes>[0]);
  const stats: BoatAssetStats = { lods, materials: sources.size, textures: textures.size, textureBytes: bytes };

  const built = new Map<string, THREE.MeshPhysicalNodeMaterial>();
  const materialFor = (slot: SlotName, variant: BoatVariant, water: boolean): THREE.MeshPhysicalNodeMaterial => {
    const key = `${variant}:${water ? 'sea' : 'dry'}:${slot}`;
    let mat = built.get(key);
    if (mat === undefined) {
      mat = createSlotMaterial(slot, sources.get(slot) as THREE.Material, { variant, water });
      built.set(key, mat);
    }
    return mat;
  };
  const length = extras.bowZ - extras.sternZ;

  return {
    extras,
    stats,
    slots: [...sources.keys()],
    instantiate(opts: BoatInstanceOptions): BoatInstance {
      const lod = new THREE.LOD();
      lod.name = `${root.name}:${opts.variant}`;
      lod.userData = { ...root.userData, boatRoot: true };
      const applyLivery = (l: BoatLivery | number | null | undefined): void => {
        delete lod.userData.liveryTint;
        delete lod.userData.boatLivery;
        if (typeof l === 'number') lod.userData.liveryTint = l;
        else if (l) lod.userData.boatLivery = { ...l };
      };
      applyLivery(opts.livery);
      const slotMaterial = new Map<THREE.Mesh, THREE.Material>();
      const hulls: THREE.Mesh[][] = [];
      const levelObjects = groups.map((g, level) => {
        const copy = g.clone(true);
        for (const mesh of meshesOf(copy)) {
          const mat = materialFor(slotOf(mesh), opts.variant, opts.water);
          mesh.material = mat;
          slotMaterial.set(mesh, mat);
          mesh.userData.slot = mat.name.split(':')[0];
          // doc §6.5: LOD0/1 cast and receive, coarser levels only cast
          mesh.castShadow = true;
          mesh.receiveShadow = level < 2;
        }
        hulls[level] = tagFoamTargets(copy as unknown as TaggableObject, FOAM_INJECTION_LAYER) as unknown as THREE.Mesh[];
        if (hulls[level].length === 0) throw new Error(`speedboat asset: LOD${level} has no foamTarget hull`);
        return copy;
      });
      const place = (fovDeg: number): void => {
        const d = lodDistances(length, fovDeg, ASSET_CONTRACT.lod.switchScreenFraction);
        const hysteresis = ASSET_CONTRACT.lod.hysteresis;
        if (lod.levels.length === 0) {
          levelObjects.forEach((obj, i) => lod.addLevel(obj, i === 0 ? 0 : d[Math.min(i - 1, d.length - 1)], hysteresis));
        } else {
          lod.levels.forEach((lvl, i) => {
            lvl.distance = i === 0 ? 0 : d[Math.min(i - 1, d.length - 1)];
          });
        }
      };
      place(opts.fovDeg ?? 55);
      return {
        object: lod,
        hulls,
        setLivery: applyLivery,
        setFov: place,
        currentLevel: () => lod.getCurrentLevel(),
        overrideMaterials(pick): void {
          for (const [mesh, mat] of slotMaterial) {
            mesh.material = pick === null ? mat : pick(mesh.userData.slot as SlotName, mesh);
          }
        },
      };
    },
    dispose(): void {
      for (const mat of built.values()) mat.dispose();
      for (const mat of sources.values()) mat.dispose();
      for (const t of textures) t.dispose();
      root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose();
      });
    },
  };
}

/** call AFTER `await renderer.init()`: KTX2 support detection reads the device's features */
export async function createBoatAssetLoader(renderer: THREE.WebGPURenderer): Promise<BoatAssetLoader> {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url.endsWith('basis_transcoder.js')) return basisTranscoderJsUrl;
    if (url.endsWith('basis_transcoder.wasm')) return basisTranscoderWasmUrl;
    return url;
  });
  const ktx2 = new KTX2Loader(manager).setTranscoderPath('/basis/');
  await ktx2.detectSupportAsync(renderer);
  await MeshoptDecoder.ready;
  const gltf = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
  return {
    async load(url: string): Promise<BoatAsset> {
      const result = await gltf.loadAsync(url);
      return assetFromGltf(result.scene);
    },
    dispose(): void {
      ktx2.dispose();
    },
  };
}
