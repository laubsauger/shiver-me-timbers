/**
 * §T.63 — A CANNONBALL HOLE IS A HOLE.
 *
 * WHAT WAS WRONG, measured on the shipped galleon at HEAD before this file:
 *   • the breach was an OPAQUE disc (`createHoleMaterial`: `#120c07`,
 *     `depthWrite: true`, `transparent: false`) laid on an UNMODIFIED shell.
 *     Rays cast through its centre hit planking TWICE. You could not see
 *     through a cannonball hole.
 *   • it was 1.794 m in radius — `max(0.3, min(sy, sz) · 0.3)`, sized off the
 *     PIECE's bounding box — i.e. **3.588 m across on a 35 m ship**, 10.2% of
 *     her length, 11.2× the drawn ball's own 0.32 m diameter, and identical on
 *     every section whatever hit it.
 *   • it sat at an AUTHORED station (piece z-mid, y = −draft/4) and never read
 *     the hit, so a shot on the end of a section opened a hole up to 5.8 m
 *     away from where the ball went in.
 *   • it was built once, at the hp threshold, so a section could never show
 *     more than ONE breach however long you fired at it.
 *   • every ejecta cue was aimed along the ship's own outward normal, so the
 *     direction the ball was travelling was thrown away at the only place it
 *     was ever known.
 *
 * WHY THESE ASSERT PROPERTIES AND NOT NUMBERS (§V.80). Nothing here pins the
 * shipped radius, the shipped multiplier, or a vertex count: the hole must be
 * TRANSMISSIVE, must SCALE with the calibre, must land WHERE THE BALL DID,
 * must ACCUMULATE, and the ejecta must CORRELATE with the shot. Every one of
 * those survives a look change; a pinned 0.80 m would not, and would have
 * passed just as happily at 3.588 m.
 */
import { describe, expect, it } from 'vitest';
import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshBasicMaterial,
  DoubleSide,
  Matrix4,
  Raycaster,
  Vector3,
  type Material,
} from 'three';
import { buildGalleonBlueprint } from '../src/ship/shipBlueprint';
import { buildPieceGeometry } from '../src/ship/pieceGeometry';
import { buildHoledVariant, defaultRadius, type PieceBreach } from '../src/ship/pieceGeometryHoled';
import { asHullShape, H_STEPS, Z_SLICES } from '../src/ship/pieceGeometryHull';
import { hullHalfWidthAt } from '../src/ship/hullMath';
import { jagRadius, seatAperture, JAG_MAX, JAG_MIN } from '../src/ship/hullAperture';
import { ShipAssembly } from '../src/ship/shipAssembly';
import { applyHitDamage } from '../src/ship/destruction';
import { testHits } from '../src/combat/hitTest';
import { createInitialState, type ShipState } from '../src/state/simState';
import { createCombatFx } from '../src/combat/combatFx';
import { combatFxParams } from '../src/params/combat';
import { destructionParams } from '../src/params/destruction';
import { galleonParams } from '../src/params/ship';

const stub = (): Material => ({ dispose(): void {} }) as unknown as Material;
const PIECE = 'hull-starboard-mid';
const blueprint = buildGalleonBlueprint();
const piece = blueprint.find((p) => p.id === PIECE)!;
const hull = asHullShape(piece.shape)!;
const zMid = (hull.z0 + hull.z1) / 2;

/** the WOOD group alone (group 0) — the dark cavity must not stand in for a
 *  shell that is still there, which is exactly the defect being removed */
function woodMesh(indexedOrNot: BufferGeometry): Mesh {
  // the intact shell is INDEXED and the holed one is not; slicing a position
  // array without expanding the index first builds a triangle soup out of a
  // vertex list and every raycast below would be meaningless
  const g = indexedOrNot.index !== null ? indexedOrNot.toNonIndexed() : indexedOrNot;
  const pos = g.getAttribute('position');
  const woodCount = g.groups.length === 2 ? g.groups[0].count : pos.count;
  const cut = new BufferGeometry();
  cut.setAttribute(
    'position',
    new BufferAttribute((pos.array as Float32Array).slice(0, woodCount * 3), 3),
  );
  // DoubleSide, and it matters: the shell's quads are wound to face outboard,
  // so a FrontSide raycast from outside would report an intact hull as open.
  return new Mesh(cut, new MeshBasicMaterial({ side: DoubleSide }));
}

