/**
 * Hull-end + fitting blueprint generators: stem, transom, rails, rudder.
 * Split out of blueprintParts.ts at the file cap (§C). §V.13: pieces +
 * named sockets only, pure functions of params (§V.16).
 */
import type { ShipClassParams } from '../params/ship';
import type { PieceDef, SocketDef, Vec3 } from './pieceTypes';
import { hullShapeHints, mkPiece } from './blueprintParts';
import { hullEnvelope, hullHalfWidthAt, hullTopY, type HullShape } from './hullMath';

export function buildBowAndTransom(p: ShipClassParams): PieceDef[] {
  const L2 = p.hullLength / 2;
  // widest point of the shell's aft section — the transom can never be
  // wider than the hull it caps (that was the panel poking out astern)
  const sternHints = hullShapeHints(p, 0, -L2, -L2) as unknown as HullShape;
  const sternHalf = (p.beam / 2) * hullEnvelope(-L2, sternHints); // widest section
  const cleat = (name: string, pos: Vec3): SocketDef => ({
    id: `anchor-cleat-${name}`,
    type: 'rope-anchor',
    position: pos,
  });
  // BOW CLEATS: knightheads standing ~0.5 m proud of the beakhead sheer.
  // They used to sit at plain freeboard height and ±0.15 beam, which at the
  // stem is BELOW the sheer line and OUTSIDE the narrowed envelope — buried
  // in the planking, so bobstays and sheets speared through the hull. The
  // height matters as much as the station: a line belayed level with the rail
  // sags straight back into the timber (src/ropes measures exactly that).
  const bowHints = hullShapeHints(p, 0, L2, L2 + p.bowLength) as unknown as HullShape;
  const bowZ = L2 + p.bowLength * 0.22;
  const bowDeckY = hullTopY(bowZ, bowHints) + 0.5;
  const bowCleatX = hullHalfWidthAt(bowZ, bowDeckY, bowHints) * 0.55;
  // STERN CLEATS: on the TAFFRAIL — the rail across the highest stern works
  // (cabin roof on a galleon, the transom head on a class without castles).
  // They used to sit on the transom's outer face below the rail, and then on
  // the quarterdeck INSIDE the cabin block: both are solid geometry.
  const sternCleatZ = -(L2 - 0.6);
  const sternDeckY =
    Math.max(
      hullTopY(sternCleatZ, sternHints),
      p.freeboard + p.sterncastleRise + p.cabinHeight,
    ) + 0.12;
  const sternCleatX = hullHalfWidthAt(sternCleatZ, sternDeckY, sternHints) * 0.72;
  return [
    // stem: continues the hull loft from the sections' end to the point
    mkPiece('bow', 'bow', [0, 0, L2], {
      min: [-p.beam * 0.35, -p.draft, 0],
      max: [p.beam * 0.35, p.freeboard + p.sheerBow, p.bowLength],
    }, {
      sockets: [
        cleat('bow-port', [-bowCleatX, bowDeckY, bowZ - L2]),
        cleat('bow-starboard', [bowCleatX, bowDeckY, bowZ - L2]),
      ],
      shape: hullShapeHints(p, 0, L2, L2 + p.bowLength),
    }),
    // transom: lofted cap on the shell's own aft section, carried up to the
    // castle deck so the counter is closed (§V22 "back is not fully closed")
    mkPiece('transom', 'transom', [0, 0, -L2], {
      min: [-sternHalf, -p.draft, -p.transomCrown],
      max: [sternHalf, p.freeboard + p.sheerStern + p.sterncastleRise, 0],
    }, {
      sockets: [
        cleat('stern-port', [-sternCleatX, sternDeckY, sternCleatZ + L2]),
        cleat('stern-starboard', [sternCleatX, sternDeckY, sternCleatZ + L2]),
      ],
      shape: {
        ...hullShapeHints(p, 0, -L2, -L2),
        counterRise: p.sterncastleRise,
        crown: p.transomCrown,
      },
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
    const L2 = p.hullLength / 2;
    const hints = hullShapeHints(p, 0, -L2, -L2) as unknown as HullShape;
    const roofY = p.freeboard + p.sterncastleRise + p.cabinHeight;
    // runs across the cabin roof: never wider than the stern under it
    const half = hullHalfWidthAt(-(L2 - 0.6), roofY, hints) * 0.86;
    pieces.push(
      mkPiece('balustrade-stern', 'rail',
        [0, roofY, -(L2 - 0.6)],
        {
          min: [-half, 0, -t / 2],
          max: [half, p.railHeight, t / 2],
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
