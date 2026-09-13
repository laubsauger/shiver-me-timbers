/**
 * The speedboat GLB conventions checker (scripts/blender/checkGlb.mjs) is the build's gate: a
 * GLB it passes is one the runtime can shade in the body frame, float on the proxy's waterline,
 * foam-tag and draw inside the §V40 sampler wall. So each rule is proven here by a GLB that breaks
 * exactly that rule and must FAIL — a checker that can't fail is a checker that isn't there.
 *
 * GLBs are built in memory and round-tripped through writeBinary/readBinary, so the checker sees
 * real GLB bytes, not the Document that made them.
 */
import { describe, expect, it } from 'vitest';
import { Document, type Material, type Node } from '@gltf-transform/core';
import { checkDocument, createIO, hullTopology, ktx2LevelCount, readBytes } from '../scripts/blender/checkGlb.mjs';
import { ASSET_CONTRACT } from '../src/speedboat/assets/contract';
import { buildDeepVHull, REFERENCE_DEEP_V, deckHeight, hullStations, HULL_DATA } from '../src/speedboat/hullMesh';

const STERN = -3.6;
const BOW = 8.4;
const KEEL = -0.8;
const DECK = 0.85;
const HALF = 1.3;

interface BoatOptions {
  kind?: 'player' | 'npc';
  segments?: number[];
  /** mutate each hull's triangle list (indices into its vertex list) */
  editTris?: (tris: number[][], level: number) => void;
  /** map every hull vertex (x, y, z) → (x, y, z) */
  mapVertex?: (v: [number, number, number]) => [number, number, number];
  extras?: Record<string, unknown>;
  dropFoamTarget?: boolean;
  materials?: number;
  extraLod0Tris?: number;
  materialName?: string;
}

/** a closed, outward-wound, bow-tapered deep-V shell: stations × (keel, chine±, deck±) */
function hullGeometry(segments: number): { positions: number[]; tris: number[][] } {
  const positions: number[] = [];
  const P = 5;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const z = STERN + (BOW - STERN) * t;
    const b = HALF * Math.max(0.04, t < 0.6 ? 1 : Math.cos(((t - 0.6) / 0.4) * (Math.PI / 2)));
    const chineY = KEEL + b * 0.45;
    positions.push(0, KEEL, z, b, chineY, z, -b, chineY, z, b, DECK, z, -b, DECK, z);
  }
  const K = (i: number) => i * P;
  const Cp = (i: number) => i * P + 1;
  const Cm = (i: number) => i * P + 2;
  const Dp = (i: number) => i * P + 3;
  const Dm = (i: number) => i * P + 4;
  const tris: number[][] = [];
  const quad = (p0: number, p1: number, p2: number, p3: number, side: 1 | -1) => {
    if (side > 0) tris.push([p0, p1, p3], [p1, p2, p3]);
    else tris.push([p0, p3, p1], [p1, p3, p2]);
  };
  for (let i = 0; i < segments; i++) {
    quad(K(i), Cp(i), Cp(i + 1), K(i + 1), 1);
    quad(K(i), Cm(i), Cm(i + 1), K(i + 1), -1);
    quad(Cp(i), Dp(i), Dp(i + 1), Cp(i + 1), 1);
    quad(Cm(i), Dm(i), Dm(i + 1), Cm(i + 1), -1);
    tris.push([Dp(i), Dm(i), Dp(i + 1)], [Dm(i), Dm(i + 1), Dp(i + 1)]);
  }
  const n = segments;
  tris.push([K(0), Dp(0), Cp(0)], [K(0), Dm(0), Dp(0)], [K(0), Cm(0), Dm(0)]);
  tris.push([K(n), Cp(n), Dp(n)], [K(n), Dp(n), Dm(n)], [K(n), Dm(n), Cm(n)]);
  return { positions, tris };
}

