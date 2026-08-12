/**
 * Shared blueprint part generators — keel, deck, cannons, hull sections.
 * Hull ends (stem/transom), rails and rudder live in blueprintEnds.ts.
 * §V.13: pieces + named sockets only, no meshes. Pure functions of params;
 * both ship classes compose these (§V.18 contract stays identical).
 */
import { shipDetailParams, type ShipClassParams } from '../params/ship';
import type { DamageStateDef, PieceDef, SocketDef, Vec3 } from './pieceTypes';
import { hullHalfWidthAt, hullTopY, type HullShape } from './hullMath';

export const BASIC_STATES: DamageStateDef[] = [{ id: 'intact' }, { id: 'destroyed' }];
export const HULL_STATES: DamageStateDef[] = [
  { id: 'intact' },
  { id: 'holed' },
  { id: 'destroyed' },
];

export function mkPiece(
  id: string,
  kind: PieceDef['kind'],
  position: Vec3,
  aabb: { min: Vec3; max: Vec3 },
  opts: {
    rotation?: Vec3;
    sockets?: SocketDef[];
    damageStates?: DamageStateDef[];
    parent?: string;
    sailStates?: PieceDef['sailStates'];
    shape?: Record<string, number>;
  } = {},
): PieceDef {
  const piece: PieceDef = {
    id,
    kind,
    transform: { position, rotation: opts.rotation ?? [0, 0, 0] },
    sockets: opts.sockets ?? [],
    damageStates: opts.damageStates ?? BASIC_STATES.map((s) => ({ ...s })),
    aabb,
  };
  if (opts.parent !== undefined) piece.parent = opts.parent;
  if (opts.sailStates !== undefined) piece.sailStates = opts.sailStates;
  if (opts.shape !== undefined) piece.shape = opts.shape;
  return piece;
}

/** hull-loft shape hints shared by hull sections / bow / deck (§V18 data) */
export function hullShapeHints(
  p: ShipClassParams,
  side: number,
  z0: number,
  z1: number,
): Record<string, number> {
  return {
    side,
    z0,
    z1,
    beamHalf: p.beam / 2,
    bowZ: p.hullLength / 2 + p.bowLength,
    sternZ: -p.hullLength / 2,
    draft: p.draft,
    freeboard: p.freeboard,
    sheerBow: p.sheerBow,
    sheerStern: p.sheerStern,
    tumblehome: p.tumblehome,
    keelPinch: p.keelPinch,
    // §T.34 arris work. Carried as SHAPE HINTS rather than read from params
    // inside the geometry builder, because pieceGeometryHull is documented as
    // a pure function of the piece's serializable hints (§V18 — an AI-generated
    // shell has to be able to drop in against the same data).
    bulwarkLip: shipDetailParams.bulwarkLip,
    railChamfer: shipDetailParams.railChamfer,
    irregularity: shipDetailParams.irregularity,
  };
}

/**
 * Where a figurehead mounts: on the STEM HEAD, under the bowsprit's root.
 *
 * `socket-figurehead` used to be declared 90% of the way out along the
 * bowsprit — that is the dolphin-striker station, not a figurehead's, and
 * nothing was mounted on it anyway. Shared by the socket (blueprintEnds) and
 * the piece that sits on it (blueprintDetail) so the two cannot drift.
 */
export function figureheadStation(p: ShipClassParams): { y: number; z: number } {
  const L2 = p.hullLength / 2;
  const z = L2 + p.bowLength * 0.72;
  const shape = hullShapeHints(p, 0, L2, L2 + p.bowLength) as unknown as HullShape;
  return { y: hullTopY(z, shape) - 0.55, z };
}

export function buildKeel(p: ShipClassParams): PieceDef {
  return mkPiece('keel', 'keel', [0, -p.draft, 0], {
    min: [-p.keelWidth / 2, -p.keelHeight, -p.hullLength / 2],
    max: [p.keelWidth / 2, 0, p.hullLength / 2],
  });
}

/** Main deck. Galleon guns are deck-mounted here; brigantine guns sit on hull. */
export function buildDeck(
  p: ShipClassParams,
  opts: { deckCannons: boolean; capstan: boolean },
): PieceDef {
  const sockets: SocketDef[] = [];
  if (opts.deckCannons) {
    for (const [side, sign] of [['port', -1], ['starboard', 1]] as const) {
      for (let i = 0; i < p.cannonsPerSide; i++) {
        const z = ((p.cannonsPerSide - 1) / 2 - i) * p.cannonSpacing;
        sockets.push({
          id: `cannon-${side}-${i + 1}`,
          type: 'cannon-mount',
          position: [sign * (p.beam / 2 - p.cannonInset), 0.05, z],
        });
      }
    }
  }
  if (opts.capstan) {
    sockets.push({
      id: 'socket-capstan',
      type: 'fixture',
      position: [0, 0.05, p.hullLength * 0.18],
    });
  }
  return mkPiece('deck', 'deck', [0, p.freeboard, 0], {
    min: [-p.beam / 2, -p.deckThickness, -p.hullLength / 2],
    max: [p.beam / 2, 0, p.hullLength / 2],
  }, {
    sockets,
    shape: hullShapeHints(p, 0, -p.hullLength / 2, p.hullLength / 2),
  });
}

