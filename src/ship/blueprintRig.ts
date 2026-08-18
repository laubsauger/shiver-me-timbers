/**
 * Rig blueprint generators — masts, yards, sails, crow's nest, bowsprit.
 * §V.13: masts are detachable subtree roots; yards/sails/crow-nest declare
 * `parent` so a mast break (§V.14) carries them along. Rope anchors at
 * mastheads/yard ends/bowsprit tip are the §V.12 catenary endpoints.
 */
import type { ShipClassParams } from '../params/ship';
import type { PieceDef, SailStateDef, SocketDef } from './pieceTypes';
import { mkPiece } from './blueprintParts';
import { SAIL_ANCHOR_UV } from './sailShape';

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

  /**
   * TIERS, bottom-up: course, topsail, topgallant.
   *
   * The third tier is here because two could not answer the user's standing
   * note that the rig is "on the mast-heavy side" and "the bottom stages are
   * just not long enough". That is a MEASURED ceiling, not a preference: the
   * sails owner took `sailDropLowerFactor` to 0.26 and found the wall at ~0.27,
   * where the rear course's clew drops far enough that its sheet to the stern
   * cleat passes through the hull at full brace (bisected: 0.26 passes, 0.28
   * fails). Lengthening the topsail instead fails sooner, at 0.19, via the
   * main topsail's sheet to the chainplates. The sheets foul the hull before
   * the canvas can reach the reference, so more tiers is the only route left.
   *
   * EVERYTHING DOWNSTREAM GENERATES FROM THIS ARRAY — yards, sails, clew and
   * bunt sockets, sail states, and (through the piece ids) the rigging's
   * lifts, braces and sheets. Adding a tier is one entry plus its three
   * params; nothing else in the ship knows how many tiers there are. Keeping
   * that true is the point, so resist special-casing a level ANYWHERE by name.
   *
   * Names stay positional rather than becoming course/topsail/topgallant
   * throughout: `lower` and `upper` are baked into piece ids that rope anchors
   * and several tests address by string, and renaming them would be churn for
   * no behaviour. `topgallant` joins them as the real term for the third.
   */
  const levels = [
    { level: 'lower', frac: p.yardLowerFrac, lenF: p.yardLowerLenFactor, dropF: p.sailDropLowerFactor },
    { level: 'upper', frac: p.yardUpperFrac, lenF: p.yardUpperLenFactor, dropF: p.sailDropUpperFactor },
    {
      level: 'topgallant',
      frac: p.yardTopgallantFrac,
      lenF: p.yardTopgallantLenFactor,
      dropF: p.sailDropTopgallantFactor,
    },
  ] as const;
  for (const { level, frac, lenF, dropF } of levels) {
    const yardId = `yard-${name}-${level}`;
    const len = height * lenF;
    // EVERY YARD IS SIZED BY ITS OWN LENGTH (§V.66, `yardSlenderness`). One
    // shared metre value made a 4.41 m topgallant yard as thick as a 13.23 m
    // course, which is the tell the user picked up on.
    const yr = len / (2 * Math.max(1, p.yardSlenderness));
    // yards ride FORWARD of their mast (real square rig, and §V22 critique:
    // "the yard shouldn't go through the mast, the sail shouldn't cut into
    // it"). Socket ids are unchanged — only their world station moves. Inside
    // the loop, because the stand-off is the YARD's own radius: a thin
    // topgallant yard sits closer to its mast than a course does.
    const yardZ = r + yr + p.yardMastClearance;
    const ends: SocketDef[] = [
      { id: `anchor-${yardId}-port`, type: 'rope-anchor', position: [-len / 2, 0, 0] },
      { id: `anchor-${yardId}-starboard`, type: 'rope-anchor', position: [len / 2, 0, 0] },
    ];
    pieces.push(
      mkPiece(yardId, 'yard', [0, height * frac, yardZ], {
        min: [-len / 2, -yr, -yr],
        max: [len / 2, yr, yr],
      }, { parent: mastId, sockets: ends }),
    );
    if (opts.sails) {
      const sailId = `sail-${name}-${level}`;
      const sailWidth = len * 0.92;
      const sailDrop = height * dropF;
      // ANCHORS SEWN TO THE CANVAS. src/ropes previously had to start its
      // sheet run at the yard END because no clew sockets existed — its own
      // header said "adapt when the ship system adds clew anchors" — and the
      // user spotted the result: a sail with nothing at its lower corners
      // looks unattached. `position` is the flat station, `cloth` is the uv
      // the live position is evaluated at (sailShape.ts).
      const clothSockets: SocketDef[] = Object.entries(SAIL_ANCHOR_UV).map(
        ([suffix, [u, v]]) => ({
          id: `anchor-${sailId}-${suffix}`,
          type: 'rope-anchor' as const,
          position: [(u - 0.5) * sailWidth, -(1 - v) * sailDrop, 0] as [number, number, number],
          cloth: [u, v] as [number, number],
        }),
      );
      pieces.push(
        mkPiece(sailId, 'sail', [0, -yr, p.sailYardOffset], {
          min: [-len * 0.46, -sailDrop, -0.5],
          max: [len * 0.46, 0.15, 0.5],
        }, {
          parent: yardId,
          sockets: clothSockets,
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
export function buildBowsprit(p: ShipClassParams): PieceDef {
  const r = p.bowspritRadius;
  const len = p.bowspritLength;
  const sockets: SocketDef[] = [
    { id: 'anchor-bowsprit-tip', type: 'rope-anchor', position: [0, len, 0] },
  ];
  // NOTE: `socket-figurehead` used to live here, 90% of the way out the spar.
  // A figurehead belongs on the STEM HEAD, so the socket moved to the bow
  // piece (blueprintParts.figureheadStation) and now actually carries a piece.
  // base sits inboard on the fore deck so the spar visibly roots in the
  // ship and runs out over the stem — no floating joint
  return mkPiece('bowsprit', 'bowsprit',
    [0, p.freeboard + p.forecastleRise * 0.6 + 0.15, p.hullLength / 2 - 1.2],
    { min: [-r, 0, -r], max: [r, len, r] },
    { rotation: [Math.PI / 2 - p.bowspritPitch, 0, 0], sockets });
}
