/**
 * RAFT 2100 — Kon-Tiki dimensions (§V82: TO SCALE, FROM THE REFERENCE, not
 * eyeballed). Every value cites a row of docs/raft2100/kon-tiki-reference.md
 * as `[§n Row]`; values the reference does not pin are marked `// EST` with
 * the photo/range they were read from. `buildRaftBlueprint` (src/ship/
 * raftBlueprint.ts) is a pure function of this object.
 *
 * FRAME (same as the other two classes): +z bow, +x STARBOARD, +y up,
 * y = 0 waterline. The log centrelines sit AT the waterline: "logs ~half
 * submerged" [§1 Draft].
 */
import { registerParams, type ParamMeta } from './registry';

export interface RaftParams {
  /** seed for the chink widths / log diameters (§V2 — hashed, never random) */
  seed: number;
  // --- §1 Hull
  logCount: number; // [§1 Main logs] 9 balsa logs
  logCentreLength: number; // [§1 Centre log] 13.7 m
  logOuterLength: number; // [§1 Side logs] outermost 9.1 m, symmetric linear stagger
  logDiameterMax: number; // [§1 Log diameter] up to 60 cm fresh
  logDiameterMin: number; // [§1 Log diameter] use 50–60 cm
  logBowTaper: number; // EST — bow radius ÷ stern radius; "tapering" [§1 Log diameter]
  logBowChamfer: number; // EST — length of the pointed tip, m [§1 Bow ends "pointed/chamfered"]
  chinkMin: number; // [§1 Gaps] 2 cm
  chinkMax: number; // [§1 Gaps] 8 cm
  guaraChinkMin: number; // [§2 Positions] guaras sit "in larger chinks" — a 2.5 cm plank needs > 2.5 cm
  sternProjection: number; // [§1 Stern] three middle logs project ~0.6 m
  sternProjectingLogs: number; // [§1 Stern] three
  logAxisY: number; // [§1 Draft] logs ~half submerged → centreline at the waterline
  splashboardHeight: number; // [§1 Bow ends] 30–40 cm
  splashboardThickness: number; // EST — "dark plank" [§1 Bow ends]
  splashboardInset: number; // EST — set back from the log tips, m [PHOTO-02,03]
  crossbeamCount: number; // [§1 Cross-beams] 9
  crossbeamPitch: number; // [§1 Cross-beams] ~0.91 m
  crossbeamDiameter: number; // [§1 Cross-beams] ~30 cm
  crossbeamLength: number; // [§1 Cross-beams] ~5.5 m
  footRailDiameter: number; // EST — "one slim balsa log" [§1 Foot-rails]
  footRailLength: number; // EST — runs the decked length [§1 Foot-rails]
  matThickness: number; // EST — split bamboo + plaited mats [§1 Deck]
  // --- §3 Cabin
  cabinWidth: number; // [§3 Plan] 2.4 m
  cabinLength: number; // [§3 Plan] 4.3 m
  cabinAftZ: number; // EST — "amidships, nearer stern" [§3 Location]; leaves bare logs aft [§5 Stern]
  cabinEave: number; // EST — wall height over floor; ridge "1.2–1.5" [§3 Height] and clear 1.2 everywhere
  cabinRidge: number; // [§3 Height] ~1.2–1.5 m ridge over floor
  cabinWallThickness: number; // EST — split-bamboo weave [§3 Walls]
  cabinOpeningLength: number; // [§3 Opening] ~1.4 m of the STARBOARD wall
  cabinOpeningAftOffset: number; // EST — opening "mid-to-aft" [§3 Museum]: from the aft wall
  cabinBoxHeight: number; // EST — floor mats over 8 lashed boxes [§3 Floor]
  roofOverhang: number; // [§3 Roof] 20–30 cm
  roofThickness: number; // EST — laths + leaves [§3 Roof]
  // --- §4 Mast & rig
  mastGapToCabin: number; // EST — legs "just forward of cabin front wall" [§4 Leg spacing]
  mastHeight: number; // [§4 Height] 8.8 m to crossing (WP); museum "nearly 10" — EST range 8.5–10
  mastLegSpacing: number; // EST — ≈ 4.5 m at deck [§4 Leg spacing]
  mastLegDiameter: number; // [§4 Pole Ø] 15–20 cm
  mastCrossingOverlap: number; // EST — legs run past the crossing, lashed [§4 Mast]
  topPoleHeight: number; // EST — "short pole above crossing" [§4 Masthead]
  platformSize: number; // EST — "wooden lookout platform at crossing" [§4 Masthead]
  platformThickness: number; // EST
  ladderWidth: number; // EST — rope ladder w/ wooden rungs [§4 Masthead]
  ladderRungPitch: number; // EST
  yardLength: number; // [§4 Yard] ~5.5 m+ — EST 6.0 (wider than the 5.5 m sail)
  yardDiameter: number; // EST — two bamboo stems bound together [§4 Yard]
  yardMastClearance: number; // EST — yard rides forward of the legs
  sailYardOffset: number; // EST — cloth forward of the yard axis
  mainYardHeight: number; // EST — hoisted below the crossing [PHOTO-10]
  mainSailWidth: number; // [§4 Mainsail] 5.5 m wide
  mainSailDrop: number; // [§4 Mainsail] 4.6 m drop
  topsailHeightAboveCrossing: number; // EST — on the short pole [§4 Topsail]
  topsailYardLength: number; // EST — [§9.2] topsail size unknown
  topsailWidth: number; // EST
  topsailDrop: number; // EST
  mizzenZ: number; // EST — "short mizzen pole at stern" [§4 Mizzen]
  mizzenX: number; // EST — offset to port to clear the oar sweep [PHOTO-10]
  mizzenHeight: number; // EST — [§9.2] mizzen size unknown
  mizzenDiameter: number; // EST
  mizzenYardLength: number; // EST
  mizzenSailWidth: number; // EST
  mizzenSailDrop: number; // EST
  flagpoleHeight: number; // EST — "tall thin flag/antenna pole" [§4 Mizzen]
  flagpoleDiameter: number; // EST
  flagpoleX: number; // EST — starboard of the oar, opposite the mizzen
  flagFly: number; // EST — Norwegian flag [§4 Mizzen]
  flagHoist: number; // EST
  // --- §2 Guaras
  guaraCount: number; // [§2 Count] 5
  guaraHeight: number; // [§2 Size] ~2 m total
  guaraWidth: number; // [§2 Size] 60 cm
  guaraThickness: number; // [§2 Size] 25 mm
  guaraDepth: number; // [§2 Size] 1.5 m below raft
  guaraTravel: number; // EST — how far a guara is hand-raised [§2 Fixing "partway"]
  guaraDefaultDepth: number; // EST — 0 = fully raised, 1 = fully lowered; rest pose
  guaraFwdZ: number; // EST — "~2 at bow" [§2 Positions]
  guaraAftZ: number; // EST — "~2 at stern"
  guaraMidZ: number; // EST — "1 midships", forward of the mast
  // --- §5 Steering
  sternBlockLength: number; // [§5 Mount] ~2.5 m
  sternBlockSection: number; // [§5 Mount] 30 cm
  tholePinHeight: number; // [§5 Mount] ~30 cm
  tholePinSpacing: number; // [§5 Mount] ~40 cm
  tholePinDiameter: number; // EST
  oarLength: number; // [§5 Oar] 5.8 m
  oarShaftDiameter: number; // EST — mangrove pole [§5 Oar]
  oarBladeLength: number; // [§5 Oar] ~1.2 m
  oarBladeWidth: number; // [§5 Oar] ~0.4 m
  oarTillerLength: number; // EST — "cross-piece lashed to handle as tiller" [§5 Oar]
  oarInboard: number; // EST — shaft inboard of the pins, m
  oarDip: number; // EST — rad the blade dips below the block
  // --- §6 Deck items (2100 dressing as boxes — all EST against the museum set)
  crateWidth: number; // EST — pine crates [§6]
  crateHeight: number; // EST
  jerrycanHeight: number; // EST — 2100 stand-in for the water cans [§6]
  drumDiameter: number; // EST — rain drum (2100)
  drumHeight: number; // EST
  dinghyLength: number; // EST — ring dinghy on edge against the port wall [§6]
  dinghyHeight: number; // EST
  dinghyThickness: number; // EST
  cageSize: number; // EST — parrot cage under the roof [§6]
  kitchenBoxSize: number; // EST — Primus box starboard outside the door [§6]
}

