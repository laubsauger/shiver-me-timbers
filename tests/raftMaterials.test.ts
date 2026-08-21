/**
 * §T90 — raft materials, GPU-free. Node graphs are ASSEMBLED here (a misused
 * node throws at build; the compile half is the browser's, §V22), the §V40
 * binding count is taken lexically the way tests/shipBindingBudget.test.ts
 * takes it, and the Kon-Tiki face is driven through its CPU mirror.
 */
import { describe, expect, it } from 'vitest';
import raftMaterialsSource from '../src/ship/raftMaterials.ts?raw';
import raftMaterialsBalsaSource from '../src/ship/raftMaterialsBalsa.ts?raw';
import raftMaterialsWeaveSource from '../src/ship/raftMaterialsWeave.ts?raw';
import raftMaterialNodesSource from '../src/ship/raftMaterialNodes.ts?raw';
import raftSailFaceSource from '../src/ship/raftSailFace.ts?raw';
import { createPieceMaterial, familyOf } from '../src/ship/pieceMaterials';
import {
  BALSA_AXIS,
  CRATE_VARIANT,
  bambooDeckVariantOf,
  crateVariantOf,
  crossbeamStation0,
} from '../src/ship/raftMaterials';
import {
  FACE_RAYS,
  konTikiFaceApplies,
  konTikiFacePrimitives,
  konTikiFaceSdf,
} from '../src/ship/raftSailFace';
import { hashPieceId, pieceIdOfMesh } from '../src/ship/raftMaterialNodes';
import { createSailClothMaterial } from '../src/ship/sailMaterial';
import { buildRaftBlueprint } from '../src/ship/raftBlueprint';
import { raftParams } from '../src/params/raft';
import { raftMaterialParams } from '../src/params/raftMaterials';
import { getParamsEntry } from '../src/params/registry';
import type { PieceKind } from '../src/ship/pieceTypes';

const RAFT_KINDS: readonly PieceKind[] = [
  'log', 'crossbeam', 'bamboo-deck', 'guara', 'cabin-wall', 'thatch-roof',
  'bipod-mast', 'steering-oar', 'crate', 'splashboard', 'stern-block',
];

describe('§T90 raft material factory', () => {
  it('builds a lit, relief-carrying material for every raft kind', () => {
    for (const kind of RAFT_KINDS) {
      const mat = createPieceMaterial(kind);
      expect(mat.colorNode, `${kind} has no colour`).toBeDefined();
      expect(mat.roughnessNode, `${kind} has no roughness`).toBeDefined();
      expect(mat.name).toBe(`piece-${kind}`);
      mat.dispose();
    }
  });

  it('routes every raft kind to a raft family — none is left on the galleon presets', () => {
    const galleonFamilies = new Set(['hull', 'deck', 'spar', 'trim', 'sail', 'flag', 'iron', 'glass']);
    for (const kind of RAFT_KINDS) {
      expect(galleonFamilies.has(familyOf(kind)), `${kind} still on ${familyOf(kind)}`).toBe(false);
    }
    // and the blueprint uses nothing this file forgot
    const used = new Set(buildRaftBlueprint().map((d) => d.kind));
    for (const kind of used) expect(familyOf(kind)).toBeDefined();
  });

  it('knows the axis every balsa member runs along (a log is along z, a leg along y)', () => {
    for (const kind of RAFT_KINDS) {
      if (familyOf(kind) === 'balsa') expect(BALSA_AXIS[kind], `${kind} has no axis`).toBeDefined();
    }
    expect(BALSA_AXIS.log).toBe('z');
    expect(BALSA_AXIS.crossbeam).toBe('x');
    expect(BALSA_AXIS['bipod-mast']).toBe('y');
  });

  it('picks a crate look per authored piece id, and every dressing id resolves', () => {
    const ids = buildRaftBlueprint().filter((d) => d.kind === 'crate').map((d) => d.id);
    expect(ids).toContain('rain-drum');
    expect(ids).toContain('dinghy');
    expect(ids).toContain('cage');
    expect(crateVariantOf('rain-drum')).toBe(CRATE_VARIANT.drum);
    expect(crateVariantOf('dinghy')).toBe(CRATE_VARIANT.dinghy);
    expect(crateVariantOf('cage')).toBe(CRATE_VARIANT.cage);
    expect(crateVariantOf('jerrycan-1')).toBe(CRATE_VARIANT.jerrycan);
    expect(crateVariantOf('crate-2')).toBe(CRATE_VARIANT.pine);
    for (const id of ids) expect(Number.isInteger(crateVariantOf(id))).toBe(true);
    // mats everywhere a deck slab is; slats only on the lookout
    expect(bambooDeckVariantOf('lookout-platform')).toBe(1);
    expect(bambooDeckVariantOf('deck-fore')).toBe(0);
    expect(bambooDeckVariantOf('cabin-floor')).toBe(0);
  });

  it('reads the rope-groove stations off the blueprint, not a second literal (§V37)', () => {
    const beam0 = buildRaftBlueprint().find((d) => d.id === 'crossbeam-0')!;
    expect(crossbeamStation0()).toBe(beam0.transform.position[2]);
  });

  it('identifies a piece from its mesh name, deterministically (§V2)', () => {
    expect(pieceIdOfMesh('log-3-mesh')).toBe('log-3');
    expect(pieceIdOfMesh('log-3')).toBe('log-3');
    expect(hashPieceId('log-3')).toBe(hashPieceId('log-3'));
    expect(hashPieceId('log-3')).not.toBe(hashPieceId('log-4'));
    for (const id of ['log-0', 'crate-1', 'sail-main-lower']) {
      const h = hashPieceId(id);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
    }
  });
});