function buildBoat(o: BoatOptions = {}): Document {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('Scene');
  doc.getRoot().setDefaultScene(scene);
  const slotNames = Object.keys(ASSET_CONTRACT.slots);
  const nMat = o.materials ?? 2;
  const mats: Material[] = [];
  for (let i = 0; i < nMat; i++) mats.push(doc.createMaterial(i === 0 && o.materialName ? o.materialName : (slotNames[i] ?? `M_Extra${i}`)));
  const root = doc.createNode('SB_test').setExtras({
    assetKind: o.kind ?? 'npc',
    contractVersion: ASSET_CONTRACT.version,
    bowZ: BOW,
    sternZ: STERN,
    beam: 2 * HALF,
    keelY: KEEL,
    deckY: DECK,
    ...o.extras,
  });
  scene.addChild(root);
  const segs = o.segments ?? [40, 10, 4];
  segs.forEach((seg, level) => {
    const group = doc.createNode(`LOD${level}`).setExtras({ lodLevel: level });
    root.addChild(group);
    const { positions, tris } = hullGeometry(seg);
    o.editTris?.(tris, level);
    const mapped = o.mapVertex
      ? positions.flatMap((_, i) => (i % 3 === 0 ? o.mapVertex!([positions[i], positions[i + 1], positions[i + 2]]) : []))
      : positions;
    const hullMesh = doc.createMesh(`Hull_LOD${level}`);
    // two primitives with SEPARATE vertex copies, like a real multi-slot shell split at its
    // material boundary: raw indices never close, so the checker must weld across primitives
    const half = Math.floor(tris.length / 2);
    for (const part of [tris.slice(0, half), tris.slice(half)]) {
      const pos = doc.createAccessor().setType('VEC3').setArray(new Float32Array(mapped)).setBuffer(buffer);
      const idx = doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(part.flat())).setBuffer(buffer);
      hullMesh.addPrimitive(doc.createPrimitive().setAttribute('POSITION', pos).setIndices(idx).setMaterial(mats[0]));
    }
    const hull = doc.createNode(`Hull_LOD${level}`).setMesh(hullMesh).setExtras(o.dropFoamTarget ? { lodLevel: level } : { lodLevel: level, foamTarget: true });
    group.addChild(hull);
    // every further material on a small part, so each is really used
    for (let m = 1; m < mats.length; m++) {
      const p = doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 1, 0, 0.1, 1, 0, 0, 1.1, 0])).setBuffer(buffer);
      const mesh = doc.createMesh(`Part${m}_LOD${level}`).addPrimitive(doc.createPrimitive().setAttribute('POSITION', p).setMaterial(mats[m]));
      group.addChild(doc.createNode(`Part${m}_LOD${level}`).setMesh(mesh).setExtras({ lodLevel: level }));
    }
    if (level === 0 && o.extraLod0Tris) {
      const n = o.extraLod0Tris;
      const arr = new Float32Array(n * 9);
      for (let t = 0; t < n; t++) arr.set([t * 1e-3, 1, 0, t * 1e-3 + 1e-3, 1, 0, t * 1e-3, 1.001, 0], t * 9);
      const p = doc.createAccessor().setType('VEC3').setArray(arr).setBuffer(buffer);
      const mesh = doc.createMesh('Greeble_LOD0').addPrimitive(doc.createPrimitive().setAttribute('POSITION', p).setMaterial(mats[0]));
      group.addChild(doc.createNode('Greeble_LOD0').setMesh(mesh).setExtras({ lodLevel: 0 }));
    }
  });
  return doc;
}

async function check(doc: Document, opts: Parameters<typeof checkDocument>[2] = {}) {
  const io = await createIO();
  const bytes = await io.writeBinary(doc);
  return checkDocument(await io.readBinary(bytes), ASSET_CONTRACT, opts);
}

const failsWith = async (doc: Document, re: RegExp, opts: Parameters<typeof checkDocument>[2] = {}) => {
  const { errors } = await check(doc, opts);
  expect(errors.some((e) => re.test(e)), `expected an error matching ${re}, got:\n${errors.join('\n')}`).toBe(true);
};

describe('checkGlb: a conforming GLB passes', () => {
  it('the synthetic reference boat has zero violations (so every failure below is the rule under test)', async () => {
    const { errors, stats } = await check(buildBoat());
    expect(errors).toEqual([]);
    expect(stats.tris[0]).toBeGreaterThan(stats.tris[1]);
  });

  it('the hull shell is welded across primitives and closed with positive volume', async () => {
    const io = await createIO();
    const doc = await io.readBinary(await io.writeBinary(buildBoat()));
    const hull = doc.getRoot().listNodes().find((n: Node) => n.getName() === 'Hull_LOD0') as Node;
    const topo = hullTopology(hull, ASSET_CONTRACT.tolerance.weld);
    expect(topo.openEdges).toBe(0);
    expect(topo.nonManifoldEdges).toBe(0);
    expect(topo.volume).toBeGreaterThan(0);
  });
});