const m = (min: number, max: number, step = 0.01): ParamMeta => ({ min, max, step });

export const raftParams: RaftParams = registerParams(
  'ship-raft',
  {
    seed: 1947,
    logCount: 9,
    logCentreLength: 13.7,
    logOuterLength: 9.1,
    logDiameterMax: 0.6,
    logDiameterMin: 0.5,
    logBowTaper: 0.82, // EST
    logBowChamfer: 0.7, // EST
    chinkMin: 0.02,
    chinkMax: 0.08,
    guaraChinkMin: 0.05,
    sternProjection: 0.6,
    sternProjectingLogs: 3,
    logAxisY: 0,
    splashboardHeight: 0.35,
    splashboardThickness: 0.04, // EST
    splashboardInset: 0.3, // EST
    crossbeamCount: 9,
    crossbeamPitch: 0.91,
    crossbeamDiameter: 0.3,
    crossbeamLength: 5.5,
    footRailDiameter: 0.15, // EST
    footRailLength: 7.0, // EST
    matThickness: 0.04, // EST
    cabinWidth: 2.4,
    cabinLength: 4.3,
    cabinAftZ: -4.3, // EST
    cabinEave: 1.2, // EST
    cabinRidge: 1.45,
    cabinWallThickness: 0.05, // EST
    cabinOpeningLength: 1.4,
    cabinOpeningAftOffset: 0.9, // EST
    cabinBoxHeight: 0.3, // EST
    roofOverhang: 0.25,
    roofThickness: 0.08, // EST
    mastGapToCabin: 0.6, // EST
    mastHeight: 8.8, // EST 8.5–10
    mastLegSpacing: 4.5, // EST
    mastLegDiameter: 0.18,
    mastCrossingOverlap: 0.35, // EST
    topPoleHeight: 2.4, // EST
    platformSize: 0.9, // EST
    platformThickness: 0.05, // EST
    ladderWidth: 0.35, // EST
    ladderRungPitch: 0.35, // EST
    yardLength: 6.0, // EST
    yardDiameter: 0.12, // EST
    yardMastClearance: 0.05, // EST
    sailYardOffset: 0.12, // EST
    mainYardHeight: 7.2, // EST
    mainSailWidth: 5.5,
    mainSailDrop: 4.6,
    topsailHeightAboveCrossing: 1.8, // EST
    topsailYardLength: 3.0, // EST
    topsailWidth: 2.6, // EST
    topsailDrop: 1.4, // EST
    mizzenZ: -5.4, // EST
    mizzenX: -0.9, // EST
    mizzenHeight: 3.6, // EST
    mizzenDiameter: 0.1, // EST
    mizzenYardLength: 2.2, // EST
    mizzenSailWidth: 2.0, // EST
    mizzenSailDrop: 1.6, // EST
    flagpoleHeight: 5.0, // EST
    flagpoleDiameter: 0.06, // EST
    flagpoleX: 0.9, // EST
    flagFly: 0.9, // EST
    flagHoist: 0.65, // EST
    guaraCount: 5,
    guaraHeight: 2.0,
    guaraWidth: 0.6,
    guaraThickness: 0.025,
    guaraDepth: 1.5,
    guaraTravel: 1.2, // EST
    guaraDefaultDepth: 0.5, // EST
    guaraFwdZ: 2.2, // EST
    guaraAftZ: -5.0, // EST
    guaraMidZ: 1.4, // EST
    sternBlockLength: 2.5,
    sternBlockSection: 0.3,
    tholePinHeight: 0.3,
    tholePinSpacing: 0.4,
    tholePinDiameter: 0.06, // EST
    oarLength: 5.8,
    oarShaftDiameter: 0.09, // EST
    oarBladeLength: 1.2,
    oarBladeWidth: 0.4,
    oarTillerLength: 0.9, // EST
    oarInboard: 1.8, // EST
    oarDip: 0.35, // EST
    crateWidth: 0.6, // EST
    crateHeight: 0.5, // EST
    jerrycanHeight: 0.47, // EST
    drumDiameter: 0.58, // EST
    drumHeight: 0.88, // EST
    dinghyLength: 2.2, // EST
    dinghyHeight: 1.0, // EST
    dinghyThickness: 0.35, // EST
    cageSize: 0.4, // EST
    kitchenBoxSize: 0.6, // EST
  },
  {
    seed: m(0, 99999, 1),
    logCentreLength: m(10, 16),
    logOuterLength: m(6, 13.7),
    logDiameterMax: m(0.3, 0.8),
    logDiameterMin: m(0.3, 0.8),
    logBowTaper: m(0.5, 1),
    chinkMin: m(0, 0.1, 0.005),
    chinkMax: m(0, 0.15, 0.005),
    cabinEave: m(0.9, 1.5),
    cabinRidge: m(1.2, 1.6),
    mastHeight: m(8.5, 10),
    mastLegSpacing: m(3, 5.5),
    mainYardHeight: m(5, 8.8),
    mainSailWidth: m(4, 6),
    mainSailDrop: m(3.5, 5),
    guaraDefaultDepth: m(0, 1),
    oarDip: m(0, 0.8),
  },
);