/** greybox gun (barrel + carriage) per cannon-mount socket, parented to
 *  the socket's carrier and rotated to fire outboard */
export function buildCannons(host: PieceDef[]): PieceDef[] {
  const cannons: PieceDef[] = [];
  for (const piece of host) {
    for (const socket of piece.sockets) {
      if (socket.type !== 'cannon-mount') continue;
      const sign = socket.position[0] >= 0 ? 1 : -1;
      cannons.push(
        mkPiece(socket.id.replace('cannon-', 'gun-'), 'cannon',
          [socket.position[0], socket.position[1], socket.position[2]],
          { min: [-0.35, 0, -1.1], max: [0.35, 0.9, 1.3] },
          { parent: piece.id, rotation: [0, (sign * Math.PI) / 2, 0] }),
      );
    }
  }
  return cannons;
}

/** a mast whose shrouds need chainplates on the hull side abeam of it */
export interface ChannelStation {
  /** mast name — socket ids become `anchor-channel-{side}-{name}[-i]` */
  name: string;
  /** ship-space z of the mast */
  z: number;
  /**
   * Y of the DECK THE MAST IS STEPPED ON. Critical: the mizzen is stepped on
   * the quarterdeck (4.8 m), two metres above the main deck, so a chainplate
   * placed on the main shell's sheer line put its shrouds THROUGH the
   * quarterdeck — src/ropes had to drop the mizzen shrouds entirely. A
   * chainplate belongs on the deck its mast stands on.
   */
  baseY: number;
}

/** 3 sections per side, each a damage-zone carrier (§V.14 targets). */
export function buildHullSections(
  p: ShipClassParams,
  opts: { hullCannons: boolean; channels?: ChannelStation[] },
): PieceDef[] {
  const segLen = p.hullLength / 3;
  const bh = p.beam / 2;
  // + the proud rim (§T.34): the shell now carries above the sheer line, and
  // an AABB that stops at the sheer would clip it out of every damage-zone
  // and breach-sizing calculation that reads the box instead of the mesh
  const topY = p.freeboard + Math.max(p.sheerBow, p.sheerStern) + shipDetailParams.bulwarkLip;
  const segs = [
    { name: 'bow', zc: segLen, cannons: [0], first: 1 },
    { name: 'mid', zc: 0, cannons: [segLen / 4, -segLen / 4], first: 2 },
    { name: 'stern', zc: -segLen, cannons: [0], first: 4 },
  ] as const;
  const pieces: PieceDef[] = [];
  for (const [side, sign] of [['port', -1], ['starboard', 1]] as const) {
    for (const seg of segs) {
      const hints = hullShapeHints(p, sign, seg.zc - segLen / 2, seg.zc + segLen / 2);
      const sockets: SocketDef[] = [
        {
          id: `dz-hull-${side}-${seg.name}`,
          type: 'damage-zone',
          position: [sign * bh * 0.85, -0.4, 0],
        },
      ];
      // CHAINPLATES: real shroud landings just outboard of the deck edge
      // abeam of each mast, raked aft into a FAN (docs/ship-reference-
      // schema.png — one plate per mast gives one token shroud). src/ropes
      // used to derive these by interpolating the bow/stern cleats; a derived
      // point drifts inboard and the lines then run through the deck. Owned
      // by the section they sit on, so a blown-out hull section takes its
      // shrouds with it (§V13/§V14).
      for (const station of opts.channels ?? []) {
        if (station.z < seg.zc - segLen / 2 || station.z >= seg.zc + segLen / 2) continue;
        const shape = hints as unknown as HullShape;
        // the plate sits a cap-rail's depth below the deck the mast stands
        // on — never below the shell's own sheer line
        const y = Math.max(station.baseY, hullTopY(station.z, shape)) - 0.28;
        const plates = Math.max(1, Math.round(p.channelPlates));
        for (let i = 0; i < plates; i++) {
          const z = station.z - i * p.channelPlateSpacing; // fan rakes aft
          const x = sign * (hullHalfWidthAt(z, y, shape) + 0.06);
          sockets.push({
            id: `anchor-channel-${side}-${station.name}-${i + 1}`,
            type: 'rope-anchor',
            position: [x, y, z - seg.zc],
          });
        }
      }
      if (opts.hullCannons) {
        seg.cannons.forEach((z, i) => {
          sockets.push({
            id: `cannon-${side}-${seg.first + i}`,
            type: 'cannon-mount',
            position: [sign * bh * 0.92, p.cannonMountHeight, z],
          });
        });
      }
      pieces.push(
        // half-shell strip of the loft: piece origin on the centreline so
        // the curved shell lives in piece space (aabb covers the half hull)
        mkPiece(`hull-${side}-${seg.name}`, 'hull-section',
          [0, 0, seg.zc],
          {
            min: [sign < 0 ? -bh : 0, -p.draft, -segLen / 2],
            max: [sign < 0 ? 0 : bh, topY, segLen / 2],
          },
          {
            sockets,
            damageStates: HULL_STATES.map((s) => ({ ...s })),
            shape: hints,
          }),
      );
    }
  }
  return pieces;
}
