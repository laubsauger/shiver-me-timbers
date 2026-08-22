/**
 * Raft cabin + 2100 dressing — woven walls, gable ends, thatch, floor mats
 * over the box layer, and the crates/drum/dinghy/cage set as simple boxes.
 * The STARBOARD wall is open for ~1.4 m mid-to-aft: the only door [§3 Opening].
 *
 * §B87 — THE DRESSING PASS. The user, from the doorway: "the inside of the
 * raft looks very barren and very lame … the radio inside is just floating in
 * air … the three boxes look kinda repetitive". So the cabin is now furnished
 * the way [§3 Floor / Radio corner / Museum] describes it — loose reed matting
 * over the box layer, two straw mattresses laid fore-and-aft the way the crew
 * slept, the radio SITTING on a crate in the port-aft nook behind its
 * cardboard partition with the battery cases beside it, pots and a ladle on
 * the wall by the door, a chart forward of it — and the roof is courses of
 * thatch on visible bamboo laths instead of a smooth slab.
 *
 * WHAT MAY STAND WHERE. The raft's deck field (§V83, raftDeckFieldCells.ts) is
 * built from THIS graph: a `crate` whose foot is on the floor becomes an
 * obstacle the walker paths around, and a `bamboo-deck` slab becomes a surface
 * he steps onto. So the furniture that is meant to be walked past — the radio
 * crate, its partition, the battery cases — stands against a wall in the
 * port-aft corner, and the things laid on the floor in the middle of the room
 * (the mats, the two berths) are `bamboo-deck` slabs, 2 to 13 cm proud, which
 * the walker steps over. The lane from the doorway to the mat and on into the
 * radio nook stays open: see `radioCorner` for the clearance it is held to.
 */
import type { RaftParams } from '../params/raft';
import type { PieceDef, SocketDef, Vec3 } from './pieceTypes';
import { mkPiece } from './blueprintParts';
import { shipDetailParams } from '../params/ship';
import { thatchCourses } from './pieceGeometryRaft';
import { vhash, vjitter, vrange } from './variation';
import type { RaftLayout } from './raftPartsLayout';

interface BoxOpts {
  sockets?: SocketDef[];
  shape?: Record<string, number>;
  rotation?: [number, number, number];
  parent?: string;
}

function box(
  id: string,
  kind: PieceDef['kind'],
  x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
  opts: BoxOpts = {},
): PieceDef {
  return mkPiece(id, kind, [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], {
    min: [-(x1 - x0) / 2, -(y1 - y0) / 2, -(z1 - z0) / 2],
    max: [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2],
  }, opts);
}

/**
 * A box authored in SHIP coordinates but hung off `parent`. Everything laid on
 * the cabin floor rides the floor piece, which keeps the ONE reading of "a
 * bamboo-deck slab with no parent is part of the DECK" that §V82's coverage
 * test depends on — a mattress is not deck, and neither is a roof lath.
 */
function childBox(
  id: string,
  kind: PieceDef['kind'],
  parent: string,
  origin: Vec3,
  x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
  opts: BoxOpts = {},
): PieceDef {
  return box(id, kind,
    x0 - origin[0], x1 - origin[0],
    y0 - origin[1], y1 - origin[1],
    z0 - origin[2], z1 - origin[2],
    { ...opts, parent });
}

/**
 * A thin member spanning two SHIP-space points — the wire aerial. `rope-rail`
 * geometry runs along the piece's local +z, so the euler is the one that maps
 * +z onto the direction: three composes 'XYZ' as Rx·Ry·Rz, and Rz leaves +z
 * alone, so R·(0,0,1) = (sin y, −sin x·cos y, cos x·cos y).
 */
