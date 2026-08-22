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
import type { PieceDef, SailStateDef, SocketDef, Vec3 } from './pieceTypes';
import { mkPiece } from './blueprintParts';
import { SAIL_ANCHOR_UV } from './sailShape';
import { FLAG_STYLE_NORWAY } from './flagMaterial';
import type { RaftLayout } from './raftPartsLayout';
import { shipDetailParams } from '../params/ship';
import { vhash, vjitter } from './variation';

/**
 * §B73 — a yard on this raft is never square to its mast. Seeded off the
 * yard's own key so the main, topsail and mizzen each hang differently, and
 * scaled by the ship-wide `irregularity` dial (§T34) so one knob still zeros
 * it. Cock is never zero at irregularity 1: magnitude ½..1 of the bound, sign
 * by hash — a yard that happens to hang dead level is the one thing the 1947
 * photo never shows.
 */
export function yardAttitude(p: RaftParams, key: number, sprit = 0): { cock: number; rake: number; slew: number; offset: number } {
  const irr = Math.max(0, shipDetailParams.irregularity);
  const sign = vhash(key, 2) < 0.5 ? -1 : 1;
  return {
    cock: (sprit + p.yardCock * (0.5 + 0.5 * vhash(key, 1)) * sign) * irr,
    rake: p.yardRake * (0.5 + 0.5 * vhash(key, 3)) * irr,
    slew: vjitter(p.yardSlew, key, 4) * irr,
    offset: vjitter(p.yardOffset, key, 5) * irr,
  };
}

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
  key: number,
  sprit = 0,
  furlDrop = 0,
  gap = p.yardMastClearance,
): PieceDef[] {
  const yardId = `yard-${mast}-${level}`;
  const sailId = `sail-${mast}-${level}`;
  const att = yardAttitude(p, key, sprit);
  const ends: SocketDef[] = [
    { id: `anchor-${yardId}-port`, type: 'rope-anchor', position: [-len / 2, 0, 0] },
    { id: `anchor-${yardId}-starboard`, type: 'rope-anchor', position: [len / 2, 0, 0] },
  ];
  // rotation about +x by +rake tips the hanging canvas (−y) aft, i.e. the
  // head leads the foot forward; +z cock lifts the STARBOARD arm
  const yard = mkPiece(yardId, 'yard', [att.offset, y, mastR + yr + gap], {
    min: [-len / 2, -yr, -yr],
    max: [len / 2, yr, yr],
  }, {
    parent: `mast-${mast}`,
    sockets: ends,
    // §B86-3: how far this yard comes down its halyard when the sail is in
    // (ShipAssembly.setYardHoist); 0 = it stays where it is hoisted
    shape: { doubled: 1, hoistDrop: furlDrop },
    rotation: [att.rake, att.slew, att.cock],
  });
  const clothSockets: SocketDef[] = Object.entries(SAIL_ANCHOR_UV).map(([suffix, [u, v]]) => ({
    id: `anchor-${sailId}-${suffix}`,
    type: 'rope-anchor' as const,
    position: [(u - 0.5) * sailWidth, -(1 - v) * sailDrop, 0] as [number, number, number],
    cloth: [u, v] as [number, number],
  }));
  const sail = mkPiece(sailId, 'sail', [0, -yr, p.sailYardOffset], {
    min: [-sailWidth / 2, -sailDrop, -0.5],
    max: [sailWidth / 2, 0.15, 0.5],
  }, {
    parent: yardId,
    sockets: clothSockets,
    sailStates: SAIL_STATES.map((s) => ({ ...s })),
    // §B73 [ref-sails-1947]: running before the wind, the foot is hauled
    // FORWARD of the mast — the belly leads. sailFrame.readSheetLeadSign
    // §B83: the robands are sized to THIS yard (pieceGeometrySail.sailTieSpec)
    // §B86-2: and this raft's own saturating wind, so one shared membrane
    // still answers two very different suits of canvas (sailDynamics.readSailWindRef)
    // §B86-3: the roll is gathered along THIS yard, at the raft's own packing
    shape: { sheetLeadAft: -1, yardR: yr, windRef: p.sailWindRef, yardLength: len, furlPack: p.furlBundlePack },
  });
  return [yard, sail];
}

