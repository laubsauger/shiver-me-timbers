/**
 * Speedboat asset runtime (src/speedboat/assets/): the mapping from what the GLB SAYS (glTF
 * extras) to what the sea systems READ (foamTarget on meshes + injection layer, wetline span,
 * LOD switch distances), and an end-to-end parse of the built pipeline-test GLB through
 * three's GLTFLoader + MeshoptDecoder into slot node materials — no GPU needed.
 *
 * Why each matters: flowfoam's injection walk only tests MESHES, so a tag left on the glTF node
 * (a Group, for a multi-material hull) means no foam at the hull; a wrong stem/transom squeezes the
 * wetline onto the wrong planks; and eight boats must share ≤ 7 materials or the pipeline budget
 * (doc §5.3) is gone.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { readBytes } from '../scripts/blender/checkGlb.mjs';
import { FOAM_INJECTION_LAYER } from '../src/flowfoam/accumulation';
import {
  ASSET_CONTRACT,
  lodDistances,
  readBoatExtras,
  tagFoamTargets,
  textureBytes,
  wetlineOptions,
  type TaggableObject,
} from '../src/speedboat/assets/contract';
import { assetFromGltf } from '../src/speedboat/assets/boatModel';
import { buildDeepVHull, REFERENCE_DEEP_V } from '../src/speedboat/hullMesh';

const goodExtras = (): Record<string, unknown> => ({
  assetKind: 'player',
  contractVersion: ASSET_CONTRACT.version,
  bowZ: 8.4,
  sternZ: -3.6,
  beam: 2.9,
  keelY: -0.818,
  deckY: 0.856,
  pipelineTest: true,
});

describe('extras → foamTarget / layer 27', () => {
  it('a hull node tag reaches every mesh under it, and only those (flowfoam tests meshes, not nodes)', () => {
    const mesh = (): THREE.Mesh => new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    const lod0 = new THREE.Group();
    const hull = new THREE.Group();
    hull.userData = { foamTarget: true, lodLevel: 0 }; // GLTFLoader: multi-primitive node → Group
    const bottom = mesh();
    const topsides = mesh();
    hull.add(bottom, topsides);
    const rail = mesh();
    rail.userData = { lodLevel: 0 };
    lod0.add(hull, rail);

    const tagged = tagFoamTargets(lod0 as unknown as TaggableObject, FOAM_INJECTION_LAYER);
    expect(tagged).toHaveLength(2);
    for (const m of [bottom, topsides]) {
      expect(m.userData.foamTarget).toBe(true);
      expect(m.layers.isEnabled(FOAM_INJECTION_LAYER)).toBe(true);
    }
    expect(rail.userData.foamTarget).toBeUndefined();
    expect(rail.layers.isEnabled(FOAM_INJECTION_LAYER)).toBe(false);
    expect(FOAM_INJECTION_LAYER).toBe(27);
  });

  it('a single-primitive hull (the node IS the mesh) is tagged too', () => {
    const hull = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    hull.userData = { foamTarget: true };
    expect(tagFoamTargets(hull as unknown as TaggableObject, FOAM_INJECTION_LAYER)).toHaveLength(1);
    expect(hull.layers.isEnabled(27)).toBe(true);
  });
});

describe('root extras → wetline span', () => {
  it('reads a valid root and hands the wetline its stem/transom', () => {
    const extras = readBoatExtras(goodExtras());
    expect(wetlineOptions(extras)).toEqual({ bowZ: 8.4, sternZ: -3.6 });
    expect(extras.pipelineTest).toBe(true);
  });

  it('refuses a boat the wetline would map wrongly, loudly', () => {
    const bad = (patch: Record<string, unknown>) => () => readBoatExtras({ ...goodExtras(), ...patch });
    expect(bad({ bowZ: undefined })).toThrow(/missing bowZ/);
    expect(bad({ bowZ: Number.NaN })).toThrow(/bowZ must be a finite number/);
    expect(bad({ bowZ: -5 })).toThrow(/must exceed sternZ/);
    expect(bad({ contractVersion: ASSET_CONTRACT.version + 1 })).toThrow(/rebuild the GLB/);
    expect(bad({ assetKind: 'hero' })).toThrow(/not player\|npc/);
  });
});

describe('LOD thresholds are screen fractions (doc §5.3), THREE.LOD wants distances', () => {
  it('the distance returned puts the boat at exactly that fraction of the screen height', () => {
    const [d0, d1] = lodDistances(12, 55, ASSET_CONTRACT.lod.switchScreenFraction);
    const t = Math.tan((55 * Math.PI) / 360);
    expect(12 / (2 * d0 * t)).toBeCloseTo(0.35, 9);
    expect(12 / (2 * d1 * t)).toBeCloseTo(0.12, 9);
    expect(d1).toBeGreaterThan(d0); // coarser level further away
    // a narrower lens keeps the detailed level to a greater distance
    expect(lodDistances(12, 30, [0.35])[0]).toBeGreaterThan(d0);
  });
});

describe('texture memory readout', () => {
  it('counts the uploaded mip chain for compressed textures, RGBA8 + mips otherwise', () => {
    expect(textureBytes({ isCompressedTexture: true, mipmaps: [{ data: new Uint8Array(1024) }, { data: new Uint8Array(256) }] })).toBe(1280);
    expect(textureBytes({ image: { width: 256, height: 256 } })).toBe(Math.round(256 * 256 * 4 * (4 / 3)));
  });
});

describe('the built pipeline-test GLB through GLTFLoader + MeshoptDecoder (no GPU)', () => {
  /** stands in for KTX2Loader, which needs a renderer and a worker: one tiny compressed texture per image */
  const fakeKtx2 = {
    load(_url: string, onLoad: (t: THREE.CompressedTexture) => void): void {
      const mip = { data: new Uint8Array(64), width: 4, height: 4 };
      onLoad(new THREE.CompressedTexture([mip] as unknown as ImageData[], 4, 4, THREE.RGBA_ASTC_4x4_Format));
    },
  };

  const parse = async () => {
    const bytes = readBytes(decodeURIComponent(new URL('../assets/models/speedboat_pipeline_test.glb', import.meta.url).pathname));
    await MeshoptDecoder.ready;
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    loader.setKTX2Loader(fakeKtx2 as unknown as Parameters<GLTFLoader['setKTX2Loader']>[0]);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    // GLTFLoader reads `self.URL` to blob-wrap embedded images; node has URL but no `self`
    const g = globalThis as unknown as { self?: unknown };
    const hadSelf = 'self' in g;
    if (!hadSelf) g.self = globalThis;
    try {
      const gltf = await loader.parseAsync(buf, '');
      return assetFromGltf(gltf.scene);
    } finally {
      if (!hadSelf) delete g.self;
    }
  };

  it('extras sit on the physics proxy and every LOD is lighter than the last', async () => {
    const asset = await parse();
    const proxy = buildDeepVHull(REFERENCE_DEEP_V);
    expect(asset.extras.bowZ).toBeCloseTo(proxy.stemZ, 2);
    expect(asset.extras.sternZ).toBeCloseTo(proxy.transomZ, 2);
    expect(asset.extras.keelY).toBeCloseTo(proxy.keelBodyY, 2);
    expect(asset.extras.pipelineTest).toBe(true);
    expect(asset.stats.lods.length).toBe(ASSET_CONTRACT.lod.levels);
    for (let i = 1; i < asset.stats.lods.length; i++) expect(asset.stats.lods[i].tris).toBeLessThan(asset.stats.lods[i - 1].tris);
    expect(asset.stats.lods[0].tris).toBeLessThanOrEqual(ASSET_CONTRACT.assetKinds.player.triBudget[0]);
    expect(asset.stats.materials).toBeLessThanOrEqual(ASSET_CONTRACT.maxMaterials);
    expect(asset.stats.textureBytes).toBeGreaterThan(0);
  });

  it('instances: slot node materials shared across boats, hulls foam-tagged per LOD, livery per boat', async () => {
    const asset = await parse();
    const boats = Array.from({ length: 8 }, (_, i) => asset.instantiate({ variant: i === 0 ? 'hero' : 'npc', water: false, livery: 0x100000 * i }));
    const materials = new Set<THREE.Material>();
    for (const b of boats) {
      expect(b.object.levels.length).toBe(ASSET_CONTRACT.lod.levels);
      b.object.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const mat = m.material as THREE.Material;
        expect(mat).toBeInstanceOf(THREE.MeshPhysicalNodeMaterial);
        materials.add(mat);
      });
      b.hulls.forEach((level) => {
        expect(level.length).toBeGreaterThan(0);
        for (const h of level) {
          expect(h.userData.foamTarget).toBe(true);
          expect(h.layers.isEnabled(FOAM_INJECTION_LAYER)).toBe(true);
        }
      });
    }
    // hero + npc variants: at most 7 slots each, regardless of boat count
    const slotsPerVariant = asset.slots.length;
    expect(materials.size).toBe(2 * slotsPerVariant);
    expect(slotsPerVariant).toBeLessThanOrEqual(7);
    expect(boats[3].object.userData.liveryTint).toBe(0x300000);
    boats[3].setLivery(null);
    expect(boats[3].object.userData.liveryTint).toBeUndefined();

    const perspex = (b: (typeof boats)[number]): THREE.MeshPhysicalNodeMaterial | undefined => {
      let found: THREE.MeshPhysicalNodeMaterial | undefined;
      b.object.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshPhysicalNodeMaterial | undefined;
        if (m?.name.startsWith('M_Perspex')) found = m;
      });
      return found;
    };
    // hero pays for transmission once; the seven NPCs use alpha (doc §5.4)
    expect(perspex(boats[0])?.transmission).toBeGreaterThan(0);
    expect(perspex(boats[1])?.transparent).toBe(true);
    expect(perspex(boats[1])?.transmission).toBe(0);
  });
});