function spanPiece(id: string, a: Vec3, b: Vec3, r: number, sag: number, seed: number, segments: number): PieceDef {
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.max(1e-3, Math.hypot(d[0], d[1], d[2]));
  const yaw = Math.asin(Math.min(1, Math.max(-1, d[0] / len)));
  const pitch = Math.atan2(-d[1] / len, d[2] / len);
  return mkPiece(id, 'rope-rail', [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], {
    min: [-r, -sag - r, -len / 2],
    max: [r, 0, len / 2],
  }, {
    rotation: [pitch, yaw, 0],
    shape: { posts: 0, rope: r, sag, segments, seed },
  });
}

/** roof pitch: eave → ridge over the half-width (outer wall face) */
export function roofSlope(p: RaftParams): number {
  return Math.atan2(p.cabinRidge - p.cabinEave, p.cabinWidth / 2);
}

/** the inside face of the cabin: what the interior dressing may occupy */
export interface CabinRoom {
  x0: number; x1: number; z0: number; z1: number;
  /** floor top, and the wall top over it */
  floor: number; eave: number;
  /** the doorway's z span in the starboard wall — nothing may stand in it */
  doorZ0: number; doorZ1: number;
}

export function cabinRoom(p: RaftParams, L: RaftLayout): CabinRoom {
  const t = p.cabinWallThickness;
  const inner = p.cabinWidth / 2 - t;
  return {
    x0: -inner, x1: inner,
    z0: L.cabinAftZ + t, z1: L.cabinFrontZ - t,
    floor: L.cabinFloorY,
    eave: L.cabinFloorY + p.cabinEave,
    doorZ0: L.cabinAftZ + p.cabinOpeningAftOffset,
    doorZ1: L.cabinAftZ + p.cabinOpeningAftOffset + p.cabinOpeningLength,
  };
}

/**
 * THE RADIO CORNER, resolved once and read by everything that has to agree
 * with it (§V37): the crate builder, the set that stands ON the crate, the
 * partition that screens the nook, and `station-radio` — the socket the
 * preview harness crouches at and the one T116's interaction prompt anchors to.
 *
 * §B87 MOVED `station-radio`. It used to sit at the port-aft corner itself,
 * which is now where the crate is — the player would have been standing inside
 * the furniture. It sits at the MOUTH of the nook instead: still port, still
 * aft, still behind the partition, but far enough forward and inboard that a
 * 0.6 m walking capsule clears the crate (0.16 m), the partition (0.08 m) and
 * the battery cases, and near enough that a crouched eye is ~0.6 m from the
 * dial with it below the eye line. The `dial` field is what that reach is
 * measured against.
 */
export interface RadioCorner {
  /** the crate the set stands on, in ship space */
  crate: { x0: number; x1: number; z0: number; z1: number; top: number };
  /** the cardboard partition: a fore-aft panel closing the nook to starboard */
  partition: { x0: number; x1: number; z0: number; z1: number; top: number };
  /** the set itself: centre, size and the yaw that turns its face to the station */
  set: { centre: Vec3; width: number; height: number; depth: number; yaw: number };
  /** the tuning dial's centre — the thing that must be legible at arm's length */
  dial: Vec3;
  /** where the player kneels (`station-radio`), in ship space */
  station: Vec3;
}

