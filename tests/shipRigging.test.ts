/**
 * §V12/§V13 rigging plan tests. The plan is the contract between the ship
 * piece graph (socket ids) and the GPU rope solver (createRopes indices) —
 * if it references a socket that does not exist, or drifts between runs,
 * ropes attach to nothing after a ship-side rename.
 *
 * The rest of these tests guard the LAYOUT, against two user-reported faults:
 *
 *  1. SPIDER WEB. The rig once ran shrouds from every masthead to BOTH end
 *     cleats and braces from every yard to the transom: 20 of 48 lines
 *     spanned the whole hull. Rigging is local — a line belongs to its bay.
 *  2. ROPES THROUGH THE DECK. Endpoints sat inboard/below the deck surface
 *     and lines sagged through it. The catenary solver knows nothing about
 *     the ship, so both the endpoints and the whole solved curve have to be
 *     outside the hull solid.
 *
 * Both are geometric, so these tests resolve the plan through a real
 * ShipAssembly and solve the real catenary — a "does it name a valid socket"
 * test cannot see either failure.
 */
import { describe, expect, it } from 'vitest';
import type { Material } from 'three';
import {
  applyBlocks,
  applyRiggingPlan,
  buildRiggingPlan,
  collectRopeAnchorIds,
  selectBlockSockets,
  slackForFurl,
  validateRiggingPlan,
  type RiggingRope,
} from '../src/ropes/shipRigging';
import { solveCatenary } from '../src/ropes/catenaryMath';
import {
  buildBrigantineBlueprint,
  buildGalleonBlueprint,
} from '../src/ship/shipBlueprint';
import { ShipAssembly } from '../src/ship/shipAssembly';
import { asHullShape, hullHalfWidthAt, hullTopY, type HullShape } from '../src/ship/hullMath';
import { brigantineParams, galleonParams, shipRigParams } from '../src/params/ship';
import type { PieceDef } from '../src/ship/pieceTypes';

const stubFactory = (): Material => ({ dispose(): void {} }) as unknown as Material;

type Point = [number, number, number];
interface ResolvedRope {
  rope: RiggingRope;
  a: Point;
  b: Point;
  length: number;
  /** fore-aft extent of the line — the spider-web metric */
  zSpan: number;
}

/** the plan as the GPU sees it: every rope resolved through the real ship
 *  piece graph. The ship sits at the origin, so world == ship-local. */
function resolvePlan(blueprint: PieceDef[], brace = 0): ResolvedRope[] {
  const plan = buildRiggingPlan(blueprint);
  const assembly = new ShipAssembly(blueprint, stubFactory);
  // main.ts calls updateRig() before the ropes block, so the yards may be
  // braced round to the apparent wind when the anchors are resolved
  assembly.setRigTrim(brace);
  assembly.group.updateWorldMatrix(true, true);
  const out: ResolvedRope[] = [];
  applyRiggingPlan(plan, {
    setRope(index, a, b, length): void {
      out[index] = {
        rope: plan[index],
        a: [a.x, a.y, a.z],
        b: [b.x, b.y, b.z],
        length: length ?? 0,
        zSpan: Math.abs(b.z - a.z),
      };
    },
    setRopeCount(): void {},
  }, (id) => assembly.socketWorldPosition(id));
  return out;
}

/**
 * The solid volume of the ship a rope must never enter. Half-breadth comes
 * from the ship's OWN loft (castle slabs and the cabin taper to the same
 * envelope by construction — see blueprintCastles), so the only thing the
 * raised works change is how high the walking surface is over their span.
 */
function hullSolid(blueprint: PieceDef[]): {
  shape: HullShape;
  decks: Array<{ topY: number; z0: number; z1: number }>;
} {
  const shape = asHullShape(blueprint.find((p) => p.kind === 'deck')?.shape);
  if (shape === null) throw new Error('blueprint has no deck shape hints');
  const raised = new Set(['forecastle-deck', 'sterncastle-deck', 'cabin']);
  const decks = blueprint
    .filter((p) => raised.has(p.kind) && p.parent === undefined)
    .map((p) => ({
      topY: p.transform.position[1] + p.aabb.max[1],
      z0: p.transform.position[2] + p.aabb.min[2],
      z1: p.transform.position[2] + p.aabb.max[2],
    }));
  return { shape, decks };
}