/**
 * §T.138 — THE SEIZING THAT HOLDS A YARD TO THE POLE IT IS SET ON.
 *
 * A yard parreled to a single spar is LASHED to it. With `poleParrelGap` of
 * air between the two surfaces there has to be rope in that air, or the spar
 * reads as unattached — USER, of the mizzen: "the horizontal bar for the back
 * sail is floating mid-air".
 *
 * WHOSE FRAME (§V71): the collar is a child of the POLE, not of the yard.
 * Bracing turns a yard about its OWN origin (`rigTrim`), which is the point
 * held 'standoff' forward of the pole — i.e. the yard pivots IN its parrel,
 * exactly as a real one does, and the seizing stays on the mast while the
 * spar swings inside it. Parented to the yard it would swing away from the
 * pole at every brace, which is the same defect in a new place. Its span is
 * derived from the standoff the yard is actually hung at, so re-tuning
 * `poleParrelGap` carries the rope with it.
 */
function parrelSeizing(
  p: RaftParams,
  mast: string,
  level: string,
  mastR: number,
  yr: number,
  gap: number,
  y: number,
): PieceDef {
  const standoff = mastR + yr + gap; // pole axis → yard axis, in the mast's z
  const wrapR = standoff / 2 + Math.max(mastR, yr);
  const turns = Math.max(3, Math.round(wrapR / p.lashingRopeDiameter));
  const width = p.lashingRopeDiameter * turns;
  const R = wrapR + p.lashingRopeDiameter * 0.6;
  return mkPiece(`lashing-parrel-${mast}-${level}`, 'lashing', [0, y, standoff / 2], {
    min: [-width / 2, -R, -R],
    max: [width / 2, R, R],
  }, {
    parent: `mast-${mast}`,
    // `ring: 0` = a wrap round the pair, no torus under it (as the bipod's)
    shape: { n: 1, x0: 0, rope: p.lashingRopeDiameter, turns, beamR: wrapR, ring: 0 },
  });
}