export function radioCorner(p: RaftParams, L: RaftLayout): RadioCorner {
  const r = cabinRoom(p, L);
  const crate = {
    x0: r.x0 + 0.02,
    x1: r.x0 + 0.02 + p.radioCrateWidth,
    z0: r.z0 + 0.03,
    z1: r.z0 + 0.03 + p.radioCrateDepth,
    top: r.floor + p.radioCrateHeight,
  };
  const partition = {
    x0: crate.x1 + 0.37,
    x1: crate.x1 + 0.37 + p.partitionThickness,
    z0: r.z0 - 0.01,
    z1: r.z0 - 0.01 + p.partitionLength,
    top: r.floor + p.partitionHeight,
  };
  const centre: Vec3 = [(crate.x0 + crate.x1) / 2, crate.top + p.radioHeight / 2, (crate.z0 + crate.z1) / 2];
  // the player kneels at the nook's mouth: forward of the crate, inboard of it,
  // and forward of the partition's own forward end
  const station: Vec3 = [partition.x0 - 0.38, r.floor, partition.z1 + 0.06];
  // face the set at him. Rotation about +y by θ carries local +z (the face
  // plate, see buildRadioGeometry) to (sin θ, 0, cos θ).
  const yaw = Math.atan2(station[0] - centre[0], station[2] - centre[2]);
  // the dial sits on the port half of the face plate, just forward of it —
  // the same offsets buildRadioGeometry lays it out with
  const dx = -p.radioWidth * 0.28;
  const dz = p.radioDepth * 0.4;
  return {
    crate,
    partition,
    set: { centre, width: p.radioWidth, height: p.radioHeight, depth: p.radioDepth, yaw },
    dial: [
      centre[0] + dx * Math.cos(yaw) + dz * Math.sin(yaw),
      centre[1] - p.radioHeight * 0.06,
      centre[2] - dx * Math.sin(yaw) + dz * Math.cos(yaw),
    ],
    station,
  };
}

