/**
 * Rig blueprint generators — masts, yards, sails, crow's nest, bowsprit.
 * §V.13: masts are detachable subtree roots; yards/sails/crow-nest declare
 * `parent` so a mast break (§V.14) carries them along. Rope anchors at
 * mastheads/yard ends/bowsprit tip are the §V.12 catenary endpoints.
 */
import type { ShipClassParams } from '../params/ship';
import type { PieceDef, SailStateDef, SocketDef } from './pieceTypes';
import { mkPiece } from './blueprintParts';

export type MastName = 'fore' | 'main' | 'rear';

const SAIL_STATES: SailStateDef[] = [{ id: 'furled' }, { id: 'reefed' }, { id: 'full' }];

/** One mast with two yards; optional sail per yard, optional crow's nest. */
export function buildMastRig(
  p: ShipClassParams,
  name: MastName,
  z: number,
  height: number,
  baseY: number,
  opts: { sails: boolean; crowNest: boolean },
): PieceDef[] {
  const mastId = `mast-${name}`;
  const r = p.mastRadius;
  const pieces: PieceDef[] = [
    mkPiece(mastId, 'mast', [0, baseY, z], {
      min: [-r, 0, -r],
      max: [r, height, r],
    }, {
      sockets: [{
        id: `anchor-masthead-${name}`,
        type: 'rope-anchor',
        position: [0, height, 0],
      }],
    }),
  ];

  const levels = [
    { level: 'lower', frac: p.yardLowerFrac, lenF: p.yardLowerLenFactor, dropF: p.sailDropLowerFactor },
    { level: 'upper', frac: p.yardUpperFrac, lenF: p.yardUpperLenFactor, dropF: p.sailDropUpperFactor },
  ] as const;
  for (const { level, frac, lenF, dropF } of levels) {
    const yardId = `yard-${name}-${level}`;
    const len = height * lenF;
    const yr = p.yardRadius;
    const ends: SocketDef[] = [
      { id: `anchor-${yardId}-port`, type: 'rope-anchor', position: [-len / 2, 0, 0] },
      { id: `anchor-${yardId}-starboard`, type: 'rope-anchor', position: [len / 2, 0, 0] },
    ];
    pieces.push(
      mkPiece(yardId, 'yard', [0, height * frac, 0], {
        min: [-len / 2, -yr, -yr],
        max: [len / 2, yr, yr],
      }, { parent: mastId, sockets: ends }),
    );
    if (opts.sails) {
      pieces.push(
        mkPiece(`sail-${name}-${level}`, 'sail', [0, 0, 0], {
          min: [-len * 0.46, -height * dropF, -0.5],
          max: [len * 0.46, 0.15, 0.5],
        }, {
          parent: yardId,
          sailStates: SAIL_STATES.map((s) => ({ ...s })),
        }),
      );
    }
  }

  if (opts.crowNest && p.crowNestRadius > 0) {
    const cr = p.crowNestRadius;
    pieces.push(
      mkPiece('crow-nest', 'crow-nest', [0, height * p.crowNestFrac, 0], {
        min: [-cr, 0, -cr],
        max: [cr, p.crowNestHeight, cr],
      }, {
        parent: mastId,
        sockets: [
          { id: 'anchor-crow-nest', type: 'rope-anchor', position: [0, p.crowNestHeight, 0] },
          { id: 'socket-lookout', type: 'fixture', position: [0, 0.1, 0] },
        ],
      }),
    );
  }
  return pieces;
}

/** Bowsprit: local +y runs along the spar; pitched up from the bow. */
export function buildBowsprit(
  p: ShipClassParams,
  opts: { figurehead: boolean },
): PieceDef {
  const r = p.bowspritRadius;
  const len = p.bowspritLength;
  const sockets: SocketDef[] = [
    { id: 'anchor-bowsprit-tip', type: 'rope-anchor', position: [0, len, 0] },
  ];
  if (opts.figurehead) {
    sockets.push({
      id: 'socket-figurehead',
      type: 'fixture',
      position: [0, len * 0.9, 0],
    });
  }
  return mkPiece('bowsprit', 'bowsprit',
    [0, p.freeboard + p.forecastleRise + 0.2, p.hullLength / 2 + p.bowLength * 0.5],
    { min: [-r, 0, -r], max: [r, len, r] },
    { rotation: [Math.PI / 2 - p.bowspritPitch, 0, 0], sockets });
}