/**
 * How far INSIDE the ship a point is, in metres (≤ 0 = outside/clear).
 *
 * This is the rope's CENTRELINE, not its tube surface. The margins are thin
 * on purpose: chainplates stand 0.06 m proud of the shell and rope radii are
 * 0.022–0.05 m, so a shroud is meant to lie against the topsides at its foot —
 * a line floating a hand's width off the hull reads as detached. Worst
 * measured clearance is ~0.015 m (a brace, yards hard over), i.e. the tube
 * grazes the planking. That is a look question for the browser pass, not a
 * geometry failure; what must never happen is the centreline going inside.
 */
function penetration(p: Point, solid: ReturnType<typeof hullSolid>): number {
  const [x, y, z] = p;
  const { shape, decks } = solid;
  if (z > shape.bowZ || z < shape.sternZ || y < -shape.draft) return -1;
  let top = hullTopY(z, shape);
  for (const deck of decks) {
    if (z >= deck.z0 && z <= deck.z1) top = Math.max(top, deck.topY);
  }
  if (y > top) return -1;
  return hullHalfWidthAt(z, y, shape) - Math.abs(x);
}

const shipCases = [
  ['galleon', buildGalleonBlueprint, galleonParams],
  ['brigantine', buildBrigantineBlueprint, brigantineParams],
] as const;