export function buildCabin(p: RaftParams, L: RaftLayout): PieceDef[] {
  const W = p.cabinWidth;
  const t = p.cabinWallThickness;
  const hw = W / 2;
  const z0 = L.cabinAftZ;
  const z1 = L.cabinFrontZ;
  const base = L.crossbeamTopY; // walls stand on the crossbeams, the box layer inside
  const eaveY = L.cabinFloorY + p.cabinEave;
  const ridgeY = L.cabinFloorY + p.cabinRidge;
  const out: PieceDef[] = [];

  // FLOOR: mats over 8 lashed boxes [§3 Floor] — proud of the deck by the box
  // height (§V83). Carries the indoor stations.
  const floorHalfH = (L.cabinFloorY - base) / 2;
  const floorLen = p.cabinLength - 2 * t;
  const radio = radioCorner(p, L);
  out.push(box('cabin-floor', 'bamboo-deck', -hw + t, hw - t, base, L.cabinFloorY, z0 + t, z1 - t, {
    shape: { boxes: 1 },
    sockets: [
      // radio corner: port-aft, behind its partition [§3 Radio corner]. §B87
      // resolves it through `radioCorner` so the crouch station and the crate
      // the set stands on cannot drift apart (§V37).
      {
        id: 'station-radio',
        type: 'fixture',
        position: [radio.station[0], floorHalfH, radio.station[2] - (z0 + z1) / 2],
      },
      // chart table against the starboard wall, forward of the door
      { id: 'station-chart', type: 'fixture', position: [hw - 0.4, floorHalfH, (p.cabinOpeningAftOffset + p.cabinOpeningLength + 0.35) - floorLen / 2] },
      // sleeping mat, fore-aft along the port side [§3 Floor]
      { id: 'station-mat', type: 'fixture', position: [-hw + 0.6, floorHalfH, 0.3] },
    ],
  }));

  // WALLS — thin woven panels; the material does the weave (§T90)
  //
  // §T129b — THE SIDE WALLS STOP AT THE GABLES. They used to run the full
  // `cabinLength` while the gables ran the full `cabinWidth`, so at each of the
  // four corners the two panels occupied the SAME 5 cm × 5 cm × 1.5 m of space:
  // the side wall's outer face and the gable's end face landed on one plane
  // pointing one way, and so did the gable's outer face and the side wall's end
  // cap. Eight patches of surface the depth buffer had no way to order, which
  // is the user's "the side walls and the back walls are stuck in each other".
  // The gables span the width and close the corners; the side walls fill the
  // clear length BETWEEN them, butting each gable's inner face — a butt joint's
  // two faces are anti-parallel, so one is always culled and it cannot fight.
  const sideZ0 = z0 + t;
  const sideZ1 = z1 - t;
  out.push(box('cabin-wall-port', 'cabin-wall', -hw, -hw + t, base, eaveY, sideZ0, sideZ1));
  const openZ0 = z0 + p.cabinOpeningAftOffset;
  const openZ1 = openZ0 + p.cabinOpeningLength;
  out.push(box('cabin-wall-starboard-aft', 'cabin-wall', hw - t, hw, base, eaveY, sideZ0, openZ0));
  out.push(box('cabin-wall-starboard-fwd', 'cabin-wall', hw - t, hw, base, eaveY, openZ1, sideZ1));
  // gable ends: wall height + the triangle up to the ridge [§3 Museum: gable ends woven]
  const rise = ridgeY - eaveY;
  for (const [name, za, zb] of [['aft', z0, z0 + t], ['fwd', z1 - t, z1]] as const) {
    out.push(box(`cabin-wall-${name}`, 'cabin-wall', -hw, hw, base, ridgeY, za, zb, {
      shape: { gable: rise },
    }));
  }

  // THATCH ROOF (§B87): two slopes meeting at the ridge, each laid in
  // OVERLAPPING COURSES on visible bamboo laths, overhanging by roofOverhang
  // on every side with a ragged eave [§3 Roof]. It was one smooth box per
  // slope, which is why the user said it "doesn't really look like a thatched
  // roof": a slab has no step for a low sun to catch, so it read as a painted
  // plane at every hour. The geometry carries the COURSES (their butts step
  // down the slope by `roofCourseRise`, and the eave course is broken into
  // butts of different lengths); the `thatch` material carries the individual
  // LEAF inside a course. Both halves, or it is stripes on a slab again.
  const slope = roofSlope(p);
  const run = hw + p.roofOverhang;
  const slabLen = run / Math.cos(slope);
  const roofZLen = p.cabinLength + 2 * p.roofOverhang;
  for (const [side, sign] of [['port', -1], ['starboard', 1]] as const) {
    const eaveTipY = ridgeY - run * Math.tan(slope);
    // which way local +x runs DOWN the slope: the two slabs are mirrored about
    // the ridge, so it is +1 to starboard and −1 to port
    const shape = {
      overhang: p.roofOverhang,
      eaveSign: sign,
      coursePitch: p.roofCoursePitch,
      courseOverlap: p.roofCourseOverlap,
      courseRise: p.roofCourseRise,
      eaveSegments: p.roofEaveSegments,
      eaveRagged: p.roofEaveRagged,
      seed: p.seed + sign,
    };
    out.push(
      mkPiece(`thatch-roof-${side}`, 'thatch-roof',
        [sign * run / 2, (ridgeY + eaveTipY) / 2, (z0 + z1) / 2], {
          min: [-slabLen / 2, 0, -roofZLen / 2],
          max: [slabLen / 2, p.roofThickness, roofZLen / 2],
        }, { rotation: [0, 0, -sign * slope], shape }),
    );
    // the laths the thatch is tied to, riding the slope with it. They run DOWN
    // the slope, which is the axis the bamboo family draws its canes along on a
    // slab's underside — and the underside is the only face anyone sees, from
    // inside the cabin looking up. `platform` keeps them out of the deck field
    // (raftDeckFieldCells.ts: a bamboo member at a level nobody walks on).
    const under = thatchCourses(slabLen, p.roofThickness, shape)[0].bottom;
    out.push(
      mkPiece(`roof-lath-${side}`, 'bamboo-deck', [0, 0, 0], {
        min: [-slabLen / 2, under - p.roofLathSection, -p.cabinLength / 2],
        max: [slabLen / 2, under, p.cabinLength / 2],
      }, {
        parent: `thatch-roof-${side}`,
        shape: { laths: p.roofLathCount, section: p.roofLathSection, seed: p.seed + sign, platform: 1 },
      }),
    );
  }
  out.push(...buildCabinInterior(p, L));
  return out;
}