/**
 * Does a ray meet timber where the CAMERA is — outside the ship, looking in?
 * Cast along −x at (y, z) from well clear of the beam, which is the same
 * question the player asks of a hole.
 */
function blocked(mesh: Mesh, y: number, z: number): boolean {
  const ray = new Raycaster(new Vector3(30, y, z), new Vector3(-1, 0, 0), 0, 60);
  return ray.intersectObject(mesh).length > 0;
}

/** fraction of a disc of rays at (y, z) that pass clean through the planking */
function openFraction(mesh: Mesh, y: number, z: number, radius: number): number {
  let open = 0;
  let total = 0;
  for (let a = 0; a < 24; a++) {
    for (let f = 0; f <= 0.6; f += 0.15) {
      const th = (a / 24) * Math.PI * 2;
      total++;
      if (!blocked(mesh, y + Math.sin(th) * radius * f, z + Math.cos(th) * radius * f)) open++;
    }
  }
  return open / total;
}

/** widest opening across the shell at this height, by bisection on rays */
function openSpanZ(mesh: Mesh, y: number, z: number, limit: number): number {
  let lo = z;
  let hi = z;
  const step = 0.01;
  while (z - lo < limit && !blocked(mesh, y, lo - step)) lo -= step;
  while (hi - z < limit && !blocked(mesh, y, hi + step)) hi += step;
  return hi - lo;
}

const holedWith = (...breaches: PieceBreach[]): Mesh =>
  woodMesh(buildHoledVariant(piece.kind, piece.aabb, 1, piece.shape, breaches));

const breachAt = (y: number, z: number, radius = defaultRadius()): PieceBreach => ({
  point: [0, y, z],
  radius,
  seed: 12345,
});