describe('§V40 binding budget of the raft families', () => {
  // the same patterns tests/shipBindingBudget.test.ts counts with
  const BINDING_PATTERNS: readonly RegExp[] = [
    /\btexture\s*\(/g, /\btextureNode\s*\(/g, /\btexture3D\s*\(/g, /\bcubeTexture\s*\(/g,
    /\bviewportTexture\s*\(/g, /\bviewportDepthTexture\s*\(/g, /\bshadow\s*\(/g,
    /\breflector\s*\(/g, /\.sample\s*\(/g, /\btextureLoad\s*\(/g, /\bsampleCascadeLayer\s*\(/g,
  ];
  const strip = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const sites = (s: string): number =>
    BINDING_PATTERNS.reduce((n, re) => n + (strip(s).match(re) ?? []).length, 0);

  const FAMILY_SOURCES = [raftMaterialsSource, raftMaterialsBalsaSource, raftMaterialsWeaveSource];

  it('binds no texture of its own in any raft family file', () => {
    for (const src of FAMILY_SOURCES) expect(sites(src)).toBe(0);
    expect(sites(raftMaterialNodesSource)).toBe(0);
    expect(sites(raftSailFaceSource)).toBe(0);
  });

  it('stays at or under the deck family (9 samplers) — it shares only the ship-wide set', () => {
    // every raft family = its own 0 + the set woodMaterial's non-deck families
    // bind: wetline 1 + caustics (1 array + 3 displacement) + sun shadow 1.
    // The deck family adds the heightfield + 2 deck-water tiers on top = 9.
    const SHARED = 1 + 4 + 1;
    const own = FAMILY_SOURCES.reduce((n, src) => n + sites(src), 0) + sites(raftMaterialNodesSource) + sites(raftSailFaceSource);
    expect(SHARED + own).toBeLessThanOrEqual(9);
  });

  it('binds nothing in the vertex stage (no positionNode)', () => {
    for (const src of FAMILY_SOURCES) expect(src).not.toContain('positionNode');
  });
});

describe('the Kon-Tiki face (CPU mirror of the sail decal SDF)', () => {
  const W = raftParams.mainSailWidth;
  const D = raftParams.mainSailDrop;
  const p = raftMaterialParams;

  it('is symmetric about the sail centreline', () => {
    for (let i = 0; i <= 40; i++) {
      for (let j = 0; j <= 40; j++) {
        const u = i / 40;
        const v = j / 40;
        expect(Math.abs(konTikiFaceSdf(u, v) - konTikiFaceSdf(1 - u, v))).toBeLessThan(1e-6);
      }
    }
  });

  it('is paint at the face centre and bare cloth outside the margin', () => {
    expect(konTikiFaceSdf(0.5, p.faceCentreV)).toBeLessThan(0);
    for (const [u, v] of [[0.02, 0.5], [0.98, 0.5], [0.5, 0.02], [0.5, 0.98], [0.03, 0.03]]) {
      expect(konTikiFaceSdf(u, v), `(${u},${v}) should be cloth`).toBeGreaterThan(0);
    }
  });

  it('wears exactly eight rays round the head', () => {
    // a circle through the middle of the rays crosses each one twice; the
    // head and beard sit inside it, the sail's edge outside
    const r = (p.faceRayInner + p.faceRayOuter) / 2;
    expect(p.faceRayInner).toBeGreaterThan(Math.hypot(p.faceHalfWidth, p.faceHalfHeight) - p.faceCorner * 0.4);
    const n = 1440;
    let changes = 0;
    let prev = konTikiFaceSdf(0.5 + r / W, p.faceCentreV) > 0;
    for (let i = 1; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const inside = konTikiFaceSdf(0.5 + (r * Math.cos(a)) / W, p.faceCentreV + (r * Math.sin(a)) / D) > 0;
      if (inside !== prev) changes++;
      prev = inside;
    }
    expect(changes).toBe(FACE_RAYS * 2);
    expect(konTikiFacePrimitives().filter((q) => q.kind === 'segment').length).toBeGreaterThanOrEqual(FACE_RAYS);
  });

  it('goes on the raft main course only — the galleon names its course the same', () => {
    expect(konTikiFaceApplies('sail-main-lower', W)).toBe(true);
    expect(konTikiFaceApplies('sail-main-lower', 16)).toBe(false);
    expect(konTikiFaceApplies('sail-main-upper', W)).toBe(false);
    expect(konTikiFaceApplies('sail-mizzen-lower', 2)).toBe(false);
    expect(konTikiFaceApplies('sail-main-lower', Number.NaN)).toBe(false);
  });

  it('is composed into the sail material through the decal hook, once', () => {
    let calls = 0;
    const handle = createSailClothMaterial(undefined, {
      apply(color) {
        calls++;
        return color;
      },
    });
    expect(calls).toBe(1);
    expect(handle.material.colorNode).toBeDefined();
    handle.material.dispose();
  });
});

describe('§V16 raft material params', () => {
  it('registers every tunable under raft-materials', () => {
    const entry = getParamsEntry('raft-materials');
    expect(entry).toBeDefined();
    expect(entry!.params).toBe(raftMaterialParams);
    for (const key of ['balsaGrey', 'weedColor', 'weaveStrip', 'thatchRowPitch', 'faceFill', 'sailTint', 'drumColor']) {
      expect(key in entry!.params, key).toBe(true);
    }
  });
});
