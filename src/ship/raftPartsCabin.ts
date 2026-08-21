/**
 * Raft cabin + 2100 dressing — woven walls, gable ends, thatch, floor mats
 * over the box layer, and the crates/drum/dinghy/cage set as simple boxes.
 * The STARBOARD wall is open for ~1.4 m mid-to-aft: the only door [§3 Opening].
 */
import type { RaftParams } from '../params/raft';
import type { PieceDef, SocketDef } from './pieceTypes';
import { mkPiece } from './blueprintParts';
import type { RaftLayout } from './raftPartsLayout';

function box(
  id: string,
  kind: PieceDef['kind'],
  x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
  opts: { sockets?: SocketDef[]; shape?: Record<string, number>; rotation?: [number, number, number] } = {},
): PieceDef {
  return mkPiece(id, kind, [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], {
    min: [-(x1 - x0) / 2, -(y1 - y0) / 2, -(z1 - z0) / 2],
    max: [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2],
  }, opts);
}

/** roof pitch: eave → ridge over the half-width (outer wall face) */
export function roofSlope(p: RaftParams): number {
  return Math.atan2(p.cabinRidge - p.cabinEave, p.cabinWidth / 2);
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
  out.push(box('cabin-floor', 'bamboo-deck', -hw + t, hw - t, base, L.cabinFloorY, z0 + t, z1 - t, {
    shape: { boxes: 1 },
    sockets: [
      // radio corner: port-aft, behind its partition [§3 Radio corner]
      { id: 'station-radio', type: 'fixture', position: [-hw + 0.4, floorHalfH, -floorLen / 2 + 0.4] },
      // chart table against the starboard wall, forward of the door
      { id: 'station-chart', type: 'fixture', position: [hw - 0.4, floorHalfH, (p.cabinOpeningAftOffset + p.cabinOpeningLength + 0.35) - floorLen / 2] },
      // sleeping mat, fore-aft along the port side [§3 Floor]
      { id: 'station-mat', type: 'fixture', position: [-hw + 0.6, floorHalfH, 0.3] },
    ],
  }));

  // WALLS — thin woven panels; the material does the weave (§T90)
  out.push(box('cabin-wall-port', 'cabin-wall', -hw, -hw + t, base, eaveY, z0, z1));
  const openZ0 = z0 + p.cabinOpeningAftOffset;
  const openZ1 = openZ0 + p.cabinOpeningLength;
  out.push(box('cabin-wall-starboard-aft', 'cabin-wall', hw - t, hw, base, eaveY, z0, openZ0));
  out.push(box('cabin-wall-starboard-fwd', 'cabin-wall', hw - t, hw, base, eaveY, openZ1, z1));
  // gable ends: wall height + the triangle up to the ridge [§3 Museum: gable ends woven]
  const rise = ridgeY - eaveY;
  for (const [name, za, zb] of [['aft', z0, z0 + t], ['fwd', z1 - t, z1]] as const) {
    out.push(box(`cabin-wall-${name}`, 'cabin-wall', -hw, hw, base, ridgeY, za, zb, {
      shape: { gable: rise },
    }));
  }

  // THATCH ROOF: two slabs meeting at the ridge, overhanging by roofOverhang
  // on every side [§3 Roof]
  const slope = roofSlope(p);
  const run = hw + p.roofOverhang;
  const slabLen = run / Math.cos(slope);
  const roofZLen = p.cabinLength + 2 * p.roofOverhang;
  for (const [side, sign] of [['port', -1], ['starboard', 1]] as const) {
    const eaveTipY = ridgeY - run * Math.tan(slope);
    out.push(
      mkPiece(`thatch-roof-${side}`, 'thatch-roof',
        [sign * run / 2, (ridgeY + eaveTipY) / 2, (z0 + z1) / 2], {
          min: [-slabLen / 2, 0, -roofZLen / 2],
          max: [slabLen / 2, p.roofThickness, roofZLen / 2],
        }, { rotation: [0, 0, -sign * slope], shape: { overhang: p.roofOverhang } }),
    );
  }
  return out;
}

/** 2100 dressing as boxes first (§T89). Positions per [§6]; sizes EST. */
export function buildDressing(p: RaftParams, L: RaftLayout): PieceDef[] {
  const hw = p.cabinWidth / 2;
  const cw = p.crateWidth;
  const out: PieceDef[] = [];
  const y0 = L.crossbeamTopY;
  // crates along the PORT cabin wall [§6]
  const crateX1 = -hw - 0.03;
  for (let k = 0; k < 3; k++) {
    const zc = L.cabinFrontZ - 0.35 - k * (cw + 0.05);
    out.push(box(`crate-${k + 1}`, 'crate', crateX1 - cw, crateX1, y0, y0 + p.crateHeight, zc - cw / 2, zc + cw / 2));
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
  // rain drum at the cabin's starboard-aft corner, on the bare logs (2100)
  const dr = p.drumDiameter / 2;
  out.push(box('rain-drum', 'crate', hw + 0.05, hw + 0.05 + 2 * dr, L.logTopY, L.logTopY + p.drumHeight,
    L.cabinAftZ - 0.05 - 2 * dr, L.cabinAftZ - 0.05, { shape: { round: 1 } }));
  // empty parrot cage hung under the roof, inside [§6]
  const cs = p.cageSize;
  const cageTop = L.cabinFloorY + p.cabinEave - 0.05;
  out.push(box('cage', 'crate', 0.3, 0.3 + cs, cageTop - cs, cageTop, L.cabinFrontZ - 1.2, L.cabinFrontZ - 1.2 + cs, {
    shape: { cage: 1 },
  }));
  // kitchen box on the starboard strip, aft of the door, in the lee [§3 Outside door]
  const ks = p.kitchenBoxSize;
  const kz1 = L.cabinAftZ + p.cabinOpeningAftOffset - 0.1;
  out.push(box('kitchen-box', 'crate', hw + 0.1, hw + 0.1 + ks, L.deckY, L.deckY + ks * 0.8, kz1 - ks, kz1));
  return out;
}