describe('checkGlb: each broken convention FAILS the build', () => {
  it('more than 7 materials (one pipeline set shared by 8 boats, doc §5.3)', async () => {
    await failsWith(buildBoat({ materials: 8 }), /materials: 8 materials > 7/);
  });

  it('a material name outside the slot contract (the runtime factory maps by name)', async () => {
    await failsWith(buildBoat({ materialName: 'M_Paint' }), /'M_Paint' is not a contract slot/);
  });

  it('more than 4 textures on one material (§V40 sampler wall)', async () => {
    const doc = buildBoat();
    const mat = doc.getRoot().listMaterials()[0];
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const tex = (n: string) => doc.createTexture(n).setImage(png).setMimeType('image/png');
    mat.setBaseColorTexture(tex('a')).setNormalTexture(tex('b')).setOcclusionTexture(tex('c'))
      .setEmissiveTexture(tex('d')).setMetallicRoughnessTexture(tex('e'));
    await failsWith(doc, /textures: .* samples 5 textures > 4/);
  });

  it('missing root extras (the wetline span and bbox checks read them)', async () => {
    await failsWith(buildBoat({ extras: { bowZ: undefined } }), /missing 'bowZ'/);
  });

  it('extras that disagree with the geometry', async () => {
    await failsWith(buildBoat({ extras: { bowZ: 9.4 } }), /bowZ 9.4 ≠ hull max z/);
  });

  it('no foamTarget hull (flowfoam would never see the boat)', async () => {
    await failsWith(buildBoat({ dropFoamTarget: true }), /needs exactly one foamTarget mesh/);
  });

  it('a non-manifold hull (a hole: Archimedes and the foam capture both need a closed shell)', async () => {
    await failsWith(buildBoat({ editTris: (t, l) => l === 0 && t.splice(7, 1) }), /manifold: Hull_LOD0 is not a closed/);
  });

  it('an inside-out hull (every triangle reversed)', async () => {
    await failsWith(buildBoat({ editTris: (t) => t.forEach((tri) => tri.reverse()) }), /inside-out/);
  });

  it('bow pointing −Z (a 180° yaw on export)', async () => {
    await failsWith(
      buildBoat({ mapVertex: ([x, y, z]) => [-x, y, -z], extras: { bowZ: -STERN, sternZ: -BOW } }),
      /bow must point \+Z/,
    );
  });

  it('Blender Z-up exported without the +Y-up conversion', async () => {
    await failsWith(buildBoat({ mapVertex: ([x, y, z]) => [x, -z, y] }), /not Z|keel must be down/);
  });

  it('upside down (keel up)', async () => {
    await failsWith(buildBoat({ mapVertex: ([x, y, z]) => [-x, -y, z] }), /keel must be down/);
  });

  it('origin at the transom instead of the CG', async () => {
    await failsWith(
      buildBoat({ mapVertex: ([x, y, z]) => [x, y, z - STERN], extras: { sternZ: 0, bowZ: BOW - STERN } }),
      /origin must be at the CG/,
    );
  });

  it('a hull that does not sit on the physics proxy (expect = hullOffsets dump)', async () => {
    const proxy = { stemZ: BOW + 0.3, transomZ: STERN, keelBodyY: KEEL, deckBodyY: DECK, chineBeam: 2 * HALF };
    await failsWith(buildBoat(), /proxy: hull stem .* ≠ physics proxy/, { expect: { proxy } });
  });

  it('a hull whose chine or sheer is off the proxy sections (STYLE-SPEC C3: chine = halfBeamAt, sheer = + flare term)', async () => {
    // the synthetic hull's own sections in the hull frame (z from the transom, y from the keel)
    const spec = { length: BOW - STERN, lcgFromTransom: -STERN, vcgAboveKeel: -KEEL };
    const stations = Array.from({ length: 61 }, (_, i) => {
      const t = i / 60;
      const b = HALF * Math.max(0.04, t < 0.6 ? 1 : Math.cos(((t - 0.6) / 0.4) * (Math.PI / 2)));
      const z = t * (BOW - STERN);
      return { z, chineHalfBeam: b, chineY: b * 0.45, deckY: DECK - KEEL, deckZ: z };
    });
    const proxy = { stemZ: BOW, transomZ: STERN, keelBodyY: KEEL, deckBodyY: DECK, chineBeam: 2 * HALF };
    const flat = { topsideFlareDeg: 0, topsideFlareStartAboveChine: 0 };
    // vertical topsides sit exactly on it: no section error
    const ok = await check(buildBoat(), { expect: { proxy, spec, stations, renderOnly: flat } });
    expect(ok.errors.filter((e) => e.includes('half-beam'))).toEqual([]);
    // a 5 cm wider proxy chine: the hull's chine no longer sits on halfBeamAt
    const wide = stations.map((s) => ({ ...s, chineHalfBeam: s.chineHalfBeam + 0.05 }));
    await failsWith(buildBoat(), /proxy: chine half-beam .* ≠ proxy/, { expect: { proxy, spec, stations: wide, renderOnly: flat } });
    // the json asks for an 8° flare from the chine up, the hull has vertical sides: sheer too narrow
    await failsWith(buildBoat(), /proxy: sheer half-beam .* ≠ proxy/, {
      expect: { proxy, spec, stations, renderOnly: { topsideFlareDeg: 8, topsideFlareStartAboveChine: 0 } },
    });
  });

  it('hero parts: a prop that cannot spin (missing node, pivot or the outboard it follows)', async () => {
    // props, wheel, dial and outboards animate WITHOUT node transforms (identity rule), so the
    // pivot + axis in extras are the only way the runtime can turn them about the right point
    const withParts = (edit: (outboard: Node, prop: Node | null) => void, keepProp = true) => {
      const doc = buildBoat({ extras: { partsVersion: 1 } });
      const lod0 = doc.getRoot().listNodes().find((n) => n.getName() === 'LOD0') as Node;
      const buffer = doc.getRoot().listBuffers()[0];
      const mat = doc.getRoot().listMaterials()[0];
      const mesh = (name: string) => {
        const p = doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, -4.5, 0.1, 0, -4.5, 0, 0.1, -4.5])).setBuffer(buffer);
        return doc.createMesh(name).addPrimitive(doc.createPrimitive().setAttribute('POSITION', p).setMaterial(mat));
      };
      const outboard = doc.createNode('Outboard_P_LOD0').setMesh(mesh('Outboard_P_LOD0')).setExtras({
        lodLevel: 0, steerPivot: [0.66, -0.2, -4.5], steerAxis: [0, 1, 0], trimPivot: [0.66, -0.2, -4.4], trimAxis: [1, 0, 0],
      });
      lod0.addChild(outboard);
      let prop: Node | null = null;
      if (keepProp) {
        prop = doc.createNode('Prop_P_LOD0').setMesh(mesh('Prop_P_LOD0')).setExtras({
          lodLevel: 0, animRole: 'propSpin', pivot: [0.66, -1.2, -4.7], axis: [0, 0, 1], follows: 'Outboard_P',
        });
        lod0.addChild(prop);
      }
      edit(outboard, prop);
      return doc;
    };
    const ok = await check(withParts(() => {}));
    expect(ok.errors.filter((e) => e.startsWith('parts'))).toEqual([]);
    await failsWith(withParts(() => {}, false), /parts: outboard P has no separate prop node Prop_P_LOD0/);
    await failsWith(withParts((_, p) => p!.setExtras({ lodLevel: 0, animRole: 'propSpin', axis: [0, 0, 1], follows: 'Outboard_P' })), /Prop_P_LOD0' needs extras.pivot/);
    await failsWith(withParts((_, p) => p!.setExtras({ lodLevel: 0, animRole: 'propSpin', pivot: [0, 0, 0], axis: [0, 0, 1], follows: 'Outboard_X' })), /does not name an LOD0 node/);
    await failsWith(withParts((o) => o.setExtras({ lodLevel: 0 })), /Outboard_P_LOD0' extras.steerPivot/);
  });

  it('a node transform (shading reads positionLocal as the body frame in metres)', async () => {
    const doc = buildBoat();
    doc.getRoot().listNodes().find((n) => n.getName() === 'LOD1')?.setTranslation([0, 0.5, 0]);
    await failsWith(doc, /'LOD1' has a non-identity transform/);
  });

  it('NPC LOD0 over 50k tris, and LOD levels that are not lighter', async () => {
    await failsWith(buildBoat({ kind: 'npc', extraLod0Tris: 50_000 }), /budget: LOD0 has \d+ tris > npc budget 50000/);
    await failsWith(buildBoat({ segments: [10, 40, 4] }), /LOD1 .* is not lighter than LOD0/);
  });

  it('too many draws per LOD (eight boats × unbatched parts was 523 draws in the browser sync)', async () => {
    // every extra material is one more primitive on its own part node: 3 draws per LOD at 2 materials
    const { errors, stats } = await check(buildBoat({ kind: 'npc' }));
    expect(errors.filter((e) => e.includes('draws'))).toEqual([]);
    expect(stats.drawsPerLod[0]).toBe(3);
    const doc = buildBoat({ kind: 'npc' });
    const lod0 = doc.getRoot().listNodes().find((n) => n.getName() === 'LOD0') as Node;
    const mat = doc.getRoot().listMaterials()[1];
    for (let i = 0; i < ASSET_CONTRACT.assetKinds.npc.drawBudget[0]; i++) {
      const p = doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 1, 0, 0.1, 1, 0, 0, 1.1, 0])).setBuffer(doc.getRoot().listBuffers()[0]);
      const mesh = doc.createMesh(`Bolt${i}_LOD0`).addPrimitive(doc.createPrimitive().setAttribute('POSITION', p).setMaterial(mat));
      lod0.addChild(doc.createNode(`Bolt${i}_LOD0`).setMesh(mesh).setExtras({ lodLevel: 0 }));
    }
    await failsWith(doc, /budget: LOD0 has \d+ draws > npc draw budget 12/);
  });

  it('player LOD0 budget is 120k, not the NPC 50k', async () => {
    const { errors } = await check(buildBoat({ kind: 'player', extraLod0Tris: 50_000 }));
    expect(errors.filter((e) => e.startsWith('budget'))).toEqual([]);
    await failsWith(buildBoat({ kind: 'player', extraLod0Tris: 120_000 }), /player budget 120000/);
  });

  it('final stage: PNG textures and no meshopt are packaging failures', async () => {
    const doc = buildBoat();
    doc.getRoot().listMaterials()[0].setBaseColorTexture(doc.createTexture('png').setImage(new Uint8Array(8)).setMimeType('image/png'));
    await failsWith(doc, /is image\/png, not KTX2/, { stage: 'final' });
    await failsWith(buildBoat(), /not meshopt-compressed/, { stage: 'final' });
  });

  it('KTX2 mip level count is read from the container header', () => {
    const head = new Uint8Array(80);
    head.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
    new DataView(head.buffer).setUint32(40, 11, true);
    expect(ktx2LevelCount(head)).toBe(11);
    expect(ktx2LevelCount(new Uint8Array(80))).toBe(-1);
  });
});