export function buildBipodMast(p: RaftParams, L: RaftLayout): PieceDef[] {
  const out: PieceDef[] = [];
  const legR = p.mastLegDiameter / 2;
  const halfSpan = p.mastLegSpacing / 2;
  const lean = Math.atan2(halfSpan, p.mastHeight);
  const legLen = Math.hypot(halfSpan, p.mastHeight) + p.mastCrossingOverlap;
  // §B75: the whole bipod is RAKED AFT. Rotation about +x by +θ tips a +y pole
  // toward +z (the bow), so aft is −rake; every piece stepped at deck level
  // (legs, topsail pole) carries it and the crossing lands at `crossingAt`
  const rake = Math.max(0, p.mastRakeAft);
  const crossingAt: Vec3 = [0, L.logTopY + p.mastHeight * Math.cos(rake), L.mastZ - p.mastHeight * Math.sin(rake)];
  // two legs stepped through the deck onto the logs, leaning to the crossing
  for (const [side, sign] of [['port', -1], ['starboard', 1]] as const) {
    // §B86-1: where a halyard is made fast. Both come down the mast's AFT
    // side (−z on the leg) because the sails hang FORWARD of it — a belay on
    // the fore deck would run the line straight through the mainsail.
    const sockets: SocketDef[] = [
      { id: `anchor-belay-main-${side}`, type: 'rope-anchor', position: [-sign * (legR + 0.05), 0.25, -0.3] },
    ];
    // §B78-3: the ladder station used to sit at the leg's FOOT, 0.45 m
    // OUTBOARD of it — x 2.69 in ship space, past the foot-rail and off the
    // walkable deck, so no stance on this raft could ever take hold of it.
    // It rides the ladder now, `ladderGrabHeight` up the leg on the same
    // outboard face the rungs hang from (§B83); the leg's lean carries that
    // point INBOARD of the rail, over deck a walker can stand on.
    if (side === 'starboard') {
      sockets.push({ id: 'station-ladder', type: 'fixture', position: [legR + p.ladderStandoff, p.ladderGrabHeight, 0] });
    }
    out.push(
      mkPiece(`bipod-leg-${side}`, 'bipod-mast', [sign * halfSpan, L.logTopY, L.mastZ], {
        min: [-legR, 0, -legR],
        max: [legR, legLen, legR],
      }, {
        // rotation about z by +θ tips a +y pole toward −x, so the PORT leg
        // (sign −1) takes −lean to reach the centreline; each leg also has its
        // own fore-aft lean (§B73: the bipod is two crooked poles, not an A)
        rotation: [-rake + vjitter(p.legLeanJitter, sign, 7) * Math.max(0, shipDetailParams.irregularity), 0, sign * lean],
        sockets,
        shape: { taper: 0.8, sides: 10 },
      }),
    );
  }
  // rope ladder with wooden rungs up the starboard leg [§4 Masthead] — hung
  // on the leg's outboard face, a hand off the pole, in the leg's own frame so
  // its stringers run with the lean and the rungs lie square to it (§B75/§B83)
  out.push(
    mkPiece('mast-ladder', 'bipod-mast', [legR + p.ladderStandoff, 0.4, 0], {
      min: [-p.ladderWidth / 2, 0, -0.04],
      max: [p.ladderWidth / 2, legLen - p.mastCrossingOverlap - 1.2, 0.04],
    }, {
      parent: 'bipod-leg-starboard',
      // the ladder() geometry lays its rungs along local x; a quarter turn
      // about the leg axis hangs it on the leg's OUTBOARD face, rungs running
      // fore-aft — ⊥ the leg and ⊥ the leg's outward normal (§B83)
      rotation: [0, Math.PI / 2, 0],
      shape: { ladder: 1, rungPitch: p.ladderRungPitch },
    }),
  );

  // the topsail pole = the rig's `mast-main` (see header). Stepped at deck
  // level, drawn from the crossing up.
  const poleR = legR * 0.8;
  const crossing = p.mastHeight;
  /**
   * §B78-4 — THE PERCH IS A PLACE TO LOOK FROM, and the topsail is resolved
   * against it (§V71), never the other way round. The platform is at the
   * crossing [§4 Masthead] and the topsail is set on the pole above it; with
   * both authored as free numbers they overlapped, and the lookout's eye
   * stood INSIDE the cloth — "forward is 100 % topsail" (R2 walk review).
   * The sail's FOOT is hoisted `lookoutHeadroom` above the platform and the
   * pole grows to carry the yard, so no knob can put the canvas back over the
   * lookout's head.
   */
  const perchY = crossing + p.platformThickness;
  // how far the cloth can hang BELOW its yard for ANY attitude `yardAttitude`
  // gives it (§V71: the live shape, not the rest pose) — the farthest cloth
  // corner from the yard's own axis, so no cock/rake/slew can dip under it
  const topsailReach = Math.hypot(p.topsailWidth / 2, p.yardDiameter * 0.3 + p.topsailDrop, p.sailYardOffset);
  const topsailY = Math.max(crossing + p.topsailHeightAboveCrossing, perchY + p.lookoutHeadroom + topsailReach);
  const top = Math.max(crossing + p.topPoleHeight, topsailY + p.yardDiameter * 2);
  const irr = Math.max(0, shipDetailParams.irregularity);
  out.push(
    mkPiece('mast-main', 'mast', [0, L.logTopY, L.mastZ], {
      min: [-poleR, crossing, -poleR],
      max: [poleR, top, poleR],
    }, {
      // raked with the legs, and lashed askew above the crossing (§B73);
      // small, because the piece pivots at deck level and the crossing
      // bundle has to hide the offset
      rotation: [-rake + vjitter(p.topPoleTilt, 11) * irr, 0, vjitter(p.topPoleTilt, 12) * irr],
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
  // the crossing itself: a rope bundle wrapping both legs where they meet
  // [§4 Mast "lashed crosswise at top"], the wrap axis vertical
  const wrapR = legR * 1.5;
  out.push(
    mkPiece('lashing-crossing', 'lashing', crossingAt, {
      min: [-p.crossingWrapWidth / 2, -wrapR - 0.02, -wrapR - 0.02],
      max: [p.crossingWrapWidth / 2, wrapR + 0.02, wrapR + 0.02],
    }, {
      rotation: [-rake, 0, Math.PI / 2],
      shape: { n: 1, x0: 0, rope: p.lashingRopeDiameter, turns: p.crossingWrapWidth / p.lashingRopeDiameter, beamR: wrapR, ring: 0 },
    }),
  );
  const yr = p.yardDiameter / 2;
  // main yard hoisted below the crossing; the legs are ~legR apart there so
  // the yard clears them on the leg radius
  out.push(...yardAndSail(p, 'main', 'lower', p.mainYardHeight, p.yardLength, yr, legR,
    p.mainSailWidth, p.mainSailDrop, 1, 0, p.mainYardFurlDrop));
  // small topsail on the pole above the crossing [§4 Topsail], hoisted clear
  // of the lookout (see `topsailY`). §T.138: a yard on ONE pole gets a
  // parrel-sized gap and a seizing across it, not the bipod's splay allowance
  out.push(...yardAndSail(p, 'main', 'upper', topsailY,
    p.topsailYardLength, yr * 0.6, poleR, p.topsailWidth, p.topsailDrop, 2, 0, 0, p.poleParrelGap));
  out.push(parrelSeizing(p, 'main', 'upper', poleR, yr * 0.6, p.poleParrelGap, topsailY));
  return out;
}

/**
 * §T.138 / §V71 — a deck pole stands on the CROWN OF A LOG, never in a chink.
 * The mizzen and flag poles were authored at ±0.9 m, which is where the two
 * aft guara chinks happen to be: the flagpole's box ran through the starboard
 * guara plank and the pair read as "two poles from the guaras" (USER). Snap
 * the wanted x to the nearest log centreline and seat the pole on THAT log's
 * own crown, so a re-seeded log field can never put a pole in a gap again.
 */
function stepOnLog(p: RaftParams, L: RaftLayout, x: number): { x: number; crown: number } {
  let best = L.logs[0];
  for (const l of L.logs) if (Math.abs(l.x - x) < Math.abs(best.x - x)) best = l;
  return { x: best.x, crown: p.logAxisY + best.r };
}

/** short mizzen pole + small square sail, and the tall thin flag pole [§4 Mizzen] */
export function buildMizzenAndFlag(p: RaftParams, L: RaftLayout): PieceDef[] {
  const out: PieceDef[] = [];
  const mr = p.mizzenDiameter / 2;
  const mizzenFoot = stepOnLog(p, L, p.mizzenX);
  out.push(
    mkPiece('mast-mizzen', 'mast', [mizzenFoot.x, mizzenFoot.crown, p.mizzenZ], {
      min: [-mr, 0, -mr],
      max: [mr, p.mizzenHeight, mr],
    }, {
      sockets: [{ id: 'anchor-masthead-mizzen', type: 'rope-anchor', position: [0, p.mizzenHeight, 0] }],
    }),
  );
  const yr = p.yardDiameter * 0.3;
  // the mizzen's spar is a SPRIT (§B73 [ref-sails-1947]): hoisted to the
  // pole head and stood up at `mizzenSpritAngle`, the small sail hanging
  // loose off it — in the photo it flies ABOVE the cabin ridge, not behind it.
  // §T.138: parreled to the pole with `poleParrelGap` of slack and a seizing
  // across it — at the bipod's 0.30 m it hung in clear air off a 0.10 m pole
  out.push(...yardAndSail(p, 'mizzen', 'lower', p.mizzenHeight - 0.25, p.mizzenYardLength, yr, mr,
    p.mizzenSailWidth, p.mizzenSailDrop, 3, p.mizzenSpritAngle, 0, p.poleParrelGap));
  out.push(parrelSeizing(p, 'mizzen', 'lower', mr, yr, p.poleParrelGap, p.mizzenHeight - 0.25));

  const fr = p.flagpoleDiameter / 2;
  const flagFoot = stepOnLog(p, L, p.flagpoleX);
  out.push(
    mkPiece('flagpole', 'bipod-mast', [flagFoot.x, flagFoot.crown, p.mizzenZ], {
      min: [-fr, 0, -fr],
      max: [fr, p.flagpoleHeight, fr],
    }, {
      shape: { taper: 0.7, sides: 8 },
      // §B86-1: the truck the ensign's own halyard is rove through
      sockets: [{ id: 'anchor-truck-flag', type: 'rope-anchor', position: [0, p.flagpoleHeight - 0.05, 0] }],
    }),
  );
  out.push(
    mkPiece('flag-stern', 'pennant', [0, p.flagpoleHeight - 0.05, 0], {
      min: [0, -p.flagHoist, -0.1],
      max: [p.flagFly, 0.1, 0.1],
    }, {
      parent: 'flagpole',
      shape: { fly: p.flagFly, hoist: p.flagHoist, style: FLAG_STYLE_NORWAY, taper: 0, headY: 0, staff: 0 },
    }),
  );
  return out;
}
