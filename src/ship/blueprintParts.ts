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
  return piece;
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
  }, { sockets });
}

/** 3 sections per side, each a damage-zone carrier (§V.14 targets). */
export function buildHullSections(
  p: ShipClassParams,
  opts: { hullCannons: boolean },
): PieceDef[] {
  const segLen = p.hullLength / 3;
  const t = p.hullThickness;
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
          position: [(sign * t) / 2, -0.4, 0],
        },
      ];
      if (opts.hullCannons) {
        seg.cannons.forEach((z, i) => {
          sockets.push({
            id: `cannon-${side}-${seg.first + i}`,
            type: 'cannon-mount',
            position: [(sign * t) / 2, p.cannonMountHeight, z],
          });
        });
      }
      pieces.push(
        mkPiece(`hull-${side}-${seg.name}`, 'hull-section',
          [sign * ((p.beam - t) / 2), 0, seg.zc],
          {
            min: [-t / 2, -p.draft, -segLen / 2],
            max: [t / 2, p.freeboard, segLen / 2],
          },
          { sockets, damageStates: HULL_STATES.map((s) => ({ ...s })) }),
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
    mkPiece('bow', 'bow', [0, 0, L2], {
      min: [-p.beam * 0.35, -p.draft, 0],
      max: [p.beam * 0.35, p.freeboard, p.bowLength],
    }, {
      sockets: [
        cleat('bow-port', [-p.beam * 0.15, p.freeboard + 0.05, p.bowLength * 0.25]),
        cleat('bow-starboard', [p.beam * 0.15, p.freeboard + 0.05, p.bowLength * 0.25]),
      ],
    }),
    mkPiece('transom', 'transom', [0, 0, -L2], {
      min: [-p.beam * 0.4, -p.draft * 0.6, -0.35],
      max: [p.beam * 0.4, p.freeboard, 0],
    }, {
      sockets: [
        cleat('stern-port', [-p.beam * 0.2, p.freeboard + 0.05, -0.1]),
        cleat('stern-starboard', [p.beam * 0.2, p.freeboard + 0.05, -0.1]),
      ],
    }),
  ];
}

/** Raised bow/stern works: forecastle, quarterdeck + cabin (stepped stern
 *  ~2 levels above main deck), gallery band, lantern posts. Galleon only. */
export function buildCastles(p: ShipClassParams): PieceDef[] {
  const L2 = p.hullLength / 2;
  const cabinLen = p.sterncastleLength * 0.5;
  const roofY = p.freeboard + p.sterncastleRise + p.cabinHeight;
  return [
    mkPiece('forecastle-deck', 'forecastle-deck',
      [0, p.freeboard + p.forecastleRise, L2 - p.forecastleLength / 2],
      {
        min: [-p.beam * 0.425, -p.deckThickness, -p.forecastleLength / 2],
        max: [p.beam * 0.425, 0, p.forecastleLength / 2],
      }),
    mkPiece('sterncastle-deck', 'sterncastle-deck',
      [0, p.freeboard + p.sterncastleRise, -(L2 - p.sterncastleLength / 2)],
      {
        min: [-p.beam * 0.475, -p.deckThickness, -p.sterncastleLength / 2],
        max: [p.beam * 0.475, 0, p.sterncastleLength / 2],
      },
      {
        sockets: [{
          id: 'socket-wheel',
          type: 'fixture',
          position: [0, 0.05, p.sterncastleLength / 2 - 0.4],
        }],
      }),
    mkPiece('cabin', 'cabin',
      [0, p.freeboard + p.sterncastleRise, -(L2 - cabinLen / 2 - 0.1)],
      {
        min: [-p.beam * 0.42, 0, -cabinLen / 2],
        max: [p.beam * 0.42, p.cabinHeight, cabinLen / 2],
      }),
    mkPiece('gallery', 'gallery',
      [0, p.freeboard + p.sterncastleRise + p.cabinHeight * 0.5, -(L2 + 0.15)],
      {
        min: [-p.beam * 0.38, -p.galleryHeight / 2, -0.12],
        max: [p.beam * 0.38, p.galleryHeight / 2, 0.12],
      }),
    mkPiece('lantern-post-port', 'lantern-post',
      [-p.beam * 0.32, roofY, -(L2 - 0.5)],
      { min: [-0.1, 0, -0.1], max: [0.1, p.lanternPostHeight, 0.1] }),
    mkPiece('lantern-post-starboard', 'lantern-post',
      [p.beam * 0.32, roofY, -(L2 - 0.5)],
      { min: [-0.1, 0, -0.1], max: [0.1, p.lanternPostHeight, 0.1] }),
  ];
}

export function buildRails(
  p: ShipClassParams,
  opts: { sternBalustrade: boolean },
): PieceDef[] {
  const len = p.hullLength * p.railLengthFactor;
  const t = p.railThickness;
  const pieces: PieceDef[] = [];
  for (const [side, sign] of [['port', -1], ['starboard', 1]] as const) {
    pieces.push(
      mkPiece(`rail-${side}`, 'rail',
        [sign * (p.beam / 2 - p.railInset), p.freeboard, 0],
        { min: [-t / 2, 0, -len / 2], max: [t / 2, p.railHeight, len / 2] }),
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