/**
 * §B87 — WHAT MAKES THE CABIN LIVED-IN. Everything here is [§3 Floor / Radio
 * corner / Museum] or the 2100 column of the design doc's dressing table, and
 * everything is placed so the doorway → mat → radio-nook lane stays walkable:
 * the solid furniture is against a wall, and what lies in the middle of the
 * floor is a slab the walker steps onto.
 */
function buildCabinInterior(p: RaftParams, L: RaftLayout): PieceDef[] {
  const r = cabinRoom(p, L);
  const radio = radioCorner(p, L);
  const fy = r.floor;
  // the cabin-floor piece's own origin, which everything laid on it hangs off
  const origin: Vec3 = [0, (L.crossbeamTopY + fy) / 2, (r.z0 + r.z1) / 2];
  const on = (id: string, kind: PieceDef['kind'],
    x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, opts: BoxOpts = {}): PieceDef =>
    childBox(id, kind, 'cabin-floor', origin, x0, x1, y0, y1, z0, z1, opts);
  const out: PieceDef[] = [];

  // LOOSE REED MATS over the box layer [§3 Floor] — thrown down by hand, so
  // they do not line up with the room or with each other
  const ml = p.floorMatLength / 2;
  const mw = p.floorMatWidth / 2;
  const mt = p.floorMatThickness;
  const mid = (r.z0 + r.z1) / 2;
  // kept clear of the doorway's own aperture: even a 2 cm mat lying across the
  // sill is a thing the eye reads as "the door does not open"
  for (const [k, cx, cz, yaw] of [[0, 0.0, mid - 0.15, 0.05], [1, -0.05, mid + 1.05, -0.04]] as const) {
    out.push(on(`floor-mat-${k}`, 'bamboo-deck', cx - mw, cx + mw, fy, fy + mt, cz - ml, cz + ml,
      { rotation: [0, yaw, 0] }));
  }

  // TWO STRAW MATTRESSES, laid FORE-AND-AFT along the logs — "sleepers
  // fore-aft" [§3 Floor], striped ticking [§3 Museum]. They are bamboo-deck
  // slabs, not crates: a berth the walker cannot stand on is a berth with no
  // `station-mat`.
  const bw = p.mattressWidth;
  const bl = p.mattressLength / 2;
  const bh = p.mattressHeight;
  out.push(on('berth-port', 'bamboo-deck', r.x0 + 0.02, r.x0 + 0.02 + bw, fy + mt, fy + mt + bh,
    mid - bl, mid + bl, { rotation: [0, 0.02, 0] }));
  // the starboard berth lies FORWARD of the doorway: the crew slept two a side
  // [§3 Floor], and the 1.4 m of open wall is the only way in [§3 Opening]
  out.push(on('berth-starboard', 'bamboo-deck', r.x1 - 0.10 - bw, r.x1 - 0.10, fy + mt, fy + mt + bh,
    r.doorZ1 + 0.03, Math.min(r.z1 - 0.05, r.doorZ1 + 0.03 + 2 * bl), { rotation: [0, -0.025, 0] }));

  // THE RADIO CORNER [§3 Radio corner]: the crate the set stands on, the set,
  // the cardboard partition that screens it, and the battery cases beside it.
  const c = radio.crate;
  out.push(on('radio-crate', 'crate', c.x0, c.x1, fy, c.top, c.z0, c.z1,
    { shape: { lash: 1, lashRope: p.crateLashRope, seed: p.seed + 3 } }));
  const s = radio.set;
  out.push(mkPiece('radio-set', 'radio', s.centre, {
    min: [-s.width / 2, -s.height / 2, -s.depth / 2],
    max: [s.width / 2, s.height / 2, s.depth / 2],
  }, {
    rotation: [0, s.yaw, 0],
    shape: {
      dial: p.radioDialDiameter,
      meterWidth: p.radioMeterWidth,
      meterHeight: p.radioMeterHeight,
      crank: p.radioCrankReach,
      // needle rest positions — off-station and reading nothing, which is
      // where T103 will pick them up
      dialAngle: -0.75,
      meterAngle: 0.55,
    },
    sockets: [
      // where the wire aerial is made fast on the set (T116/T103 read it)
      { id: 'anchor-aerial-radio', type: 'rope-anchor', position: [-s.width * 0.36, s.height * 0.65, -s.depth * 0.2] },
    ],
  }));
  const q = radio.partition;
  // "one corner behind a cardboard partition (decorated)" — a fore-aft panel,
  // leaning the way salvaged card does
  out.push(on('radio-partition', 'crate', q.x0, q.x1, fy, q.top, q.z0, q.z1,
    { rotation: [0, 0, 0.035] }));
  let by = fy;
  for (let k = 0; k < 2; k++) {
    const shrink = k * 0.03;
    const bx = c.x1 + 0.03 + shrink;
    out.push(on(`battery-${k + 1}`, 'crate',
      bx, bx + p.batteryCaseWidth - 2 * shrink, by, by + p.batteryCaseHeight,
      r.z0 + 0.03 + shrink, r.z0 + 0.03 + p.batteryCaseDepth - shrink,
      { rotation: [0, vjitter(0.09, p.seed, 31, k), 0] }));
    by += p.batteryCaseHeight;
  }
  // the aerial's lead INSIDE the cabin: up from the set to the aft gable under
  // the ridge, where `aerial-wire` takes it on to the mast crossing
  const gableIn: Vec3 = [0, L.cabinFloorY + p.cabinRidge - 0.1, r.z0 + 0.02];
  out.push(spanPiece('aerial-lead',
    [s.centre[0] - s.width * 0.3, s.centre[1] + s.height * 0.6, s.centre[2]],
    gableIn, 0.006, 0.05, p.seed + 5, 3));

  // POTS AND A LADLE on the starboard wall, aft of the door [§3 Museum, §6].
  // Hung above head height against the wall: their feet are well clear of the
  // deck field's `cabinFloorY + 0.3`, so they are dressing, not an obstacle.
  const pd = p.potDiameter;
  const potY = fy + p.cabinEave - 0.12;
  out.push(on('pot-1', 'crate', r.x1 - 0.01 - pd, r.x1 - 0.01, potY - p.potHeight, potY,
    r.doorZ0 - 0.10 - pd, r.doorZ0 - 0.10, { shape: { round: 1, sides: 8 } }));
  const pd2 = pd * 0.75;
  out.push(on('pot-2', 'crate', r.x1 - 0.01 - pd2, r.x1 - 0.01, potY - p.potHeight * 0.72, potY - 0.02,
    r.doorZ0 - 0.46 - pd2, r.doorZ0 - 0.46, { shape: { round: 1, sides: 8 } }));
  out.push(on('ladle', 'crate', r.x1 - 0.05, r.x1 - 0.01, potY - 0.42, potY + 0.02,
    r.doorZ0 - 0.78, r.doorZ0 - 0.74, { rotation: [0, 0, 0.12] }));

  // THE CHART on the starboard wall, forward of the door [§6] — the paper the
  // radio's locked stations get marked on (design doc §05)
  out.push(on('chart', 'crate', r.x1 - 0.045, r.x1 - 0.01,
    fy + 0.5, fy + 0.5 + p.chartHeight,
    r.doorZ1 + 0.06, r.doorZ1 + 0.06 + p.chartWidth, { rotation: [0, 0, -0.02] }));
  return out;
}

