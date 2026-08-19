/**
 * §V.13/§V.18 ship piece graph. WHY these tests exist: the piece contract
 * is what future AI-generated meshes must satisfy (V18 swap), damage zones
 * are what cannonballs target (V14), rope anchors are what the catenary
 * solver attaches to (V12), and determinism keeps multiplayer possible (V2).
 */
import { describe, expect, it } from 'vitest';
/** corners in the yard's plane — the shape BEFORE the sheets haul them */
const FLAT_SHEETS = {
  sheetLeadPort: [0, 0, 0] as [number, number, number],
  sheetLeadStarboard: [0, 0, 0] as [number, number, number],
};
import type { Material, Mesh } from 'three';
import { buildBrigantineBlueprint, buildGalleonBlueprint } from '../src/ship/shipBlueprint';
import { buildHoledVariant, buildPieceGeometry, buildSailGeometry } from '../src/ship/pieceGeometry';
import { buildWheelDiscGeometry } from '../src/ship/pieceGeometryFittings';
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
  SAIL_GUST_DETUNE,
  braceAngle,
  sailDrive,
  sailStateForTrim,
  trimDropScale,
} from '../src/ship/sailDynamics';
import { helmWheelAngle, updateRig } from '../src/ship/rigTrim';
import { sheetLeadDirections } from '../src/ship/sailFrame';
/** a sail sitting square in its ship's frame */
const IDENTITY_MATRIX = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
import { oceanParams } from '../src/params/ocean';
import {
  SAIL_BELLY_FOOT,
  SAIL_DRAFT_MAX,
  SAIL_DRAFT_MIN,
  SAIL_FOOT_FILL,
  arcShorten,
  sailBellyProfile,
  SAIL_ARC_COEFF,
  sailCamberRatio,
  sailClothOffset,
  sailClothPoint,
  sailClothFrame,
  sailSewnPoint,
  sailCornerPull,
  sailDraftLead,
  sailDraftProfile,
  sailFlutterRate,
  SAIL_ANCHOR_UV,
  furlBundleScale,
  sailFurlLift,
  sailLaceStation,
  sailPanelCoord,
  seamQuiltProfile,
  sailClothSegments,
  SAIL_LACE_SPAN,
  SAIL_SAMPLES_PER_PANEL,
  leechStandoff,
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
    // three masts x however many TIERS the rig carries. This was a bare 6,
    // i.e. the tier count baked into a test about sail STATES, so adding the
    // third tier failed it here rather than anywhere that has an opinion
    // about tiers (§T.34 rig proportions).
    const masts = pieces.filter((p) => p.kind === 'mast').length;
    expect(yards.length).toBeGreaterThan(0);
    expect(yards.length % masts, 'every mast carries the same tiers').toBe(0);
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

  it('every §V13 state builds the SAME mesh — the silhouette is the trim', () => {
    // WHY THIS ASSERTS THE OPPOSITE OF WHAT IT USED TO. It used to demand three
    // distinct vertex counts, i.e. three meshes, which is exactly the thing the
    // user felt as "a super abrupt transition… it goes to fully packed up":
    // swapping between two silhouettes is a jump wherever the swap is put, and
    // at the bottom of the travel it was still a 3x thickness step and a
    // +0.61 m jump in the top of the canvas. One mesh carries the canvas AND
    // the gathered roll, and the trim moves between them continuously.
    const sail = buildGalleonBlueprint().find((p) => p.kind === 'sail')!;
    const counts = (['furled', 'reefed', 'full'] as const).map(
      (s) => buildSailGeometry(s, sail.aabb).attributes.position.count,
    );
    expect(new Set(counts).size).toBe(1);
    // and that one mesh carries all three vertex classes
    const geo = buildSailGeometry('full', sail.aabb);
    const shape = geo.getAttribute('sailShape');
    const bunt = geo.getAttribute('sailBunt');
    let cloth = 0;
    let hard = 0;
    let roll = 0;
    for (let i = 0; i < shape.count; i++) {
      if (shape.getX(i) === 1) cloth++;
      else if (bunt.getX(i) === 1) roll++;
      else hard++;
    }
    expect(cloth, 'cloth').toBeGreaterThan(0);
    expect(hard, 'robands').toBeGreaterThan(0);
    expect(roll, 'gathered roll').toBeGreaterThan(0);
    geo.dispose();
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
    //
    // MEASURED AGAINST EACH YARD'S OWN RADIUS (§V.66). It used to read one
    // shared `p.yardRadius`, which was only correct while every yard on the
    // ship was the same thickness — the very thing that made a 4.41 m
    // topgallant yard as fat as a 13.23 m course. The yard's radius is its own
    // aabb, so the invariant now follows the spar rather than a constant.
    for (const yard of pieces.filter((x) => x.kind === 'yard')) {
      const yr = yard.aabb.max[1];
      expect(yr, yard.id).toBeGreaterThan(0);
      expect(yard.transform.position[2], yard.id).toBeGreaterThanOrEqual(p.mastRadius + yr);
    }
    // and they are NOT all the same: a yard is sized by its own length
    const radii = pieces.filter((x) => x.kind === 'yard').map((y) => y.aabb.max[1]);
    expect(new Set(radii.map((r) => r.toFixed(4))).size).toBeGreaterThan(1);
    expect(Math.max(...radii) / Math.min(...radii)).toBeGreaterThan(2);
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
      // CLOTH ONLY. The gathered roll lives in this same mesh now and is a
      // tube ~0.9 m thick — measuring it here would assert that the FURL is
      // flat, which is not what "the belly lives in the shader" means.
      if (shape.getX(i) === 1) maxZ = Math.max(maxZ, Math.abs(pos.getZ(i)));
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
  const base = { forwardX: 0, forwardZ: 1, windSpeed: p.sailWindRef, yawRate: 0 };

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
    // no wind and no way on ⇒ no apparent wind ⇒ genuinely slack canvas
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

  it('gusts breathe over PHASE without a global sync pulse (§B.4, §V.55)', () => {
    // WHY PHASE AND NOT TIME: `sailGustFreq` is live in Tweakpane, so
    // `time × rate` is not a phase at all — its instantaneous frequency is
    // ω + t·dω/dt and elapsed time multiplies every wobble in the rate
    // (measured on the flags: 0.93 Hz intended, 59.5 Hz at ten minutes). The
    // two accumulators are integrated by rigTrim.updateRig; this asserts the
    // breathing survived the move, and that the pair is genuinely DETUNED —
    // one period would read as a single animation looping.
    const at = (a: number): number =>
      sailDrive(
        { ...base, windDirection: 0, gustPhase: a, gustPhaseB: a * SAIL_GUST_DETUNE },
        p,
      ).drive;
    const samples = [0, 1.7, 3.4, 5.1, 6.8, 8.5].map(at);
    expect(new Set(samples.map((v) => v.toFixed(4))).size).toBeGreaterThan(3);
    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(0.02);
  });

  it('never emits a non-finite value into a shader uniform (§V28)', () => {
    const bad = sailDrive(
      {
        forwardX: NaN,
        forwardZ: 0,
        shipForwardX: NaN,
        shipForwardZ: NaN,
        windDirection: NaN,
        windSpeed: NaN,
        shipVelX: NaN,
        shipVelZ: NaN,
        yawRate: NaN,
        gustPhase: NaN,
        gustPhaseB: NaN,
      },
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
    // …INCLUDING AT THE BOTTOM. This used to expect 'furled' here, i.e. one
    // last rebuild in the last 2% of the travel — which is precisely the
    // moment the user was still complaining about ("it goes to fully packed up
    // on the top"). The roll is in the same mesh and grows with the trim, so
    // there is no trim at which anything is rebuilt.
    updateRig(asm, 1 / 60, 0);
    for (const id of asm.sailPieceIds()) expect(asm.sailState(id), id).toBe('full');
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

  it('NEVER swaps the mesh — the geometry is trim-independent', () => {
    // WHY: hysteresis is right for a label and fatal for a shape. The old path
    // keyed geometry off `sailStateForTrim`, so the cloth jumped 34% of its
    // drop at trim 0.55 going in and 41% at trim 0.62 coming out — "it does
    // the same on the way out" is the hysteresis band, seen. Moving that swap
    // to the bottom of the travel shrank it but could not remove it, because
    // one fitted constant can only null ONE of the several quantities that
    // step. So the mesh does not depend on the trim at all any more, and the
    // cheapest way to keep that true is to assert it on the BUILDER: the same
    // vertex buffer, byte for byte, whatever state anyone asks for.
    const sail = buildGalleonBlueprint().find((q) => q.kind === 'sail')!;
    const ref = buildSailGeometry('full', sail.aabb);
    const refPos = ref.getAttribute('position').array as Float32Array;
    for (const state of ['furled', 'reefed', 'full'] as const) {
      const geo = buildSailGeometry(state, sail.aabb);
      const pos = geo.getAttribute('position').array as Float32Array;
      expect(pos.length, state).toBe(refPos.length);
      let worst = 0;
      for (let i = 0; i < pos.length; i++) worst = Math.max(worst, Math.abs(pos[i] - refPos[i]));
      expect(worst, state).toBe(0);
      geo.dispose();
    }
    ref.dispose();
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
    // one sail per yard — derived, not the old hardcoded tier count of 6
    expect(asm.sailPieceIds()).toHaveLength(
      buildGalleonBlueprint().filter((q) => q.kind === 'yard').length,
    );
    asm.dispose();
  });
});

/**
 * §V22 — "pulling up and down the sails still skips. It's not a smooth
 * transition to packed-up sails. It suddenly jumps when it's like half
 * unfurled, and then it suddenly snaps and they're in — and on the way out it
 * does the same."
 *
 * A REPEAT complaint (earlier: "sail reefing skips 30-40%", then "we still
 * have a basically super abrupt transition from sails being minimally
 * unfurled to being fully packed up"), and everything upstream already looked
 * fine every time: the drop scale was monotone and stepless and its own unit
 * test said so. The jump was never in the scale, it was in the GEOMETRY the
 * scale was applied to.
 *
 * THIS MEASURES THE SILHOUETTE, NOT ONE POINT OF IT — and that is the lesson
 * from the round that did not finish the job. The old version tracked the
 * LOWEST vertex of the canvas, `trimDropMin` was fitted to make that one
 * number continuous across the mesh swap, and it succeeded: the foot matched
 * to 3% of the drop. Meanwhile the TOP of the sail jumped 0.04-0.09 of the
 * drop, the silhouette TRIPLED in thickness, and the foot's own scallop
 * disagreed by 0.09 of the drop at the buntline stations — none of which the
 * metric could see, because it sampled mid-bay where the two shapes agreed.
 * A fit against one scalar will always find a value that makes that scalar
 * continuous, whether or not anything else is.
 */
describe('hauling the canvas up and down is SMOOTH end to end (§V22)', () => {
  const TAU = Math.PI * 2;
  const p = shipRigParams;
  const mp = shipMaterialParams;

  /**
   * The sail's silhouette at a given trim, exactly as the vertex stage builds
   * it: cloth rides `sailClothPoint`, the gathered roll's section is scaled by
   * `furlBundleScale`, and hardware stays where it was authored.
   *
   * Returns the four numbers that MOVED at the old mesh swap, so a future
   * change cannot make one of them continuous at another's expense:
   * the top, the bottom, the fore-and-aft thickness, and the depth of the
   * canvas at the buntline stations (where the two shapes disagreed most).
   */
  function silhouette(aabb: PieceDef['aabb'], scale: number): number[] {
    const geo = buildSailGeometry('full', aabb);
    const pos = geo.getAttribute('position');
    const shape = geo.getAttribute('sailShape');
    const bunt = geo.getAttribute('sailBunt');
    const uvs = geo.getAttribute('uv');
    const width = aabb.max[0] - aabb.min[0];
    const s = { drive: 0, luff: 0, skew: 0, dropScale: scale, flutterPhase: 0, ...FLAT_SHEETS };
    const roll = furlBundleScale(scale);
    const bays = Math.max(1, Math.round(mp.sailFurlBays));
    let lo = 0;
    let hi = 0;
    let zLo = 0;
    let zHi = 0;
    let station = 0; // lowest cloth within a tenth of a bay of a buntline
    for (let i = 0; i < pos.count; i++) {
      let y = pos.getY(i);
      let z = pos.getZ(i);
      if (shape.getX(i) === 1) {
        const c = sailClothPoint(uvs.getX(i), uvs.getY(i), shape.getY(i), shape.getZ(i), s, mp);
        y = c[1];
        z = c[2];
        const u = uvs.getX(i);
        const near = Math.abs(u * bays - Math.round(u * bays));
        if (near < 0.1 && y < station) station = y;
      } else if (bunt.getX(i) === 1) {
        y *= roll;
        z *= roll;
      }
      if (y < lo) lo = y;
      if (y > hi) hi = y;
      if (z < zLo) zLo = z;
      if (z > zHi) zHi = z;
    }
    geo.dispose();
    void width;
    return [hi, lo, zHi - zLo, station];
  }

  const sails = buildGalleonBlueprint().filter((s) => s.id.startsWith('sail-'));

  it.each(['down', 'up'] as const)('shows no jump hauling %s', (dir) => {
    for (const sail of sails) {
      const drop = -sail.aabb.min[1];
      let prev: number[] | null = null;
      let worst = 0;
      let worstAt = 0;
      let worstWhich = 0;
      for (let i = 0; i <= 200; i++) {
        const t = dir === 'down' ? 1 - i / 200 : i / 200;
        const now = silhouette(sail.aabb, trimDropScale(t, p));
        if (prev !== null) {
          for (let k = 0; k < now.length; k++) {
            const step = Math.abs(now[k] - prev[k]) / drop;
            if (step > worst) {
              worst = step;
              worstAt = t;
              worstWhich = k;
            }
          }
        }
        prev = now;
      }
      // MEASURED BEFORE ANY OF THIS: 0.34 hauling down (at trim 0.55) and 0.41
      // hauling up (at trim 0.62 — a different place, which is the hysteresis
      // band showing through). AFTER the swap moved to the bottom: 0.044 on
      // the foot but 0.081 on the TOP and 0.216 on the thickness, which is
      // what this now catches. Half a percent of trim may not move ANY part of
      // the sail's outline by a twentieth of its own drop.
      const names = ['top', 'foot', 'thickness', 'station'];
      expect(
        worst,
        `${sail.id} ${dir} ${names[worstWhich]} @ trim ${worstAt.toFixed(3)}`,
      ).toBeLessThan(0.05);
    }
  });

  it('the rope anchors ride the same ramp — 24 of 68 ropes end on this cloth', () => {
    /**
     * §V.71 / §V.45. Every sheet, tack and buntline resolves its endpoint
     * through `sailClothPoint` at a fixed (u, v), so whatever the furl does to
     * the surface it does to 24 of the ship's 68 ropes. A MESH SWAP moved that
     * surface discontinuously and the ropes had to teleport with it; a
     * continuous roll cannot, and this is the assertion that says so rather
     * than assuming it.
     *
     * The bound is deliberately far tighter than the silhouette's: an anchor
     * is a single point on a surface that is now smooth in the trim, so its
     * step should be about one 200th of its own travel, not a twentieth of the
     * sail's drop.
     */
    for (const sail of sails) {
      const width = sail.aabb.max[0] - sail.aabb.min[0];
      const drop = -sail.aabb.min[1];
      for (const [name, [u, v]] of Object.entries(SAIL_ANCHOR_UV)) {
        let prev: number[] | null = null;
        let worst = 0;
        let worstAt = 0;
        let travel = 0;
        for (let i = 0; i <= 200; i++) {
          const t = 1 - i / 200;
          const st = {
            drive: 0.6, luff: 0, skew: 0,
            dropScale: trimDropScale(t, p), flutterPhase: 0, ...FLAT_SHEETS,
          };
          const q = sailClothPoint(u, v, width, drop, st, mp);
          if (prev !== null) {
            const d = Math.hypot(q[0] - prev[0], q[1] - prev[1], q[2] - prev[2]);
            travel += d;
            if (d > worst) {
              worst = d;
              worstAt = t;
            }
          }
          prev = q;
        }
        expect(
          worst / drop,
          `${sail.id} ${name} @ trim ${worstAt.toFixed(3)}`,
        ).toBeLessThan(0.01);
        // and it genuinely MOVES — an anchor that never left its station would
        // pass the step bound trivially while hanging off the cloth
        expect(travel / drop, `${sail.id} ${name}`).toBeGreaterThan(0.1);
      }
    }
  });

  it('nothing cloth-class stands outside the roll when she is fully in', () => {
    /**
     * THE GUARD THE FURL REWORK NEEDED AND DID NOT HAVE. User, on the finished
     * bundles: "the fully packed up, rolled up sails now have a flappy end on
     * all sides of the packages, on all sections of it, flapping in the wind."
     *
     * Freeing `trimDropMin` (0.23 → 0.03) was right, but it exposed every
     * length in the furl path that was a fraction of the sail AS CUT rather
     * than AS SET. Three were: `sailFurlLift` (could lift the foot above its
     * own head), the flutter amplitude (±0.406 m of ripple on 0.227 m of
     * remaining canvas — 2.4x the whole sail, peaking at both leeches and at
     * the foot, i.e. a triangular tab off each end of the roll), and the sewn
     * reef points (0.390 m rigid offsets, 1.7x the remaining sail).
     *
     * So the invariant is not about any one of those terms. It is the thing
     * the user can see: when she is fully furled, the canvas is INSIDE the
     * bundle. Anything that stands outside it is a flapping tab, whichever
     * term put it there.
     */
    const worstLuff = 1.4; // the cap in sailDrive
    for (const sail of sails) {
      const width = sail.aabb.max[0] - sail.aabb.min[0];
      const drop = -sail.aabb.min[1];
      const set = trimDropScale(0, p);
      const roll = furlBundleScale(set);
      // the roll's THINNEST section — the nipped waist at a gasket, which is
      // what the cloth actually has to hide behind (buildSailGeometry)
      const waist = Math.max(0.15, drop * 0.05) * 1.15 * roll * 0.62;
      let worstZ = 0;
      for (let ph = 0; ph < TAU; ph += 0.4) {
        const st = { drive: 1, luff: worstLuff, skew: 0, dropScale: set, flutterPhase: ph, ...FLAT_SHEETS };
        for (let i = 0; i <= 28; i++) {
          for (let j = 0; j <= 16; j++) {
            const q = sailClothPoint(i / 28, j / 16, width, drop, st, mp);
            worstZ = Math.max(worstZ, Math.abs(q[2]));
          }
        }
      }
      expect(worstZ, `${sail.id} cloth stands ${worstZ.toFixed(3)} m off the yard`).toBeLessThan(waist);
    }
  });

  it('…but a SET sail still shakes — the furl fix must not flatten the flutter', () => {
    // WHY: `× set` on the ripple is only correct if it is invisible at full
    // sail. A fix for the furl that quietly took the life out of a drawing
    // sail would be a worse regression than the tabs (§V22 "the sails appear
    // too static", three times).
    const sail = sails.find((s) => s.id === 'sail-main-lower')!;
    const width = sail.aabb.max[0] - sail.aabb.min[0];
    const drop = -sail.aabb.min[1];
    let span = 0;
    for (let ph = 0; ph < TAU; ph += 0.4) {
      const st = { drive: 0.2, luff: 1, skew: 0, dropScale: 1, flutterPhase: ph, ...FLAT_SHEETS };
      const z = sailClothPoint(0, 0, width, drop, st, mp)[2];
      span = Math.max(span, Math.abs(z));
    }
    expect(span).toBeGreaterThan(0.3); // full sail: the leech still flies
  });

  it('has no dead zone: every part of the travel does something', () => {
    // WHY: the other half of the complaint. Trim 0.15..0.54 used to be 39% of
    // the player's control in which the canvas did not move at all, which is
    // where "skips 30-40%" came from. The travel now runs to the very bottom:
    // there is no furled state in which the sail is inert, so the sweep starts
    // at 0 rather than above a geometry threshold.
    //
    // MEASURED OVER THE WHOLE OUTLINE, for the same reason the jump test is:
    // near the bottom of the travel the LOWEST point of the sail stops being
    // the canvas and becomes the roll, which grows more slowly per unit trim
    // than the canvas shrinks (0.0048 of the drop per 2% of trim against
    // 0.0165 on the cloth itself). Reading one number would call that a dead
    // zone while the sail is visibly still gathering.
    const sail = sails.find((s) => s.id === 'sail-main-lower')!;
    const drop = -sail.aabb.min[1];
    let prev: number[] | null = null;
    for (let t = 0; t <= 1.0001; t += 0.02) {
      const now = silhouette(sail.aabb, trimDropScale(t, p));
      if (prev !== null) {
        let moved = 0;
        for (let k = 0; k < now.length; k++) moved = Math.max(moved, Math.abs(now[k] - prev[k]) / drop);
        expect(moved, `trim ${t.toFixed(2)}`).toBeGreaterThan(0.005);
      }
      prev = now;
    }
  });

  it('the gathered roll grows as the canvas shrinks, and only then', () => {
    // WHY: this is the exchange that replaced the swap. The roll must be
    // INVISIBLE at full sail (or it is a sausage lying on a drawing sail) and
    // must reach its authored size when she is in — and in between it may only
    // ever grow, because a roll that thins anywhere is a second discontinuity
    // wearing a smooth face.
    expect(furlBundleScale(1)).toBe(0);
    expect(furlBundleScale(trimDropScale(0, p))).toBeGreaterThan(0.9);
    let prev = -1;
    for (let t = 1; t >= -1e-9; t -= 0.01) {
      const v = furlBundleScale(trimDropScale(t, p));
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    // and at full sail it is not merely small, it is degenerate: every bunt
    // vertex collapses onto the head line, so it rasterises nothing
    const sail = sails.find((s) => s.id === 'sail-main-lower')!;
    const geo = buildSailGeometry('full', sail.aabb);
    const pos = geo.getAttribute('position');
    const bunt = geo.getAttribute('sailBunt');
    let worst = 0;
    for (let i = 0; i < pos.count; i++) {
      if (bunt.getX(i) !== 1) continue;
      worst = Math.max(worst, Math.abs(pos.getY(i)) + Math.abs(pos.getZ(i)));
    }
    expect(worst).toBeGreaterThan(0); // it IS a real bundle when built…
    expect(worst * furlBundleScale(1)).toBe(0); // …and exactly nothing at full sail
    geo.dispose();
  });

  it('gathers the foot into bays as it comes in, and lets it hang when set', () => {
    // WHY: the continuous scale alone slides a flat rectangle of canvas up a
    // slot, which is not "packed-up sails". The foot must rise at the stations
    // its buntlines are made fast to and swag between them — the user's
    // standing note about reefed canvas showing "lines… in the centre or at
    // thirds, instead of just a completely straight line rolled up".
    const drop = 6.3;
    const at = (trim: number, u: number): number =>
      sailFurlLift(u, 0, drop, { drive: 0, luff: 0, skew: 0, dropScale: trimDropScale(trim, p), flutterPhase: 0, ...FLAT_SHEETS }, mp);

    // a set sail is NOT gathered — this must not disturb the belly (§B.21)
    for (let u = 0; u <= 1; u += 0.1) expect(at(1, u)).toBeCloseTo(0, 9);

    // Hauled almost in, the foot is scalloped: stations up, mid-bays hanging.
    //
    // AGAINST THE HANGING DROP, NOT THE BUILT ONE (§V.66 — assert the RATIO).
    // The gather is a fraction of the canvas that is STILL DOWN, which is what
    // stops it lifting the foot above its own head once the canvas is allowed
    // to shorten properly; measuring it against the drop the sail was CUT with
    // is measuring it against a length that is no longer there, and the old
    // absolute bound of 0.05·builtDrop only held because `trimDropMin` pinned
    // the hanging length at 0.23 of it.
    const bays = mp.sailFurlBays;
    const hanging = drop * trimDropScale(0.05, p);
    for (let b = 0; b < bays; b++) {
      const station = b / bays;
      const midBay = (b + 0.5) / bays;
      expect(at(0.05, station) - at(0.05, midBay)).toBeGreaterThan(hanging * 0.1);
    }
    /**
     * THE GATHER GROWS MONOTONICALLY AS SHE COMES IN — AS A FRACTION OF THE
     * CANVAS IT IS GATHERING, which is the only form of that statement that
     * survives the swag being scaled by the hanging drop (§V.66).
     *
     * In METRES it is a parabola: `swag · furl · set`, zero at full sail and
     * zero again when there is no canvas left down, peaking mid-travel. That
     * is correct rather than a regression — a sail with nothing hanging has
     * nothing to swag, and by then the gathered ROLL carries the lumpiness.
     * Asserting the metres monotone would forbid the sail ever finishing its
     * furl. What must never reverse is how hard the buntlines are hauling on
     * what is left, and that is the ratio.
     */
    const ratio = (trim: number): number => {
      const hang = drop * trimDropScale(trim, p);
      return at(trim, 0) / hang;
    };
    let prev = ratio(1);
    let worstStep = 0;
    for (let t = 0.99; t >= 0; t -= 0.01) {
      const v = ratio(t);
      expect(v, `trim ${t.toFixed(2)}`).toBeGreaterThan(prev - 1e-9);
      worstStep = Math.max(worstStep, Math.abs(at(t, 0) - at(t + 0.01, 0)));
      prev = v;
    }
    // …and in metres it is still STEPLESS, which is the property the user
    // feels: no 1% of the travel may move the gathered foot by 2% of the drop
    expect(worstStep).toBeLessThan(drop * 0.02);
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
  const state = (drive: number) => ({ drive, luff: 0, skew: 0, dropScale: 1, flutterPhase: 0, ...FLAT_SHEETS });

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

  it('holds the leech at the YARDARM and the CLEW, and lets it fly between', () => {
    // RE-CUT, and the old assertion was the bug. It required the leech to sit
    // at z ≈ 0 for EVERY v, on the reasoning that the edges are "bolt-roped
    // and sheeted, so a belly that did not close there would tear the cloth
    // off its own edges". A bolt rope is sewn ALONG an edge — it stiffens the
    // edge, it does not attach it to anything. A square sail's leech is bent
    // to the ship at exactly TWO points, the yardarm and the clew, and flies
    // between them.
    //
    // Pinning it everywhere is what made the sail's projected outline a
    // PERFECT RECTANGLE in every wind, at every angle, at every trim — the
    // user's twice-made "the top and bottom corners don't have to be
    // perfectly straight aligned". So the intent this now encodes is: held
    // where it is actually made fast, free where it is not, and bounded.
    const width = 12.17;
    const drop = 6.3; // §T.74c: the corner tension field is a field in METRES
    for (const u of [0, 1]) {
      // made fast at both ends
      expect(Math.abs(sailClothOffset(u, 0, width, drop, state(1), p))).toBeLessThan(0.02);
      expect(Math.abs(sailClothOffset(u, 1, width, drop, state(1), p))).toBeLessThan(0.02);
      // and genuinely flying in between — this is the assertion that would
      // have failed on the old shape, which is the point of re-cutting it
      expect(sailClothOffset(u, 0.5, width, drop, state(1), p)).toBeGreaterThan(0.05);
    }
    // the head is bent to its yard along its whole length
    for (const u of [0.2, 0.5, 0.8]) {
      expect(Math.abs(sailClothOffset(u, 1, width, drop, state(1), p))).toBeLessThan(0.02);
    }
    // bounded: the leech may fly, it may not blow through the rigging
    const peak = sailCamberRatio(1, p) * width;
    for (const u of [0, 1]) {
      expect(sailClothOffset(u, 0.5, width, drop, state(1), p)).toBeLessThan(peak);
    }
  });

  it('is CAMBER against the chord, not a fraction of the drop (the bulge bug)', () => {
    // WHY THIS IS THE TEST: the belly is a section bowing across the sail's
    // WIDTH, so its depth is camber and camber is measured against the chord
    // it bows over. `sailBillow` scaled it by the DROP instead, which is not
    // a wrong number so much as a wrong DIMENSION — and it is the whole of
    // "still looks very very bulgy": measured on the shipped params the main
    // course carried 24.8% of chord at the default sea and 40.7% in a storm,
    // against a real square sail's 10-15%.
    //
    // Asserted as a RATIO so it survives any retune of the sail's size, and
    // so that a future change that reintroduces the drop-scaling fails here
    // rather than on screen. Two sails of very different aspect must agree.
    // QUILT OFF, on purpose: this asserts the PRIMARY camber law. The
    // inter-seam quilting is a physical repeat, so mid-width lands at a
    // different point in its cycle on a 6 m sail than on an 18 m one — that is
    // correct and is asserted separately below. Leaving it on here would test
    // two laws at once and fail for the right reason on the wrong assertion.
    const smooth = { ...p, sailFlutterAmp: 0, sailSeamQuilt: 0 };
    const narrow = { width: 6, drop: 6 };
    const wide = { width: 18, drop: 6 };
    // §T.74c made this test STRONGER for free: the corner tension field is a
    // field in metres over the cut panel, so these two sails now differ in
    // ASPECT as well as size and the camber law has to survive both.
    const camberOf = (s: { width: number; drop: number }): number =>
      sailClothOffset(0.5, SAIL_BELLY_FOOT, s.width, s.drop, state(1), smooth) / s.width;
    expect(camberOf(narrow)).toBeCloseTo(camberOf(wide), 6);
    // and it sits where a real sail sits
    expect(camberOf(wide)).toBeGreaterThan(0.05);
    expect(camberOf(wide)).toBeLessThanOrEqual(p.sailCamberMax);
  });

  it('leaves real headroom above the wind the game actually sails in', () => {
    // THE FLAG BUG, again (§B: flagStreamRef 7 against a default wind of 11
    // pinned the telltale at maximum, so it carried no information). If drive
    // is already at its ceiling in ordinary conditions, a breeze and a gale
    // produce identical canvas and the sail stops reporting anything.
    // RE-CUT. This used to assert `sailWindRef > windSpeed`, which was the
    // right guard for a LINEAR ramp into a clamp: put the ref above the working
    // wind or the sail pins at maximum and a breeze and a gale look identical.
    // The load curve saturates now, so the headroom comes from its SHAPE and
    // the ref is a scale, not a ceiling — asserting its position would be
    // asserting the old curve. The intent is unchanged: ordinary conditions
    // must not be pinned at the top, or the sail stops reporting anything.
    const ordinary = sailDrive({ ...base, windDirection: 0, windSpeed: oceanParams.windSpeed }, p);
    const gale = sailDrive({ ...base, windDirection: 0, windSpeed: oceanParams.windSpeed * 2 }, p);
    expect(ordinary.drive).toBeGreaterThan(0.4); // she is drawing…
    expect(gale.drive).toBeGreaterThan(ordinary.drive * 1.02); // …with room above her
  });

  it('deepens visibly from light air to a gale, and never past a real sail', () => {
    // RE-CUT. This used to assert `ordinary > 1.8` METRES on a 7 m course —
    // an absolute depth against the DROP, with no chord anywhere in it. That
    // encodes two things, only one of which is the intent: "wind drives
    // belly" (yes) and "and it is this deep" (no — that is the bulge the user
    // has now complained about twice). Restated as a camber RATIO, so it
    // fails if wind stops driving the belly and passes at any sane camber.
    const CHORD = 12.17; // the galleon's main course
    const CDROP = 6.3;
    // quilt off: the ceiling is a bound on the sail's OVERALL depth, and the
    // quilting is a ±ripple about it, bounded separately just below
    const smooth = { ...p, sailFlutterAmp: 0, sailSeamQuilt: 0 };
    const camberAt = (windSpeed: number): number => {
      const d = sailDrive({ ...base, windDirection: 0, windSpeed }, p).drive;
      return sailClothOffset(0.5, SAIL_BELLY_FOOT, CHORD, CDROP, state(d), smooth) / CHORD;
    };
    const light = camberAt(5);
    const ordinary = camberAt(oceanParams.windSpeed);
    const gale = camberAt(22);
    expect(light).toBeLessThan(ordinary);
    expect(ordinary).toBeLessThan(gale);
    // RE-CUT: this demanded gale/light > 2.5, i.e. a curve that keeps climbing.
    // The user asked for the opposite at the top — "up to a certain max, from
    // which more speed is not gonna necessarily do more bending" — so the
    // assertion now encodes EARLY ONSET plus SATURATION, which is the shape,
    // rather than a raw ratio, which was the old linear slope in disguise.
    const gain = (a: number, b: number): number => (b - a) / Math.max(a, 1e-6);
    /**
     * BAR RE-CUT 0.15 → 0.05 AT §T.74a, AND IT IS A LOOSENING — SAY SO.
     *
     * It measured 0.24 on the old law and now measures 0.076. Nothing regressed:
     * the CURVE changed shape on purpose. Depth is no longer `camber × drive`
     * but `√(excess taken up)`, so a great deal more of the belly has already
     * arrived by 5 m/s and there is correspondingly less left to gain between 5
     * and 11 — which is the physical claim, not a side effect. A sail with a
     * fixed cut has a fixed amount of cloth to bulge with; once the wind has
     * taken it up, more wind buys tension.
     *
     * WHAT THE BAR IS FOR IS UNCHANGED, and that is why it is still here rather
     * than deleted: it is the flag bug's guard (§B: `flagStreamRef` 7 against a
     * default wind of 11 pinned the telltale at maximum, so it reported
     * nothing). If drive stops reaching the cloth at all, this goes to zero.
     * 0.05 is well clear of that and well below the measured 0.076.
     *
     * The SHAPE assertions on the next lines are the ones that carry the intent
     * now, and they got STRICTER for free — see tests/sailMembrane.test.ts,
     * where the concavity is asserted as `first quarter > 3× last quarter`
     * (measured 3.73×, and exactly 1.00× on the old linear law).
     */
    expect(gain(light, ordinary)).toBeGreaterThan(0.05); // it rises where she sails…
    expect(gain(ordinary, gale)).toBeLessThan(gain(light, ordinary)); // …then flattens
    // becalmed is genuinely slack — the curve passes through zero, and an
    // additive floor (which this briefly had) would have held camber in a calm
    expect(camberAt(0)).toBeCloseTo(0, 6);
    // …and the whole of it must live where a square sail's camber lives. The
    // ceiling is the half that was missing: a gale used to reach 45% of chord.
    expect(ordinary).toBeGreaterThan(0.05);
    expect(gale).toBeLessThanOrEqual(p.sailCamberMax + 1e-9);

    // §V44: BOUNDED FACTORS DO NOT IMPLY A BOUNDED PRODUCT, so the quilted
    // total gets its own bound rather than being assumed to inherit the cap.
    // The quilt peaks at +0.5 of its amplitude, so the deepest cloth on the
    // sail is the ceiling times (1 + 0.5·quilt) and no more — stated here so
    // that raising `sailSeamQuilt` can never quietly blow the camber ceiling.
    const quiltedGale = (): number => {
      let worst = 0;
      for (let i = 0; i <= 2000; i++) {
        const d = sailDrive({ ...base, windDirection: 0, windSpeed: 22 }, p).drive;
        worst = Math.max(
          worst,
          sailClothOffset(i / 2000, SAIL_BELLY_FOOT, CHORD, CDROP, state(d), {
            ...p,
            sailFlutterAmp: 0,
            sailLeechOpen: 0,
          }) / CHORD,
        );
      }
      return worst;
    };
    expect(quiltedGale()).toBeLessThanOrEqual(p.sailCamberMax * (1 + 0.5 * p.sailSeamQuilt) + 1e-9);
  });

  it('goes slack in irons and inverts when the wind backs the sail', () => {
    const irons = sailDrive({ ...base, windDirection: Math.PI, windSpeed: 12 }, p);
    const backed = sailClothOffset(0.5, SAIL_BELLY_FOOT, 7, 5, state(irons.drive), p);
    expect(backed).toBeLessThan(0); // pressed back against the rig, not filled
  });
});

/**
 * §V22 / §V43 / §T.34 — the SILHOUETTE, which is what the user has now
 * complained about twice: "the top and bottom corners they don't have to be
 * perfectly straight aligned", and "it still looks very very bulgy".
 *
 * Both complaints have the same structural cause and no amount of tuning
 * reaches it. The old shape displaced the cloth along ONE axis (local +z) and
 * left x and y as pure functions of (u, v), so the sail's projected outline
 * was EXACTLY the flat rectangle for every wind, every angle and every trim.
 * A z-only field pinned at its edges cannot round a corner or curve an edge.
 *
 * It also meant the canvas GAINED SURFACE AREA as the wind rose — it inflated
 * like a balloon rather than bowing like a fixed piece of cloth, which is a
 * cause of "bulgy" that is independent of how deep the belly is.
 *
 * These tests are about the OUTLINE. Every one of them passes on a sail of any
 * depth and fails the moment the shape goes back to being a rectangle.
 */
describe('the sail is CLOTH, not an inflating bag (§V43 SoT parity)', () => {
  const p = { ...shipMaterialParams, sailFlutterAmp: 0 };
  const WIDTH = 12.17; // the galleon's main course
  const DROP = 6.3;
  const state = (drive: number) => ({ drive, luff: 0, skew: 0, dropScale: 1, flutterPhase: 0, ...FLAT_SHEETS });
  const pt = (u: number, v: number, drive: number) =>
    sailClothPoint(u, v, WIDTH, DROP, state(drive), p);

  it('draws the clews IN and UP as she fills — arc length is conserved', () => {
    // THE CUE THAT SEPARATES CLOTH FROM A BALLOON. A strip that bows by d over
    // a chord c is c·(1 + 8/3·(d/c)²) long, so it must give up span to pay for
    // its own bow. Without this the sail simply gets bigger as it fills, and
    // the sheets and blocks have nothing to follow.
    const slack = pt(1, 0, 0); // becalmed clew
    const full = pt(1, 0, 1); // hard full
    expect(full[0]).toBeLessThan(slack[0]); // drawn inboard…
    expect(full[1]).toBeGreaterThan(slack[1]); // …and lifted

    // and it is MONOTONE in the wind, not a one-off offset
    let prevX = Infinity;
    let prevY = -Infinity;
    for (const drive of [0, 0.25, 0.5, 0.75, 1]) {
      const [x, y] = pt(1, 0, drive);
      expect(x).toBeLessThanOrEqual(prevX + 1e-9);
      expect(y).toBeGreaterThanOrEqual(prevY - 1e-9);
      prevX = x;
      prevY = y;
    }
  });

  it('becalmed, the cloth returns to the panel it was cut from', () => {
    // the compensation must VANISH with the wind, or a ship at anchor shows a
    // permanently shrunken sail. Only the static roach survives, by design.
    const flat = { ...p, sailFootRoach: 0 };
    const [x, y, z] = sailClothPoint(1, 0, WIDTH, DROP, state(0), flat);
    expect(x).toBeCloseTo(WIDTH / 2, 9);
    expect(y).toBeCloseTo(-DROP, 9);
    expect(z).toBeCloseTo(0, 9);
  });

  it('bows the LEECH inboard, deepest at the draft and not at all at the head', () => {
    // the side edge is no longer a straight vertical line: each horizontal
    // strip gives up span in proportion to its OWN bow, and the bow follows
    // the vertical belly profile — zero at the yard, deepest around mid-height
    const headX = pt(1, 1, 1)[0];
    const draftX = pt(1, SAIL_BELLY_FOOT, 1)[0];
    const footX = pt(1, 0, 1)[0];
    expect(headX).toBeCloseTo(WIDTH / 2, 9); // bent to the yard: full width
    expect(draftX).toBeLessThan(headX - 0.05); // pulled in where she is deepest
    expect(draftX).toBeLessThan(footX); // the foot is a free edge, less bow
  });

  it('scallops the FOOT, highest at mid-width and not at all at the clews', () => {
    // the vertical strips bow too, most where the section is deepest, so the
    // bottom edge curves up between the two clews instead of running straight
    const clewY = pt(1, 0, 1)[1];
    const midY = pt(0.5, 0, 1)[1];
    expect(midY).toBeGreaterThan(clewY + 0.05);
    // and the curve is smooth, not a kink: sampled across the foot it rises
    // to a single interior maximum
    const ys = Array.from({ length: 21 }, (_, i) => pt(i / 20, 0, 1)[1]);
    const argmax = ys.indexOf(Math.max(...ys));
    expect(argmax).toBeGreaterThan(3);
    expect(argmax).toBeLessThan(17);
  });

  it('never leaves the foot a straight line, even with no wind in her', () => {
    // the roach is CUT into the sail, so the silhouette is honest at anchor
    // too — the complaint was about the outline, not about the breeze
    expect(p.sailFootRoach).toBeGreaterThan(0);
    const clewY = sailClothPoint(0, 0, WIDTH, DROP, state(0), p)[1];
    const midY = sailClothPoint(0.5, 0, WIDTH, DROP, state(0), p)[1];
    expect(midY).toBeGreaterThan(clewY + 0.05);
  });

  it('TWISTS: the upper sail presents at a different angle from the lower', () => {
    // after the belly itself, the most recognisable cue that a sail is
    // answering the wind rather than being posed in it. Measured as the
    // deepest point of the section MOVING between foot and head — a sail whose
    // every section is identical is a extruded shape, not canvas.
    // QUILT OFF: the draft migration is a property of the SMOOTH section, and
    // the quilting puts ±0.15 of local ripple on top whose crests sit at fixed
    // u for every v. An argmax search over the quilted surface therefore snaps
    // to the nearest crest and reports the SEAM grid instead of the draft —
    // a measurement artefact, not a lost cue.
    const smooth = { ...p, sailSeamQuilt: 0 };
    const draftOf = (v: number): number => {
      let best = -Infinity;
      let arg = 0;
      for (let i = 0; i <= 400; i++) {
        const u = i / 400;
        const z = sailClothOffset(u, v, WIDTH, DROP, state(1), smooth);
        if (z > best) {
          best = z;
          arg = u;
        }
      }
      return arg;
    };
    expect(Math.abs(draftOf(0.9) - draftOf(0.1))).toBeGreaterThan(0.03);
    // …and it is DRIVEN, not baked: no wind, no twist
    const flat = { ...smooth, sailTwist: 0 };
    const at = (v: number, pp: typeof p): number =>
      sailClothOffset(0.3, v, WIDTH, DROP, state(1), pp);
    expect(at(0.9, smooth)).not.toBeCloseTo(at(0.9, flat), 4);
  });

  it('a reefed sail is FLATTER, and the outline agrees with the surface', () => {
    // the cloth that is left is stretched between its yard and the reef band.
    // The outline shrink and the belly must read the SAME camber or the edge
    // and the surface inside it disagree — a visible crease at the leech.
    const reefed = { drive: 1, luff: 0, skew: 0, dropScale: 0.3, flutterPhase: 0, ...FLAT_SHEETS };
    const set = state(1);
    expect(Math.abs(sailClothOffset(0.5, SAIL_BELLY_FOOT, WIDTH, DROP, reefed, p))).toBeLessThan(
      Math.abs(sailClothOffset(0.5, SAIL_BELLY_FOOT, WIDTH, DROP, set, p)),
    );
    // the clew of the reefed sail is drawn in LESS, because she is bowing less
    const inboardSet = WIDTH / 2 - sailClothPoint(1, 0, WIDTH, DROP, set, p)[0];
    const inboardReefed = WIDTH / 2 - sailClothPoint(1, 0, WIDTH, DROP, reefed, p)[0];
    expect(inboardReefed).toBeLessThan(inboardSet);
  });

  it('arc-length compensation is INVERTIBLE, and only ever shortens', () => {
    /**
     * RE-CUT AT §T.74a, AND THE OLD ASSERTION WAS THE ONE THAT HAD TO GO.
     *
     * It read "arc-length compensation is the textbook parabola" and pinned the
     * literal 8/3 — "the coefficient is not a taste knob, it is the 8/3 of a
     * parabolic arc". That is true of a parabola and false of this sail: the
     * corner tension field flattens both ends of every strip, the leech standoff
     * peaks where the membrane vanishes, and the vertical profile was never a
     * parabola. Integrating the realised shapes gives 0.50 … 2.54 (see
     * SAIL_ARC_COEFF), and holding 8/3 cost 6.81% of the cloth's own length
     * WITH A SIGN FLIP — the foot gained canvas while the draft lost it.
     *
     * So the constant is now MEASURED, and pinning a measurement is asserting
     * the fit rather than the intent (§Rule 6). What actually has to hold is
     * the pair of properties the shape depends on, and they are asserted here:
     *
     *   · it INVERTS `sailCamberRatio` exactly — the same coefficient converts
     *     excess to bow and bow back to lost span, so the sail's depth and the
     *     sail's outline can never disagree about one piece of cloth;
     *   · it never LENGTHENS the cloth whatever it is handed (§V28/§V44).
     */
    expect(arcShorten(0)).toBeCloseTo(1, 12);
    expect(arcShorten(0.15)).toBeCloseTo(1 / (1 + SAIL_ARC_COEFF * 0.15 * 0.15), 12);
    // the round trip, which is the property that replaced the literal
    for (const excess of [0.02, 0.065, 0.15]) {
      const k = sailCamberRatio(1, { ...p, sailClothExcess: excess, sailCamberMax: 1 });
      expect(1 / arcShorten(k) - 1).toBeCloseTo(excess, 12);
    }
    for (const k of [-2, -0.3, 0, 0.3, 2, NaN]) {
      const f = arcShorten(k);
      expect(Number.isFinite(f)).toBe(true);
      expect(f).toBeGreaterThan(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });

  it('the leech standoff is held at BOTH its made-fast ends, for every u', () => {
    // the shape term itself, asserted directly: whatever the edge does in
    // between, it is zero where the sail is actually bent to the ship
    for (let i = 0; i <= 10; i++) {
      const u = i / 10;
      expect(leechStandoff(u, 0)).toBeCloseTo(0, 9); // the clew
      expect(leechStandoff(u, 1)).toBeCloseTo(0, 9); // the yardarm
    }
    expect(leechStandoff(0, 0.5)).toBeCloseTo(1, 9); // full at the leech
    expect(leechStandoff(0.5, 0.5)).toBeCloseTo(0, 9); // nothing at mid-width
  });
});

/**
 * §V22 / §V43 — THE CORNER CONSTRAINT.
 *
 * User: "it's like arc length, but ALSO that the actual pin points stop being
 * flat in space and can actually be ANGLED. That's also part of the secret
 * here. So they can be angled, an extension to the piece of rope or block that
 * it's attached to, instead of just being always perfectly flat against the
 * mast."
 *
 * The head is laced to its yard along its whole length, so it genuinely is a
 * straight line and must stay one. The CLEWS are hauled by sheets to points on
 * the ship that are nowhere near the sail's plane, so the foot leaves that
 * plane. Before this, `x = (u − 0.5)·width` with no wind term at all: the
 * corners lived in the yard's plane and could never leave it.
 */
describe('the clews are hauled OUT of the yard plane (§V45 one truth)', () => {
  const p = { ...shipMaterialParams, sailFlutterAmp: 0 };
  const WIDTH = 12.17;
  const DROP = 6.3;
  // a ship heading +z with her yards square: the sheets lead aft and out
  const leads = sheetLeadDirections(IDENTITY_MATRIX, 0, 1, p.sailSheetSpread);
  const st = (drive: number) => ({
    drive,
    luff: 0,
    skew: 0,
    dropScale: 1,
    flutterPhase: 0,
    sheetLeadPort: leads.port,
    sheetLeadStarboard: leads.starboard,
  });

  it('hauls the sheets AFT and DOWN, not somewhere in the sail plane', () => {
    // the direction is the thing under test: aft is −z in a ship-aligned
    // frame, and a sheet that led anywhere else would not be a sheet
    for (const lead of [leads.port, leads.starboard]) {
      expect(lead[2]).toBeLessThan(-0.2); // aft
      expect(lead[1]).toBeLessThan(-0.2); // and down
    }
    // …and they SPREAD, port to port and starboard to starboard. This is the
    // difference that rotates the foot's chord against the head's.
    expect(leads.port[0]).toBeLessThan(leads.starboard[0]);
  });

  it('moves the clew in ALL THREE axes — the corner is no longer flat', () => {
    const flat = sailClothPoint(1, 0, WIDTH, DROP, { ...st(1), ...FLAT_SHEETS }, p);
    const hauled = sailClothPoint(1, 0, WIDTH, DROP, st(1), p);
    // the old shape could only ever move z. All three must move now, or the
    // corner is still pinned in the yard's plane.
    expect(Math.abs(hauled[0] - flat[0])).toBeGreaterThan(0.01);
    expect(Math.abs(hauled[1] - flat[1])).toBeGreaterThan(0.01);
    expect(Math.abs(hauled[2] - flat[2])).toBeGreaterThan(0.01);
  });

  it('leaves the HEAD laced to its yard — a straight line, still', () => {
    // the one corner constraint that was already right, and the sheets must
    // not disturb it: the head is bent to the spar along its whole length
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      const pull = sailCornerPull(u, 1, WIDTH, st(1), p);
      for (const c of pull) expect(Math.abs(c)).toBeLessThan(1e-9);
    }
    // and the head's own line stays straight in x: equal spacing, no bow
    const xs = [0, 0.25, 0.5, 0.75, 1].map(
      (u) => sailClothPoint(u, 1, WIDTH, DROP, st(1), p)[0],
    );
    for (let i = 2; i < xs.length; i++) {
      expect(xs[i] - xs[i - 1]).toBeCloseTo(xs[1] - xs[0], 6);
    }
  });

  it('comes taut with the load — a slack sheet hauls nothing', () => {
    const slack = sailCornerPull(1, 0, WIDTH, st(0), p);
    const taut = sailCornerPull(1, 0, WIDTH, st(1), p);
    for (const c of slack) expect(Math.abs(c)).toBeCloseTo(0, 9);
    expect(Math.hypot(...taut)).toBeGreaterThan(0.05);
  });

  it('TWISTS the foot against the head once the yard is BRACED', () => {
    // THE ANSWER TO "does twist fall out of the corner solve?": YES, but only
    // where it physically should, and the null case is worth stating because
    // it is what proves the mechanism is real rather than a fudge.
    //
    // With the yard SQUARE the two sheets are mirror images of each other, so
    // they haul both clews equally aft and the foot swings back as a rigid
    // line — no twist, correctly. BRACE the yard and that mirror symmetry is
    // broken: the leads' purely-lateral difference rotates into the sail's own
    // frame and acquires a fore-and-aft component, so the two clews are hauled
    // by different amounts and the foot's chord rotates against the head's.
    //
    // Measured with the aerodynamic draft-migration term (`sailTwist`) OFF, so
    // this is the corner geometry and nothing else. The two are complementary:
    // this moves where the sail's CORNERS are, that moves where it is DEEPEST.
    const noDraftTwist = { ...p, sailTwist: 0 };
    const braced = Math.PI / 5;
    const c = Math.cos(braced);
    const sn = Math.sin(braced);
    const m = [c, 0, -sn, 0, 0, 1, 0, 0, sn, 0, c, 0, 0, 0, 0, 1];
    const bl = sheetLeadDirections(m, 0, 1, p.sailSheetSpread);
    const bracedState = {
      ...st(1),
      sheetLeadPort: bl.port,
      sheetLeadStarboard: bl.starboard,
    };
    const at = (u: number, v: number): number[] =>
      sailClothPoint(u, v, WIDTH, DROP, bracedState, noDraftTwist);
    // the head's chord runs straight across its yard: both ends at the same z
    expect(Math.abs(at(1, 1)[2] - at(0, 1)[2])).toBeLessThan(1e-6);
    // the foot's does not — its two sheets pull it round
    expect(Math.abs(at(1, 0)[2] - at(0, 0)[2])).toBeGreaterThan(0.01);

    // and SQUARE is the null case: symmetric sheets, no geometric twist
    const sq = (u: number): number => sailClothPoint(u, 0, WIDTH, DROP, st(1), noDraftTwist)[2];
    expect(Math.abs(sq(1) - sq(0))).toBeLessThan(1e-9);
  });

  it('never moves a vertex when there is no sheet, and never emits a NaN', () => {
    // §V28: this reaches vertices. A sail with no sheet (the plan skips some)
    // must render exactly as the un-hauled shape, not as a hole in the world.
    const none = sailCornerPull(0.3, 0.2, WIDTH, { ...st(1), ...FLAT_SHEETS }, p);
    for (const c of none) expect(c).toBe(0);
    const poison = {
      ...st(NaN),
      sheetLeadPort: [NaN, NaN, NaN] as [number, number, number],
      sheetLeadStarboard: [Infinity, 0, 0] as [number, number, number],
    };
    for (const c of sailCornerPull(NaN, NaN, NaN, poison, p)) {
      expect(Number.isFinite(c)).toBe(true);
    }
    // and a heading that has not been published yet fails to FLAT, not to a
    // direction someone made up
    const dead = sheetLeadDirections(IDENTITY_MATRIX, 0, 0, p.sailSheetSpread);
    expect(dead.port).toEqual([0, 0, 0]);
  });

  it('swings with the BRACE — the same anchors arrive from a new quarter', () => {
    // the whole reason the lead is resolved in SAIL-LOCAL space. Brace the
    // yard round and the fixed sheet anchors pull the foot a different way,
    // which is what stops the rig reading as one rigid assembly.
    const braced = Math.PI / 5;
    const c = Math.cos(braced);
    const sn = Math.sin(braced);
    // column-major, rotation about +y
    const m = [c, 0, -sn, 0, 0, 1, 0, 0, sn, 0, c, 0, 0, 0, 0, 1];
    const square = sheetLeadDirections(IDENTITY_MATRIX, 0, 1, p.sailSheetSpread);
    const swung = sheetLeadDirections(m, 0, 1, p.sailSheetSpread);
    expect(Math.abs(swung.port[0] - square.port[0])).toBeGreaterThan(0.05);
  });
});

/**
 * §V22 / §V45 — WHAT IS SEWN TO THE CLOTH RIDES THE CLOTH.
 *
 * User, with every instance circled on both courses and both sides: "all of
 * the larger bottom sails have this little thing poking through them… It's not
 * the seams, it's not the normal ropes, it's something else."
 *
 * It was `reefPoints()`. Each reef point is a small quad carrying ONE (u, v)
 * for all four vertices so the cloth moves it RIGIDLY rather than shearing it
 * — the right instinct, half-built: the quad was translated to its station and
 * kept the flat panel's orientation. Invisible on a nearly-flat sail; once the
 * camber fix took the course from 8% of chord to 14%, the canvas curved out
 * from under quads still lying in the original plane and their corners came
 * through.
 *
 * The second latent bug that fix exposed, after the buntline. Both were fine
 * only because the sail barely moved.
 */
describe('parts sewn to the canvas ride its frame, not its plane', () => {
  const p = { ...shipMaterialParams, sailFlutterAmp: 0 };
  const WIDTH = 12.17;
  const DROP = 6.3;
  const st = (drive: number) => ({
    drive, luff: 0, skew: 0, dropScale: 1, flutterPhase: 0,
    sheetLeadPort: [0, 0, 0] as [number, number, number],
    sheetLeadStarboard: [0, 0, 0] as [number, number, number],
  });
  // a reef point's four corners, as offsets from its own flat station
  const CORNERS: [number, number, number][] = [
    [-0.0175, 0.15, 0.02], [0.0175, 0.15, 0.02],
    [-0.0175, -0.15, 0.02], [0.0175, -0.15, 0.02],
  ];

  it('keeps every corner CLEAR of the canvas, at any camber', () => {
    // THE BUG, asserted directly. The corner must stay on the outside of the
    // surface — measured as its height above the cloth's own tangent plane at
    // the station it is sewn to. Flat placement fails this the moment the
    // sail curves; the frame placement holds it at the standoff exactly.
    for (const drive of [0, 0.4, 0.8, 1.0]) {
      const s = st(drive);
      for (const [u, v] of [[0.2, 0.66], [0.5, 0.38], [0.8, 0.66]] as const) {
        const base = sailClothPoint(u, v, WIDTH, DROP, s, p);
        const n = sailClothFrame(u, v, WIDTH, DROP, s, p).normal;
        for (const c of CORNERS) {
          const q = sailSewnPoint(u, v, c, WIDTH, DROP, s, p);
          const height = (q[0] - base[0]) * n[0] + (q[1] - base[1]) * n[1] + (q[2] - base[2]) * n[2];
          expect(height).toBeCloseTo(c[2], 6); // exactly its standoff, still
          expect(height).toBeGreaterThan(0); // …and on the outside
        }
      }
    }
  });

  it('moves the quad RIGIDLY — it must not shear with the curvature', () => {
    // the single shared (u, v) is what buys this; if a future change gives the
    // quad per-vertex uv it will start shearing and this catches it
    const s = st(1);
    const [u, v] = [0.35, 0.5];
    for (let i = 0; i < CORNERS.length; i++) {
      for (let j = i + 1; j < CORNERS.length; j++) {
        const a = sailSewnPoint(u, v, CORNERS[i], WIDTH, DROP, s, p);
        const b = sailSewnPoint(u, v, CORNERS[j], WIDTH, DROP, s, p);
        const want = Math.hypot(
          CORNERS[i][0] - CORNERS[j][0],
          CORNERS[i][1] - CORNERS[j][1],
          CORNERS[i][2] - CORNERS[j][2],
        );
        expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeCloseTo(want, 6);
      }
    }
  });

  it('reduces to the flat placement on a becalmed sail', () => {
    // no camber ⇒ the frame is the panel's own axes ⇒ nothing moves. If this
    // fails the basis is built wrong-handed or the tangents are swapped.
    const s = st(0);
    const flatP = { ...p, sailFootRoach: 0 };
    const q = sailSewnPoint(0.5, 0.5, [0.1, 0.2, 0.02], WIDTH, DROP, s, flatP);
    expect(q[0]).toBeCloseTo(0.1, 6);
    expect(q[1]).toBeCloseTo(-DROP * 0.5 + 0.2, 6);
    expect(q[2]).toBeCloseTo(0.02, 6);
  });

  it('leaves the HEAD still, which is why the robands need no frame', () => {
    // `sailTies()` builds the robands at weight 0 — they are seized to the
    // YARD, which does not deform. That is only safe because every term of the
    // shape carries a (1 − v) or a down(v) that vanishes at the head. Asserted
    // rather than assumed: if a future term moves the head, the robands start
    // floating off it and this fires first.
    for (const drive of [0, 1]) {
      for (const u of [0, 0.3, 0.5, 0.7, 1]) {
        const q = sailClothPoint(u, 1, WIDTH, DROP, st(drive), p);
        expect(q[0]).toBeCloseTo((u - 0.5) * WIDTH, 6);
        expect(q[1]).toBeCloseTo(0, 6);
        expect(q[2]).toBeCloseTo(0, 6);
      }
    }
  });
});

/**
 * §V.55 / §B.30 — the flutter phase, and the two-clock defect it closes.
 */
describe('flutter rides an INTEGRATED phase with one owner (§V.55, §B.30)', () => {
  const p = shipMaterialParams;

  it('shakes faster the harder she luffs — which needs the integral', () => {
    // The old shape held the rate CONSTANT and let luff drive amplitude only,
    // because `time × ω(luff)` is not a phase when ω moves: its instantaneous
    // frequency is ω + t·dω/dt and elapsed time multiplies every wobble in the
    // rate (measured on the flags: 0.93 Hz intended, 59.5 Hz at ten minutes,
    // with sign flips). An accumulator needs ONE owner, and the shape had two
    // evaluators on two clocks. It has one owner now, so this cue is legal.
    expect(sailFlutterRate(1, p)).toBeGreaterThan(sailFlutterRate(0, p) * 1.5);
    expect(sailFlutterRate(0, p)).toBeCloseTo(p.sailFlutterFreq, 9);
  });

  it('the rate is BOUNDED, so the accumulator can never run away (§V44)', () => {
    for (const luff of [-5, 0, 0.5, 1, 99, NaN]) {
      const r = sailFlutterRate(luff, p);
      expect(Number.isFinite(r)).toBe(true);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(p.sailFlutterFreq * (1 + 1.4 * p.sailFlutterLuffRate) + 1e-9);
    }
  });

  it('the shape reads a phase and owns no clock at all', () => {
    // THE ACTUAL FIX for §B.30's "~0.28 m of rope anchor" divergence: the CPU
    // evaluator and the shader cannot disagree about time if neither has a
    // clock. Same phase in ⟹ same cloth out, and the phase is handed to both.
    const width = 12.17;
    const at = (flutterPhase: number): number =>
      sailClothOffset(0.2, 0.3, width, 6.3, { drive: 0.7, luff: 0.5, skew: 0, dropScale: 1, flutterPhase, ...FLAT_SHEETS }, p);
    expect(at(1.234)).toBeCloseTo(at(1.234), 12);
    expect(at(0)).not.toBeCloseTo(at(Math.PI / 2), 4);
    // and it is periodic in 2π, which is what makes wrapping the accumulator
    // safe — a wrap must not show as a jump in the cloth
    expect(at(0.7)).toBeCloseTo(at(0.7 + Math.PI * 2), 6);
  });
});

/**
 * §V22 — "not wind speed and wind capture dependent enough" (Stage 2a/2c).
 */
describe('the sails feel the wind the SHIP feels (apparent, braced)', () => {
  const p = shipMaterialParams;
  const ahead = { forwardX: 0, forwardZ: 1, yawRate: 0 };

  it('eases as she runs away from the wind, loads as she hardens up', () => {
    // A ship running dead downwind at 8 m/s in an 11 m/s breeze feels 3 m/s
    // and her canvas should go soft — the cue her own masthead pennant has
    // always shown (flagDynamics.apparentWind), which the sails never read.
    // Same TRUE wind in all three cases: only her way through it changes.
    const trueWind = { windDirection: 0, windSpeed: 11 };
    const anchored = sailDrive({ ...ahead, ...trueWind }, p).drive;
    const running = sailDrive({ ...ahead, ...trueWind, shipVelZ: 8 }, p).drive;
    const punching = sailDrive({ ...ahead, ...trueWind, shipVelZ: -4 }, p).drive;
    // The FACTOR is deliberately gone: it encoded the old linear map. The load
    // curve is concave now (early onset), so easing the apparent wind eases the
    // cloth by less than proportionally — which is the point, and is what stops
    // a ship running at near wind speed from showing a flat sheet.
    expect(running).toBeLessThan(anchored);
    expect(punching).toBeGreaterThan(anchored);
  });

  it('defaults to the true wind when nobody says how fast she is going', () => {
    // a headless probe or a sail rendered before its first updateRig must get
    // the old, valid answer rather than a silently zeroed one
    const withVel = sailDrive({ ...ahead, windDirection: 0, windSpeed: 11, shipVelX: 0, shipVelZ: 0 }, p);
    const without = sailDrive({ ...ahead, windDirection: 0, windSpeed: 11 }, p);
    expect(without.drive).toBeCloseTo(withVel.drive, 12);
  });

  it('does not double-count the brace: the point of sail is the HULL\'s', () => {
    // `trimEfficiency` is a POINT-OF-SAIL curve carrying the sim's dead zone,
    // so it must be measured on the hull. Fed the SAIL's braced angle instead,
    // a yard braced 35° reported 80° off the wind where the hull had 45° — a
    // far better point of sail than the ship actually had, so the canvas
    // stayed full while she made almost no way.
    const wind = { windDirection: Math.PI * 0.75, windSpeed: 11 }; // close-hauled
    const braced = Math.PI * 0.19; // ~35° of brace
    const sail = { forwardX: Math.sin(braced), forwardZ: Math.cos(braced) };
    // the hull's heading is what decides how well she is drawing…
    const honest = sailDrive({ ...sail, shipForwardX: 0, shipForwardZ: 1, yawRate: 0, ...wind }, p);
    // …and reading it off the braced yard instead flatters her
    const flattered = sailDrive({ ...sail, yawRate: 0, ...wind }, p);
    expect(honest.drive).toBeLessThan(flattered.drive);
    expect(honest.luff).toBeGreaterThan(flattered.luff);
  });
});

/**
 * §V43 / §V33 / §V51 — THE SEAMS AND THE ROBANDS ARE ONE NUMBER.
 *
 * User, having counted: "too many segments, easy as that. It was just too many
 * vertical stripes on the sails basically. It didn't align with the number of
 * mounting points we do have on the cross beams."
 *
 * They are the same physical thing seen twice — the canvas is bent to the yard
 * AT its seams, because a seam is the doubled, stiffer part of the cloth and
 * that is what you pass a lashing through. They were two independent numbers:
 * a hard `count = 7` in `sailTies()` and a seam grid derived from a bolt width
 * in metres, which put 20 cloths against 7 robands. The bolt derivation was
 * the better physics and the wrong answer; §V43 makes the reference the bar.
 *
 * Same failure as the lantern socket and the lantern post (999071d).
 */
describe('the seams land on the robands (§V33/§V51 single owner)', () => {
  const p = shipMaterialParams;

  it('puts an integer seam coordinate on EVERY lashing station', () => {
    // THE WHOLE SPEC, asserted directly. `fract(panelCoord)` is what the
    // shader draws its seam from, so an integer at a station means the seam
    // line and the roband are the same line. If these two ever drift apart
    // again, this is what catches it.
    for (const count of [3, 5, 7, 9, 12]) {
      for (let i = 0; i < count; i++) {
        const u = sailLaceStation(i, count);
        const pc = sailPanelCoord(u, count);
        expect(pc).toBeCloseTo(i, 9);
        expect(Math.abs(pc - Math.round(pc))).toBeLessThan(1e-9);
      }
    }
  });

  it('holds the cloth at each seam and bellies it between — quilting', () => {
    // the quilt must be pinned exactly where the lashings are, or the sail
    // reads as corrugated independently of its own mounting points
    const count = p.sailLacingPoints;
    for (let i = 0; i < count; i++) {
      expect(seamQuiltProfile(sailPanelCoord(sailLaceStation(i, count), count)))
        .toBeCloseTo(-0.5, 9); // held at the seam
    }
    // and standing proud halfway between two of them
    const mid = (sailLaceStation(2, count) + sailLaceStation(3, count)) / 2;
    expect(seamQuiltProfile(sailPanelCoord(mid, count))).toBeCloseTo(0.5, 9);
    // ZERO MEAN over a cloth: quilting redistributes camber, it does not add
    // any, so the sail's overall depth is still the one the wind asked for
    let sum = 0;
    const N = 2000;
    for (let k = 0; k <= N; k++) sum += seamQuiltProfile(k / N);
    expect(sum / (N + 1)).toBeCloseTo(0, 3);
  });

  it('gives the mesh enough segments to resolve its own quilting', () => {
    // The quilt is a periodic term in the VERTEX stage, so its band limit is
    // the MESH — `fwidth` cannot reach it, there is no fragment. Derived from
    // the same count, so raising the lacing can never outrun the geometry.
    for (const count of [3, 7, 9, 16]) {
      const segs = sailClothSegments(count);
      const cloths = (count - 1) / SAIL_LACE_SPAN;
      expect(segs / cloths).toBeGreaterThanOrEqual(SAIL_SAMPLES_PER_PANEL - 1e-9);
    }
  });

  it('is the count the yard actually carries, and stays sane at any of it', () => {
    // 7 is what the yards carry today, so nothing on the beam had to move.
    // Measuring the reference gives ~9.3 seam lines on a course
    // (docs/inspo/ship/ref-rig-proportions.png: a 30 px period on a 278 px
    // chord; correlation + at 30 and 60 px, − at 15 and 45, which only a true
    // 30 px repeat produces), so 9 is one Tweakpane step away.
    expect(p.sailLacingPoints).toBeGreaterThanOrEqual(5);
    expect(p.sailLacingPoints).toBeLessThanOrEqual(10);
    // §V28: these size geometry and feed a shader coordinate
    for (const bad of [0, -1, 1, NaN, Infinity]) {
      expect(Number.isFinite(sailLaceStation(0, bad))).toBe(true);
      expect(Number.isFinite(sailPanelCoord(0.5, bad))).toBe(true);
      expect(sailClothSegments(bad)).toBeGreaterThanOrEqual(16);
    }
  });
});

/**
 * §V22 / §V45 — WHAT IS SEWN TO THE CLOTH RIDES THE CLOTH.
 *
 * User, with every instance circled on both courses and both sides: "all of
 * the larger bottom sails have this little thing poking through them… It's not
 * the seams, it's not the normal ropes, it's something else."
 *
 * It was `reefPoints()`. Each reef point is a small quad carrying ONE (u, v)
 * for all four vertices so the cloth moves it RIGIDLY rather than shearing it
 * — the right instinct, half-built: the quad was translated to its station and
 * kept the flat panel's orientation. Invisible on a nearly-flat sail; once the
 * camber fix took the course from 8% of chord to 14%, the canvas curved out
 * from under quads still lying in the original plane and their corners came
 * through.
 *
 * The second latent bug that fix exposed, after the buntline. Both were fine
 * only because the sail barely moved.
 */
describe('parts sewn to the canvas ride its frame, not its plane', () => {
  const p = { ...shipMaterialParams, sailFlutterAmp: 0 };
  const WIDTH = 12.17;
  const DROP = 6.3;
  const st = (drive: number) => ({
    drive, luff: 0, skew: 0, dropScale: 1, flutterPhase: 0,
    sheetLeadPort: [0, 0, 0] as [number, number, number],
    sheetLeadStarboard: [0, 0, 0] as [number, number, number],
  });
  // a reef point's four corners, as offsets from its own flat station
  const CORNERS: [number, number, number][] = [
    [-0.0175, 0.15, 0.02], [0.0175, 0.15, 0.02],
    [-0.0175, -0.15, 0.02], [0.0175, -0.15, 0.02],
  ];

  it('keeps every corner CLEAR of the canvas, at any camber', () => {
    // THE BUG, asserted directly. The corner must stay on the outside of the
    // surface — measured as its height above the cloth's own tangent plane at
    // the station it is sewn to. Flat placement fails this the moment the
    // sail curves; the frame placement holds it at the standoff exactly.
    for (const drive of [0, 0.4, 0.8, 1.0]) {
      const s = st(drive);
      for (const [u, v] of [[0.2, 0.66], [0.5, 0.38], [0.8, 0.66]] as const) {
        const base = sailClothPoint(u, v, WIDTH, DROP, s, p);
        const n = sailClothFrame(u, v, WIDTH, DROP, s, p).normal;
        for (const c of CORNERS) {
          const q = sailSewnPoint(u, v, c, WIDTH, DROP, s, p);
          const height = (q[0] - base[0]) * n[0] + (q[1] - base[1]) * n[1] + (q[2] - base[2]) * n[2];
          expect(height).toBeCloseTo(c[2], 6); // exactly its standoff, still
          expect(height).toBeGreaterThan(0); // …and on the outside
        }
      }
    }
  });

  it('moves the quad RIGIDLY — it must not shear with the curvature', () => {
    // the single shared (u, v) is what buys this; if a future change gives the
    // quad per-vertex uv it will start shearing and this catches it
    const s = st(1);
    const [u, v] = [0.35, 0.5];
    for (let i = 0; i < CORNERS.length; i++) {
      for (let j = i + 1; j < CORNERS.length; j++) {
        const a = sailSewnPoint(u, v, CORNERS[i], WIDTH, DROP, s, p);
        const b = sailSewnPoint(u, v, CORNERS[j], WIDTH, DROP, s, p);
        const want = Math.hypot(
          CORNERS[i][0] - CORNERS[j][0],
          CORNERS[i][1] - CORNERS[j][1],
          CORNERS[i][2] - CORNERS[j][2],
        );
        expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeCloseTo(want, 6);
      }
    }
  });

  it('reduces to the flat placement on a becalmed sail', () => {
    // no camber ⇒ the frame is the panel's own axes ⇒ nothing moves. If this
    // fails the basis is built wrong-handed or the tangents are swapped.
    const s = st(0);
    const flatP = { ...p, sailFootRoach: 0 };
    const q = sailSewnPoint(0.5, 0.5, [0.1, 0.2, 0.02], WIDTH, DROP, s, flatP);
    expect(q[0]).toBeCloseTo(0.1, 6);
    expect(q[1]).toBeCloseTo(-DROP * 0.5 + 0.2, 6);
    expect(q[2]).toBeCloseTo(0.02, 6);
  });

  it('leaves the HEAD still, which is why the robands need no frame', () => {
    // `sailTies()` builds the robands at weight 0 — they are seized to the
    // YARD, which does not deform. That is only safe because every term of the
    // shape carries a (1 − v) or a down(v) that vanishes at the head. Asserted
    // rather than assumed: if a future term moves the head, the robands start
    // floating off it and this fires first.
    for (const drive of [0, 1]) {
      for (const u of [0, 0.3, 0.5, 0.7, 1]) {
        const q = sailClothPoint(u, 1, WIDTH, DROP, st(drive), p);
        expect(q[0]).toBeCloseTo((u - 0.5) * WIDTH, 6);
        expect(q[1]).toBeCloseTo(0, 6);
        expect(q[2]).toBeCloseTo(0, 6);
      }
    }
  });
});

/**
 * §V.55 / §B.30 — the flutter phase, and the two-clock defect it closes.
 */
describe('flutter rides an INTEGRATED phase with one owner (§V.55, §B.30)', () => {
  const p = shipMaterialParams;

  it('shakes faster the harder she luffs — which needs the integral', () => {
    // The old shape held the rate CONSTANT and let luff drive amplitude only,
    // because `time × ω(luff)` is not a phase when ω moves: its instantaneous
    // frequency is ω + t·dω/dt and elapsed time multiplies every wobble in the
    // rate (measured on the flags: 0.93 Hz intended, 59.5 Hz at ten minutes,
    // with sign flips). An accumulator needs ONE owner, and the shape had two
    // evaluators on two clocks. It has one owner now, so this cue is legal.
    expect(sailFlutterRate(1, p)).toBeGreaterThan(sailFlutterRate(0, p) * 1.5);
    expect(sailFlutterRate(0, p)).toBeCloseTo(p.sailFlutterFreq, 9);
  });

  it('the rate is BOUNDED, so the accumulator can never run away (§V44)', () => {
    for (const luff of [-5, 0, 0.5, 1, 99, NaN]) {
      const r = sailFlutterRate(luff, p);
      expect(Number.isFinite(r)).toBe(true);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(p.sailFlutterFreq * (1 + 1.4 * p.sailFlutterLuffRate) + 1e-9);
    }
  });

  it('the shape reads a phase and owns no clock at all', () => {
    // THE ACTUAL FIX for §B.30's "~0.28 m of rope anchor" divergence: the CPU
    // evaluator and the shader cannot disagree about time if neither has a
    // clock. Same phase in ⟹ same cloth out, and the phase is handed to both.
    const width = 12.17;
    const at = (flutterPhase: number): number =>
      sailClothOffset(0.2, 0.3, width, 6.3, { drive: 0.7, luff: 0.5, skew: 0, dropScale: 1, flutterPhase, ...FLAT_SHEETS }, p);
    expect(at(1.234)).toBeCloseTo(at(1.234), 12);
    expect(at(0)).not.toBeCloseTo(at(Math.PI / 2), 4);
    // and it is periodic in 2π, which is what makes wrapping the accumulator
    // safe — a wrap must not show as a jump in the cloth
    expect(at(0.7)).toBeCloseTo(at(0.7 + Math.PI * 2), 6);
  });
});

/**
 * §V22 — "not wind speed and wind capture dependent enough" (Stage 2a/2c).
 */
describe('the sails feel the wind the SHIP feels (apparent, braced)', () => {
  const p = shipMaterialParams;
  const ahead = { forwardX: 0, forwardZ: 1, yawRate: 0 };

  it('eases as she runs away from the wind, loads as she hardens up', () => {
    // A ship running dead downwind at 8 m/s in an 11 m/s breeze feels 3 m/s
    // and her canvas should go soft — the cue her own masthead pennant has
    // always shown (flagDynamics.apparentWind), which the sails never read.
    // Same TRUE wind in all three cases: only her way through it changes.
    const trueWind = { windDirection: 0, windSpeed: 11 };
    const anchored = sailDrive({ ...ahead, ...trueWind }, p).drive;
    const running = sailDrive({ ...ahead, ...trueWind, shipVelZ: 8 }, p).drive;
    const punching = sailDrive({ ...ahead, ...trueWind, shipVelZ: -4 }, p).drive;
    // The FACTOR is deliberately gone: it encoded the old linear map. The load
    // curve is concave now (early onset), so easing the apparent wind eases the
    // cloth by less than proportionally — which is the point, and is what stops
    // a ship running at near wind speed from showing a flat sheet.
    expect(running).toBeLessThan(anchored);
    expect(punching).toBeGreaterThan(anchored);
  });

  it('defaults to the true wind when nobody says how fast she is going', () => {
    // a headless probe or a sail rendered before its first updateRig must get
    // the old, valid answer rather than a silently zeroed one
    const withVel = sailDrive({ ...ahead, windDirection: 0, windSpeed: 11, shipVelX: 0, shipVelZ: 0 }, p);
    const without = sailDrive({ ...ahead, windDirection: 0, windSpeed: 11 }, p);
    expect(without.drive).toBeCloseTo(withVel.drive, 12);
  });

  it('does not double-count the brace: the point of sail is the HULL\'s', () => {
    // `trimEfficiency` is a POINT-OF-SAIL curve carrying the sim's dead zone,
    // so it must be measured on the hull. Fed the SAIL's braced angle instead,
    // a yard braced 35° reported 80° off the wind where the hull had 45° — a
    // far better point of sail than the ship actually had, so the canvas
    // stayed full while she made almost no way.
    const wind = { windDirection: Math.PI * 0.75, windSpeed: 11 }; // close-hauled
    const braced = Math.PI * 0.19; // ~35° of brace
    const sail = { forwardX: Math.sin(braced), forwardZ: Math.cos(braced) };
    // the hull's heading is what decides how well she is drawing…
    const honest = sailDrive({ ...sail, shipForwardX: 0, shipForwardZ: 1, yawRate: 0, ...wind }, p);
    // …and reading it off the braced yard instead flatters her
    const flattered = sailDrive({ ...sail, yawRate: 0, ...wind }, p);
    expect(honest.drive).toBeLessThan(flattered.drive);
    expect(honest.luff).toBeGreaterThan(flattered.luff);
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
/**
 * THE SAIL MUST *READ* AS A FULL SAIL, NOT MERELY CONTAIN THE NUMBERS.
 *
 * User, after three rounds of camber work: "fully blown sails are still very
 * flat and parallel to the mast, and not really corner-pinned, stretched out
 * further, with more blow visible." MEASURED IN THE BROWSER at the shipped
 * params, on the main course at the default sea, this is what was actually
 * there:
 *
 *   · drive 0.74, camber 11% of chord, peak belly 1.33 m — the AMPLITUDE was
 *     never the problem, and every existing test that checks it passed;
 *   · the mid-height section was not an ARCH but a WASHBOARD. `sailSeamQuilt`
 *     0.3 put a ±0.17 m, six-cycle corrugation on top of a 1.15 m arch, so the
 *     surface slope oscillated ~±10° six times across the cloth against the
 *     belly's own ~11° gradient. The quilt's slope was a PEER of the shape's
 *     at six times the frequency, so the finite-difference normal — and every
 *     shading cue riding it — read corrugated cloth rather than one curve.
 *     Turning the seams off in the browser turned flat rectangles into
 *     visibly full sails at IDENTICAL camber. That is the whole defect;
 *   · the clews were hauled 0.182 m on a 12.17 m chord — 1.5%, invisible.
 *
 * WHY THE SUITE MISSED BOTH. Every shape test asserted that a signed quantity
 * was non-zero, or bounded, or turned over. None asserted that the belly is
 * the DOMINANT feature of its own section, and the clew test's threshold is
 * 0.01 m — 0.08% of chord — so it passes on a haul nobody can see. A test that
 * cannot fail while the user is looking at the bug is not testing the intent.
 *
 * WHAT THESE DO NOT PROVE, stated plainly (§V.45): they run on the CPU mirror
 * in sailShape.ts, so they cannot catch the TSL graph in sailClothNodes.ts
 * drifting from that mirror, or being unwired from `material.positionNode`
 * altogether. Closing THAT seam needs a GPU readback of the vertex stage,
 * which this suite has no device for. The browser A/B that produced the
 * numbers above is the only thing currently covering it.
 */
describe('the belly must DOMINATE its own section, not compete with the seams', () => {
  const WIDTH = 12.17;
  const DROP = 6.3;
  // flutter off and phase fixed: this is about the STANDING shape, and a
  // travelling ripple would make the metric depend on when it was sampled
  const p = { ...shipMaterialParams, sailFlutterAmp: 0 };
  const st = { drive: 1, luff: 0, skew: 0, dropScale: 1, flutterPhase: 0, ...FLAT_SHEETS };
  const section = (over: Partial<typeof p>): number[] =>
    Array.from({ length: 41 }, (_, i) =>
      sailClothOffset(i / 40, SAIL_BELLY_FOOT, WIDTH, DROP, st, { ...p, ...over }),
    );
  const quiltShare = (over: Partial<typeof p>): number => {
    const arch = section({ sailSeamQuilt: 0 });
    const peak = Math.max(...arch);
    const got = section(over);
    return Math.max(...got.map((z, i) => Math.abs(z - arch[i]))) / peak;
  };

  it('keeps the seam quilt a texture ON the belly, not a rival TO it', () => {
    const arch = section({ sailSeamQuilt: 0 });
    expect(Math.max(...arch)).toBeGreaterThan(0.5); // there is an arch to ride
    // 8% of the belly's own depth. At the shipped 0.3 this was 15% and the
    // sails read as flat corrugated sheets in the browser; at 0.08 it is 4%.
    const share = quiltShare({});
    expect(share, `seam quilt displaces ${(100 * share).toFixed(1)}% of belly depth`).toBeLessThan(
      0.08,
    );
  });

  it('would have FIRED at the quilt that shipped the flat sails', () => {
    // a guard is only worth having if it fails on the bug it was written for
    // (§Rule 6); otherwise it is one more test that cannot fail
    expect(quiltShare({ sailSeamQuilt: 0.3 })).toBeGreaterThan(0.08);
  });
});

describe('the clews are hauled VISIBLY, not merely non-zero (§V44)', () => {
  const WIDTH = 12.17;
  const p = { ...shipMaterialParams, sailFlutterAmp: 0 };
  const leads = sheetLeadDirections(IDENTITY_MATRIX, 0, 1, p.sailSheetSpread);
  const st = {
    drive: 1,
    luff: 0,
    skew: 0,
    dropScale: 1,
    flutterPhase: 0,
    sheetLeadPort: leads.port,
    sheetLeadStarboard: leads.starboard,
  };
  /** how far the clew leaves the yard's plane, as a fraction of the chord */
  const clewFraction = (over: Partial<typeof p>): number => {
    const pull = sailCornerPull(1, 0, WIDTH, st, { ...p, ...over });
    return Math.hypot(pull[0], pull[1], pull[2]) / WIDTH;
  };

  it('moves the corner by a fraction of the CHORD, not by a centimetre', () => {
    // "not really corner-pinned, stretched out further". The neighbouring
    // block asserts only > 0.01 m — 0.08% of this chord — which is how the
    // sails could read as perfect rectangles with that test green.
    const f = clewFraction({});
    expect(f, `clew hauled only ${(100 * f).toFixed(2)}% of chord`).toBeGreaterThan(0.05);
  });

  it('would have FIRED at the sheetPull that shipped the square corners', () => {
    expect(clewFraction({ sailSheetPull: 0.16 })).toBeLessThan(0.05);
  });
});

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
    const width = 12.17;
    const at = (skew: number, u: number, v: number): number =>
      sailClothOffset(u, v, width, 6.3, { drive: 1, luff: 0, skew, dropScale: 1, flutterPhase: 0, ...FLAT_SHEETS },
        { ...p, sailFlutterAmp: 0 });
    // RE-CUT: this used to assert the leech sits at zero for every v, which
    // the free leech deliberately no longer does. The invariant it was really
    // protecting is that the SKEW term must not move the leech — the original
    // bug translated the whole section sideways and left 41% of the peak
    // standing at the port bolt rope. So: leech value INDEPENDENT of skew.
    for (const v of [0, 0.45, 0.9]) {
      const ref0 = at(0, 0, v);
      const ref1 = at(0, 1, v);
      for (const skew of [-1, -0.5, 0.5, 1]) {
        expect(at(skew, 0, v)).toBeCloseTo(ref0, 9);
        expect(at(skew, 1, v)).toBeCloseTo(ref1, 9);
      }
    }
    // it still MOVES, or the skew term has silently become a no-op: at the free
    // foot the two tacks put visibly different amounts of cloth at mid-width
    expect(at(1, 0.5, 0)).not.toBeCloseTo(at(-1, 0.5, 0), 3);
    // …and the head cannot lag at all — it is bent to its yard
    expect(at(1, 0.4, 1)).toBeCloseTo(at(-1, 0.4, 1), 6);
  });
});

describe("the ship's wheel turns with the helm (§V22)", () => {
  const p = shipRigParams;

  it('is geared like a barrel, not like a tiller', () => {
    // WHY: user asked for the wheel to turn "to make the first-person view a
    // little bit more interesting". A 1:1 map to the rudder would sweep a
    // quarter turn and read as a car; a ship's wheel hauls its tiller through
    // several turns of a barrel, and the multiple revolutions ARE the thing
    // that makes it interesting from the captain's eye.
    expect(helmWheelAngle(0, p)).toBe(0);
    const hardOver = helmWheelAngle(1, p);
    const turns = Math.abs(hardOver) / (Math.PI * 2);
    expect(turns).toBeGreaterThan(1); // more than one revolution each way…
    expect(turns * 2).toBeCloseTo(p.helmTurnsLockToLock, 6); // …and lock to lock is the param
    expect(helmWheelAngle(-1, p)).toBeCloseTo(-hardOver, 9); // symmetric
    // §V28: a NaN rudder must not poison a transform
    expect(helmWheelAngle(NaN, p)).toBe(0);
    expect(helmWheelAngle(5, p)).toBeCloseTo(hardOver, 9); // clamped at the stops
  });

  it('actually reaches the mesh, and only the turning half (§V.62)', () => {
    // WHY: this repo has thirteen-plus recorded silent no-ops — a value that is
    // computed, plumbed, and never applied. The wheel used to be ONE merged
    // mesh including its pedestal, so "rotate the wheel" was not expressible
    // at all. Assert the piece graph, not the arithmetic.
    const asm = new ShipAssembly(buildGalleonBlueprint(), stubFactory);
    const disc = asm.group.getObjectByName('wheel-disc');
    const pedestal = asm.group.getObjectByName('wheel');
    expect(disc, 'wheel-disc piece exists').toBeDefined();
    expect(disc!.parent!.name).toBe('wheel'); // parented at the axle
    asm.setHelmAngle(helmWheelAngle(1, p));
    expect(disc!.rotation.z).toBeCloseTo(helmWheelAngle(1, p), 9);
    expect(pedestal!.rotation.z).toBe(0); // the pedestal does NOT turn
    asm.dispose();
  });

  it('the disc is centred on its own axle, or multiple turns wobble', () => {
    // WHY: at 3.5 turns lock to lock any offset between the mesh's centre and
    // the axis it spins about stops reading as an offset and starts reading as
    // a wobble, which is a worse artifact than a wheel that never moved.
    const sail = buildGalleonBlueprint().find((q) => q.id === 'wheel')!;
    const geo = buildWheelDiscGeometry(sail.aabb);
    const pos = geo.getAttribute('position');
    let cx = 0;
    let cy = 0;
    let rMin = Infinity;
    let rMax = 0;
    for (let i = 0; i < pos.count; i++) {
      cx += pos.getX(i);
      cy += pos.getY(i);
      const r = Math.hypot(pos.getX(i), pos.getY(i));
      rMin = Math.min(rMin, r);
      rMax = Math.max(rMax, r);
    }
    cx /= pos.count;
    cy /= pos.count;
    expect(Math.hypot(cx, cy)).toBeLessThan(rMax * 0.01);
    expect(rMax).toBeGreaterThan(0.2); // it is a real wheel, not a nub
    geo.dispose();
  });
});
