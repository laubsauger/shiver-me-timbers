/**
 * Shared blueprint part generators — hull, decks, stern works, rails.
 * §V.13: pieces + named sockets only, no meshes. Pure functions of params;
 * both ship classes compose these (§V.18 contract stays identical).
 */
import type { ShipClassParams } from '../params/ship';
import type { DamageStateDef, PieceDef, SocketDef, Vec3 } from './pieceTypes';

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
  };
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

/** 3 sections per side, each a damage-zone carrier (§V.14 targets). */
export function buildHullSections(
  p: ShipClassParams,
  opts: { hullCannons: boolean },
): PieceDef[] {
  const segLen = p.hullLength / 3;
  const bh = p.beam / 2;
  const topY = p.freeboard + Math.max(p.sheerBow, p.sheerStern);
  const segs = [
    { name: 'bow', zc: segLen, cannons: [0], first: 1 },
    { name: 'mid', zc: 0, cannons: [segLen / 4, -segLen / 4], first: 2 },
    { name: 'stern', zc: -segLen, cannons: [0], first: 4 },
  ] as const;
  const pieces: PieceDef[] = [];
  for (const [side, sign] of [['port', -1], ['starboard', 1]] as const) {
    for (const seg of segs) {
      const sockets: SocketDef[] = [
        {
          id: `dz-hull-${side}-${seg.name}`,
          type: 'damage-zone',
          position: [sign * bh * 0.85, -0.4, 0],
        },
      ];
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
            shape: hullShapeHints(p, sign, seg.zc - segLen / 2, seg.zc + segLen / 2),
          }),
      );
    }
  }
  return pieces;
}

export function buildBowAndTransom(p: ShipClassParams): PieceDef[] {
  const L2 = p.hullLength / 2;
  const cleat = (name: string, pos: Vec3): SocketDef => ({
    id: `anchor-cleat-${name}`,
    type: 'rope-anchor',
    position: pos,
  });
  return [
    // stem: continues the hull loft from the sections' end to the point
    mkPiece('bow', 'bow', [0, 0, L2], {
      min: [-p.beam * 0.35, -p.draft, 0],
      max: [p.beam * 0.35, p.freeboard + p.sheerBow, p.bowLength],
    }, {
      sockets: [
        cleat('bow-port', [-p.beam * 0.15, p.freeboard + 0.05, p.bowLength * 0.25]),
        cleat('bow-starboard', [p.beam * 0.15, p.freeboard + 0.05, p.bowLength * 0.25]),
      ],
      shape: hullShapeHints(p, 0, L2, L2 + p.bowLength),
    }),
    // transom plate matches the rounded-in stern envelope (~55% beam)
    mkPiece('transom', 'transom', [0, 0, -L2], {
      min: [-p.beam * 0.29, -p.draft * 0.6, -0.35],
      max: [p.beam * 0.29, p.freeboard + p.sheerStern, 0],
    }, {
      sockets: [
        cleat('stern-port', [-p.beam * 0.2, p.freeboard + 0.05, -0.1]),
        cleat('stern-starboard', [p.beam * 0.2, p.freeboard + 0.05, -0.1]),
      ],
    }),
  ];
}

export function buildRails(
  p: ShipClassParams,
  opts: { sternBalustrade: boolean },
): PieceDef[] {
  const len = p.hullLength * p.railLengthFactor;
  const t = p.railThickness;
  const maxSheer = Math.max(p.sheerBow, p.sheerStern);
  const pieces: PieceDef[] = [];
  for (const [side, sign] of [['port', -1], ['starboard', 1]] as const) {
    // origin on the centreline: the run curves with taper + sheer (hints)
    pieces.push(
      mkPiece(`rail-${side}`, 'rail',
        [0, p.freeboard, 0],
        {
          min: [sign < 0 ? -p.beam / 2 : t, 0, -len / 2],
          max: [sign < 0 ? -t : p.beam / 2, p.railHeight + maxSheer, len / 2],
        },
        {
          shape: {
            ...hullShapeHints(p, sign, -len / 2, len / 2),
            railInset: p.railInset,
          },
        }),
    );
  }
  if (opts.sternBalustrade) {
    pieces.push(
      mkPiece('balustrade-stern', 'rail',
        [0, p.freeboard + p.sterncastleRise + p.cabinHeight, -(p.hullLength / 2 - 0.6)],
        {
          min: [-p.beam * 0.35, 0, -t / 2],
          max: [p.beam * 0.35, p.railHeight, t / 2],
        }),
    );
  }
  return pieces;
}

export function buildRudder(p: ShipClassParams): PieceDef {
  return mkPiece('rudder', 'rudder', [0, -0.6, -(p.hullLength / 2 + 0.15)], {
    min: [-p.rudderThickness / 2, -p.rudderHeight / 2, -p.rudderChord],
    max: [p.rudderThickness / 2, p.rudderHeight / 2, 0],
  });
}
