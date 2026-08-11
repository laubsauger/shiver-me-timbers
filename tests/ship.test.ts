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
import { galleonParams, shipMaterialParams } from '../src/params/ship';
import type { PieceDef } from '../src/ship/pieceTypes';
import {
  hullEnvelope,
  hullHalfWidthAt,
  hullTopY,
  type HullShape,
} from '../src/ship/hullMath';
import { sailDrive } from '../src/ship/sailDynamics';

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
      const geo = buildPieceGeometry(p.kind, p.aabb, p.shape);
      expect(geo.attributes.position.count).toBeGreaterThan(0);
      geo.dispose();
    }
  });

  it('mounts a gun piece at every cannon-mount socket (visible cannons)', () => {
    const guns = pieces.filter((p) => p.kind === 'cannon');
    const mounts = pieces.flatMap((p) => p.sockets.filter((s) => s.type === 'cannon-mount'));
    expect(guns).toHaveLength(mounts.length);
    const ids = new Set(pieces.map((p) => p.id));
    for (const gun of guns) expect(ids.has(gun.parent!)).toBe(true);
  });

  it('hull loft tapers toward the stem — no boxy bow (§V22 silhouette)', () => {
    // widest |x| among vertices forward of `minLocalZ` in piece space
    const halfBreadth = (id: string, minLocalZ: number): number => {
      const piece = pieces.find((x) => x.id === id)!;
      const geo = buildPieceGeometry(piece.kind, piece.aabb, piece.shape);
      const pos = geo.attributes.position;
      let max = 0;
      for (let i = 0; i < pos.count; i++) {
        if (pos.getZ(i) > minLocalZ) max = Math.max(max, Math.abs(pos.getX(i)));
      }
      geo.dispose();
      return max;
    };
    const midWidth = halfBreadth('hull-starboard-mid', -Infinity);
    const forwardWidth = halfBreadth('hull-starboard-bow', 3); // fwd quarter
    const stemWidth = halfBreadth('bow', -Infinity);
    expect(forwardWidth).toBeLessThan(midWidth * 0.75);
    expect(stemWidth).toBeLessThan(forwardWidth);
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

/**
 * §V22 user critiques turned into headless invariants. WHY each matters:
 * a stern that does not close is a hole you can see into; a slab wider than
 * the shell shows as a flat panel sticking out of the hull; a yard through
 * its mast makes the sail cut into the spar; a rope anchor buried in solid
 * geometry makes the rigging hang through the deck.
 */
describe('hull silhouette is closed and nothing overhangs it (§V22)', () => {
  const p = galleonParams;
  const pieces = buildGalleonBlueprint();
  const byId = new Map(pieces.map((x) => [x.id, x]));
  const sternZ = -p.hullLength / 2;
  const hints = (id: string): HullShape => byId.get(id)!.shape as unknown as HullShape;

  /** widest |x| of a built piece, in SHIP space */
  const extent = (id: string): { maxX: number; minY: number; maxY: number } => {
    const piece = byId.get(id)!;
    const geo = buildPieceGeometry(piece.kind, piece.aabb, piece.shape);
    const pos = geo.attributes.position;
    let maxX = 0;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      maxX = Math.max(maxX, Math.abs(pos.getX(i) + piece.transform.position[0]));
      minY = Math.min(minY, pos.getY(i) + piece.transform.position[1]);
      maxY = Math.max(maxY, pos.getY(i) + piece.transform.position[1]);
    }
    geo.dispose();
    return { maxX, minY, maxY };
  };

  it('the transom spans the full shell opening — keel line to castle deck', () => {
    // WHY: it used to stop at the sheer line, leaving the counter under the
    // quarterdeck open, and started above the keel, leaving a slot under it.
    const t = extent('transom');
    expect(t.minY).toBeLessThanOrEqual(-p.draft + 0.01);
    expect(t.maxY).toBeGreaterThanOrEqual(p.freeboard + p.sterncastleRise - 0.01);
  });

  it('the transom is never wider than the shell it caps', () => {
    // WHY: the old box transom was ±0.29·beam vs a ~0.55·halfBeam stern —
    // its corners poked out through the planking as flat panels.
    const shellHalf = (p.beam / 2) * hullEnvelope(sternZ, hints('hull-port-stern'));
    expect(extent('transom').maxX).toBeLessThanOrEqual(shellHalf + 1e-3);
  });

  it('stern works (cabin, gallery, balustrade) stay inside the stern', () => {
    // WHY: "ugly panels on the back side" — every aft fixture must sit
    // within the hull's own section AT ITS OWN STATION, not just somewhere.
    const shell = hints('hull-port-stern');
    for (const id of ['transom', 'gallery', 'balustrade-stern', 'cabin', 'sterncastle-deck']) {
      const piece = byId.get(id)!;
      const geo = buildPieceGeometry(piece.kind, piece.aabb, piece.shape);
      const pos = geo.attributes.position;
      let worst = 0;
      let worstAt = '';
      for (let i = 0; i < pos.count; i++) {
        const x = Math.abs(pos.getX(i) + piece.transform.position[0]);
        const y = pos.getY(i) + piece.transform.position[1];
        const z = pos.getZ(i) + piece.transform.position[2];
        const over = x - hullHalfWidthAt(z, y, shell);
        if (over > worst) {
          worst = over;
          worstAt = `x=${x.toFixed(2)} y=${y.toFixed(2)} z=${z.toFixed(2)}`;
        }
      }
      geo.dispose();
      expect(worst, `${id} overhangs by ${worst.toFixed(3)}m at ${worstAt}`).toBeLessThan(0.03);
    }
  });

  it('castle decks and rails never overhang the topsides amidships', () => {
    // WHY: tumblehome means the plan envelope is WIDER than the shell at
    // rail height; sizing decks from the plan alone broke them out of the hull.
    const midHints = hints('hull-port-mid');
    const railLineHalf = hullHalfWidthAt(0, hullTopY(0, midHints), midHints);
    expect(extent('rail-starboard').maxX).toBeLessThanOrEqual(railLineHalf + 1e-3);
    expect(extent('deck').maxX).toBeLessThanOrEqual(railLineHalf + 0.35);
  });
});

describe('rig clears the mast, cloth is shader-driven (§V22)', () => {
  const p = galleonParams;
  const pieces = buildGalleonBlueprint();

  it('every yard rides forward of its mast, spar surfaces clear', () => {
    // WHY: a yard on the mast axis puts the sail INSIDE the spar; the cloth
    // then visibly cuts through the mast from every angle.
    const clearance = p.mastRadius + p.yardRadius;
    for (const yard of pieces.filter((x) => x.kind === 'yard')) {
      expect(yard.transform.position[2], yard.id).toBeGreaterThanOrEqual(clearance);
    }
  });

  it('sail cloth hangs forward of its yard axis and below it', () => {
    for (const sail of pieces.filter((x) => x.kind === 'sail')) {
      expect(sail.transform.position[2], sail.id).toBeGreaterThan(0);
      expect(sail.transform.position[1], sail.id).toBeLessThanOrEqual(0);
    }
  });

  it('full sail is flat cloth + tagged hardware — the belly lives in the shader', () => {
    // WHY: a baked belly cannot react to wind (§V22 "sails appear too
    // static"). The material needs (clothWeight, width, drop) per vertex and
    // a flat panel to bend; robands must stay put (weight 0).
    const sail = pieces.find((x) => x.kind === 'sail')!;
    const geo = buildSailGeometry('full', sail.aabb);
    const shape = geo.getAttribute('sailShape');
    expect(shape).toBeDefined();
    expect(shape.itemSize).toBe(3);
    const pos = geo.attributes.position;
    let maxZ = 0;
    const weights = new Set<number>();
    for (let i = 0; i < pos.count; i++) {
      maxZ = Math.max(maxZ, Math.abs(pos.getZ(i)));
      weights.add(shape.getX(i));
    }
    expect(maxZ).toBeLessThan(0.2); // flat: no baked billow
    expect(weights.has(1)).toBe(true); // cloth
    expect(weights.has(0)).toBe(true); // robands
    const width = sail.aabb.max[0] - sail.aabb.min[0];
    expect(shape.getY(0)).toBeCloseTo(width, 5);
    geo.dispose();
  });
});

describe('sail wind response (§V22 "the sails appear too static")', () => {
  // WHY: the cloth must answer the SAME wind the sim sails on — otherwise
  // the rig contradicts the physics the player feels. Convention (shared
  // with src/sailing): forward = +z, windDirection = blowing TOWARD.
  const p = shipMaterialParams;
  const base = { forwardX: 0, forwardZ: 1, windSpeed: p.sailWindRef, yawRate: 0, time: 0 };

  it('fills on a run and backs when the wind heads the ship', () => {
    const running = sailDrive({ ...base, windDirection: 0 }, p); // wind astern
    const irons = sailDrive({ ...base, windDirection: Math.PI }, p); // wind ahead
    expect(running.drive).toBeGreaterThan(0.6);
    expect(running.luff).toBeLessThan(0.3);
    expect(irons.drive).toBeLessThan(0);
    expect(irons.luff).toBeGreaterThan(0.7);
  });

  it('draws on a beam reach, because the SIM says that is fastest', () => {
    // WHY: the cloth reads the same trimEfficiency curve the thrust uses —
    // a sail flapping while the ship accelerates is a visible contradiction.
    const beam = sailDrive({ ...base, windDirection: Math.PI / 2 }, p);
    expect(beam.drive).toBeGreaterThan(0.6);
    expect(beam.luff).toBeLessThan(0.3);
  });

  it('shakes hardest inside the sim dead zone (in irons)', () => {
    const closeHauled = sailDrive({ ...base, windDirection: Math.PI * 0.93 }, p);
    expect(closeHauled.luff).toBeGreaterThan(0.5);
    expect(closeHauled.drive).toBeLessThan(0.4);
  });

  it('scales with wind speed — becalmed cloth does not billow', () => {
    const calm = sailDrive({ ...base, windDirection: 0, windSpeed: 0 }, p);
    const stiff = sailDrive({ ...base, windDirection: 0, windSpeed: p.sailWindRef * 1.5 }, p);
    expect(calm.drive).toBeCloseTo(0, 5);
    expect(calm.luff).toBeCloseTo(0, 5);
    expect(stiff.drive).toBeGreaterThan(sailDrive({ ...base, windDirection: 0 }, p).drive);
  });

  it('a turn skews the belly to the side the ship swings and shakes it', () => {
    const straight = sailDrive({ ...base, windDirection: 0 }, p);
    const turning = sailDrive({ ...base, windDirection: 0, yawRate: 0.5 }, p);
    expect(turning.skew).toBeGreaterThan(0);
    expect(sailDrive({ ...base, windDirection: 0, yawRate: -0.5 }, p).skew).toBeLessThan(0);
    expect(turning.luff).toBeGreaterThan(straight.luff);
  });

  it('gusts breathe over time without a global sync pulse (§B.4)', () => {
    const at = (t: number): number => sailDrive({ ...base, windDirection: 0, time: t }, p).drive;
    const samples = [0, 1.7, 3.4, 5.1, 6.8, 8.5].map(at);
    expect(new Set(samples.map((v) => v.toFixed(4))).size).toBeGreaterThan(3);
    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(0.02);
  });

  it('never emits a non-finite value into a shader uniform (§V28)', () => {
    const bad = sailDrive(
      { forwardX: NaN, forwardZ: 0, windDirection: NaN, windSpeed: NaN, yawRate: NaN, time: NaN },
      p,
    );
    for (const v of [bad.drive, bad.luff, bad.skew]) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('rope anchors are reachable, not buried (§V12 endpoints)', () => {
  it('no rope-anchor socket sits inside solid hull volume', () => {
    // WHY: the bow/stern cleats sat below the sheer inside the planking, so
    // bobstays and backstays ran out through the deck and hull.
    const p = galleonParams;
    const blueprint = buildGalleonBlueprint();
    const asm = new ShipAssembly(blueprint, stubFactory);
    const hints = blueprint.find((x) => x.id === 'hull-port-mid')!
      .shape as unknown as HullShape;
    const sternZ = -p.hullLength / 2;
    const bowZ = p.hullLength / 2 + p.bowLength;
    for (const piece of blueprint) {
      for (const socket of piece.sockets) {
        if (socket.type !== 'rope-anchor') continue;
        const [x, y, z] = asm.socketWorldPosition(socket.id);
        if (z < sternZ || z > bowZ) continue; // clear of the hull fore/aft
        if (y > hullTopY(z, hints) + p.sterncastleRise) continue; // up in the rig
        const half = hullHalfWidthAt(z, y, hints);
        const buried = Math.abs(x) < half * 0.95 && y < hullTopY(z, hints) - 0.05;
        expect(buried, `${socket.id} @ ${[x, y, z].map((v) => v.toFixed(2))}`).toBe(false);
      }
    }
    asm.dispose();
  });

  it('declares a chainplate per mast per side for the shrouds', () => {
    // WHY: src/ropes had to DERIVE shroud feet by interpolating the bow and
    // stern cleats, which lands them inboard of the hull — lines then pass
    // through the deck. Real sockets on the shell fix that at the source.
    const ids = buildGalleonBlueprint()
      .flatMap((x) => x.sockets)
      .filter((s) => s.type === 'rope-anchor' && s.id.startsWith('anchor-channel-'))
      .map((s) => s.id)
      .sort();
    expect(ids).toEqual([
      'anchor-channel-port-fore',
      'anchor-channel-port-main',
      'anchor-channel-port-rear',
      'anchor-channel-starboard-fore',
      'anchor-channel-starboard-main',
      'anchor-channel-starboard-rear',
    ]);
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
