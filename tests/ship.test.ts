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
import type { PieceDef, SailStateId } from '../src/ship/pieceTypes';
import {
  hullEnvelope,
  hullHalfWidthAt,
  hullTopY,
  type HullShape,
} from '../src/ship/hullMath';
import {
  braceAngle,
  sailDrive,
  sailGeometryState,
  sailStateForTrim,
  trimDropScale,
} from '../src/ship/sailDynamics';
import { updateRig } from '../src/ship/rigTrim';
import { oceanParams } from '../src/params/ocean';
import {
  SAIL_BELLY_FOOT,
  SAIL_DRAFT_MAX,
  SAIL_DRAFT_MIN,
  SAIL_FOOT_FILL,
  sailBellyProfile,
  sailClothOffset,
  sailDraftLead,
  sailDraftProfile,
  sailFurlLift,
} from '../src/ship/sailShape';

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

  it('declares the fixture sockets: wheel, capstan, lookout, figurehead, catheads, lanterns', () => {
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
      // the ship's practical lanterns hang from these (src/lanterns). Without
      // them the lights mounted on `anchor-cleat-stern-*` instead, which put
      // two lit spheres beside the two unlit bulbs the posts already carry.
      'socket-lantern-port',
      'socket-lantern-starboard',
      'socket-lookout',
      'socket-wheel',
    ]);
  });

  it('hangs the lantern sockets off the lantern POSTS, at their cap', () => {
    // WHY: the pieces that carry the lantern-bulb geometry are the only
    // correct mount, and the socket is the pendulum PIVOT — the light hangs
    // cordLength below it — so it belongs at the top of the post, not at the
    // bulb and not on the deck.
    for (const side of ['port', 'starboard'] as const) {
      const post = byId.get(`lantern-post-${side}`)!;
      const socket = post.sockets.find((s) => s.id === `socket-lantern-${side}`)!;
      expect(socket.type).toBe('fixture');
      expect(socket.position[1]).toBeCloseTo(post.aabb.max[1]);
    }
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

  it('reefs every sail together, and does it WITHOUT a mid-travel mesh swap', () => {
    const asm = new ShipAssembly(buildGalleonBlueprint(), stubFactory);
    asm.group.updateMatrixWorld(true);
    updateRig(asm, 1 / 60, 1);
    expect(asm.sailState('sail-main-lower')).toBe('full');
    // WHY: a third of the way in used to rebuild every sail as the 'reefed'
    // mesh, which is where the user's "it suddenly jumps when it's like half
    // unfurled" came from. At any working trim the cloth is the SAME mesh,
    // shortened continuously — the reef is a scale, not a swap.
    for (const t of [0.8, 0.6, 0.45, 0.3, 0.1]) {
      updateRig(asm, 1 / 60, t);
      for (const id of asm.sailPieceIds()) expect(asm.sailState(id), `${id} @ ${t}`).toBe('full');
    }
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

  it('drop scale moves over the WHOLE range — no plateau anywhere', () => {
    // WHY, and this is the whole bug: this test used to assert only that the
    // scale was monotone and stepless, which `min + (1−min)·clamp(…)` satisfies
    // while being PINNED for the bottom 55% of the travel. A flat interval is a
    // stretch of the player's control that does nothing, and the user feels it
    // as a skip — measured, the old form was constant at 0.55 for every trim
    // below 0.55, and the sail's foot did not move through 39% of the range.
    expect(trimDropScale(1, p)).toBeCloseTo(1, 6);
    expect(trimDropScale(0, p)).toBeCloseTo(p.trimDropMin, 6);
    const span = 1 - p.trimDropMin;
    let prev = trimDropScale(0, p);
    for (let t = 0.01; t <= 1.0001; t += 0.01) {
      const v = trimDropScale(t, p);
      const step = v - prev;
      expect(step).toBeGreaterThan(span * 0.005); // every 1% of trim MOVES it…
      expect(step).toBeLessThan(span * 0.02); // …and none of them lurches
      prev = v;
    }
  });

  it('swaps the mesh ONCE, at the bottom, not at mid-travel', () => {
    // WHY: hysteresis is right for a label and fatal for a shape. The old path
    // keyed geometry off `sailStateForTrim`, so the cloth jumped 34% of its
    // drop at trim 0.55 going in and 41% at trim 0.62 coming out — "it does
    // the same on the way out" is the hysteresis band, seen.
    let state = sailGeometryState(1, 'full', p);
    const swaps: number[] = [];
    for (let i = 200; i >= 0; i--) {
      const t = i / 200;
      const next = sailGeometryState(t, state, p);
      if (next !== state) swaps.push(t);
      state = next;
    }
    expect(swaps).toHaveLength(1);
    expect(swaps[0]).toBeLessThan(0.05); // …and at the very bottom of travel
    // coming back out it must not cost much more trim than it took to furl,
    // or the control feels like it has backlash
    const outSwaps: number[] = [];
    for (let i = 0; i <= 200; i++) {
      const t = i / 200;
      const next = sailGeometryState(t, state, p);
      if (next !== state) outSwaps.push(t);
      state = next;
    }
    expect(outSwaps).toHaveLength(1);
    // the hysteresis band is bounded BY the threshold, so shaking the canvas
    // back out can never cost more than twice the trim it took to furl — the
    // old label band was a flat 0.06 sitting at mid-travel, which is why the
    // jump landed at 0.55 going in and 0.62 coming out
    expect(outSwaps[0]).toBeLessThanOrEqual(2 * p.furlGeometryBelow + 1e-9);
    expect(outSwaps[0]).toBeGreaterThanOrEqual(swaps[0] - 1e-9);
    // never 'reefed': an intermediate mesh is a jump wherever you put it
    for (let i = 0; i <= 200; i++) {
      expect(sailGeometryState(i / 200, 'full', p)).not.toBe('reefed');
      expect(sailGeometryState(i / 200, 'furled', p)).not.toBe('reefed');
    }
  });

  it('the label keeps its three states and its hysteresis (HUD, audio)', () => {
    // WHY: separating shape from label must not cost the label. The plaque
    // still reads "reefed" at mid-trim and still must not flicker on an edge.
    expect(sailStateForTrim(0.35, 'full', p)).toBe('reefed');
    expect(sailStateForTrim(p.reefReefedBelow + p.reefHysteresis * 0.5, 'reefed', p)).toBe('reefed');
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

/**
 * §V22 — "pulling up and down the sails still skips. It's not a smooth
 * transition to packed-up sails. It suddenly jumps when it's like half
 * unfurled, and then it suddenly snaps and they're in — and on the way out it
 * does the same."
 *
 * A REPEAT complaint (earlier: "sail reefing skips 30–40%"), and everything
 * upstream of this file already looked fine: the drop scale was monotone and
 * stepless, and its own unit test said so. The jump was never in the scale, it
 * was in the GEOMETRY the scale was applied to, so it could only be caught by
 * measuring the thing the player actually watches — where the foot of the
 * canvas is — through the whole real path, at every trim, in both directions.
 * That is what this does.
 */
describe('hauling the canvas up and down is SMOOTH end to end (§V22)', () => {
  const p = shipRigParams;
  const mp = shipMaterialParams;

  /** exactly what the vertex stage builds: the hung y plus the gather lift */
  function canvasFoot(aabb: PieceDef['aabb'], state: ReturnType<typeof sailGeometryState>, scale: number): number {
    const geo = buildSailGeometry(state, aabb);
    const pos = geo.getAttribute('position');
    const shape = geo.getAttribute('sailShape');
    const uvs = geo.getAttribute('uv');
    const s = { drive: 0, luff: 0, skew: 0, dropScale: scale, time: 0, phase: 0 };
    let lo = 0;
    for (let i = 0; i < pos.count; i++) {
      const w = shape.getX(i);
      const y =
        pos.getY(i) * (1 + (scale - 1) * w) +
        sailFurlLift(uvs.getX(i), uvs.getY(i), shape.getZ(i), s, mp) * w;
      if (y < lo) lo = y;
    }
    geo.dispose();
    return lo;
  }

  const sails = buildGalleonBlueprint().filter((s) => s.id.startsWith('sail-'));

  it.each(['down', 'up'] as const)('shows no jump hauling %s', (dir) => {
    for (const sail of sails) {
      const drop = -sail.aabb.min[1];
      let state: SailStateId = dir === 'down' ? 'full' : 'furled';
      let prev: number | null = null;
      let worst = 0;
      let worstAt = 0;
      for (let i = 0; i <= 200; i++) {
        const t = dir === 'down' ? 1 - i / 200 : i / 200;
        state = sailGeometryState(t, state, p);
        const y = canvasFoot(sail.aabb, state, trimDropScale(t, p));
        if (prev !== null && Math.abs(y - prev) / drop > worst) {
          worst = Math.abs(y - prev) / drop;
          worstAt = t;
        }
        prev = y;
      }
      // MEASURED BEFORE THE FIX: 0.34 hauling down (at trim 0.55) and 0.41
      // hauling up (at trim 0.62 — a different place, which is the hysteresis
      // band showing through). Half a percent of trim may not move the foot of
      // the sail by a twentieth of its own drop.
      expect(worst, `${sail.id} ${dir} @ trim ${worstAt.toFixed(3)}`).toBeLessThan(0.05);
    }
  });

  it('has no dead zone: every part of the travel does something', () => {
    // WHY: the other half of the complaint. Trim 0.15..0.54 used to be 39% of
    // the player's control in which the canvas did not move at all, which is
    // where "skips 30–40%" came from. Below `furlGeometryBelow` she is furled
    // and is SUPPOSED to be inert, so the sweep starts above it.
    const sail = sails.find((s) => s.id === 'sail-main-lower')!;
    const drop = -sail.aabb.min[1];
    const from = p.furlGeometryBelow + p.reefHysteresis;
    let prev: number | null = null;
    for (let t = from; t <= 1.0001; t += 0.02) {
      const y = canvasFoot(sail.aabb, sailGeometryState(t, 'full', p), trimDropScale(t, p));
      if (prev !== null) expect(Math.abs(y - prev) / drop, `trim ${t.toFixed(2)}`).toBeGreaterThan(0.005);
      prev = y;
    }
  });

  it('gathers the foot into bays as it comes in, and lets it hang when set', () => {
    // WHY: the continuous scale alone slides a flat rectangle of canvas up a
    // slot, which is not "packed-up sails". The foot must rise at the stations
    // its buntlines are made fast to and swag between them — the user's
    // standing note about reefed canvas showing "lines… in the centre or at
    // thirds, instead of just a completely straight line rolled up".
    const drop = 6.3;
    const at = (trim: number, u: number): number =>
      sailFurlLift(u, 0, drop, { drive: 0, luff: 0, skew: 0, dropScale: trimDropScale(trim, p), time: 0, phase: 0 }, mp);

    // a set sail is NOT gathered — this must not disturb the belly (§B.21)
    for (let u = 0; u <= 1; u += 0.1) expect(at(1, u)).toBeCloseTo(0, 9);

    // hauled almost in, the foot is scalloped: stations up, mid-bays hanging
    const bays = mp.sailFurlBays;
    for (let b = 0; b < bays; b++) {
      const station = b / bays;
      const midBay = (b + 0.5) / bays;
      expect(at(0.05, station)).toBeGreaterThan(at(0.05, midBay) + drop * 0.05);
    }
    // and the gather grows monotonically as she comes in — no step of its own
    let prev = at(1, 0);
    for (let t = 0.98; t >= 0; t -= 0.02) {
      const v = at(t, 0);
      expect(v).toBeGreaterThan(prev - 1e-9);
      prev = v;
    }
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

/**
 * §V22 / §T.34 — "Sails are certainly not getting blown hard enough to look
 * interesting. They have no billow to them."
 *
 * The belly was already being COMPUTED (proved earlier by locking
 * sailDropScale and watching the sails shrink), so these tests pin the two
 * things that made a live belly read as flat cloth: a vertical profile with no
 * inflection, and a drive term with no headroom above the wind the game
 * actually runs at.
 */
describe('sail belly reads as a curved surface (§V22 "no billow")', () => {
  const p = shipMaterialParams;
  const base = { forwardX: 0, forwardZ: 1, yawRate: 0, time: 0 };
  const state = (drive: number) => ({ drive, luff: 0, skew: 0, dropScale: 1, time: 0, phase: 0 });

  it('is deepest around mid-height and comes back at BOTH ends', () => {
    // the old profile was smoothstep(0, 0.9, 1−v): monotone, deepest at the
    // free foot, zero only at the head. A monotone section has no inflection,
    // so the lower sail swings forward as one piece and shades like a tilted
    // plane however deep it is.
    const peak = sailBellyProfile(SAIL_BELLY_FOOT);
    expect(peak).toBeCloseTo(1, 6); // full depth at the draft
    expect(sailBellyProfile(1)).toBeCloseTo(0, 6); // bent to the yard at the head
    // the foot is a FREE edge — it eases back but never returns to the yard
    expect(sailBellyProfile(0)).toBeCloseTo(SAIL_FOOT_FILL, 6);
    expect(sailBellyProfile(0)).toBeLessThan(peak * 0.7);

    // and the section genuinely turns over rather than ramping: sampling from
    // foot to head the profile must rise, reach the peak, then fall
    const xs = Array.from({ length: 41 }, (_, i) => i / 40);
    const ys = xs.map(sailBellyProfile);
    const argmax = ys.indexOf(Math.max(...ys));
    expect(xs[argmax]).toBeGreaterThan(0.15); // not pinned at the foot…
    expect(xs[argmax]).toBeLessThan(0.85); // …nor at the head
    for (let i = 1; i <= argmax; i++) expect(ys[i]).toBeGreaterThanOrEqual(ys[i - 1] - 1e-9);
    for (let i = argmax + 1; i < ys.length; i++) expect(ys[i]).toBeLessThanOrEqual(ys[i - 1] + 1e-9);
  });

  it('still pins the cloth at both leeches and at the head', () => {
    // the bolt ropes hold the sides; a belly that did not go to zero here
    // would tear the cloth off its own edges
    const drop = 7;
    for (const v of [0, 0.45, 0.9]) {
      expect(Math.abs(sailClothOffset(0, v, drop, state(1), p))).toBeLessThan(0.02);
      expect(Math.abs(sailClothOffset(1, v, drop, state(1), p))).toBeLessThan(0.02);
    }
    expect(Math.abs(sailClothOffset(0.5, 1, drop, state(1), p))).toBeLessThan(0.02);
  });

  it('leaves real headroom above the wind the game actually sails in', () => {
    // THE FLAG BUG, again (§B: flagStreamRef 7 against a default wind of 11
    // pinned the telltale at maximum, so it carried no information). If drive
    // is already at its ceiling in ordinary conditions, a breeze and a gale
    // produce identical canvas and the sail stops reporting anything.
    const ordinary = sailDrive({ ...base, windDirection: 0, windSpeed: oceanParams.windSpeed }, p);
    expect(p.sailWindRef).toBeGreaterThan(oceanParams.windSpeed); // ref above the working wind
    expect(ordinary.drive).toBeGreaterThan(0.4); // she is drawing…
    expect(ordinary.drive).toBeLessThan(0.8); // …with room left above her
  });

  it('deepens visibly from light air to a gale', () => {
    const depthAt = (windSpeed: number): number => {
      const d = sailDrive({ ...base, windDirection: 0, windSpeed }, p).drive;
      // peak of the belly: mid-width, at the draft, on a 7 m course
      return sailClothOffset(0.5, SAIL_BELLY_FOOT, 7, state(d), p);
    };
    const light = depthAt(5);
    const ordinary = depthAt(oceanParams.windSpeed);
    const gale = depthAt(22);
    expect(light).toBeLessThan(ordinary);
    expect(ordinary).toBeLessThan(gale);
    // the whole point: the range has to be READABLE, not a few percent
    expect(gale / Math.max(light, 1e-6)).toBeGreaterThan(2.5);
    // and ordinary conditions must give a belly worth looking at on a 7 m sail
    expect(ordinary).toBeGreaterThan(1.8);
  });

  it('goes slack in irons and inverts when the wind backs the sail', () => {
    const irons = sailDrive({ ...base, windDirection: Math.PI, windSpeed: 12 }, p);
    const backed = sailClothOffset(0.5, SAIL_BELLY_FOOT, 7, state(irons.drive), p);
    expect(backed).toBeLessThan(0); // pressed back against the rig, not filled
  });
});

/**
 * §V22 / §V43 — "the sail blow is like a way too steep bulge in the middle and
 * then nothing towards the sides. It has to be more distributed."
 *
 * The FOURTH sail complaint, and the first one about the HORIZONTAL section:
 * §B.21 fixed the vertical profile and left `sin²(πu)` across, MULTIPLIED into
 * it. A product of two centred bumps puts the whole shape in a lens in the
 * middle — measured 0.31 of the peak as a mean over a whole course, with the
 * cloth at 9.5% of full one tenth of the way in from a leech.
 *
 * These tests are about DISTRIBUTION, which is the thing no depth or
 * displacement-magnitude assertion can see: every one of them passes on a sail
 * of any depth and fails the moment the bulge is re-centred or re-narrowed.
 */
describe('the draft is DISTRIBUTED across the cloth (§V43 SoT parity)', () => {
  const p = shipMaterialParams;
  const lead = sailDraftLead(p.sailDraftPos);
  const section = (u: number): number => sailDraftProfile(u, lead, p.sailDraftFullness);
  const peak = Math.max(...Array.from({ length: 2001 }, (_, i) => section(i / 2000)));

  it('carries real depth out toward the leeches, not a lens in the middle', () => {
    // sin²(πu) — the shape this replaced — scores 0.095 / 0.095 / 0.500 here.
    // A membrane parabola scores 0.46 / 0.25 / 0.66. The gap IS the complaint.
    expect(section(0.1) / peak).toBeGreaterThan(0.35); // a tenth in from the luff
    expect(section(0.9) / peak).toBeGreaterThan(0.2); // …and from the leech

    // the honest summary: how much of the peak the sail carries ON AVERAGE.
    // Anything that narrows the section drops this, whatever it does to depth.
    const N = 2000;
    let sum = 0;
    for (let i = 0; i <= N; i++) sum += section(i / N);
    expect(sum / (N + 1) / peak).toBeGreaterThan(0.6);
  });

  it('is still pinned to the bolt rope at both leeches', () => {
    // "distributed" must not become "detached": the leeches are roped and
    // sheeted, so the falloff is a boundary layer at the edge, not an open one
    expect(section(0)).toBeCloseTo(0, 6);
    expect(section(1)).toBeCloseTo(0, 6);
  });

  it('puts the deepest point AFT OF THE LUFF, not at the midpoint', () => {
    // real canvas draws at roughly 40% aft of the luff: a fast entry curve and
    // a long flat exit to the leech. A symmetric section is the tell that
    // someone has gone back to a centred bump.
    const N = 2000;
    let argmax = 0;
    let best = -1;
    for (let i = 0; i <= N; i++) {
      const y = section(i / N);
      if (y > best) {
        best = y;
        argmax = i / N;
      }
    }
    expect(argmax).toBeGreaterThan(0.3);
    expect(argmax).toBeLessThan(0.48);
    // and the asymmetry is real, not a rounding: equal distances either side
    // of the MIDPOINT are not equally full
    expect(section(0.3)).toBeGreaterThan(section(0.7) * 1.15);
  });

  it('never folds the cloth back over itself, anywhere in the tunable band', () => {
    // the draft is moved by warping u, and a warp that is not monotone maps two
    // points of canvas onto one — a self-intersecting sail. The clamp on the
    // warp lead is what prevents it, so the guard has to hold across the whole
    // range Tweakpane exposes AND the extra swing `skew` adds on top.
    for (let k = 0; k <= 20; k++) {
      const dp = SAIL_DRAFT_MIN - 0.3 + ((SAIL_DRAFT_MAX + 0.6 - SAIL_DRAFT_MIN) * k) / 20;
      const l = sailDraftLead(dp);
      let prev = -1;
      for (let i = 0; i <= 500; i++) {
        const u = i / 500;
        const w = u + l * Math.sin(Math.PI * u);
        expect(w).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = w;
      }
    }
  });

  it('lags the DRAFT to leeward while turning, and never walks off the leech', () => {
    // the ship's swing used to translate the whole section sideways, which at
    // full skew left 41% of the peak standing at the port bolt rope — the cloth
    // torn off its own edge. Moving the draft position instead keeps both
    // leeches at zero at every skew.
    const drop = 7;
    const at = (skew: number, u: number, v: number): number =>
      sailClothOffset(u, v, drop, { drive: 1, luff: 0, skew, dropScale: 1, time: 0, phase: 0 },
        { ...p, sailFlutterAmp: 0 });
    for (const skew of [-1, -0.5, 0, 0.5, 1]) {
      for (const v of [0, 0.45, 0.9]) {
        expect(Math.abs(at(skew, 0, v))).toBeLessThan(1e-6);
        expect(Math.abs(at(skew, 1, v))).toBeLessThan(1e-6);
      }
    }
    // it still MOVES, or the skew term has silently become a no-op: at the free
    // foot the two tacks put visibly different amounts of cloth at mid-width
    expect(at(1, 0.5, 0)).not.toBeCloseTo(at(-1, 0.5, 0), 3);
    // …and the head cannot lag at all — it is bent to its yard
    expect(at(1, 0.4, 1)).toBeCloseTo(at(-1, 0.4, 1), 6);
  });
});