/** 2100 dressing as boxes first (§T89). Positions per [§6]; sizes EST. */
export function buildDressing(p: RaftParams, L: RaftLayout): PieceDef[] {
  const hw = p.cabinWidth / 2;
  const cw = p.crateWidth;
  const out: PieceDef[] = [];
  const y0 = L.crossbeamTopY;
  // Crates along the PORT cabin wall [§6], the stack a player sees first
  // coming aft from the bow. §B87: "the three boxes look kinda repetitive on
  // the front, like they should be differently oriented or something" — they
  // were one box authored three times. Every one now differs in all three
  // dimensions, in how far off square it was shoved, in how far it stands off
  // the wall, in its gap to the next, and in how many rope bands hold it
  // down; the crate MATERIAL already picks pine boards or khaki ration card
  // off the piece id's own hash, so the contents differ too. Seeded (§V2) and
  // scaled by the one shared `irregularity` dial, exactly as §T34 varies the
  // galleon's fittings — turn it to 0 and the three go back to identical.
  const irr = Math.max(0, shipDetailParams.irregularity);
  const crateX1 = -hw - 0.03;
  let cursor = L.cabinFrontZ - 0.25;
  for (let k = 0; k < 3; k++) {
    const w = cw * (1 + vjitter(p.crateSizeVar, p.seed, 81, k) * irr);
    const d = cw * (1 + vjitter(p.crateSizeVar, p.seed, 82, k) * irr);
    const h = p.crateHeight * (1 + vjitter(p.crateSizeVar * 0.7, p.seed, 83, k) * irr);
    const standOff = vrange(0, 0.07, p.seed, 84, k) * irr;
    cursor -= d / 2 + 0.05 + vrange(0, 0.12, p.seed, 85, k) * irr;
    const x1 = crateX1 - standOff;
    out.push(box(`crate-${k + 1}`, 'crate', x1 - w, x1, y0, y0 + h, cursor - d / 2, cursor + d / 2, {
      rotation: [0, vjitter(p.crateYawVar, p.seed, 86, k) * irr, 0],
      shape: {
        lash: vhash(p.seed, 87, k) > 0.5 ? 2 : 1,
        lashRope: p.crateLashRope,
        seed: p.seed + k,
      },
    }));
    cursor -= d / 2;
  }
  // jerrycans outboard of the crates (2100 stand-in for the 56 water cans)
  for (let k = 0; k < 2; k++) {
    const x1 = crateX1 - cw - 0.05;
    const zc = L.cabinFrontZ - 0.5 - k * 0.4;
    out.push(box(`jerrycan-${k + 1}`, 'crate', x1 - 0.18, x1, y0, y0 + p.jerrycanHeight, zc - 0.175, zc + 0.175));
  }
  // yellow ring dinghy on edge against the port wall, aft of the crates [§6]
  const dz1 = L.cabinAftZ + 0.1 + p.dinghyLength;
  out.push(box('dinghy', 'crate', crateX1 - p.dinghyThickness, crateX1, y0, y0 + p.dinghyHeight, L.cabinAftZ + 0.1, dz1, {
    shape: { dinghy: 1 },
  }));
  // §B78-2 — rain drum at the cabin's PORT-aft corner, on the bare logs
  // (2100). It stood on the STARBOARD quarter, where it and the kitchen box
  // between them left a 0.4 m slot between the cabin and the deck edge: the
  // R2 walk review tried three ways out of the tiller spawn and called the
  // stern "an island". Starboard is the WORKING side — the door, the strip,
  // the helmsman's road forward — so the stores go to port with the crates,
  // the jerrycans and the dinghy, clear of the guara slots.
  const dr = p.drumDiameter / 2;
  out.push(box('rain-drum', 'crate', -hw - 0.05 - 2 * dr, -hw - 0.05, L.logTopY, L.logTopY + p.drumHeight,
    L.cabinAftZ - 0.05 - 2 * dr, L.cabinAftZ - 0.05, { shape: { round: 1 } }));
  // empty parrot cage hung under the roof, inside [§6]
  const cs = p.cageSize;
  const cageTop = L.cabinFloorY + p.cabinEave - 0.05;
  out.push(box('cage', 'crate', 0.3, 0.3 + cs, cageTop - cs, cageTop, L.cabinFrontZ - 1.2, L.cabinFrontZ - 1.2 + cs, {
    shape: { cage: 1 },
  }));
  // kitchen box on the starboard strip, aft of the door, in the lee [§3
  // Outside door] — LASHED AGAINST THE WALL (§B78-2): the strip is 1.2 m
  // wide and the walker's capsule is 0.6, so a box standing 0.1 m off the
  // wall left the road forward narrower than the man who uses it.
  const ks = p.kitchenBoxSize;
  const kz1 = L.cabinAftZ + p.cabinOpeningAftOffset - 0.1;
  out.push(box('kitchen-box', 'crate', hw + 0.03, hw + 0.03 + ks, L.deckY, L.deckY + ks * 0.8, kz1 - ks, kz1));

  // §B87 / ref §10 — A PLANK CHEST lashed on the fore-deck, forward of the
  // cabin and a little to starboard of the centreline, where the reference
  // raft carries hers. Kept INBOARD of `station-sheet-s` (x = cabinWidth/2)
  // and clear of `station-halyard` at the mast foot: the fore-deck is the
  // raft's one big open floor and the chest must not close either road.
  const chestZ = L.cabinFrontZ + 0.6;
  out.push(box('plank-chest', 'crate',
    -0.10, -0.10 + p.chestLength, L.deckY, L.deckY + p.chestHeight,
    chestZ, chestZ + p.chestWidth, {
      rotation: [0, vjitter(0.12, p.seed, 88) * Math.max(0, shipDetailParams.irregularity), 0],
      shape: { lash: 2, lashRope: p.crateLashRope, seed: p.seed + 9 },
    }));

  // §B87 / ref §10 — THE SLACK-ROPE RAILING: short stanchions along each deck
  // edge with a rope thrown between them, sloppy, dipping in every span. It is
  // NOT a bulwark and it is deliberately NOT solid to the walker: §V85 says
  // the deck edge is a real edge you can step off and climb back at, so this
  // draws through the deck field's default (no case for `rope-rail`) and stops
  // nobody. One piece per side — posts and rope in one hemp-toned draw.
  for (const [side, sign] of [['port', -1], ['starboard', 1]] as const) {
    const outer = L.logs[sign < 0 ? 0 : L.logs.length - 1];
    const zA = L.cabinAftZ + 0.3;
    const zB = Math.min(outer.zBow - 0.7, L.cabinFrontZ + p.footRailLength * 0.45);
    out.push(
      mkPiece(`rail-${side}`, 'rope-rail', [outer.x - sign * outer.r * 0.3, L.logTopY, (zA + zB) / 2], {
        min: [-p.railPostDiameter / 2, 0, -(zB - zA) / 2],
        max: [p.railPostDiameter / 2, p.railHeight, (zB - zA) / 2],
      }, {
        shape: {
          posts: p.railPosts,
          postRadius: p.railPostDiameter / 2,
          rope: p.railRopeDiameter / 2,
          sag: p.railRopeSag,
          segments: 3,
          seed: p.seed + (sign > 0 ? 21 : 22),
        },
      }),
    );
  }

  // the wire aerial, aft gable → the bipod crossing [2100 dressing: "a wire
  // aerial to the masthead"]. It leaves the cabin at the ridge, where
  // `aerial-lead` brought it up from the set, and lands on the crossing the
  // stays are made fast at (`anchor-hounds-main`, i.e. `mastHeight` up).
  out.push(spanPiece('aerial-wire',
    [0, L.cabinFloorY + p.cabinRidge + 0.04, L.cabinAftZ + 0.02],
    [0, L.logTopY + p.mastHeight, L.mastZ],
    0.006, p.aerialSag, p.seed + 7, 5));
  return out;
}
