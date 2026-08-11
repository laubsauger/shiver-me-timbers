/**
 * §V.13/§V.18 ship piece graph. WHY these tests exist: the piece contract
 * is what future AI-generated meshes must satisfy (V18 swap), damage zones
 * are what cannonballs target (V14), rope anchors are what the catenary
 * solver attaches to (V12), and determinism keeps multiplayer possible (V2).
 */
import { describe, expect, it } from 'vitest';
import type { Material, Mesh } from 'three';
import { buildBrigantineBlueprint, buildGalleonBlueprint } from '../src/ship/shipBlueprint';
import { buildHoledVariant, buildPieceGeometry, buildSailGeometry } from '../src/ship/pieceGeometry';
import { ShipAssembly } from '../src/ship/shipAssembly';
import { galleonParams } from '../src/params/ship';
import type { PieceDef } from '../src/ship/pieceTypes';

const stubFactory = () => ({ dispose(): void {} }) as unknown as Material;

const blueprints: Array<[string, () => PieceDef[]]> = [
  ['brigantine', buildBrigantineBlueprint],
  ['galleon', buildGalleonBlueprint],
];

describe.each(blueprints)('%s blueprint (§V.13/§V.18)', (_name, build) => {
  const pieces = build();

  it('is deterministic — two calls produce deep-equal graphs (V2/V18)', () => {
    expect(build()).toEqual(build());
  });

  it('round-trips through JSON losslessly (V18 mesh-swap contract is data)', () => {
    expect(JSON.parse(JSON.stringify(pieces))).toEqual(pieces);
  });

  it('piece ids and socket ids are unique (piece ops address by id)', () => {
    const pieceIds = pieces.map((p) => p.id);
    expect(new Set(pieceIds).size).toBe(pieceIds.length);
    const socketIds = pieces.flatMap((p) => p.sockets.map((s) => s.id));
    expect(new Set(socketIds).size).toBe(socketIds.length);
  });

  it('every parent reference resolves (detach must carry a valid subtree)', () => {
    const ids = new Set(pieces.map((p) => p.id));
    for (const p of pieces) {
      if (p.parent !== undefined) expect(ids.has(p.parent)).toBe(true);
    }
  });

  it('every hull section is a damage-zone carrier with a holed state (V14 targets)', () => {
    const hull = pieces.filter((p) => p.kind === 'hull-section');
    expect(hull).toHaveLength(6);
    for (const section of hull) {
      expect(section.sockets.some((s) => s.type === 'damage-zone')).toBe(true);
      expect(section.damageStates.map((s) => s.id)).toContain('holed');
    }
  });

  it('every mast carries ≥1 rope anchor (V12 catenary endpoints)', () => {
    const masts = pieces.filter((p) => p.kind === 'mast');
    expect(masts.length).toBeGreaterThanOrEqual(2);
    for (const mast of masts) {
      expect(mast.sockets.some((s) => s.type === 'rope-anchor')).toBe(true);
    }
  });

  it('mounts 4 cannons per side (V14 combat needs targets to fire from)', () => {
    const mounts = pieces.flatMap((p) => p.sockets.filter((s) => s.type === 'cannon-mount'));
    expect(mounts.filter((s) => s.id.includes('port'))).toHaveLength(4);
    expect(mounts.filter((s) => s.id.includes('starboard'))).toHaveLength(4);
  });

  it('every piece kind builds greybox geometry with vertices', () => {
    for (const p of pieces) {
      const geo = buildPieceGeometry(p.kind, p.aabb);
      expect(geo.attributes.position.count).toBeGreaterThan(0);
      geo.dispose();
    }
  });
});

describe('galleon specifics (docs/ship-reference-schema.png)', () => {
  const pieces = buildGalleonBlueprint();
  const byId = new Map(pieces.map((p) => [p.id, p]));

  it('has 3 masts, mainmast tallest, crow-nest riding the mainmast', () => {
    const masts = pieces.filter((p) => p.kind === 'mast');
    expect(masts.map((m) => m.id).sort()).toEqual(['mast-fore', 'mast-main', 'mast-rear']);
    const height = (m: PieceDef): number => m.aabb.max[1];
    const main = byId.get('mast-main')!;
    for (const m of masts) {
      if (m.id !== 'mast-main') expect(height(main)).toBeGreaterThan(height(m));
    }
    const nest = byId.get('crow-nest')!;
    expect(nest.parent).toBe('mast-main');
    expect(nest.sockets.some((s) => s.type === 'rope-anchor')).toBe(true);
    expect(nest.sockets.some((s) => s.id === 'socket-lookout')).toBe(true);
  });

  it('each yard carries a sail with furled|reefed|full states', () => {
    const yards = pieces.filter((p) => p.kind === 'yard');
    expect(yards).toHaveLength(6);
    for (const yard of yards) {
      const sail = pieces.find((p) => p.kind === 'sail' && p.parent === yard.id);
      expect(sail, `sail for ${yard.id}`).toBeDefined();
      expect(sail!.sailStates?.map((s) => s.id)).toEqual(['furled', 'reefed', 'full']);
    }
  });

  it('declares the fixture sockets: wheel, capstan, lookout, figurehead', () => {
    const fixtures = pieces
      .flatMap((p) => p.sockets)
      .filter((s) => s.type === 'fixture')
      .map((s) => s.id)
      .sort();
    expect(fixtures).toEqual(['socket-capstan', 'socket-figurehead', 'socket-lookout', 'socket-wheel']);
  });

  it('cannons are deck-mounted, not hull gunports', () => {
    for (const p of pieces.filter((x) => x.kind === 'hull-section')) {
      expect(p.sockets.some((s) => s.type === 'cannon-mount')).toBe(false);
    }
    expect(byId.get('deck')!.sockets.filter((s) => s.type === 'cannon-mount')).toHaveLength(8);
  });
});

