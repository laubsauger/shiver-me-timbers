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
import { readFileSync } from 'node:fs';
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
import { assetFromGltf, measureDeckEdge } from '../src/speedboat/assets/boatModel';
import { CONCEPT_LIVERIES, FLEET_LIVERIES, HERO_LIVERY, numberGlyphs, resolveLivery } from '../src/speedboat/assets/livery';
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

describe('the built hero GLB through GLTFLoader + MeshoptDecoder (no GPU)', () => {
  /** stands in for KTX2Loader, which needs a renderer and a worker: one tiny compressed texture per image */
  const fakeKtx2 = {
    load(_url: string, onLoad: (t: THREE.CompressedTexture) => void): void {
      const mip = { data: new Uint8Array(64), width: 4, height: 4 };
      onLoad(new THREE.CompressedTexture([mip] as unknown as ImageData[], 4, 4, THREE.RGBA_ASTC_4x4_Format));
    },
  };

  const parse = async (options?: Parameters<typeof assetFromGltf>[1]) => {
    const bytes = readBytes(decodeURIComponent(new URL('../assets/models/speedboat_hero.glb', import.meta.url).pathname));
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
      return { asset: assetFromGltf(gltf.scene, options), scene: gltf.scene };
    } finally {
      if (!hadSelf) delete g.self;
    }
  };

  it('extras sit on the physics proxy and every LOD is lighter than the last', async () => {
    const { asset } = await parse();
    const proxy = buildDeepVHull(REFERENCE_DEEP_V);
    expect(asset.extras.bowZ).toBeCloseTo(proxy.stemZ, 2);
    expect(asset.extras.sternZ).toBeCloseTo(proxy.transomZ, 2);
    expect(asset.extras.keelY).toBeCloseTo(proxy.keelBodyY, 2);
    expect(asset.extras.pipelineTest).toBe(false);
    expect(asset.stats.lods.length).toBe(ASSET_CONTRACT.lod.levels);
    for (let i = 1; i < asset.stats.lods.length; i++) expect(asset.stats.lods[i].tris).toBeLessThan(asset.stats.lods[i - 1].tris);
    expect(asset.stats.lods[0].tris).toBeLessThanOrEqual(ASSET_CONTRACT.assetKinds.player.triBudget[0]);
    expect(asset.stats.materials).toBeLessThanOrEqual(ASSET_CONTRACT.maxMaterials);
    expect(asset.stats.textureBytes).toBeGreaterThan(0);
  });

  it('instances: slot node materials shared across boats, hulls foam-tagged per LOD, livery per boat', async () => {
    const { asset } = await parse();
    const boats = Array.from({ length: 8 }, (_, i) => asset.instantiate({ variant: i === 0 ? 'hero' : 'npc', water: false, livery: 0x100000 * i }));
    const materials = new Set<THREE.Material>();
    for (const b of boats) {
      expect(b.object.levels.length).toBe(ASSET_CONTRACT.lod.levels);
      b.object.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        // runtime-only helpers are not slot materials: the water-mask cap and the prop blur discs (§T.192)
        if (m.userData.waterMask === true || m.name.startsWith('PropBlur_')) return;
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
    // §T.192: transmission read a backdrop copied before the ocean drew and showed a grey slab; every variant now
    // blends, after the ocean
    for (const b of [boats[0], boats[1]]) {
      expect(perspex(b)?.transparent).toBe(true);
      expect(perspex(b)?.transmission).toBe(0);
      expect(perspex(b)?.depthWrite).toBe(false);
    }
  });

  it('§T.192 water mask: one depth-only cap per boat over the whole cockpit sole, drawn between the opaque boat and the ocean', async () => {
    const { asset } = await parse();
    const b = asset.instantiate({ variant: 'hero', water: false });
    const cap = b.waterMask as THREE.Mesh;
    expect(cap).toBeTruthy();
    expect(cap.parent).toBe(b.object);
    const mat = cap.material as THREE.Material;
    // no colour, depth on, in the transparent pass (the ocean is transparent: §V.24) ahead of the ocean's order 0
    expect(mat.colorWrite).toBe(false);
    expect(mat.depthWrite).toBe(true);
    expect(mat.transparent).toBe(true);
    expect(cap.renderOrder).toBeLessThan(0);
    expect(cap.castShadow).toBe(false);
    // it lies on the deck and faces up (a down-facing cap is culled from every camera above the sheer)
    const pos = cap.geometry.getAttribute('position');
    const idx = cap.geometry.getIndex() as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) expect(pos.getY(i)).toBeCloseTo(asset.extras.deckY, 2);
    const a = new THREE.Vector3().fromBufferAttribute(pos, idx.getX(0));
    const c1 = new THREE.Vector3().fromBufferAttribute(pos, idx.getX(1));
    const c2 = new THREE.Vector3().fromBufferAttribute(pos, idx.getX(2));
    expect(c1.sub(a).cross(c2.sub(a)).y).toBeGreaterThan(0);
    // the seat sits inside it: a ray down through the pilot's eye point crosses the cap
    const eye = JSON.parse(String(b.object.userData.partsAnchors)).eye as number[];
    const ray = new THREE.Raycaster(new THREE.Vector3(eye[0], 5, eye[2]), new THREE.Vector3(0, -1, 0));
    cap.updateMatrixWorld(true);
    expect(ray.intersectObject(cap).length).toBe(1);
    // gauge glass (under the sheer, inside the well) draws BEFORE the cap; the windscreen after the ocean
    const orders = new Map<string, number>();
    b.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.userData.slot === 'M_Perspex') orders.set(/^GaugeGlass/.test(m.name) ? 'gauge' : 'screen', m.renderOrder);
    });
    expect(orders.get('gauge')).toBeLessThan(cap.renderOrder);
    expect(orders.get('screen')).toBeGreaterThan(0);
  });

  it('§T.192 drives: each outboard steers about ITS OWN swivel, its prop rides it, trim swings the lower unit aft, LOD1 matches LOD0', async () => {
    const { asset } = await parse();
    const b = asset.instantiate({ variant: 'npc', water: false });
    const node = (level: number, name: string): THREE.Object3D => b.object.levels[level].object.getObjectByName(name) as THREE.Object3D;
    const ob = node(0, 'Outboard_P_LOD0');
    const prop = node(0, 'Prop_P_LOD0');
    const drive1 = node(1, 'Drive_P_LOD1');
    expect(ob && prop && drive1).toBeTruthy();
    const steerPivot = new THREE.Vector3(...(ob.userData.steerPivot as [number, number, number]));
    const trimPivot = new THREE.Vector3(...(ob.userData.trimPivot as [number, number, number]));
    const propPivot = new THREE.Vector3(...(prop.userData.pivot as [number, number, number]));
    const at = (o: THREE.Object3D, p: THREE.Vector3): THREE.Vector3 => p.clone().applyMatrix4(o.matrix);

    const DEG = Math.PI / 180;
    b.setDriveState({ steerRad: 20 * DEG, trimRad: 0, propRpm: [0, 0, 0] }, 1 / 60);
    // the swivel stays put (the port drive does NOT swing about the centreline) …
    expect(at(ob, steerPivot).distanceTo(steerPivot)).toBeLessThan(1e-6);
    // … the thrust line turns toward +x (HullWater's sense: + steer → thrust from +z toward +x) …
    const fwd = new THREE.Vector3(0, 0, 1).transformDirection(ob.matrix);
    expect(Math.asin(fwd.x) / DEG).toBeCloseTo(20, 4);
    // … and the prop, 0.42 m aft of the swivel, swings with it: out to −x by that lever × sin 20°
    const lever = steerPivot.z - propPivot.z;
    expect(at(prop, propPivot).x - propPivot.x).toBeCloseTo(-lever * Math.sin(20 * DEG), 4);
    expect(drive1.matrix.equals(ob.matrix)).toBe(true);

    b.setDriveState({ steerRad: 0, trimRad: 8 * DEG, propRpm: [0, 0, 0] }, 1 / 60);
    // trim out: a lower-unit point below the tilt tube moves aft (−z) and up
    const skeg = new THREE.Vector3(trimPivot.x, trimPivot.y - 1.0, trimPivot.z);
    const moved = at(ob, skeg);
    expect(moved.z).toBeLessThan(skeg.z - 0.1);
    expect(moved.y).toBeGreaterThan(skeg.y);
  });

  it('§T.192 props: spin at rpm with a per-frame cap (no strobing), then a blur disc takes over and the blades hide', async () => {
    const { asset } = await parse();
    const b = asset.instantiate({ variant: 'npc', water: false });
    const lod0 = b.object.levels[0].object;
    const prop = lod0.getObjectByName('Prop_C_LOD0') as THREE.Object3D;
    const disc = lod0.getObjectByName('PropBlur_C_LOD0') as THREE.Mesh;
    expect(disc).toBeTruthy();
    const axis = new THREE.Vector3(...(prop.userData.axis as [number, number, number]));
    const pivot = new THREE.Vector3(...(prop.userData.pivot as [number, number, number]));
    const angle = (): number => {
      const q = new THREE.Quaternion().setFromRotationMatrix(prop.matrix);
      return 2 * Math.atan2(new THREE.Vector3(q.x, q.y, q.z).dot(axis), q.w);
    };
    // 300 rpm for one 60 fps frame = 30° exactly
    b.setDriveState({ steerRad: 0, trimRad: 0, propRpm: [300, 300, 300] }, 1 / 60);
    expect(Math.abs(angle()) / (Math.PI / 180)).toBeCloseTo(30, 3);
    expect(pivot.clone().applyMatrix4(prop.matrix).distanceTo(pivot)).toBeLessThan(1e-6);
    expect(prop.visible).toBe(true);
    expect(disc.visible).toBe(false);
    // 3000 rpm would be 300° a frame — it reads backwards; the drawn step is capped and the disc is fully in
    const before = angle();
    b.setDriveState({ steerRad: 0, trimRad: 0, propRpm: [3000, 3000, 3000] }, 1 / 60);
    let step = Math.abs(angle() - before);
    if (step > Math.PI) step = 2 * Math.PI - step;
    expect(step).toBeLessThanOrEqual(0.6 + 1e-9);
    expect(prop.visible).toBe(false);
    expect(disc.visible).toBe(true);
    expect(disc.userData.propBlur).toBe(1);
    // garbage in (§V28) leaves a finite pose
    b.setDriveState({ steerRad: Number.NaN, trimRad: Infinity, propRpm: [Number.NaN] }, Number.NaN);
    expect(prop.matrix.elements.every(Number.isFinite)).toBe(true);
  });

  it('§T.192 deck livery: the painted band follows the hull\'s own deck outline — full beam aft, a point at the stem', async () => {
    const { asset, scene } = await parse();
    const lod0 = scene.children[0].children.find((c) => c.name === 'LOD0');
    const edge = measureDeckEdge(lod0, asset.extras)!;
    expect(edge).toBeTruthy();
    expect(edge.half.length).toBe(64);
    // the render beam is the widest point of the deck outline amidships; the stem closes to (almost) nothing
    const widest = Math.max(...edge.half);
    expect(widest * 2).toBeCloseTo(asset.extras.beam, 1);
    expect(edge.half[edge.half.length - 1]).toBeLessThan(0.02);
    expect(edge.half[0]).toBeGreaterThan(0.9);
    // the band + stripe (0.22 m) fit inside the deck at the cockpit, so the non-skid field survives between them and the well
    const atZ = (z: number): number => edge.half[Math.round((z - edge.z0) / edge.dz)];
    expect(atZ(0) - 0.22).toBeGreaterThan(0.8 + 0.05);
    // and the NonSlip material got it (the paint is compiled in, not a debug toggle)
    const b = asset.instantiate({ variant: 'hero', water: false });
    let nonSlip: THREE.MeshPhysicalNodeMaterial | undefined;
    b.object.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshPhysicalNodeMaterial | undefined;
      if (m?.name?.startsWith('M_NonSlip')) nonSlip = m;
    });
    expect(nonSlip?.colorNode).toBeTruthy();
  });

  it('§T.192 anisotropic filtering on every boat texture, over linear mips (WebGPU ignores anisotropy otherwise)', async () => {
    const { asset, scene } = await parse({ anisotropy: 16 });
    expect(asset.stats.textures).toBeGreaterThan(0);
    const seen = new Set<THREE.Texture>();
    scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as unknown as Record<string, unknown> | undefined;
      if (!m) return;
      for (const v of Object.values(m)) if (v instanceof THREE.Texture) seen.add(v);
    });
    expect(seen.size).toBeGreaterThan(0);
    for (const t of seen) {
      expect(t.anisotropy).toBe(16);
      expect(t.magFilter).toBe(THREE.LinearFilter);
      expect([THREE.LinearFilter, THREE.LinearMipmapLinearFilter]).toContain(t.minFilter);
    }
  });
});

