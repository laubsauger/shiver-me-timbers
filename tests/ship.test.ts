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
import { createWoodMaterial } from '../src/ship/woodMaterial';
import { galleonParams, shipMaterialParams, shipRigParams } from '../src/params/ship';
import type { PieceDef } from '../src/ship/pieceTypes';
import {
  hullEnvelope,
  hullHalfWidthAt,
  hullTopY,
  type HullShape,
} from '../src/ship/hullMath';
import {
  braceAngle,
  sailDrive,
  sailStateForTrim,
  trimDropScale,
} from '../src/ship/sailDynamics';
import { updateRig } from '../src/ship/rigTrim';
import { oceanParams } from '../src/params/ocean';

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

  it('declares the fixture sockets: wheel, capstan, lookout, figurehead, catheads', () => {
    const fixtures = pieces
      .flatMap((p) => p.sockets)
      .filter((s) => s.type === 'fixture')
      .map((s) => s.id)
      .sort();
    expect(fixtures).toEqual([
      'socket-capstan',
      'socket-cathead-port',
      'socket-cathead-starboard',
      'socket-figurehead',
      'socket-lookout',
      'socket-wheel',
    ]);
  });

  it('mounts a piece on socket-figurehead, at the station it declares', () => {
    // WHY: `socket-figurehead` was declared for many sessions with NOTHING
    // mounted on it, so the most-looked-at point of the silhouette was bare
    // planking — and the socket itself sat 90% of the way out the bowsprit,
    // which is not where a figurehead goes. A declared fixture socket with no
    // piece on it is an invisible gap; assert the pairing, not just the socket.
    const carrier = pieces.find((x) => x.sockets.some((s) => s.id === 'socket-figurehead'))!;
    const socket = carrier.sockets.find((s) => s.id === 'socket-figurehead')!;
    const figurehead = pieces.find((x) => x.kind === 'figurehead')!;
    expect(figurehead.parent).toBe(carrier.id);
    expect(figurehead.transform.position).toEqual(socket.position);
    // and it is forward of the stem, not amidships or out on the spar
    expect(carrier.transform.position[2] + socket.position[2]).toBeGreaterThan(
      galleonParams.hullLength / 2,
    );
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

describe.each(blueprints)('%s hull shell is watertight (§V22)', (_name, build) => {
  /**
   * WHY this exists, and why the silhouette test above was NOT enough:
   * containment proves no piece pokes OUT of the outline. It says nothing
   * about whether the surfaces meet. Two real holes hid behind a green
   * containment sweep — the two side shells stopped at the keel line leaving
   * a 0.125 m slot per side down most of the hull, and the transom sampled
   * its height in 10 steps against the shell's 8, so its side edge diverged
   * from the planking by up to 0.35 m. Both read as "you can look through
   * the back plate into the interior of the ship".
   *
   * The assertion: weld every shell piece into one surface and count how
   * many triangles use each edge. An edge used ONCE is an open boundary.
   * The only legitimate boundary is the top rim (sheer line, counter top,
   * beakhead edge) — anything open below that is a hole you can see through.
   */
  const pieces = build();
  const SHELL_KINDS = new Set(['hull-section', 'bow', 'transom']);
  const shape = pieces.find((p) => p.kind === 'deck')!.shape as unknown as HullShape;

  const weld = (): {
    pts: number[][];
    directed: Map<string, number>;
    undirected: Map<string, number>;
  } => {
    const key = new Map<string, number>();
    const pts: number[][] = [];
    const id = (x: number, y: number, z: number): number => {
      const k = `${Math.round(x * 1e3)},${Math.round(y * 1e3)},${Math.round(z * 1e3)}`;
      let v = key.get(k);
      if (v === undefined) {
        v = pts.length;
        key.set(k, v);
        pts.push([x, y, z]);
      }
      return v;
    };
    const directed = new Map<string, number>();
    const undirected = new Map<string, number>();
    for (const piece of pieces) {
      if (!SHELL_KINDS.has(piece.kind)) continue;
      const geo = buildPieceGeometry(piece.kind, piece.aabb, piece.shape);
      const pos = geo.attributes.position;
      const index = geo.getIndex();
      const count = index ? index.count : pos.count;
      const vid: number[] = [];
      for (let i = 0; i < count; i++) {
        const k = index ? index.getX(i) : i;
        vid.push(
          id(
            pos.getX(k) + piece.transform.position[0],
            pos.getY(k) + piece.transform.position[1],
            pos.getZ(k) + piece.transform.position[2],
          ),
        );
      }
      for (let i = 0; i + 2 < vid.length; i += 3) {
        const [a, b, c] = [vid[i], vid[i + 1], vid[i + 2]];
        if (a === b || b === c || a === c) continue; // degenerate
        for (const [u, v] of [
          [a, b],
          [b, c],
          [c, a],
        ]) {
          directed.set(`${u}>${v}`, (directed.get(`${u}>${v}`) ?? 0) + 1);
          const uk = u < v ? `${u}|${v}` : `${v}|${u}`;
          undirected.set(uk, (undirected.get(uk) ?? 0) + 1);
        }
      }
      geo.dispose();
    }
    return { pts, directed, undirected };
  };

  const welded = weld();

  it('has no open edge below the sheer — nothing to see through', () => {
    const holes: string[] = [];
    for (const [uk, count] of welded.undirected) {
      if (count !== 1) continue;
      const [u, v] = uk.split('|').map(Number);
      const y = Math.max(welded.pts[u][1], welded.pts[v][1]);
      const z = (welded.pts[u][2] + welded.pts[v][2]) / 2;
      // the top rim is meant to be open; anything below it is a hole
      if (y < hullTopY(z, shape) - 0.15) {
        holes.push(`(${welded.pts[u].map((n) => n.toFixed(2)).join(',')})`);
      }
    }
    expect(holes.slice(0, 8).join(' ')).toBe('');
    expect(holes).toHaveLength(0);
  });

  it('is manifold and consistently wound — no face shows its back to the sea', () => {
    // WHY: a flipped strip renders inside-out, which with a double-sided
    // material looks exactly like a hole into the hull.
    let nonManifold = 0;
    let flipped = 0;
    for (const [uk, count] of welded.undirected) {
      const [u, v] = uk.split('|').map(Number);
      if (count > 2) nonManifold++;
      // a shared edge must be traversed in OPPOSITE directions by its two
      // faces; twice the same way means one of them is wound backwards
      else if (welded.directed.get(`${u}>${v}`) === 2) flipped++;
    }
    expect(nonManifold).toBe(0);
    expect(flipped).toBe(0);
  });
});

describe('wood material consumes the water-lighting hook (§T.32/§V.34)', () => {
  /**
   * WHY: the ship reading as "pasted on top of the water" is the user's
   * standing complaint, and the fix is that the hull RECEIVES caustics and
   * wave-bounce. Every one of those arrives through a node slot on the
   * material. Drop any single assignment and the ship silently stops
   * receiving that channel — no error, no test failure, just a hull that
   * looks detached again. This pins all four slots, including emissiveNode,
   * which carries the caustics + bounce and is the one with no other reason
   * to exist on an opaque wood material.
   */
  const handle = createWoodMaterial({
    light: 0xa97c50,
    dark: 0x4a3520,
    wale: true,
    waterline: true,
  });

  it('populates colour, roughness, relief and the caustics/bounce slot', () => {
    expect(handle.material.colorNode, 'colorNode (albedo × water tint)').toBeDefined();
    expect(handle.material.roughnessNode, 'roughnessNode (× roughnessScale)').toBeDefined();
    expect(handle.material.normalNode, 'normalNode (relief × reliefScale)').toBeDefined();
    expect(handle.material.emissiveNode, 'emissiveNode — caustics + bounce').toBeDefined();
  });

  it('re-reads live params without throwing (§V16 panel drives it)', () => {
    expect(() => handle.refresh()).not.toThrow();
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

describe('yards brace round with the wind (§V22 "static, especially turning")', () => {
  const p = shipRigParams;
  const ahead = { forwardX: 0, forwardZ: 1 }; // ship heading world +z

  it('is square on a run and swings round as the ship comes up to the wind', () => {
    // WHY: frozen athwartships yards are the visible half of the complaint,
    // and a rig braced hard round while running is just as wrong as one that
    // never moves. windDirection = blowing TOWARD (src/sailing convention).
    const running = braceAngle({ ...ahead, windDirection: 0 }, p);
    const beam = braceAngle({ ...ahead, windDirection: Math.PI / 2 }, p);
    expect(Math.abs(running)).toBeLessThan(0.02);
    expect(Math.abs(beam)).toBeGreaterThan(0.3);
  });

  it('braces the WINDWARD yardarm forward, and flips with the tack', () => {
    // wind blowing toward +x = coming from port → port arm leads. A positive
    // rotation about +y sends the starboard arm aft, so port tack = positive.
    const portTack = braceAngle({ ...ahead, windDirection: Math.PI / 2 }, p);
    const starboardTack = braceAngle({ ...ahead, windDirection: -Math.PI / 2 }, p);
    expect(portTack).toBeGreaterThan(0);
    expect(starboardTack).toBeLessThan(0);
    expect(portTack).toBeCloseTo(-starboardTack, 6);
  });

  it('never exceeds the clamp — beyond it a yard fouls its own shrouds', () => {
    for (let a = 0; a < Math.PI * 2; a += 0.05) {
      const angle = braceAngle({ ...ahead, windDirection: a }, p);
      expect(Math.abs(angle), `wind ${a.toFixed(2)}`).toBeLessThanOrEqual(p.braceMax + 1e-9);
      expect(Number.isFinite(angle)).toBe(true);
    }
  });

  it('crosses the eye of the wind without snapping the rig over', () => {
    // WHY: a hard sign flip at head-to-wind would whip every yard across the
    // ship in one frame. The tack blend must be continuous through it.
    let prev = braceAngle({ ...ahead, windDirection: Math.PI - 0.4 }, p);
    for (let d = -0.4; d <= 0.4; d += 0.02) {
      const angle = braceAngle({ ...ahead, windDirection: Math.PI + d }, p);
      expect(Math.abs(angle - prev), `step at ${d.toFixed(2)}`).toBeLessThan(0.2);
      prev = angle;
    }
  });

  it('setRigTrim swings the yards AND the sails and anchors riding them', () => {
    // WHY: bracing has to be a piece-graph op (§V13) — the sail is a child of
    // the yard and the brace/sheet anchors are its sockets, so they must
    // follow for free or the rig comes apart when the yards move.
    const asm = new ShipAssembly(buildGalleonBlueprint(), stubFactory);
    const before = asm.socketWorldPosition('anchor-yard-main-lower-starboard');
    asm.setRigTrim(0.5);
    const after = asm.socketWorldPosition('anchor-yard-main-lower-starboard');
    expect(after[2]).toBeLessThan(before[2]); // starboard arm swings aft
    expect(asm.group.getObjectByName('yard-main-lower')!.rotation.y).toBeCloseTo(0.5, 9);
    expect(asm.group.getObjectByName('sail-main-lower')).toBeDefined();
    asm.setRigTrim(NaN); // §V28: a bad angle must never poison a transform
    expect(asm.braceAngle).toBe(0.5);
    asm.dispose();
  });
});

describe('updateRig — the one call main.ts makes per frame', () => {
  it('rate-limits the swing and never jumps the rig across in one frame', () => {
    // WHY: this is the integration surface. An unlimited setRigTrim would
    // teleport six yards (and their sails and rope anchors) whenever the wind
    // or heading changed, which reads worse than not bracing at all.
    const asm = new ShipAssembly(buildGalleonBlueprint(), stubFactory);
    const saved = oceanParams.windDirection;
    try {
      oceanParams.windDirection = Math.PI / 2; // beam wind, hard brace target
      asm.group.updateMatrixWorld(true);
      const dt = 1 / 60;
      let prev = asm.braceAngle;
      for (let i = 0; i < 400; i++) {
        updateRig(asm, dt, 1);
        expect(Math.abs(asm.braceAngle - prev)).toBeLessThanOrEqual(
          shipRigParams.braceRate * dt + 1e-9,
        );
        prev = asm.braceAngle;
      }
      expect(asm.braceAngle).toBeCloseTo(shipRigParams.braceMax, 6); // settled
      updateRig(asm, NaN, 1); // §V28: a bad dt must not move anything
      expect(asm.braceAngle).toBeCloseTo(shipRigParams.braceMax, 6);
    } finally {
      oceanParams.windDirection = saved;
    }
    asm.dispose();
  });

  it('reefs every sail together when the sim trim comes in', () => {
    const asm = new ShipAssembly(buildGalleonBlueprint(), stubFactory);
    asm.group.updateMatrixWorld(true);
    updateRig(asm, 1 / 60, 1);
    expect(asm.sailState('sail-main-lower')).toBe('full');
    updateRig(asm, 1 / 60, 0.3);
    for (const id of asm.sailPieceIds()) expect(asm.sailState(id), id).toBe('reefed');
    updateRig(asm, 1 / 60, 0);
    for (const id of asm.sailPieceIds()) expect(asm.sailState(id), id).toBe('furled');
    asm.dispose();
  });
});

describe('sail trim → §V13 sail states (docs/side-sails-fully-reefed.png)', () => {
  const p = shipRigParams;

  it('maps trim to furled / reefed / full', () => {
    expect(sailStateForTrim(0, 'full', p)).toBe('furled');
    expect(sailStateForTrim(0.35, 'full', p)).toBe('reefed');
    expect(sailStateForTrim(1, 'full', p)).toBe('full');
  });

  it('holds its state inside the hysteresis band — each flip rebuilds geometry', () => {
    // WHY: a trim resting exactly on a threshold would dispose and rebuild
    // six sail geometries every frame.
    const edge = p.reefReefedBelow;
    expect(sailStateForTrim(edge + p.reefHysteresis * 0.5, 'reefed', p)).toBe('reefed');
    expect(sailStateForTrim(edge + p.reefHysteresis * 1.5, 'reefed', p)).toBe('full');
    expect(sailStateForTrim(edge - 0.01, 'full', p)).toBe('reefed');
  });

  it('drop scale is continuous across the band so trim does not pop', () => {
    expect(trimDropScale(1, p)).toBeCloseTo(1, 6);
    expect(trimDropScale(p.reefReefedBelow, p)).toBeCloseTo(p.trimDropMin, 6);
    let prev = trimDropScale(0, p);
    for (let t = 0; t <= 1; t += 0.02) {
      const v = trimDropScale(t, p);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9); // monotonic
      expect(Math.abs(v - prev)).toBeLessThan(0.05); // no step
      prev = v;
    }
  });

  it('setSailState is edge-triggered — a repeat call keeps the same geometry', () => {
    const asm = new ShipAssembly(buildGalleonBlueprint(), stubFactory);
    const mesh = asm.group.getObjectByName('sail-main-lower-mesh') as Mesh;
    asm.setSailState('sail-main-lower', 'reefed');
    const reefed = mesh.geometry;
    asm.setSailState('sail-main-lower', 'reefed');
    expect(mesh.geometry).toBe(reefed); // no dispose/rebuild churn
    expect(asm.sailState('sail-main-lower')).toBe('reefed');
    asm.setSailState('sail-main-lower', 'full');
    expect(mesh.geometry).not.toBe(reefed);
    expect(asm.sailPieceIds()).toHaveLength(6);
    asm.dispose();
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

  it('declares a chainplate FAN per mast per side for the shrouds', () => {
    // WHY: src/ropes had to DERIVE shroud feet by interpolating the bow and
    // stern cleats, which lands them inboard of the hull — lines then pass
    // through the deck. Real sockets on the shell fix that at the source, and
    // one plate per mast can only ever carry one token shroud where
    // docs/ship-reference-schema.png shows a fan.
    const p = galleonParams;
    const sockets = buildGalleonBlueprint()
      .flatMap((x) => x.sockets)
      .filter((s) => s.type === 'rope-anchor' && s.id.startsWith('anchor-channel-'));
    for (const side of ['port', 'starboard']) {
      for (const mast of ['fore', 'main', 'rear']) {
        const fan = sockets.filter((s) =>
          new RegExp(`^anchor-channel-${side}-${mast}-\\d+$`).test(s.id),
        );
        expect(fan, `${side}/${mast}`).toHaveLength(p.channelPlates);
        // the unnumbered form is GONE: src/ropes iterates the fan and has a
        // test rejecting it, so one token shroud per mast cannot come back
        expect(sockets.some((s) => s.id === `anchor-channel-${side}-${mast}`)).toBe(false);
      }
    }
  });

  it('mizzen chainplates sit on the deck the mizzen is STEPPED on', () => {
    // WHY (§B-class bug): sized from the main shell's sheer line, they sat
    // 2 m below the quarterdeck the mast stands on, so every mizzen shroud
    // speared the deck — src/ropes had to drop those shrouds entirely.
    const p = galleonParams;
    const blueprint = buildGalleonBlueprint();
    const asm = new ShipAssembly(blueprint, stubFactory);
    const quarterdeck = p.freeboard + p.sterncastleRise;
    for (const side of ['port', 'starboard']) {
      const [x, y] = asm.socketWorldPosition(`anchor-channel-${side}-rear-1`);
      expect(y).toBeGreaterThan(quarterdeck - 0.4);
      expect(y).toBeLessThan(quarterdeck);
      // and outboard of the quarterdeck edge, where a chainplate belongs
      const hints = blueprint.find((b) => b.id === `hull-${side}-stern`)!
        .shape as unknown as HullShape;
      expect(Math.abs(x)).toBeGreaterThan(hullHalfWidthAt(p.rearMastZ, y, hints));
    }
    asm.dispose();
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
