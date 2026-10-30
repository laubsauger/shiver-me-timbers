/**
 * THE CIRCUIT'S KIT, READ FOR THE SUNKEN WORLD: the speedboat circuit's course GLBs (scripts/blender/course: the
 * drowned town's roofs, the pylons) loaded once per URL, and one variant's primitives at one level of detail, baked
 * into the variant's own frame. Shared by the town (town.ts) and the power line (powerLine.ts).
 *
 * With the renderer given, the KTX2 atlases are transcoded for it, as the circuit's own loader does
 * (circuit/courseFurniture.ts createCourseLoader): a part's own colour — brick, slate, galvanised steel — is what still
 * tells one part from another under the sea's growth. Without it, geometry only (no texture is fetched: tests, a
 * studio view).
 */
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import basisTranscoderJsUrl from 'three/addons/libs/basis/basis_transcoder.js?url';
import basisTranscoderWasmUrl from 'three/addons/libs/basis/basis_transcoder.wasm?url';

/** one primitive of a kit variant: its geometry (asset metres), its material slot and the kit's own material */
export interface KitPrim {
  geometry: THREE.BufferGeometry;
  slot: string;
  source: THREE.MeshStandardMaterial;
}

/** a GLTF loader that reads the geometry and none of the textures */
function geometryOnly(): GLTFLoader {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  // (the parser asks its plugins for each material before building its own: this one answers with a bare one named as
  // the slot was, so no texture is ever requested — radio/mast.ts's way)
  loader.register((parser) => ({
    name: 'drowned_geometry_only',
    loadMaterial: (i: number) => Promise.resolve(new THREE.MeshStandardMaterial({ name: String(parser.json.materials?.[i]?.name ?? '') })),
  }));
  return loader;
}

/** the circuit's own loader: KTX2 atlases transcoded for this renderer */
async function textured(renderer: THREE.WebGPURenderer): Promise<GLTFLoader> {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url.endsWith('basis_transcoder.js')) return basisTranscoderJsUrl;
    if (url.endsWith('basis_transcoder.wasm')) return basisTranscoderWasmUrl;
    return url;
  });
  const ktx2 = new KTX2Loader(manager).setTranscoderPath('/basis/');
  await renderer.init();
  ktx2.detectSupport(renderer);
  return new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
}

const roots = new Map<string, Promise<THREE.Object3D>>();
/** the kit's root (`rootName`, e.g. CF_course_roofs) from its URL (loaded once per URL and renderer kind) or the GLB's
 * own bytes; textured when given the renderer */
export function loadKitRoot(source: string | ArrayBuffer, rootName: string, renderer?: THREE.WebGPURenderer): Promise<THREE.Object3D> {
  const load = async (): Promise<THREE.Object3D> => {
    await MeshoptDecoder.ready;
    const loader = renderer ? await textured(renderer) : geometryOnly();
    const gltf = typeof source === 'string' ? await loader.loadAsync(source) : await loader.parseAsync(source, '');
    const root = gltf.scene.getObjectByName(rootName) ?? gltf.scene.children[0];
    if (!root) throw new Error(`drowned kit: no ${rootName} root`);
    const anisotropy = renderer ? renderer.getMaxAnisotropy() : 1;
    root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      // (without anisotropy the atlases go mushy at grazing angles: courseFurniture.ts)
      if (m) for (const t of [m.map, m.normalMap, m.roughnessMap, m.metalnessMap, m.aoMap]) if (t) t.anisotropy = anisotropy;
    });
    return root;
  };
  if (typeof source !== 'string') return load();
  const key = `${source}|${renderer ? 'tex' : 'geo'}`;
  let p = roots.get(key);
  if (!p) roots.set(key, (p = load()));
  return p;
}

/** a variant's primitives at `lod`, each geometry baked into the variant's own frame (the kit's origin) */
export function kitPrims(root: THREE.Object3D, lod: number, variant: string): KitPrim[] {
  const level = root.children.find((c) => c.name === `LOD${lod}`);
  const node = level?.children.find((c) => c.name === `${variant}_LOD${lod}`);
  if (!node) throw new Error(`drowned kit: no ${variant}_LOD${lod} under ${root.name}`);
  node.updateMatrixWorld(true);
  const toVariant = new THREE.Matrix4().copy(node.matrixWorld).invert();
  const prims: KitPrim[] = [];
  node.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const src = m.material as THREE.MeshStandardMaterial;
    prims.push({ geometry: m.geometry.clone().applyMatrix4(toVariant.clone().multiply(m.matrixWorld)), slot: src.name.replace(/\.\d+$/, ''), source: src });
  });
  return prims;
}

/** the root's extras (JSON-encoded strings parsed) */
export function kitExtra(root: THREE.Object3D, key: string): unknown {
  const v = root.userData?.[key];
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}