describe('fleet livery: eight boats, one texture set (STYLE-SPEC §4.2, §6)', () => {
  it('a boat wears the livery on its root; partial liveries and the old single hue fill from the hero', () => {
    // a rival that silently fell back to the hero hues would race as the hero
    expect(resolveLivery({ boatLivery: FLEET_LIVERIES['dome-ten'] })).toEqual(FLEET_LIVERIES['dome-ten']);
    expect(resolveLivery({ boatLivery: { band: 0x123456 } })).toEqual({ ...HERO_LIVERY, band: 0x123456 });
    // liveryTint is the lookdev/older API: it recolours the band and the cowl tops, nothing else
    expect(resolveLivery({ liveryTint: 0xd9442b })).toEqual({ ...HERO_LIVERY, band: 0xd9442b, dominant: 0xd9442b });
    expect(resolveLivery({ boatLivery: { topsides: Number.NaN, number: 5 } })).toEqual({ ...HERO_LIVERY, number: 5 });
    expect(resolveLivery(undefined)).toEqual(HERO_LIVERY);
  });

  it('dark-topsides rivals paint bone numerals, light ones black (the number must read, §4.3)', () => {
    const lum = (hex: number): number => 0.2126 * ((hex >> 16) & 255) + 0.7152 * ((hex >> 8) & 255) + 0.0722 * (hex & 255);
    for (const l of [...Object.values(FLEET_LIVERIES), ...Object.values(CONCEPT_LIVERIES)]) expect(Math.abs(lum(l.numeral) - lum(l.topsides))).toBeGreaterThan(60);
  });

  it('§T.200: the CPU preview fleet (hull_textures.py FLEET) is the race grid exactly, so the livery renders show the game', () => {
    const py = readFileSync(new URL('../scripts/blender/hull/hull_textures.py', import.meta.url), 'utf8');
    const hex = (s: string): number => Number.parseInt(s.slice(1), 16);
    for (const [id, l] of Object.entries(FLEET_LIVERIES)) {
      const row = new RegExp(`'${id}': \\{([^}]*)\\}`).exec(py);
      expect(row, `hull_textures.py FLEET has no '${id}' row`).not.toBeNull();
      const field = (k: string): number => hex((new RegExp(`'${k}': '(#[0-9A-Fa-f]{6})'`).exec(row![1]) ?? ['', '#000000'])[1]);
      for (const k of ['topsides', 'band', 'stripe', 'antifoul', 'numeral', 'dominant'] as const) expect(field(k), `${id}.${k}`).toBe(l[k]);
    }
  });

  it('race numbers map to one or two glyphs, never a leading zero', () => {
    expect(numberGlyphs(27)).toEqual([2, 7]);
    expect(numberGlyphs(8)).toEqual([8]);
    expect(numberGlyphs(10)).toEqual([1, 0]);
    expect(numberGlyphs(127)).toEqual([2, 7]);
  });

  it('the hero hull carries its livery mask and non-skid detail as the 4th texture, with the channel contract in extras', async () => {
    const bytes = readBytes(decodeURIComponent(new URL('../assets/models/speedboat_hero.glb', import.meta.url).pathname));
    await MeshoptDecoder.ready;
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    loader.setKTX2Loader({
      load(_url: string, onLoad: (t: THREE.CompressedTexture) => void): void {
        onLoad(new THREE.CompressedTexture([{ data: new Uint8Array(64), width: 4, height: 4 }] as unknown as ImageData[], 4, 4, THREE.RGBA_ASTC_4x4_Format));
      },
    } as unknown as Parameters<GLTFLoader['setKTX2Loader']>[0]);
    const g = globalThis as unknown as { self?: unknown };
    const hadSelf = 'self' in g;
    if (!hadSelf) g.self = globalThis;
    try {
      const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, '');
      const mats = new Map<string, THREE.MeshPhysicalMaterial>();
      gltf.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshPhysicalMaterial | undefined;
        if (m && (o as THREE.Mesh).isMesh) mats.set(m.name, m);
      });
      // antifoul folded into the gelcoat: hull 2 + parts 4 leaves the 7th slot for the pilot
      expect(mats.has('M_Antifoul')).toBe(false);
      const gel = mats.get('M_Gelcoat') as THREE.MeshPhysicalMaterial;
      const ns = mats.get('M_NonSlip') as THREE.MeshPhysicalMaterial;
      expect(gel.clearcoatMap).toBeTruthy();
      expect(ns.clearcoatNormalMap).toBeTruthy();
      const hl = gel.userData.hullLivery as { glyphAtlas: Record<string, number>; numberField: Record<string, number> };
      expect(hl.glyphAtlas.cellW).toBeGreaterThan(0);
      // the number sits on the topsides under the cockpit, between the keel and the deck (body frame)
      expect(hl.numberField.yCentre + REFERENCE_DEEP_V.vcgAboveKeel).toBeGreaterThan(0.5);
      expect(ns.userData.nonSkid.tileMetres).toBeGreaterThan(0);
    } finally {
      if (!hadSelf) delete g.self;
    }
  });
});
