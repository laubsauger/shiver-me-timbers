/**
 * Raft rig — bipod mast, lookout platform, ladder, topsail pole, yards,
 * sails, mizzen, flag pole [§4].
 *
 * WHY THE POLE ABOVE THE CROSSING IS KIND `mast` (id `mast-main`): the
 * rigging plan (src/ropes/shipRigging) and the §T85 sail membrane address a
 * sail through `mast-{m}` → `yard-{m}-{level}` → `sail-{m}-{level}` ids and
 * `anchor-masthead-{m}` / `anchor-channel-{side}-{m}-1` sockets. Giving the
 * topsail pole that identity — positioned at DECK level with its aabb starting
 * at the crossing, so the pole is drawn only above the crossing and the plan's
 * stepped-deck check still sees a deck-stepped mast — lets the yards, sails,
 * sheets, braces, buntlines and lifts generate UNCHANGED. The two legs are
 * `bipod-mast` and carry no rigging identity of their own; the plan ignores
 * them, which is what "ratlines 0" needs.
 */
import type { RaftParams } from '../params/raft';
import type { PieceDef, SailStateDef, SocketDef } from './pieceTypes';
import { mkPiece } from './blueprintParts';
import { SAIL_ANCHOR_UV } from './sailShape';
import { FLAG_STYLE_JOLLY } from './flagMaterial';
import type { RaftLayout } from './raftPartsLayout';

const SAIL_STATES: SailStateDef[] = [{ id: 'furled' }, { id: 'reefed' }, { id: 'full' }];

/** a yard on a mast piece (parent-relative y) + its sail, same contract as blueprintRig */
function yardAndSail(
  p: RaftParams,
  mast: string,
  level: string,
  y: number,
  len: number,
  yr: number,
  mastR: number,
  sailWidth: number,
  sailDrop: number,
): PieceDef[] {
  const yardId = `yard-${mast}-${level}`;
  const sailId = `sail-${mast}-${level}`;
  const ends: SocketDef[] = [
    { id: `anchor-${yardId}-port`, type: 'rope-anchor', position: [-len / 2, 0, 0] },
    { id: `anchor-${yardId}-starboard`, type: 'rope-anchor', position: [len / 2, 0, 0] },
  ];
  const yard = mkPiece(yardId, 'yard', [0, y, mastR + yr + p.yardMastClearance], {
    min: [-len / 2, -yr, -yr],
    max: [len / 2, yr, yr],
  }, { parent: `mast-${mast}`, sockets: ends, shape: { doubled: 1 } });
  const clothSockets: SocketDef[] = Object.entries(SAIL_ANCHOR_UV).map(([suffix, [u, v]]) => ({
    id: `anchor-${sailId}-${suffix}`,
    type: 'rope-anchor' as const,
    position: [(u - 0.5) * sailWidth, -(1 - v) * sailDrop, 0] as [number, number, number],
    cloth: [u, v] as [number, number],
  }));
  const sail = mkPiece(sailId, 'sail', [0, -yr, p.sailYardOffset], {
    min: [-sailWidth / 2, -sailDrop, -0.5],
    max: [sailWidth / 2, 0.15, 0.5],
  }, { parent: yardId, sockets: clothSockets, sailStates: SAIL_STATES.map((s) => ({ ...s })) });
  return [yard, sail];
}