describe('the hull is actually PERFORATED (§T.63, §V.14)', () => {
  it('you can see THROUGH a cannonball hole — the intact shell blocks every ray', () => {
    // THE HEADLINE DEFECT. `createHoleMaterial` is opaque and depth-writing,
    // and nothing was ever removed from the planking behind it, so the "hole"
    // occluded exactly like the hull it was painted on.
    const r = defaultRadius();
    const intact = woodMesh(buildPieceGeometry(piece.kind, piece.aabb, piece.shape));
    const holed = holedWith(breachAt(-0.4, 0, r));

    expect(openFraction(intact, -0.4, 0, r), 'intact planking must block everything').toBe(0);
    expect(blocked(intact, -0.4, 0), 'control: the shell is there to begin with').toBe(true);
    expect(blocked(holed, -0.4, 0), 'the middle of a breach must be OPEN').toBe(false);
    expect(openFraction(holed, -0.4, 0, r)).toBeGreaterThan(0.8);
  });

  it('the shell is only removed AT the breach — the rest of the piece is untouched', () => {
    // The aperture welds a torn annulus onto the coarse grid's own boundary.
    // If that weld were wrong the planking would open somewhere it should not,
    // and the ship would leak daylight along a grid line.
    const r = defaultRadius();
    const intact = woodMesh(buildPieceGeometry(piece.kind, piece.aabb, piece.shape));
    const holed = holedWith(breachAt(-0.4, 0, r));
    let mismatched = 0;
    let sampled = 0;
    for (let y = -1.6; y <= 2.0; y += 0.2) {
      for (let z = -5.2; z <= 5.2; z += 0.2) {
        if (Math.hypot(y + 0.4, z) < r * 2.6) continue; // skip the breach itself
        sampled++;
        if (blocked(intact, y, z) !== blocked(holed, y, z)) mismatched++;
      }
    }
    expect(sampled).toBeGreaterThan(500);
    expect(mismatched, 'no planking removed away from the breach').toBe(0);
  });

  it('the hole is sized BY THE SHOT, not by the piece it lands on', () => {
    // It used to be `min(sy, sz) · 0.3` — a function of the PIECE's bounding
    // box, so every section of every ship wore the same 3.588 m wound and a
    // heavier gun could not have made a bigger one.
    const small = defaultRadius(0.1);
    const large = defaultRadius(0.3);
    expect(large / small).toBeCloseTo(3, 6); // strictly proportional to calibre

    const spanSmall = openSpanZ(holedWith(breachAt(-0.4, 0, small)), -0.4, 0, 4);
    const spanLarge = openSpanZ(holedWith(breachAt(-0.4, 0, large)), -0.4, 0, 4);
    expect(spanLarge).toBeGreaterThan(spanSmall * 2.2);
  });

  it('§V.62 — every breach knob reaches the mesh', () => {
    const base = destructionParams.breachRadiusPerCalibre;
    const span = (): number =>
      openSpanZ(holedWith(breachAt(-0.4, 0, defaultRadius())), -0.4, 0, 4);
    const before = span();
    destructionParams.breachRadiusPerCalibre = base * 2;
    const after = span();
    destructionParams.breachRadiusPerCalibre = base;
    expect(after, 'breachRadiusPerCalibre must widen the hole').toBeGreaterThan(before * 1.6);

    // and the calibre itself, which lives in combat params, not ship params
    const ball = combatFxParams.ballDrawRadius;
    combatFxParams.ballDrawRadius = ball * 2;
    const doubled = defaultRadius();
    combatFxParams.ballDrawRadius = ball;
    expect(doubled).toBeCloseTo(defaultRadius() * 2, 9);
  });

  it('N hits make N holes — several small ones, never one giant disc', () => {
    // The overlay was built once, at the hp threshold, so a hull section could
    // never show a second breach. Three well-separated hits, three holes, and
    // the planking between them still standing.
    const r = defaultRadius();
    const spots: [number, number][] = [[-0.9, -3.6], [0.4, 0], [-0.3, 3.6]];
    const holed = holedWith(...spots.map(([y, z]) => breachAt(y, z, r)));
    for (const [y, z] of spots) {
      expect(blocked(holed, y, z), `breach at ${y},${z} must be open`).toBe(false);
    }
    // between them the hull is whole
    expect(blocked(holed, -0.25, -1.8)).toBe(true);
    expect(blocked(holed, 0.05, 1.8)).toBe(true);

    // and the total opening is nowhere near one 3.588 m disc: each hole spans
    // roughly a calibre, and they do not merge
    for (const [y, z] of spots) {
      expect(openSpanZ(holed, y, z, 6)).toBeLessThan(3.588 / 2);
    }
  });

  it('the hole is WHERE THE BALL WENT IN, not at an authored station', () => {
    const r = defaultRadius();
    const fore = holedWith(breachAt(-0.4, 4.6, r));
    const aft = holedWith(breachAt(-0.4, -4.6, r));
    expect(blocked(fore, -0.4, 4.6)).toBe(false);
    expect(blocked(fore, -0.4, -4.6), 'a fore hit must NOT open the aft end').toBe(true);
    expect(blocked(aft, -0.4, -4.6)).toBe(false);
    expect(blocked(aft, -0.4, 4.6)).toBe(true);
  });

  it('§V.71 — the torn edge resolves against the HULL, not a plane through it', () => {
    // A flat overlay ring at this station is off the planking by up to 1.04 m
    // at a 0.72 m radius, because the round bilge turns the shell hard in the
    // vertical. Every piece of wood the breach adds must sit ON the loft.
    const r = defaultRadius();
    const g = buildHoledVariant(piece.kind, piece.aabb, 1, piece.shape, [breachAt(-0.4, 0, r)]);
    const pos = g.getAttribute('position');
    const woodCount = g.groups[0].count;
    // the fringe stands proud and the collar is carried inboard; nothing may
    // wander further from the shell than those two together
    const tolerance = destructionParams.breachCollarDepth + r * 0.16 + 0.02;
    let worst = 0;
    for (let i = 0; i < woodCount; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      if (y > hull.freeboard) continue; // bulwark lip is not on this parametrisation
      if (Math.abs(y + hull.draft) < 1e-6) continue; // the flat bottom patch
      worst = Math.max(worst, Math.abs(Math.abs(x) - hullHalfWidthAt(zMid + z, y, hull)));
    }
    expect(worst, 'breach geometry hugs the shell').toBeLessThan(tolerance);
    expect(worst).toBeLessThan(1.04); // the flat-ring number, stated
  });

  it('the dark interior is INSIDE the planking, never proud of it', () => {
    // The old backing was a flat disc AT the surface, filling the aperture.
    // A cone set back has the opposite failure mode available to it: at
    // 1.7 x radius the bilge has already turned inboard by ~0.5 m, so a flat
    // plane there would cut back OUT through undamaged planking as a dark
    // collar. Every cavity vertex must sit at or inside the shell.
    const r = defaultRadius();
    const g = buildHoledVariant(piece.kind, piece.aabb, 1, piece.shape, [breachAt(-0.4, 0, r)]);
    const pos = g.getAttribute('position');
    const start = g.groups[1].start;
    let worstProud = -Infinity;
    for (let i = start; i < start + g.groups[1].count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      worstProud = Math.max(worstProud, Math.abs(x) - hullHalfWidthAt(zMid + z, y, hull));
    }
    expect(worstProud, 'the cavity never pokes out through the hull').toBeLessThanOrEqual(0);
  });

  it('§V.28 — a NaN hit never reaches the vertex buffer', () => {
    const asm = new ShipAssembly(blueprint, stub);
    expect(asm.addBreach(PIECE, { point: [0, Number.NaN, 0], radius: 0.4, seed: 1 })).toBe(false);
    expect(asm.addBreach(PIECE, { point: [0, 0, 0], radius: Number.NaN, seed: 1 })).toBe(false);
    expect(asm.breachesOf(PIECE)).toHaveLength(0);

    // and a finite one that DOES land leaves no NaN behind
    expect(asm.addBreach(PIECE, { point: [0, -0.4, 1.2], radius: 0.4, seed: 1 })).toBe(true);
    const pos = (asm as unknown as {
      pieces: Map<string, { mesh: { geometry: BufferGeometry } }>;
    }).pieces.get(PIECE)!.mesh.geometry.getAttribute('position');
    let nans = 0;
    for (let i = 0; i < pos.count * 3; i++) if (!Number.isFinite((pos.array as Float32Array)[i])) nans++;
    expect(nans).toBe(0);
  });

  it('the torn rim is RAGGED and bounded — no spike escapes its own patch', () => {
    // the jag is what makes the edge read as splintered rather than drilled;
    // it must also stay inside the block of cells the aperture replaced, or it
    // z-fights the planking it is supposed to have removed
    let lo = Infinity;
    let hi = -Infinity;
    for (let a = 0; a < 720; a++) {
      const v = jagRadius((a / 720) * Math.PI * 2, 4242);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(hi - lo, 'a circle is not a tear').toBeGreaterThan(0.2);
    expect(lo).toBeGreaterThanOrEqual(JAG_MIN - 1e-9);
    expect(hi).toBeLessThanOrEqual(JAG_MAX + 1e-9);

    const block = seatAperture({ z: zMid, y: -0.4, radius: defaultRadius(), seed: 7 },
      hull, Z_SLICES, H_STEPS)!;
    expect(block).not.toBeNull();
    const keepU = (defaultRadius() * JAG_MAX) / block.cellZ;
    const keepV = (defaultRadius() * JAG_MAX) / block.cellY;
    expect(block.uc - keepU).toBeGreaterThanOrEqual(block.i0 - 1e-9);
    expect(block.uc + keepU).toBeLessThanOrEqual(block.i1 + 1e-9);
    expect(block.vc - keepV).toBeGreaterThanOrEqual(block.j0 - 1e-9);
    expect(block.vc + keepV).toBeLessThanOrEqual(block.j1 + 1e-9);
  });

  it('the PORT side is perforated too — the sign is carried, not assumed', () => {
    // Everything above tests starboard. The shell's winding, the loft's `side`
    // and the overlay's `faceSign` are three separate expressions of the same
    // sign, and a mismatch shows up as a hole with its splinters on the inside
    // of the ship — invisible from every angle a player uses.
    const port = blueprint.find((p) => p.id === 'hull-port-mid')!;
    const g = buildHoledVariant(port.kind, port.aabb, -1, port.shape, [breachAt(-0.4, 0)]);
    const mesh = woodMesh(g);
    const fromPort = (y: number, z: number): boolean =>
      new Raycaster(new Vector3(-30, y, z), new Vector3(1, 0, 0), 0, 60)
        .intersectObject(mesh).length > 0;
    expect(fromPort(-0.4, 0), 'the port breach is open').toBe(false);
    expect(fromPort(-0.4, 4.6), 'and the planking beside it is not').toBe(true);
    // the fringe stands OUTBOARD (−x on port), never inside the hull
    const pos = g.getAttribute('position');
    let maxX = -Infinity;
    for (let i = 0; i < g.groups[0].count; i++) maxX = Math.max(maxX, pos.getX(i));
    // 0 is legal and expected: the half-shell's bottom patch reaches the
    // centreline by design (`bottomHalf`, k = 0). Anything POSITIVE is the
    // breach built on the wrong side of the ship.
    expect(maxX, 'no port-side wood strays across the centreline').toBeLessThanOrEqual(0);
  });

  it('the breach is a fraction of the ship, not a tenth of her length', () => {
    // Not a pinned radius — a RATIO the look has to respect. The disc this
    // replaces was 10.2% of a 35 m hull and 11.2 ball diameters across.
    const d = defaultRadius() * 2;
    expect(d / galleonParams.hullLength).toBeLessThan(0.05);
    expect(d / (combatFxParams.ballDrawRadius * 2)).toBeLessThan(6);
    expect(d / (combatFxParams.ballDrawRadius * 2)).toBeGreaterThan(1);
  });
});

describe('a hit is what makes a hole (§T.63 wiring)', () => {
  const seatFor = (pieceId: string) => ({
    shipPosition: [0, 0, 0] as [number, number, number],
    shipQuaternion: [0, 0, 0, 1] as [number, number, number, number],
    pieceFrame: {
      position: blueprint.find((p) => p.id === pieceId)!.transform.position,
      quaternion: [0, 0, 0, 1] as [number, number, number, number],
    },
    ballRadius: combatFxParams.ballDrawRadius,
  });

  it('EVERY hit through the planking cuts its own hole', () => {
    // it used to be gated on the hp threshold — hit 2 of 4 — so the opening
    // shots of an engagement left no mark at all
    const asm = new ShipAssembly(blueprint, stub);
    const damage: Record<string, number> = {};
    const seat = seatFor(PIECE);
    for (const z of [-4.4, -1.5, 1.5, 4.4]) {
      const r = applyHitDamage(
        asm, blueprint,
        { shipIndex: 0, pieceId: PIECE, point: [4.2, -0.4, z], projectileId: 1 },
        damage, undefined, seat,
      );
      expect(r.breached, `hit at z=${z} must cut`).toBe(true);
    }
    expect(asm.breachesOf(PIECE)).toHaveLength(4);
    // and they are at four DIFFERENT stations, tracking the hits
    const zs = asm.breachesOf(PIECE).map((b) => b.point[2]);
    expect(new Set(zs.map((v) => v.toFixed(3))).size).toBe(4);
  });

  it('the breach lands at the HIT, in the piece\'s own frame', () => {
    const asm = new ShipAssembly(blueprint, stub);
    applyHitDamage(
      asm, blueprint,
      { shipIndex: 0, pieceId: PIECE, point: [4.2, 0.7, 3.3], projectileId: 1 },
      {}, undefined, seatFor(PIECE),
    );
    const b = asm.breachesOf(PIECE)[0];
    const frame = blueprint.find((p) => p.id === PIECE)!.transform.position;
    expect(b.point[1]).toBeCloseTo(0.7 - frame[1], 9);
    expect(b.point[2]).toBeCloseTo(3.3 - frame[2], 9);
  });

  it('`breachesPerPiece` is the only thing that stops the list, and it says so', () => {
    const asm = new ShipAssembly(blueprint, stub);
    const cap = Math.floor(destructionParams.breachesPerPiece);
    let taken = 0;
    for (let i = 0; i < cap + 4; i++) {
      if (asm.addBreach(PIECE, { point: [0, -0.4, i * 0.9 - 4], radius: 0.4, seed: i })) taken++;
    }
    expect(taken).toBe(cap);
    expect(asm.breachesOf(PIECE)).toHaveLength(cap);
  });

  it('a piece with no `holed` state is never breached', () => {
    const asm = new ShipAssembly(blueprint, stub);
    expect(asm.addBreach('deck', { point: [0, 0, 0], radius: 0.4, seed: 1 })).toBe(false);
  });
});

describe('the shot carries momentum through the wood (§T.63)', () => {
  it('a hit knows which way the ball was going', () => {
    // `HitEvent` carried no direction at all, so every ejecta cue was built
    // from the ship's radial normal and a shot from ahead threw exactly the
    // same symmetric dome as one from abeam.
    const state = createInitialState(1);
    const v: [number, number, number] = [40, -3, 12];
    state.projectiles = [{
      id: 1, owner: 1, position: [0, 1, 0], velocity: v, age: 0,
    }];
    const target = {
      shipIndex: 0,
      pieceId: PIECE,
      aabb: { min: [-1, -1, -1] as [number, number, number], max: [1, 1, 1] as [number, number, number] },
      worldTransform: {
        position: [0, 1, 0] as [number, number, number],
        quaternion: [0, 0, 0, 1] as [number, number, number, number],
      },
    };
    const hits = testHits(state, [target], 1 / 60, 0.4);
    expect(hits).toHaveLength(1);
    const d = hits[0].direction;
    expect(d, 'the direction must survive the hit').toBeDefined();
    const len = Math.hypot(v[0], v[1], v[2]);
    expect(d![0]).toBeCloseTo(v[0] / len, 9);
    expect(d![1]).toBeCloseTo(v[1] / len, 9);
    expect(d![2]).toBeCloseTo(v[2] / len, 9);
  });

  it('splinters and chunks fly DOWNRANGE, not in a symmetric dome', () => {
    // THE PROPERTY, not a pinned angle: two hits at the same point on the same
    // hull, one with the ball travelling +z and one −z, must throw their
    // timber to opposite sides. With ejecta keyed on the ship's radial normal
    // alone — which is what it was — these two are BYTE-IDENTICAL.
    const point: [number, number, number] = [8, 3, 0];
    const ship: ShipState = {
      id: 'enemy', kind: 'enemy', position: [0, 0, 0], quaternion: [0, 0, 0, 1],
      velocity: [0, 0, 0], angularVelocity: [0, 0, 0], sailTrim: 0, rudder: 0,
      damage: {}, flood: 0,
    } as unknown as ShipState;

    const meanZ = (dir: [number, number, number] | undefined): number => {
      const fx = createCombatFx();
      const mesh = fx.group.getObjectByName('combat-debris')!;
      fx.emit(
        { muzzles: [], hits: [{ shipIndex: 0, pieceId: PIECE, point, projectileId: 3, direction: dir }],
          projectiles: [], destruction: [], detached: [] },
        [], 0, [ship],
      );
      for (let i = 0; i < 8; i++) fx.update(1 / 60, [], () => -100);
      const inst = mesh as unknown as { count: number; getMatrixAt(i: number, m: Matrix4): void };
      const m = new Matrix4();
      let sum = 0;
      for (let i = 0; i < inst.count; i++) {
        inst.getMatrixAt(i, m);
        sum += m.elements[14] - point[2];
      }
      const out = inst.count > 0 ? sum / inst.count : 0;
      fx.dispose();
      return out;
    };

    const fore = meanZ([0, 0, 1]);
    const aft = meanZ([0, 0, -1]);
    expect(fore, 'a ball travelling +z must carry the timber +z').toBeGreaterThan(0);
    expect(aft, 'and −z the other way').toBeLessThan(0);
    expect(Math.sign(fore)).not.toBe(Math.sign(aft));

    // and §V.62: turning the knob off restores the old symmetric dome, which
    // is the proof the knob is what is doing the work
    const base = combatFxParams.splinterMomentum;
    combatFxParams.splinterMomentum = 0;
    const flatFore = meanZ([0, 0, 1]);
    const flatAft = meanZ([0, 0, -1]);
    combatFxParams.splinterMomentum = base;
    expect(flatFore).toBeCloseTo(flatAft, 9);
  });

  it('a stalled projectile yields no direction rather than a NaN one (§V.28)', () => {
    const state = createInitialState(1);
    state.projectiles = [{ id: 1, owner: 1, position: [0, 1, 0], velocity: [0, 0, 0], age: 0 }];
    const target = {
      shipIndex: 0,
      pieceId: PIECE,
      aabb: { min: [-1, -1, -1] as [number, number, number], max: [1, 1, 1] as [number, number, number] },
      worldTransform: {
        position: [0, 1, 0] as [number, number, number],
        quaternion: [0, 0, 0, 1] as [number, number, number, number],
      },
    };
    const hits = testHits(state, [target], 1 / 60, 0.4);
    expect(hits).toHaveLength(1);
    expect(hits[0].direction).toBeUndefined();
  });
});