describe('buildRiggingPlan (§V13 sockets → §V12 ropes)', () => {
  it('is deterministic: identical blueprints → identical plans', () => {
    // WHY: sim determinism (§V2) and GPU re-solve both assume the plan is a
    // pure function of the blueprint — no ordering drift between runs.
    expect(buildRiggingPlan(buildGalleonBlueprint())).toEqual(
      buildRiggingPlan(buildGalleonBlueprint()),
    );
    expect(buildRiggingPlan(buildBrigantineBlueprint())).toEqual(
      buildRiggingPlan(buildBrigantineBlueprint()),
    );
  });

  it('references only rope-anchor sockets that exist, on BOTH ship classes', () => {
    // WHY: ship geometry is being reworked independently (§V18 swappable
    // pieces); this pins the socket-id contract so a rename fails here, not
    // as ropes anchored to nothing in the demo.
    for (const [, build] of shipCases) {
      const blueprint = build();
      const plan = buildRiggingPlan(blueprint);
      const ids = collectRopeAnchorIds(blueprint);
      for (const rope of plan) {
        for (const id of [rope.socketA, rope.socketB]) expect(ids.has(id), id).toBe(true);
      }
      expect(() => validateRiggingPlan(plan, blueprint)).not.toThrow();
    }
  });

  it('galleon rig is substantial (≥ 24 ropes) and never self-ties', () => {
    // WHY: the SoT look needs a real rig (stays/shrouds/lifts/braces/sheets);
    // a near-empty plan means whole categories were silently dropped — the
    // opposite failure mode from the spider web.
    const plan = buildRiggingPlan(buildGalleonBlueprint());
    expect(plan.length).toBeGreaterThanOrEqual(24);
    for (const rope of plan) expect(rope.socketA).not.toBe(rope.socketB);
    const keys = plan.map((r) => `${r.socketA}|${r.socketB}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every rope has slack > 1 — ropes sag, never taut-clamped', () => {
    // WHY: length = chord × slack; slack ≤ 1 hits the solver's taut clamp
    // (straight line) and the signature catenary sag disappears (§V12).
    for (const [, build] of shipCases) {
      for (const rope of buildRiggingPlan(build())) {
        expect(rope.slack).toBeGreaterThan(1);
        expect(rope.thickness).toBeGreaterThan(0);
      }
    }
  });

  it('shroud feet are the ship\'s chainplates, one abeam each mast', () => {
    // WHY: shrouds used to run to the extreme bow AND stern cleats from every
    // masthead — the spider web. They must land on `anchor-channel-*`, the
    // chainplate sockets the ship system places on the shell abeam each mast,
    // so a shroud never crosses a bay. Naming them explicitly also means a
    // ship-side rename fails here rather than silently re-webbing the rig.
    for (const [, build] of shipCases) {
      const plan = buildRiggingPlan(build());
      const shrouds = plan.filter((r) => r.role === 'shroud');
      expect(shrouds.length).toBeGreaterThanOrEqual(4);
      const perMastSide = new Map<string, number>();
      for (const shroud of shrouds) {
        const mast = /^anchor-masthead-(\w+)$/.exec(shroud.socketA)?.[1];
        expect(mast, shroud.socketA).toBeDefined();
        // NUMBERED plate: the unnumbered `anchor-channel-{side}-{mast}` is a
        // deprecated alias the ship system keeps only until this consumes the
        // fan. Matching it here would silently pin us to one token shroud.
        const plate = new RegExp(`^anchor-channel-(port|starboard)-${mast}-(\\d+)$`)
          .exec(shroud.socketB);
        expect(plate, shroud.socketB).not.toBeNull();
        const key = `${mast}|${plate![1]}`;
        perMastSide.set(key, (perMastSide.get(key) ?? 0) + 1);
      }
      // a FAN, not one line: every mast/side pair carries the same ≥2 plates
      const widths = [...perMastSide.values()];
      expect(perMastSide.size).toBe(new Set(shrouds.map((r) => r.socketA)).size * 2);
      expect(Math.min(...widths)).toBeGreaterThanOrEqual(2);
      expect(new Set(widths).size, 'fan width differs between masts/sides').toBe(1);
    }
  });
});

describe('rig LOCALITY (anti spider-web — docs/ship-reference-schema.png)', () => {
  it.each(shipCases)('%s: no rope spans more than half the hull fore-aft', (_n, build, params) => {
    // WHY: THE regression the user flagged. Lines running stem to transom
    // cross every other line and read as a web; real rigging stays inside one
    // mast bay. The old layout peaked at 28.9 m on a 35 m hull with 20 such
    // lines — anything over half the hull is that bug coming back.
    const worst = resolvePlan(build()).reduce((a, b) => (a.zSpan > b.zSpan ? a : b));
    expect(
      worst.zSpan,
      `${worst.rope.role} spans ${worst.zSpan.toFixed(1)} m fore-aft`,
    ).toBeLessThanOrEqual(params.hullLength * 0.5);
  });

  it('shrouds drop to the hull ABEAM of their own mast, not to the end cleats', () => {
    // WHY: shrouds to the bow AND stern cleats from every masthead was the
    // single biggest source of long crossing lines. A shroud's foot must sit
    // at its own mast's station and outboard on the hull side.
    const shrouds = resolvePlan(buildGalleonBlueprint()).filter((r) => r.rope.role === 'shroud');
    expect(shrouds.length).toBeGreaterThanOrEqual(4);
    for (const { rope, a, b } of shrouds) {
      expect(String(rope.socketA)).toMatch(/^anchor-masthead-/);
      // within the fan's own rake of its mast — never a bay away
      expect(Math.abs(b[2] - a[2]), String(rope.socketA)).toBeLessThanOrEqual(4);
      expect(Math.abs(b[0])).toBeGreaterThan(galleonParams.beam * 0.3);
      expect(b[1]).toBeLessThan(a[1]); // a shroud drops, never rises
    }
    // the fan reaches both sides of every mast
    const sides = new Set(shrouds.map((s) => Math.sign(s.b[0])));
    expect([...sides].sort()).toEqual([-1, 1]);
  });

  it('only the AFTMOST masthead carries backstays aft', () => {
    // WHY: a backstay from every masthead drags the fore mast's lines the
    // whole length of the ship. Aftmost-only keeps them a stern-quarter run.
    const resolved = resolvePlan(buildGalleonBlueprint());
    const sternZ = galleonParams.hullLength / -2;
    for (const { rope, a, b } of resolved) {
      if (typeof rope.socketA !== 'string' || !rope.socketA.startsWith('anchor-masthead-')) continue;
      if (b[2] > sternZ + 6) continue; // not a stern-quarter termination
      expect(rope.socketA, `${rope.socketA} reaches the stern`).toBe('anchor-masthead-rear');
      expect(a[2]).toBeGreaterThan(b[2]);
    }
    const backstays = resolved.filter(
      (r) => r.rope.socketA === 'anchor-masthead-rear' && r.rope.role === 'stay',
    );
    expect(backstays).toHaveLength(2);
  });

  it('braces and sheets both lead AFT and DOWN, one mast bay at most', () => {
    // WHY: braces used to run from every yard end to the transom. Direction is
    // what makes them read as rigging; bay length is what stops them webbing.
    // Sheets changed sides here: they used to be a stand-in leading FORWARD
    // from the yard end, because no clew socket existed to start them at. Now
    // that the sail carries clews, a sheet is what holds the sail's lower
    // corner back against the wind, so it leads aft — the stand-in inverted
    // the real thing, and this test inverted with it.
    const resolved = resolvePlan(buildGalleonBlueprint());
    const braces = resolved.filter((r) => r.rope.role === 'brace');
    const sheets = resolved.filter((r) => r.rope.role === 'sheet');
    expect(braces.length).toBeGreaterThanOrEqual(8);
    expect(sheets.length).toBeGreaterThanOrEqual(8);
    for (const { a, b } of [...braces, ...sheets]) {
      expect(b[2]).toBeLessThan(a[2]); // aft = -z
      expect(b[1]).toBeLessThan(a[1]); // and down to where it is belayed
    }
    // sheets start on the CLOTH, not on the spar
    for (const { rope } of sheets) expect(rope.socketA).toMatch(/^anchor-sail-.*-clew-/);
  });

  it('buntlines rise from the sail foot to the masthead, up its front', () => {
    // WHY: the user's note — "not all the lines should just go up to the mast,
    // some should attach to the sails". Buntlines are the most recognisable
    // running-rigging shape on a square rig and were the roles left declared
    // but inert while no anchor was sewn to the cloth. They must start on the
    // sail and RISE; a buntline that dropped would be a sheet.
    const bunts = resolvePlan(buildGalleonBlueprint()).filter(
      (r) => r.rope.role === 'buntline',
    );
    expect(bunts.length).toBeGreaterThanOrEqual(8);
    for (const { rope, a, b } of bunts) {
      expect(rope.socketA).toMatch(/^anchor-sail-.*-bunt-/);
      expect(rope.socketB).toMatch(/^anchor-masthead-/);
      expect(b[1]).toBeGreaterThan(a[1]); // rises
    }
  });

  it('lifts stay on their own mast: upper yard end → that mast head', () => {
    // WHY: a lift is the shortest line in the rig; if it ever targeted another
    // mast it would become a diagonal across a whole bay.
    const lifts = buildRiggingPlan(buildGalleonBlueprint()).filter((r) => r.role === 'lift');
    expect(lifts).toHaveLength(6); // 3 masts × upper yard × 2 sides
    for (const lift of lifts) {
      const mast = /^anchor-yard-(\w+)-upper-/.exec(String(lift.socketA))?.[1];
      expect(mast, String(lift.socketA)).toBeDefined();
      expect(lift.socketB).toBe(`anchor-masthead-${mast}`);
    }
  });

  it('the AVERAGE line barely travels along the ship, however many there are', () => {
    // WHY: rope COUNT is the wrong budget, and total length is too — the user
    // asked for MORE lines ("some should attach to the sails"), and sheets,
    // buntlines and a three-plate shroud fan all add rope while making the rig
    // read better, not worse. What makes a web is line spent travelling ALONG
    // the ship. So measure that PER ROPE, which is immune to the rig growing:
    //
    //   original spider-web layout   48 ropes, Σ|Δz| 584 m → 12.2 m per rope
    //   after the locality rework    36 ropes, Σ|Δz| 249 m →  6.9 m per rope
    //   with sail gear + fans        68 ropes, Σ|Δz| 336 m →  4.9 m per rope
    //
    // The rig nearly doubled and got MORE local. This fails if a new category
    // starts reaching down the hull again, no matter how few lines it adds.
    const resolved = resolvePlan(buildGalleonBlueprint());
    const crossing = resolved.reduce((sum, r) => sum + r.zSpan, 0);
    expect(crossing / resolved.length, 'mean fore-aft travel per rope').toBeLessThan(7);
    expect(crossing, 'total fore-aft travel').toBeLessThan(450);
  });
});

describe('rig CLEARANCE (no rope inside the hull or through the deck)', () => {
  it.each(shipCases)('%s: every rope ENDPOINT is outside the ship solid', (_n, build) => {
    // WHY: user report — "some of it doesn't seem to be connected to the top
    // of the deck but rather goes into the ship". The blueprint's belaying
    // cleats sit inboard on the deck, so hull-side ends are placed on the
    // loft's sheer line standing proud of the topsides instead. If an anchor
    // ever moves inboard of the shell again, this fails.
    const blueprint = build();
    const solid = hullSolid(blueprint);
    for (const { rope, a, b } of resolvePlan(blueprint)) {
      for (const [label, p] of [['A', a], ['B', b]] as const) {
        expect(
          penetration(p, solid),
          `${rope.role} end ${label} at ${p.map((v) => v.toFixed(2)).join(',')}`,
        ).toBeLessThanOrEqual(0);
      }
    }
  });

  it.each(shipCases)('%s: no solved catenary passes through the deck', (_n, build) => {
    // WHY: the other half of the same report — "it seems to kinda hang
    // through the top of the deck". Nothing in the §V12 solve knows the deck
    // exists, so clearance has to come from slack + routing. This samples the
    // SAME curve the GPU draws (catenaryMath is the tested mirror of it).
    const blueprint = build();
    const solid = hullSolid(blueprint);
    for (const { rope, a, b, length } of resolvePlan(blueprint)) {
      const curve = solveCatenary(
        { x: a[0], y: a[1], z: a[2] },
        { x: b[0], y: b[1], z: b[2] },
        length,
        24,
      );
      let worst = -Infinity;
      for (const pt of curve) worst = Math.max(worst, penetration([pt.x, pt.y, pt.z], solid));
      expect(
        worst,
        `${rope.role} sags ${worst.toFixed(2)} m into the ship`,
      ).toBeLessThanOrEqual(0);
    }
  });

  it('drops a shroud whose chainplate sits below the deck its mast stands on', () => {
    // WHY: the galleon's mizzen is stepped on the quarterdeck, ~2 m above the
    // main deck. When its chainplates were on the main shell the shrouds ran
    // straight THROUGH the quarterdeck — one of the user's "goes into the
    // ship" lines. The ship system now places a plate on the deck its mast is
    // stepped on, so the shipped blueprint must rig the mizzen; the guard has
    // to stay anyway, because nothing stops a future hull rework from
    // reintroducing the drop. So: shipped ⇒ rigged and clear, sunk ⇒ dropped.
    const mizzen = (plan: RiggingRope[]): RiggingRope[] =>
      plan.filter((r) => r.role === 'shroud' && r.socketA === 'anchor-masthead-rear');

    const shipped = buildGalleonBlueprint();
    const plates = [...collectRopeAnchorIds(shipped)].filter((id) =>
      /^anchor-channel-port-rear-\d+$/.test(id),
    ).length;
    expect(plates, 'ship declares a mizzen chainplate fan').toBeGreaterThanOrEqual(1);
    expect(mizzen(buildRiggingPlan(shipped))).toHaveLength(plates * 2);

    // …and every mizzen shroud clears the castle it runs past
    const solid = hullSolid(shipped);
    for (const { rope, a, b, length } of resolvePlan(shipped)) {
      if (rope.role !== 'shroud' || rope.socketA !== 'anchor-masthead-rear') continue;
      for (const pt of solveCatenary(
        { x: a[0], y: a[1], z: a[2] },
        { x: b[0], y: b[1], z: b[2] },
        length,
        24,
      )) {
        expect(penetration([pt.x, pt.y, pt.z], solid)).toBeLessThanOrEqual(0);
      }
    }

    // sink the mizzen plates back onto the main shell: the guard must fire
    const sunk = buildGalleonBlueprint();
    const mainDeckY = galleonParams.freeboard;
    for (const piece of sunk) {
      for (const socket of piece.sockets) {
        if (!/^anchor-channel-\w+-rear(-\d+)?$/.test(socket.id)) continue;
        socket.position[1] = mainDeckY - piece.transform.position[1] - 0.28;
      }
    }
    expect(mizzen(buildRiggingPlan(sunk))).toHaveLength(0);
  });

  it.each(shipCases)('%s: stays clear with the yards braced hard over, either tack', (_n, build) => {
    // WHY: main.ts now calls updateRig() before the ropes block, so the yards
    // swing up to ±braceMax about their masts and the running rigging is
    // resolved against the SWUNG anchor. That geometry never existed when the
    // brace/sheet leads were chosen: a yard end swinging inboard drags its
    // brace over the rail, and on the galleon's rear mast the yard half-length
    // is close to the hull half-breadth. Both tacks, since the fan is
    // symmetric but the leads are not.
    const blueprint = build();
    const solid = hullSolid(blueprint);
    // guard the guard: if setRigTrim ever stops moving the yard anchors this
    // whole test silently becomes three copies of the square-yard case
    const square = resolvePlan(blueprint, 0);
    const hardOver = resolvePlan(blueprint, shipRigParams.braceMax);
    const moved = square.reduce(
      (max, r, i) => Math.max(max, Math.hypot(...r.a.map((v, k) => v - hardOver[i].a[k]))),
      0,
    );
    expect(moved, 'bracing must actually swing the yard anchors').toBeGreaterThan(1);

    for (const brace of [-shipRigParams.braceMax, 0, shipRigParams.braceMax]) {
      for (const { rope, a, b, length } of resolvePlan(blueprint, brace)) {
        const curve = solveCatenary(
          { x: a[0], y: a[1], z: a[2] },
          { x: b[0], y: b[1], z: b[2] },
          length,
          24,
        );
        let worst = -Infinity;
        for (const pt of curve) worst = Math.max(worst, penetration([pt.x, pt.y, pt.z], solid));
        expect(
          worst,
          `${rope.role} ${rope.socketA}→${rope.socketB} enters the ship at brace ${brace.toFixed(2)} rad`,
        ).toBeLessThanOrEqual(0);
      }
    }
  });

  it('standing rigging is taut enough that it cannot bow into the ship', () => {
    // WHY: the clearance above is a geometric result of slack. Slack is a
    // tunable (§V16) and a well-meaning bump to "more rope sag" is exactly
    // what would put stays back through the deck — pin the ceiling here so
    // that edit fails a test instead of shipping.
    for (const rope of buildRiggingPlan(buildGalleonBlueprint())) {
      const cap = rope.role === 'stay' || rope.role === 'shroud' ? 1.01 : 1.06;
      expect(rope.slack, rope.role).toBeLessThanOrEqual(cap);
    }
  });
});

describe('rig completeness (every declared anchor is used)', () => {
  it('halyard ties the crow-nest socket into the rig (galleon only)', () => {
    // WHY: the crow's nest anchor was the one unused rope socket; the rig
    // should consume every anchor the ship declares or say why not.
    const galleon = buildRiggingPlan(buildGalleonBlueprint());
    expect(galleon.some((r) => r.role === 'halyard' && r.socketA === 'anchor-crow-nest')).toBe(true);
    const brig = buildRiggingPlan(buildBrigantineBlueprint());
    expect(brig.some((r) => r.role === 'halyard')).toBe(false); // no nest
  });

  it('bobstays hold the bowsprit down onto the stem', () => {
    // WHY: the schema shows the bowsprit held down against the forestay's
    // pull; without them the spar reads as unsupported. They must land on the
    // STEM (well forward, below the head) — the clearance suite proves they
    // land outside it rather than inside the bow.
    const resolved = resolvePlan(buildGalleonBlueprint());
    const bobstays = resolved.filter((r) => r.rope.socketA === 'anchor-bowsprit-tip');
    expect(bobstays).toHaveLength(2);
    for (const { a, b } of bobstays) {
      expect(b[1]).toBeLessThan(a[1]); // pulls DOWN
      expect(b[2]).toBeGreaterThan(galleonParams.hullLength / 2); // on the stem
    }
  });

  it('every yard end carries at least one line', () => {
    // WHY: yards without rigging read as floating sticks; this catches a
    // brace/sheet/lift rule that silently misses a mast or a level.
    const blueprint = buildGalleonBlueprint();
    const plan = buildRiggingPlan(blueprint);
    const used = new Set(plan.flatMap((r) => [r.socketA, r.socketB]).filter(
      (a): a is string => typeof a === 'string',
    ));
    const yardEnds = [...collectRopeAnchorIds(blueprint)].filter((id) => id.includes('-yard-'));
    expect(yardEnds.length).toBeGreaterThan(0);
    for (const id of yardEnds) expect(used.has(id), id).toBe(true);
  });
});

describe('§V46 reefing: running gear takes in and eases with the sail', () => {
  it('hauls buntlines TAUT and eases sheets as the sail furls', () => {
    // WHY: the user's note — "these shorten and lengthen and then the rope
    // physically grabs". Taut/slack is carried entirely by rope LENGTH:
    // length = chord × slack, and slack → 1 removes the catenary's sag, so a
    // hauled line visibly straightens. A buntline whose job is to drag the
    // sail's foot up must go taut as it furls; a sheet is being let go, so it
    // must do the opposite. Getting these two backwards would read as the
    // rigging fighting the sail.
    const furled = slackForFurl('buntline', 1.05, 1);
    const set = slackForFurl('buntline', 1.05, 0);
    expect(furled).toBeLessThan(set);
    expect(furled).toBeLessThan(1.01); // genuinely taut, not merely tauter
    expect(slackForFurl('sheet', 1.02, 1)).toBeGreaterThan(slackForFurl('sheet', 1.02, 0));
  });

  it('leaves STANDING rigging alone whatever the sails do', () => {
    // WHY: a shroud or stay that slackened when you furled would read as the
    // mast coming loose — the rig holds the mast up regardless of sail state.
    for (const role of ['stay', 'shroud', 'lift', 'brace', 'halyard'] as const) {
      expect(slackForFurl(role, 1.03, 1)).toBeCloseTo(1.03, 12);
      expect(slackForFurl(role, 1.03, 0.5)).toBeCloseTo(1.03, 12);
    }
  });

  it('never lets slack reach 1 — that is the solver\'s dead straight line', () => {
    // WHY: §V12 treats length ≤ chord as taut and emits a straight segment
    // with no curve at all. A buntline hauled to exactly 1.0 would snap from
    // rope to wire; keeping a hair of slack keeps it a rope under tension.
    for (const furl of [0, 0.5, 1, 2, -1, Number.NaN]) {
      for (const role of ['buntline', 'leechline', 'sheet'] as const) {
        const slack = slackForFurl(role, 1.02, furl);
        expect(slack, `${role} at furl ${furl}`).toBeGreaterThan(1);
        expect(Number.isFinite(slack)).toBe(true);
      }
    }
  });

  it('is monotone in furl, so the haul never reverses mid-reef', () => {
    // WHY: a non-monotone response would show as the line taking in, then
    // paying out, then taking in again while a single continuous furl plays —
    // the sort of thing that reads as a glitch rather than as gear.
    let prev = Infinity;
    for (let f = 0; f <= 1.0001; f += 0.02) {
      const slack = slackForFurl('buntline', 1.05, f);
      expect(slack).toBeLessThanOrEqual(prev + 1e-12);
      prev = slack;
    }
  });

  it('drives real rope LENGTHS through applyRiggingPlan', () => {
    // WHY: the pure function above could be perfect and still not be wired.
    // This is the end-to-end claim: the same plan, at two furl amounts, hands
    // the GPU different lengths for the SAME geometry.
    const plan = buildRiggingPlan(buildGalleonBlueprint());
    const lengthsAt = (furl: number): number[] => {
      const out: number[] = [];
      applyRiggingPlan(plan, {
        setRope(_i, _a, _b, length): void {
          out.push(length ?? 0);
        },
        setRopeCount(): void {},
      }, (id) => [id.length, id.charCodeAt(0), id.charCodeAt(1)], furl);
      return out;
    };
    const set = lengthsAt(0);
    const furled = lengthsAt(1);
    const sheets = plan.flatMap((r, i) => (r.role === 'sheet' ? [i] : []));
    expect(sheets.length).toBeGreaterThan(0);
    for (const i of sheets) expect(furled[i]).toBeGreaterThan(set[i]);
    // …and standing rigging is byte-identical
    const stays = plan.flatMap((r, i) => (r.role === 'stay' ? [i] : []));
    for (const i of stays) expect(furled[i]).toBe(set[i]);
  });
});

describe('selectBlockSockets (§V12 blocks at running-rigging ends)', () => {
  it('is deterministic, unique, capped, and references real sockets', () => {
    // WHY: block instances are placed by plan order — nondeterminism or
    // unknown ids would scatter pulleys into thin air after a re-apply.
    // Hull anchors are derived points, so a block must never pick one.
    const plan = buildRiggingPlan(buildGalleonBlueprint());
    const sockets = selectBlockSockets(plan, 20);
    expect(sockets).toEqual(selectBlockSockets(plan, 20));
    expect(new Set(sockets).size).toBe(sockets.length);
    expect(sockets.length).toBeLessThanOrEqual(20);
    expect(sockets.length).toBeGreaterThan(0);
    const ids = collectRopeAnchorIds(buildGalleonBlueprint());
    for (const id of sockets) expect(ids.has(id), id).toBe(true);
    // blocks sit where running rigging is worked: yard ends and, now that the
    // sail carries anchors, the clews and bunts themselves
    expect(
      sockets.filter((id) => id.includes('yard') || id.startsWith('anchor-sail-')).length,
    ).toBeGreaterThanOrEqual(8);
    // a tighter cap truncates deterministically
    expect(selectBlockSockets(plan, 5)).toEqual(sockets.slice(0, 5));
  });
});

describe('validateRiggingPlan (fail loud on unknown sockets)', () => {
  it('throws when a plan references a socket id the blueprint lacks', () => {
    // WHY: the concurrent ship rework may rename sockets; silent mis-rig is
    // the §B bug class this guards against.
    const bogus: RiggingRope[] = [
      {
        socketA: 'anchor-masthead-fore',
        socketB: 'anchor-nope',
        role: 'stay',
        slack: 1.006,
        thickness: 0.03,
      },
    ];
    expect(() => validateRiggingPlan(bogus, buildGalleonBlueprint())).toThrow(/anchor-nope/);
  });

  it('throws if the chainplate sockets the shrouds need ever disappear', () => {
    // WHY: shroud feet depend on `anchor-channel-*`, which the ship system
    // added for this rig. If a hull rework drops or renames them the plan must
    // fail loudly here rather than quietly falling back to the end cleats —
    // that fallback IS the spider web.
    const bogus: RiggingRope[] = [
      {
        socketA: 'anchor-masthead-fore',
        socketB: 'anchor-channel-port-mizzen',
        role: 'shroud',
        slack: 1.004,
        thickness: 0.04,
      },
    ];
    expect(() => validateRiggingPlan(bogus, buildGalleonBlueprint())).toThrow(
      /anchor-channel-port-mizzen/,
    );
  });
});

describe('applyRiggingPlan (§V12 re-solve entry point)', () => {
  it('feeds setRope world positions and chord×slack lengths, then sets count', () => {
    // WHY: this is the exact call main.ts repeats when a mast moves; the
    // index↔plan-entry mapping and length formula must stay stable or
    // re-application scrambles the rig.
    const plan = buildRiggingPlan(buildGalleonBlueprint());
    const calls: number[] = [];
    let count = -1;
    const positions = new Map<string, Point>();
    let n = 0;
    const socketWorldPosition = (id: string): Point => {
      if (!positions.has(id)) positions.set(id, [n++, n * 2, -n]);
      return positions.get(id)!;
    };
    applyRiggingPlan(plan, {
      setRope(index, a, b, length): void {
        const chord = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
        expect(length).toBeCloseTo(chord * plan[index].slack, 10);
        calls.push(index);
      },
      setRopeCount(c): void {
        count = c;
      },
    }, socketWorldPosition);
    expect(calls).toEqual(plan.map((_, i) => i));
    expect(count).toBe(plan.length);
  });

  it('never emits a NaN endpoint, even when every socket collapses to a point', () => {
    // WHY: §V28 — a NaN endpoint reaches the storage buffer and the compute
    // pass turns it into NaN-sized geometry (the §B5 class of GPU wedge).
    // Hull anchors are pure weighted sums precisely so no resolve-time
    // division exists to blow up; this pins that property.
    const plan = buildRiggingPlan(buildGalleonBlueprint());
    let checked = 0;
    applyRiggingPlan(plan, {
      setRope(_i, a, b, length): void {
        for (const v of [a.x, a.y, a.z, b.x, b.y, b.z, length ?? 0]) {
          expect(Number.isFinite(v)).toBe(true);
        }
        checked++;
      },
      setRopeCount(): void {},
    }, () => [0, 0, 0]);
    expect(checked).toBe(plan.length);
  });

  it('applyBlocks mirrors the same index/count contract for pulleys', () => {
    // WHY: blocks ride their sockets exactly like rope anchors; a drifting
    // index mapping would leave pulleys behind when the ship moves.
    const plan = buildRiggingPlan(buildGalleonBlueprint());
    const sockets = selectBlockSockets(plan, 20);
    const placed: number[] = [];
    let count = -1;
    applyBlocks(sockets, {
      setBlock(index, position): void {
        expect(Number.isFinite(position.x)).toBe(true);
        placed.push(index);
      },
      setBlockCount(n): void {
        count = n;
      },
    }, () => [1, 2, 3]);
    expect(placed).toEqual(sockets.map((_, i) => i));
    expect(count).toBe(sockets.length);
  });
});