export function buildBipodMast(p: RaftParams, L: RaftLayout): PieceDef[] {
  const out: PieceDef[] = [];
  const legR = p.mastLegDiameter / 2;
  const halfSpan = p.mastLegSpacing / 2;
  const lean = Math.atan2(halfSpan, p.mastHeight);
  const legLen = Math.hypot(halfSpan, p.mastHeight) + p.mastCrossingOverlap;
  // two legs stepped through the deck onto the logs, leaning to the crossing
  for (const [side, sign] of [['port', -1], ['starboard', 1]] as const) {
    const sockets: SocketDef[] = side === 'starboard'
      ? [{ id: 'station-ladder', type: 'fixture', position: [0.45, 0, 0.3] }]
      : [];
    out.push(
      mkPiece(`bipod-leg-${side}`, 'bipod-mast', [sign * halfSpan, L.logTopY, L.mastZ], {
        min: [-legR, 0, -legR],
        max: [legR, legLen, legR],
      }, {
        // rotation about z by +θ tips a +y pole toward −x, so the PORT leg
        // (sign −1) takes −lean to reach the centreline
        rotation: [0, 0, sign * lean],
        sockets,
        shape: { taper: 0.8, sides: 10 },
      }),
    );
  }
  // rope ladder with wooden rungs up the starboard leg [§4 Masthead]
  out.push(
    mkPiece('mast-ladder', 'bipod-mast', [0.3, 0.4, 0], {
      min: [-p.ladderWidth / 2, 0, -0.04],
      max: [p.ladderWidth / 2, legLen - p.mastCrossingOverlap - 1.2, 0.04],
    }, { parent: 'bipod-leg-starboard', shape: { ladder: 1, rungPitch: p.ladderRungPitch } }),
  );

  // the topsail pole = the rig's `mast-main` (see header). Stepped at deck
  // level, drawn from the crossing up.
  const poleR = legR * 0.8;
  const crossing = p.mastHeight;
  const top = crossing + p.topPoleHeight;
  out.push(
    mkPiece('mast-main', 'mast', [0, L.logTopY, L.mastZ], {
      min: [-poleR, crossing, -poleR],
      max: [poleR, top, poleR],
    }, {
      sockets: [
        { id: 'anchor-masthead-main', type: 'rope-anchor', position: [0, top, 0] },
        // stays and guys are made fast at the CROSSING, not the pole tip
        { id: 'anchor-hounds-main', type: 'rope-anchor', position: [0, crossing, 0] },
      ],
    }),
  );
  // lookout platform at the crossing [§4 Masthead]
  const ps = p.platformSize / 2;
  out.push(
    mkPiece('lookout-platform', 'bamboo-deck', [0, crossing, 0], {
      min: [-ps, 0, -ps],
      max: [ps, p.platformThickness, ps],
    }, {
      parent: 'mast-main',
      shape: { platform: 1 },
      sockets: [{ id: 'station-lookout', type: 'fixture', position: [0, p.platformThickness, 0] }],
    }),
  );
  const yr = p.yardDiameter / 2;
  // main yard hoisted below the crossing; the legs are ~legR apart there so
  // the yard clears them on the leg radius
  out.push(...yardAndSail(p, 'main', 'lower', p.mainYardHeight, p.yardLength, yr, legR, p.mainSailWidth, p.mainSailDrop));
  // small topsail on the pole above the crossing [§4 Topsail]
  out.push(...yardAndSail(p, 'main', 'upper', crossing + p.topsailHeightAboveCrossing,
    p.topsailYardLength, yr * 0.6, poleR, p.topsailWidth, p.topsailDrop));
  return out;
}

/** short mizzen pole + small square sail, and the tall thin flag pole [§4 Mizzen] */
export function buildMizzenAndFlag(p: RaftParams, L: RaftLayout): PieceDef[] {
  const out: PieceDef[] = [];
  const mr = p.mizzenDiameter / 2;
  out.push(
    mkPiece('mast-mizzen', 'mast', [p.mizzenX, L.logTopY, p.mizzenZ], {
      min: [-mr, 0, -mr],
      max: [mr, p.mizzenHeight, mr],
    }, {
      sockets: [{ id: 'anchor-masthead-mizzen', type: 'rope-anchor', position: [0, p.mizzenHeight, 0] }],
    }),
  );
  const yr = p.yardDiameter * 0.3;
  out.push(...yardAndSail(p, 'mizzen', 'lower', p.mizzenHeight - 0.35, p.mizzenYardLength, yr, mr,
    p.mizzenSailWidth, p.mizzenSailDrop));

  const fr = p.flagpoleDiameter / 2;
  out.push(
    mkPiece('flagpole', 'bipod-mast', [p.flagpoleX, L.logTopY, p.mizzenZ], {
      min: [-fr, 0, -fr],
      max: [fr, p.flagpoleHeight, fr],
    }, { shape: { taper: 0.7, sides: 8 } }),
  );
  out.push(
    mkPiece('flag-stern', 'pennant', [0, p.flagpoleHeight - 0.05, 0], {
      min: [0, -p.flagHoist, -0.1],
      max: [p.flagFly, 0.1, 0.1],
    }, {
      parent: 'flagpole',
      shape: { fly: p.flagFly, hoist: p.flagHoist, style: FLAG_STYLE_JOLLY, taper: 0, headY: 0, staff: 0 },
    }),
  );
  return out;
}