describe('damage/sail geometry variants (§V.14)', () => {
  const hull = buildGalleonBlueprint().find((p) => p.id === 'hull-port-mid')!;

  it('holed variant = base + breach overlay in 2 material groups', () => {
    const base = buildPieceGeometry(hull.kind, hull.aabb);
    const holed = buildHoledVariant(hull.kind, hull.aabb, -1);
    expect(holed.groups).toHaveLength(2);
    expect(holed.attributes.position.count).toBeGreaterThan(base.attributes.position.count);
    base.dispose();
    holed.dispose();
  });

  it('sail states produce distinct silhouettes (reefed look, ref PNG)', () => {
    const sail = buildGalleonBlueprint().find((p) => p.kind === 'sail')!;
    const counts = (['furled', 'reefed', 'full'] as const).map(
      (s) => buildSailGeometry(s, sail.aabb).attributes.position.count,
    );
    expect(new Set(counts).size).toBe(3);
  });
});

describe('ShipAssembly piece ops (§V.13: destruction only via piece graph)', () => {
  it('resolves socket world positions through the parent chain', () => {
    const asm = new ShipAssembly(buildGalleonBlueprint(), stubFactory);
    const p = galleonParams;
    const masthead = asm.socketWorldPosition('anchor-masthead-main');
    expect(masthead[0]).toBeCloseTo(0);
    expect(masthead[1]).toBeCloseTo(p.freeboard + p.mainMastHeight);
    expect(masthead[2]).toBeCloseTo(p.mainMastZ);
    const nest = asm.socketWorldPosition('anchor-crow-nest');
    expect(nest[1]).toBeCloseTo(p.freeboard + p.mainMastHeight * p.crowNestFrac + p.crowNestHeight);
    expect(() => asm.socketWorldPosition('nope')).toThrow();
    asm.dispose();
  });

  it('swaps intact ↔ holed geometry and hides destroyed pieces', () => {
    const asm = new ShipAssembly(buildGalleonBlueprint(), stubFactory);
    const mesh = asm.group.getObjectByName('hull-port-mid-mesh') as Mesh;
    const intactGeo = mesh.geometry;
    asm.setDamageState('hull-port-mid', 'holed');
    expect(mesh.geometry).not.toBe(intactGeo);
    expect(mesh.geometry.groups).toHaveLength(2);
    asm.setDamageState('hull-port-mid', 'destroyed');
    expect(mesh.visible).toBe(false);
    asm.dispose();
  });

  it('rejects damage states a piece does not declare (fail loud)', () => {
    const asm = new ShipAssembly(buildGalleonBlueprint(), stubFactory);
    expect(() => asm.setDamageState('deck', 'holed')).toThrow();
    expect(() => asm.setDamageState('ghost', 'holed')).toThrow();
    expect(() => asm.setSailState('deck', 'reefed')).toThrow();
    asm.dispose();
  });

  it('detaches a mast as one subtree with its yards + sails (V14 mast break)', () => {
    const asm = new ShipAssembly(buildGalleonBlueprint(), stubFactory);
    const subtree = asm.detachPiece('mast-main');
    expect(asm.group.getObjectByName('mast-main')).toBeUndefined();
    for (const child of ['yard-main-lower', 'yard-main-upper', 'sail-main-lower', 'crow-nest']) {
      expect(subtree.getObjectByName(child), child).toBeDefined();
    }
    // anchors on the detached rig still resolve for rope re-solve (V12)
    expect(asm.socketWorldPosition('anchor-yard-main-lower-port')).toHaveLength(3);
    asm.dispose();
  });

  it('assembles the brigantine from the same contract, no code path forks', () => {
    const asm = new ShipAssembly(buildBrigantineBlueprint(), stubFactory);
    expect(asm.group.children.length).toBeGreaterThan(10);
    asm.setDamageState('hull-starboard-bow', 'holed');
    expect(asm.socketWorldPosition('cannon-port-1')).toHaveLength(3);
    asm.dispose();
  });
});