describe('the built pipeline-test GLB (assets/models, from `node scripts/asset-build.mjs`)', () => {
  // a vite asset import cannot carry .glb (not a known asset type, and vite.config is not ours to
  // widen), so the bytes come off disk through the checker's own reader
  const bytes = (): Uint8Array => readBytes(decodeURIComponent(new URL('../assets/models/speedboat_pipeline_test.glb', import.meta.url).pathname));

  it('passes the FINAL checker, sitting on the physics proxy (§V77: one set of numbers)', async () => {
    const proxyHull = buildDeepVHull(REFERENCE_DEEP_V);
    const proxy = {
      stemZ: proxyHull.stemZ,
      transomZ: proxyHull.transomZ,
      keelBodyY: proxyHull.keelBodyY,
      deckBodyY: deckHeight(REFERENCE_DEEP_V) - REFERENCE_DEEP_V.vcgAboveKeel,
      chineBeam: proxyHull.beam,
    };
    const io = await createIO();
    const doc = await io.readBinary(bytes());
    // the same offsets the build lofts from (hullOffsets.ts: 240 segments), so the section rule
    // (chine on halfBeamAt, sheer on halfBeamAt + flare) runs against the physics module itself
    const stations = hullStations({ ...REFERENCE_DEEP_V, segments: 240 });
    const renderOnly = (HULL_DATA as unknown as { renderOnly: { topsideFlareDeg: number; topsideFlareStartAboveChine: number } }).renderOnly;
    const { errors, stats } = checkDocument(doc, ASSET_CONTRACT, { stage: 'final', expect: { proxy, spec: REFERENCE_DEEP_V, stations, renderOnly } });
    expect(errors).toEqual([]);
    expect(stats.materials).toBeLessThanOrEqual(7);
    const root = doc.getRoot().getDefaultScene()!.listChildren()[0].getExtras() as Record<string, number>;
    // the wetline maps ship-local z through (sternZ, 1/(bowZ − sternZ)): these ARE the proxy's
    expect(root.bowZ).toBeCloseTo(proxyHull.stemZ, 2);
    expect(root.sternZ).toBeCloseTo(proxyHull.transomZ, 2);
  });
});
